import dotenv from 'dotenv';
dotenv.config();

import { getStreamInfo } from './kick/stream';
import { KickChatListener } from './kick/chat';
import { TwitchChatListener } from './twitch/chat';
import { captureScreenshot } from './screenshot';
import { sendScreenshot, sendClip, sendGif, sendEmbed } from './discord';
import { RollingBuffer } from './clip';
import { Leaderboard } from './leaderboard';

const KICK_CHANNEL = process.env.KICK_CHANNEL!;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL!;
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL;
const TWITCH_OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN;
// Optional: separate webhooks for pics and gifs (fall back to main webhook if not set)
const DISCORD_WEBHOOK_PICS = process.env.DISCORD_WEBHOOK_PICS || DISCORD_WEBHOOK_URL;
const DISCORD_WEBHOOK_GIFS = process.env.DISCORD_WEBHOOK_GIFS || DISCORD_WEBHOOK_URL;
const DISCORD_WEBHOOK_CLIPS = process.env.DISCORD_WEBHOOK_CLIPS || DISCORD_WEBHOOK_URL;

if (!KICK_CHANNEL || !DISCORD_WEBHOOK_URL) {
  console.error('Missing required env vars: KICK_CHANNEL, DISCORD_WEBHOOK_URL');
  process.exit(1);
}

async function main() {
  const twitchEnabled = !!(TWITCH_CHANNEL && TWITCH_OAUTH_TOKEN);

  console.log('\n  ╭─────────────────────────────────────╮');
  console.log('  │   📸 Kick Screenshot Bot             │');
  console.log('  ╰─────────────────────────────────────╯\n');
  console.log(`  Kick   ·  ${KICK_CHANNEL}`);
  if (twitchEnabled) console.log(`  Twitch ·  ${TWITCH_CHANNEL}`);
  console.log(`  Webhooks · pics, gifs, clips → ${process.env.DISCORD_WEBHOOK_PICS ? 'dedicated' : 'main'}\n`);

  // Fetch stream info
  console.log(`\nFetching stream info for ${KICK_CHANNEL}...`);
  const streamInfo = await getStreamInfo(KICK_CHANNEL);

  if (!streamInfo.isLive || !streamInfo.playbackUrl) {
    console.error(`${KICK_CHANNEL} is not live. Start the bot when the channel is streaming.`);
    process.exit(1);
  }

  console.log(`Stream: ${streamInfo.title}`);
  console.log(`Viewers: ${streamInfo.viewerCount}`);
  console.log(`M3U8: ${streamInfo.playbackUrl.substring(0, 60)}...`);

  let m3u8Url = streamInfo.playbackUrl;

  const getFreshStreamUrl = async (): Promise<string> => {
    const info = await getStreamInfo(KICK_CHANNEL);
    if (!info.isLive || !info.playbackUrl) {
      throw new Error(`${KICK_CHANNEL} is not live`);
    }
    m3u8Url = info.playbackUrl;
    return m3u8Url;
  };

  // Start rolling buffer for clips
  const buffer = new RollingBuffer();
  console.log('\nStarting rolling buffer for !clip...');
  await buffer.start(m3u8Url);

  // Refresh stream URL every 5 min (Kick tokens expire)
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const refreshInterval = setInterval(async () => {
    try {
      const fresh = await getFreshStreamUrl();
      console.log('[Bot] Refreshing stream URL and buffer...');
      await buffer.stop();
      await buffer.start(fresh);
    } catch (e) {
      console.error('[Bot] Stream refresh failed:', e instanceof Error ? e.message : e);
    }
  }, REFRESH_INTERVAL_MS);

  // Leaderboard (persists to leaderboard.json)
  const leaderboard = new Leaderboard();
  await leaderboard.load();

  // Connect to Kick chat
  const chat = new KickChatListener(streamInfo.chatroomId);
  await chat.connect();

  // Connect to Twitch chat (optional)
  let twitchChat: TwitchChatListener | null = null;
  if (twitchEnabled) {
    twitchChat = new TwitchChatListener(TWITCH_CHANNEL!, TWITCH_OAUTH_TOKEN!);
    await twitchChat.connect();
  }

  const bindHandlers = (chatSource: KickChatListener | TwitchChatListener, senderSuffix: string, platform: 'kick' | 'twitch') => {
    chatSource.on('pic', async ({ sender }: { sender: string }) => {
      const displayName = sender + senderSuffix;
      leaderboard.increment(sender, 'pic');
      console.log(`[Bot] Taking screenshot (requested by ${displayName})...`);

      try {
        const url = await getFreshStreamUrl();
        const screenshot = await captureScreenshot(url);
        console.log(`[Bot] Screenshot captured (${(screenshot.length / 1024).toFixed(1)} KB)`);

        await sendScreenshot(DISCORD_WEBHOOK_PICS, screenshot, KICK_CHANNEL!, displayName, platform);
        console.log('[Bot] Screenshot sent to Discord!');
      } catch (error) {
        console.error('[Bot] Failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('clip', async ({ sender }: { sender: string }) => {
      const displayName = sender + senderSuffix;
      leaderboard.increment(sender, 'clip');
      console.log(`[Bot] Capturing 30s clip (requested by ${displayName})...`);

      try {
        const clip = await buffer.captureClip(30);
        console.log(`[Bot] Clip captured (${(clip.length / 1024 / 1024).toFixed(1)} MB)`);

        await sendClip(DISCORD_WEBHOOK_CLIPS, clip, KICK_CHANNEL!, displayName, platform);
        console.log('[Bot] Clip sent to Discord!');
      } catch (error) {
        console.error('[Bot] Clip failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('gif', async ({ sender }: { sender: string }) => {
      const displayName = sender + senderSuffix;
      leaderboard.increment(sender, 'gif');
      console.log(`[Bot] Capturing 5s GIF (requested by ${displayName})...`);

      try {
        const gif = await buffer.captureGif(5);
        console.log(`[Bot] GIF captured (${(gif.length / 1024).toFixed(1)} KB)`);

        await sendGif(DISCORD_WEBHOOK_GIFS, gif, KICK_CHANNEL!, displayName, platform);
        console.log('[Bot] GIF sent to Discord!');
      } catch (error) {
        console.error('[Bot] GIF failed:', error instanceof Error ? error.message : error);
      }
    });

    chatSource.on('stats', async ({ sender }: { sender: string }) => {
      const displayName = sender + senderSuffix;
      console.log(`[Bot] Sending leaderboard (requested by ${displayName})...`);
      try {
        const embed = leaderboard.buildEmbed(KICK_CHANNEL, displayName);
        await sendEmbed(DISCORD_WEBHOOK_URL, embed);
        console.log('[Bot] Leaderboard sent to Discord!');
      } catch (error) {
        console.error('[Bot] Leaderboard failed:', error instanceof Error ? error.message : error);
      }
    });
  };

  bindHandlers(chat, '', 'kick');
  if (twitchChat) bindHandlers(twitchChat, ' (Twitch)', 'twitch');

  const chatSources = twitchEnabled ? 'Kick + Twitch' : 'Kick';
  console.log('  ╭──────────────────────────────────────╮');
  console.log(`  │  ✓ Running · ${chatSources.padEnd(22)}│`);
  console.log('  │  !pic  !clip  !gif  !stats            │');
  console.log('  ╰──────────────────────────────────────╯\n');

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    clearInterval(refreshInterval);
    chat.disconnect();
    twitchChat?.disconnect();
    buffer.stop();
    leaderboard.save().catch(() => {}).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
