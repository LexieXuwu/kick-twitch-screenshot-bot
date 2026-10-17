import axios from 'axios';
import { getStreamInfo } from './kick/stream';

/** Discord embed (for rich messages). */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  author?: { name: string; icon_url?: string; url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
}

export type Source = 'kick' | 'twitch';

/** Brand accent per chat source. */
export const SOURCE_COLOR: Record<Source, number> = {
  kick: 0x53fc18,   // Kick green
  twitch: 0x9146ff, // Twitch purple
};

const SOURCE_ICON: Record<Source, string> = {
  kick: 'https://kick.com/favicon.ico',
  twitch: 'https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png',
};

const SOURCE_LABEL: Record<Source, string> = { kick: 'Kick', twitch: 'Twitch' };

// ───────────────────────── channel avatar (cached) ─────────────────────────

const AVATAR_TTL_MS = 60 * 60 * 1000;
const avatarCache = new Map<string, { url: string | null; at: number }>();

/** The channel's Kick profile picture, cached for an hour. Falls back to the Kick logo. */
export async function getChannelIcon(channelName: string): Promise<string> {
  const key = channelName.toLowerCase();
  const cached = avatarCache.get(key);
  if (cached && Date.now() - cached.at < AVATAR_TTL_MS) {
    return cached.url ?? SOURCE_ICON.kick;
  }
  let url: string | null = null;
  try {
    url = (await getStreamInfo(channelName)).avatarUrl;
  } catch {
    url = null;
  }
  avatarCache.set(key, { url, at: Date.now() });
  return url ?? SOURCE_ICON.kick;
}

// ───────────────────────────── embed building ─────────────────────────────

interface CaptureEmbedOptions {
  channelName: string;
  requestedBy: string;
  source: Source;
  title: string;
  description?: string;
  /** Filename of the attached image to show inside the embed (omit for video). */
  imageFilename?: string;
}

/**
 * One consistent card for every capture:
 *   avatar + channel name (links to the Kick channel)
 *   short title
 *   the image (when there is one)
 *   footer: who asked, with the icon of the chat they asked from
 */
async function buildCaptureEmbed(opts: CaptureEmbedOptions): Promise<DiscordEmbed> {
  const icon = await getChannelIcon(opts.channelName);
  const embed: DiscordEmbed = {
    author: {
      name: opts.channelName,
      url: `https://kick.com/${encodeURIComponent(opts.channelName.toLowerCase())}`,
      icon_url: icon,
    },
    title: opts.title,
    color: SOURCE_COLOR[opts.source],
    footer: {
      text: `Requested by ${opts.requestedBy} · ${SOURCE_LABEL[opts.source]} chat`,
      icon_url: SOURCE_ICON[opts.source],
    },
    timestamp: new Date().toISOString(),
  };
  if (opts.description) embed.description = opts.description;
  if (opts.imageFilename) embed.image = { url: `attachment://${opts.imageFilename}` };
  return embed;
}

/** Build multipart webhook body: one embed + one file (filename must match embed image url if used). */
function buildPayloadWithEmbed(
  embed: DiscordEmbed,
  fileBuffer: Buffer,
  filename: string,
  contentType: string,
): { boundary: string; body: Buffer } {
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
  const payload = { embeds: [embed] };
  const parts: Buffer[] = [];

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="payload_json"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(payload) + '\r\n'
  ));
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="files[0]"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { boundary, body: Buffer.concat(parts) };
}

async function postWithFile(
  webhookUrl: string,
  embed: DiscordEmbed,
  fileBuffer: Buffer,
  filename: string,
  contentType: string,
  timeout: number,
): Promise<void> {
  const { boundary, body } = buildPayloadWithEmbed(embed, fileBuffer, filename, contentType);
  await axios.post(webhookUrl, body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout,
  });
}

// ───────────────────────────── public senders ─────────────────────────────

export async function sendClip(
  webhookUrl: string,
  videoBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: Source = 'kick',
): Promise<void> {
  const filename = `clip-${Date.now()}.mp4`;
  // Discord shows the video player for the attachment itself; the embed is just the caption.
  const embed = await buildCaptureEmbed({
    channelName, requestedBy, source,
    title: '🎬 30-second clip',
  });
  await postWithFile(webhookUrl, embed, videoBuffer, filename, 'video/mp4', 60000);
}

export async function sendScreenshot(
  webhookUrl: string,
  imageBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: Source = 'kick',
): Promise<void> {
  const filename = `screenshot-${Date.now()}.jpg`;
  const embed = await buildCaptureEmbed({
    channelName, requestedBy, source,
    title: '📸 Screenshot',
    imageFilename: filename,
  });
  await postWithFile(webhookUrl, embed, imageBuffer, filename, 'image/jpeg', 15000);
}

export async function sendGif(
  webhookUrl: string,
  gifBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: Source = 'kick',
): Promise<void> {
  const filename = `gif-${Date.now()}.gif`;
  const embed = await buildCaptureEmbed({
    channelName, requestedBy, source,
    title: '🎞️ 5-second GIF',
    imageFilename: filename,
  });
  await postWithFile(webhookUrl, embed, gifBuffer, filename, 'image/gif', 30000);
}

export async function sendEmoji(
  webhookUrl: string,
  imageBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: Source = 'kick',
  isAnimated: boolean = false,
): Promise<void> {
  const ext = isAnimated ? 'gif' : 'png';
  const filename = `emoji-${Date.now()}.${ext}`;
  const embed = await buildCaptureEmbed({
    channelName, requestedBy, source,
    title: isAnimated ? '😀 Animated emoji · 500×500' : '😀 Emoji · 500×500',
    description: 'Right-click the image → **Save image**, then upload it in Server Settings → Emoji.',
    imageFilename: filename,
  });
  await postWithFile(webhookUrl, embed, imageBuffer, filename, isAnimated ? 'image/gif' : 'image/png', 15000);
}

export async function sendSticker(
  webhookUrl: string,
  imageBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: Source = 'kick',
  isAnimated: boolean = false,
): Promise<void> {
  const ext = isAnimated ? 'gif' : 'png';
  const filename = `sticker-${Date.now()}.${ext}`;
  const embed = await buildCaptureEmbed({
    channelName, requestedBy, source,
    title: isAnimated ? '🏷️ Animated sticker · 320×320' : '🏷️ Sticker · 320×320',
    description: 'Right-click the image → **Save image**, then upload it in Server Settings → Stickers.',
    imageFilename: filename,
  });
  await postWithFile(webhookUrl, embed, imageBuffer, filename, isAnimated ? 'image/gif' : 'image/png', 15000);
}
