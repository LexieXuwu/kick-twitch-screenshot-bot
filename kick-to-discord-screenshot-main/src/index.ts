import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { acquireSingleInstanceLock, releaseSingleInstanceLock } from './single-instance';
import { shouldSkipDiscordSend } from './discord-cooldown';
import { getStreamInfo } from './kick/stream';
import { KickChatListener } from './kick/chat';
import { TwitchChatListener } from './twitch/chat';
import { captureScreenshot } from './screenshot';
import { captureEmojiStatic, captureStickerStatic } from './emoji';
import { sendScreenshot, sendClip, sendGif, sendEmoji, sendSticker } from './discord';
import { RollingBuffer } from './clip';

const KICK_CHANNEL = process.env.KICK_CHANNEL!;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL!;
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL;
const TWITCH_OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN;
const DISCORD_WEBHOOK_PICS = process.env.DISCORD_WEBHOOK_PICS || DISCORD_WEBHOOK_URL;
const DISCORD_WEBHOOK_GIFS = process.env.DISCORD_WEBHOOK_GIFS || DISCORD_WEBHOOK_URL;
const DISCORD_WEBHOOK_CLIPS = process.env.DISCORD_WEBHOOK_CLIPS || DISCORD_WEBHOOK_URL;
const DISCORD_WEBHOOK_EMOJIS = process.env.DISCORD_WEBHOOK_EMOJIS || DISCORD_WEBHOOK_URL;

/** How often to check whether the channel is live (while offline). */
const OFFLINE_POLL_MS = 30 * 1000;
/** How often to re-check while live (notices the stream ending, keeps the playback URL fresh). */
const LIVE_POLL_MS = 60 * 1000;

if (!KICK_CHANNEL || !DISCORD_WEBHOOK_URL) {
  console.error('Missing required env vars: KICK_CHANNEL, DISCORD_WEBHOOK_URL');
  process.exit(1);
}

acquireSingleInstanceLock();

/** Short, human-readable reason for a failure (network errors often carry no message, only a code). */
function describeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { message?: string; code?: string; errors?: { message?: string; code?: string }[]; response?: { status?: number } };
    if (err.response?.status) return `Kick responded with HTTP ${err.response.status}`;
    if (err.message) return err.message;
    if (err.code) return err.code;
    const inner = err.errors?.find((x) => x?.code || x?.message);
    if (inner) return inner.code || inner.message || 'network error';
  }
  return String(e) || 'unknown error';
}

async function main() {
  const twitchEnabled = !!(TWITCH_CHANNEL && TWITCH_OAUTH_TOKEN);

  // Plain ASCII on purpose: this also ends up in logs\bot.log when run as a scheduled task.
  console.log('');
  console.log('  Kick Screenshot Bot');
  console.log('  -------------------');
  console.log(`  Kick     :  ${KICK_CHANNEL}`);
  if (twitchEnabled) console.log(`  Twitch   :  ${TWITCH_CHANNEL}`);
  console.log('  Send     :  Discord webhook');
  console.log('');

  console.log(`Looking up Kick channel ${KICK_CHANNEL}...`);
  let channelInfo;
  try {
    channelInfo = await getStreamInfo(KICK_CHANNEL);
  } catch (e) {
    throw new Error(`Could not reach Kick for channel "${KICK_CHANNEL}": ${e instanceof Error ? e.message : e}`);
  }
  if (!channelInfo.chatroomId) {
    throw new Error(`Kick channel "${KICK_CHANNEL}" was not found (no chatroom id).`);
  }

  // ── Stream state (updated by the poller below) ──
  const state = {
    live: false,
    m3u8Url: null as string | null,
  };

  const getFreshStreamUrl = async (): Promise<string> => {
    const info = await getStreamInfo(KICK_CHANNEL);
    if (!info.isLive || !info.playbackUrl) {
      throw new Error(`${KICK_CHANNEL} is not live`);
    }
    state.m3u8Url = info.playbackUrl;
    return info.playbackUrl;
  };

  const requireLiveUrl = (): string => {
    if (!state.live || !state.m3u8Url) {
      throw new Error(`${KICK_CHANNEL} is offline right now`);
    }
    return state.m3u8Url;
  };

  const buffer = new RollingBuffer(getFreshStreamUrl);

  // ── Chat connects whether or not the stream is live ──
  // A network blip here must not kill the bot: the listener reconnects on its own.
  const chat = new KickChatListener(channelInfo.chatroomId);
  try {
    await chat.connect();
  } catch (e) {
    console.error(`[Chat] First connection failed (${describeError(e)}); retrying in the background`);
    chat.ensureReconnect();
  }

  let twitchChat: TwitchChatListener | null = null;
  if (twitchEnabled) {
    twitchChat = new TwitchChatListener(TWITCH_CHANNEL!, TWITCH_OAUTH_TOKEN!);
    try {
      await twitchChat.connect();
    } catch (e) {
      console.error(`[Twitch] Connection failed (${describeError(e)}); Twitch chat will keep retrying`);
    }
  }

  const discordKey = (platform: 'kick' | 'twitch', sender: string, cmd: string) =>
    `${platform}:${sender.toLowerCase()}:${cmd}`;

  const bindHandlers = (chatSource: KickChatListener | TwitchChatListener, senderSuffix: string, platform: 'kick' | 'twitch') => {
    const guard = (cmd: string, sender: string): boolean => {
      if (shouldSkipDiscordSend(discordKey(platform, sender, cmd))) return false;
      if (!state.live) {
        console.log(`[Bot] Ignoring !${cmd} from ${sender}${senderSuffix}: ${KICK_CHANNEL} is offline`);
        return false;
      }
      return true;
    };

    chatSource.on('pic', async ({ sender }: { sender: string }) => {
      if (!guard('pic', sender)) return;
      const displayName = sender + senderSuffix;
      console.log(`[Bot] Taking screenshot (requested by ${displayName})...`);
      try {
        const screenshot = await captureScreenshot(requireLiveUrl());
        console.log(`[Bot] Screenshot captured (${(screenshot.length / 1024).toFixed(1)} KB)`);
        await sendScreenshot(DISCORD_WEBHOOK_PICS, screenshot, KICK_CHANNEL, displayName, platform);
        console.log('[Bot] Screenshot sent to Discord!');
      } catch (error) {
        console.error('[Bot] Failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('clip', async ({ sender }: { sender: string }) => {
      if (!guard('clip', sender)) return;
      const displayName = sender + senderSuffix;
      console.log(`[Bot] Capturing 30s clip (requested by ${displayName})...`);
      try {
        const clip = await buffer.captureClip(30);
        console.log(`[Bot] Clip captured (${(clip.length / 1024 / 1024).toFixed(1)} MB)`);
        await sendClip(DISCORD_WEBHOOK_CLIPS, clip, KICK_CHANNEL, displayName, platform);
        console.log('[Bot] Clip sent to Discord!');
      } catch (error) {
        console.error('[Bot] Clip failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('gif', async ({ sender }: { sender: string }) => {
      if (!guard('gif', sender)) return;
      const displayName = sender + senderSuffix;
      console.log(`[Bot] Capturing 5s GIF (requested by ${displayName})...`);
      try {
        const gif = await buffer.captureGif(5);
        console.log(`[Bot] GIF captured (${(gif.length / 1024).toFixed(1)} KB)`);
        await sendGif(DISCORD_WEBHOOK_GIFS, gif, KICK_CHANNEL, displayName, platform);
        console.log('[Bot] GIF sent to Discord!');
      } catch (error) {
        console.error('[Bot] GIF failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('emoji', async ({ sender }: { sender: string }) => {
      if (!guard('emoji', sender)) return;
      const displayName = sender + senderSuffix;
      console.log(`[Bot] Capturing emoji (requested by ${displayName})...`);
      try {
        const emoji = await captureEmojiStatic(requireLiveUrl());
        console.log(`[Bot] Emoji captured (${(emoji.length / 1024).toFixed(1)} KB)`);
        await sendEmoji(DISCORD_WEBHOOK_EMOJIS, emoji, KICK_CHANNEL, displayName, platform, false);
        console.log('[Bot] Emoji sent to Discord!');
      } catch (error) {
        console.error('[Bot] Emoji failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('emoji2', async ({ sender }: { sender: string }) => {
      if (!guard('emoji2', sender)) return;
      const displayName = sender + senderSuffix;
      console.log(`[Bot] Capturing animated emoji (requested by ${displayName})...`);
      try {
        const emoji = await buffer.captureEmojiGif(2.5);
        console.log(`[Bot] Animated emoji captured (${(emoji.length / 1024).toFixed(1)} KB)`);
        await sendEmoji(DISCORD_WEBHOOK_EMOJIS, emoji, KICK_CHANNEL, displayName, platform, true);
        console.log('[Bot] Animated emoji sent to Discord!');
      } catch (error) {
        console.error('[Bot] Animated emoji failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('sticker', async ({ sender }: { sender: string }) => {
      if (!guard('sticker', sender)) return;
      const displayName = sender + senderSuffix;
      console.log(`[Bot] Capturing sticker (requested by ${displayName})...`);
      try {
        const sticker = await captureStickerStatic(requireLiveUrl());
        console.log(`[Bot] Sticker captured (${(sticker.length / 1024).toFixed(1)} KB)`);
        await sendSticker(DISCORD_WEBHOOK_EMOJIS, sticker, KICK_CHANNEL, displayName, platform, false);
        console.log('[Bot] Sticker sent to Discord!');
      } catch (error) {
        console.error('[Bot] Sticker failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('sticker2', async ({ sender }: { sender: string }) => {
      if (!guard('sticker2', sender)) return;
      const displayName = sender + senderSuffix;
      console.log(`[Bot] Capturing animated sticker (requested by ${displayName})...`);
      try {
        const sticker = await buffer.captureStickerGif(2.5);
        console.log(`[Bot] Animated sticker captured (${(sticker.length / 1024).toFixed(1)} KB)`);
        await sendSticker(DISCORD_WEBHOOK_EMOJIS, sticker, KICK_CHANNEL, displayName, platform, true);
        console.log('[Bot] Animated sticker sent to Discord!');
      } catch (error) {
        console.error('[Bot] Sticker failed:', error instanceof Error ? error.message : error);
      }
    });

  };

  bindHandlers(chat, '', 'kick');
  if (twitchChat) bindHandlers(twitchChat, ' (Twitch)', 'twitch');

  // ── Live/offline poller: starts the clip buffer when the stream is up, stops it when down ──
  let pollTimer: NodeJS.Timeout | null = null;
  let stopping = false;

  const goLive = async (url: string, title: string | null, viewers: number) => {
    state.live = true;
    state.m3u8Url = url;
    console.log(`\n[Bot] ${KICK_CHANNEL} is LIVE: ${title ?? '(no title)'} · ${viewers} viewers`);
    console.log(`[Bot] M3U8: ${url.substring(0, 60)}...`);
    console.log('[Bot] Starting rolling buffer for !clip / !gif...');
    try {
      await buffer.start(url);
    } catch (e) {
      console.error('[Bot] Buffer start failed:', e instanceof Error ? e.message : e);
    }
  };

  const goOffline = async () => {
    state.live = false;
    state.m3u8Url = null;
    console.log(`\n[Bot] ${KICK_CHANNEL} went offline. Waiting for the next stream (chat stays connected)...`);
    await buffer.stop();
  };

  const poll = async () => {
    if (stopping) return;
    try {
      const info = await getStreamInfo(KICK_CHANNEL);
      if (info.isLive && info.playbackUrl) {
        if (!state.live) {
          await goLive(info.playbackUrl, info.title, info.viewerCount);
        } else {
          state.m3u8Url = info.playbackUrl;
        }
      } else if (state.live) {
        await goOffline();
      }
    } catch (e) {
      console.error(`[Bot] Stream status check failed (${describeError(e)}); will retry`);
    }
    if (!stopping) {
      pollTimer = setTimeout(poll, state.live ? LIVE_POLL_MS : OFFLINE_POLL_MS);
    }
  };

  await poll();

  const chatSources = twitchEnabled ? 'Kick + Twitch' : 'Kick';
  console.log('');
  console.log(`  Running  :  listening to ${chatSources} chat`);
  console.log(`  Stream   :  ${state.live ? 'live now' : `offline, waiting for ${KICK_CHANNEL} (checking every 30s)`}`);
  console.log('  Commands :  !pic  !clip  !gif  !emoji  !emoji2  !sticker  !sticker2');
  console.log('');

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nShutting down...');
    if (pollTimer) clearTimeout(pollTimer);
    chat.disconnect();
    twitchChat?.disconnect();
    try {
      await buffer.stop();
    } catch {
      /* ignore */
    }
    releaseSingleInstanceLock();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((error) => {
  console.error(`Fatal: ${describeError(error)}`);
  releaseSingleInstanceLock();
  process.exit(1);
});
