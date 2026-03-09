import { execFile } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const EMOJI_SIZE = 128;
const EMOJI_MAX_KB = 256;
const STICKER_SIZE = 320;
const STICKER_MAX_KB = 512;

/** Capture a single frame resized to square (center crop). */
async function captureFrameResized(
  m3u8Url: string,
  size: number,
  format: 'png' | 'jpg',
): Promise<Buffer> {
  const ext = format === 'png' ? 'png' : 'jpg';
  const tmpFile = join(tmpdir(), `kick-emoji-${randomBytes(4).toString('hex')}.${ext}`);

  const scaleFilter = `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`;
  const args = [
    '-y',
    '-probesize', '32768',
    '-analyzeduration', '500000',
    '-i', m3u8Url,
    '-frames:v', '1',
    '-vf', scaleFilter,
  ];

  if (format === 'png') {
    args.push('-compression_level', '9');
  } else {
    args.push('-q:v', '2');
  }
  args.push(tmpFile);

  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 30000 }, async (error) => {
      if (error) {
        reject(new Error(`FFmpeg failed: ${error.message}`));
        return;
      }

      try {
        const buffer = await readFile(tmpFile);
        await unlink(tmpFile).catch(() => {});
        resolve(buffer);
      } catch (readError) {
        reject(new Error(`Failed to read output: ${readError}`));
      }
    });
  });
}

/** Capture emoji-sized static frame (128x128 PNG, target <256KB). */
export async function captureEmojiStatic(m3u8Url: string): Promise<Buffer> {
  let buffer = await captureFrameResized(m3u8Url, EMOJI_SIZE, 'png');
  if (buffer.length <= EMOJI_MAX_KB * 1024) {
    return buffer;
  }
  // Fallback: try 96x96 if over limit
  buffer = await captureFrameResized(m3u8Url, 96, 'png');
  return buffer;
}

/** Capture sticker-sized static frame (320x320 PNG, target <512KB). */
export async function captureStickerStatic(m3u8Url: string): Promise<Buffer> {
  const buffer = await captureFrameResized(m3u8Url, STICKER_SIZE, 'png');
  return buffer;
}
