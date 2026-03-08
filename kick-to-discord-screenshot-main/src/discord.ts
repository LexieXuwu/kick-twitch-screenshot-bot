import axios from 'axios';
import FormData from 'form-data';

/** Discord embed (for rich messages). */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  author?: { name: string; icon_url?: string; url?: string };
  image?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
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

/** Send a text-only message to a Discord webhook. */
export async function sendMessage(webhookUrl: string, content: string): Promise<void> {
  await axios.post(webhookUrl, { content }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

/** Send a rich embed to a Discord webhook (nicer leaderboard UI). */
export async function sendEmbed(webhookUrl: string, embed: DiscordEmbed): Promise<void> {
  await axios.post(webhookUrl, { embeds: [embed] }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

export async function sendClip(
  webhookUrl: string,
  videoBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: 'kick' | 'twitch' = 'kick',
): Promise<void> {
  const filename = `clip-${Date.now()}.mp4`;
  const color = source === 'twitch' ? 0x9146ff : 0x22c55e; // purple for Twitch, green for Kick
  const embed: DiscordEmbed = {
    author: { name: `${channelName}`, icon_url: 'https://kick.com/favicon.ico' },
    title: '🎬 30-Second Highlight',
    description: [
      '> *A moment worth saving from the stream*',
      '',
      '```',
      `  Channel  ·  ${channelName}`,
      `  Request  ·  ${requestedBy}`,
      '```',
    ].join('\n'),
    color,
    footer: { text: `Requested by ${requestedBy}` },
    timestamp: new Date().toISOString(),
  };
  const { boundary, body } = buildPayloadWithEmbed(embed, videoBuffer, filename, 'video/mp4');

  await axios.post(webhookUrl, body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeout: 30000,
  });
}

export async function sendScreenshot(
  webhookUrl: string,
  imageBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: 'kick' | 'twitch' = 'kick',
): Promise<void> {
  const filename = `screenshot-${Date.now()}.jpg`;
  const color = source === 'twitch' ? 0x9146ff : 0x22c55e; // purple for Twitch, green for Kick
  const embed: DiscordEmbed = {
    author: { name: `${channelName}`, icon_url: 'https://kick.com/favicon.ico' },
    title: '📸 Frame Captured',
    description: [
      '> *A moment frozen in time from the stream*',
      '',
      '```',
      `  Channel  ·  ${channelName}`,
      `  Request  ·  ${requestedBy}`,
      '```',
    ].join('\n'),
    color,
    image: { url: `attachment://${filename}` },
    footer: { text: `Requested by ${requestedBy}` },
    timestamp: new Date().toISOString(),
  };
  const { boundary, body } = buildPayloadWithEmbed(embed, imageBuffer, filename, 'image/jpeg');

  await axios.post(webhookUrl, body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeout: 15000,
  });
}

export async function sendGif(
  webhookUrl: string,
  gifBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: 'kick' | 'twitch' = 'kick',
): Promise<void> {
  const filename = `gif-${Date.now()}.gif`;
  const color = source === 'twitch' ? 0x9146ff : 0x22c55e; // purple for Twitch, green for Kick
  const embed: DiscordEmbed = {
    author: { name: `${channelName}`, icon_url: 'https://kick.com/favicon.ico' },
    title: '🎞️ 5-Second Loop',
    description: [
      '> *A looping moment from the stream*',
      '',
      '```',
      `  Channel  ·  ${channelName}`,
      `  Request  ·  ${requestedBy}`,
      '```',
    ].join('\n'),
    color,
    image: { url: `attachment://${filename}` },
    footer: { text: `Requested by ${requestedBy}` },
    timestamp: new Date().toISOString(),
  };
  const { boundary, body } = buildPayloadWithEmbed(embed, gifBuffer, filename, 'image/gif');

  await axios.post(webhookUrl, body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeout: 30000,
  });
}

export async function sendEmoji(
  webhookUrl: string,
  imageBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: 'kick' | 'twitch' = 'kick',
  isAnimated: boolean = false,
): Promise<void> {
  const ext = isAnimated ? 'gif' : 'png';
  const filename = `emoji-${Date.now()}.${ext}`;
  const contentType = isAnimated ? 'image/gif' : 'image/png';
  const color = source === 'twitch' ? 0x9146ff : 0x22c55e;
  const embed: DiscordEmbed = {
    author: { name: `${channelName}`, icon_url: 'https://kick.com/favicon.ico' },
    title: isAnimated ? '😀 Emoji Preview (128x128, animated)' : '😀 Emoji Preview (128x128)',
    description: [
      '> *Right-click and save to upload as Discord emoji*',
      '',
      '```',
      `  Channel  ·  ${channelName}`,
      `  Request  ·  ${requestedBy}`,
      '```',
    ].join('\n'),
    color,
    image: { url: `attachment://${filename}` },
    footer: { text: `Requested by ${requestedBy}` },
    timestamp: new Date().toISOString(),
  };
  const { boundary, body } = buildPayloadWithEmbed(embed, imageBuffer, filename, contentType);

  await axios.post(webhookUrl, body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeout: 15000,
  });
}

export async function sendSticker(
  webhookUrl: string,
  imageBuffer: Buffer,
  channelName: string,
  requestedBy: string,
  source: 'kick' | 'twitch' = 'kick',
  isAnimated: boolean = false,
): Promise<void> {
  const ext = isAnimated ? 'gif' : 'png';
  const filename = `sticker-${Date.now()}.${ext}`;
  const contentType = isAnimated ? 'image/gif' : 'image/png';
  const color = source === 'twitch' ? 0x9146ff : 0x22c55e;
  const embed: DiscordEmbed = {
    author: { name: `${channelName}`, icon_url: 'https://kick.com/favicon.ico' },
    title: isAnimated ? '🏷️ Sticker Preview (320x320, animated)' : '🏷️ Sticker Preview (320x320)',
    description: [
      '> *Right-click and save to upload as Discord sticker*',
      '',
      '```',
      `  Channel  ·  ${channelName}`,
      `  Request  ·  ${requestedBy}`,
      '```',
    ].join('\n'),
    color,
    image: { url: `attachment://${filename}` },
    footer: { text: `Requested by ${requestedBy}` },
    timestamp: new Date().toISOString(),
  };
  const { boundary, body } = buildPayloadWithEmbed(embed, imageBuffer, filename, contentType);

  await axios.post(webhookUrl, body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeout: 15000,
  });
}
