import { execFile } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

export async function captureScreenshot(m3u8Url: string): Promise<Buffer> {
  const tmpFile = join(tmpdir(), `kick-screenshot-${randomBytes(4).toString('hex')}.jpg`);

  return new Promise((resolve, reject) => {
    // Use ffmpeg to grab a single frame from the HLS stream (reduced probesize for faster connect)
    execFile('ffmpeg', [
      '-y',
      '-probesize', '32768',
      '-analyzeduration', '500000',
      '-i', m3u8Url,
      '-frames:v', '1',
      '-q:v', '2',
      tmpFile,
    ], { timeout: 30000 }, async (error) => {
      if (error) {
        reject(new Error(`FFmpeg failed: ${error.message}`));
        return;
      }

      try {
        const buffer = await readFile(tmpFile);
        await unlink(tmpFile).catch(() => {});
        resolve(buffer);
      } catch (readError) {
        reject(new Error(`Failed to read screenshot: ${readError}`));
      }
    });
  });
}
