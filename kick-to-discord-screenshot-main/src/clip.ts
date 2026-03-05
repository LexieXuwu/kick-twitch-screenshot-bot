import { spawn, execFile, ChildProcess } from 'child_process';
import { readFile, unlink, mkdir, readdir, stat, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

export class RollingBuffer {
  private ffmpeg: ChildProcess | null = null;
  private bufferDir: string;
  private segmentDuration = 10;
  private segmentWrap = 5; // 5 x 10s = 50s window, gives comfortable 30s margin
  private capturing = false;

  constructor() {
    this.bufferDir = join(tmpdir(), `kick-buffer-${randomBytes(4).toString('hex')}`);
  }

  async start(m3u8Url: string): Promise<void> {
    await mkdir(this.bufferDir, { recursive: true });

    this.ffmpeg = spawn('ffmpeg', [
      '-nostdin',
      '-loglevel', 'error',
      '-i', m3u8Url,
      '-f', 'segment',
      '-segment_time', String(this.segmentDuration),
      '-segment_wrap', String(this.segmentWrap),
      '-reset_timestamps', '1',
      '-c', 'copy',
      '-map', '0',
      join(this.bufferDir, 'seg%03d.ts'),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    this.ffmpeg.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[Buffer] ${msg}`);
    });

    this.ffmpeg.on('error', (err) => {
      console.error('[Buffer] FFmpeg error:', err.message);
    });

    this.ffmpeg.on('exit', (code) => {
      if (code !== null && code !== 0 && code !== 255) {
        console.error(`[Buffer] FFmpeg exited with code ${code}`);
      }
    });

    // Wait for at least one segment to be written
    console.log('[Buffer] Waiting for initial segments...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    console.log('[Buffer] Rolling buffer active');
  }

  async captureClip(durationSeconds: number = 30): Promise<Buffer> {
    if (this.capturing) {
      throw new Error('A clip is already being captured, please wait');
    }

    this.capturing = true;
    try {
      return await this._doCapture(durationSeconds);
    } finally {
      this.capturing = false;
    }
  }

  private async _doCapture(durationSeconds: number): Promise<Buffer> {
    const files = await readdir(this.bufferDir);
    const segFiles = files.filter(f => f.endsWith('.ts'));

    if (segFiles.length < 2) {
      throw new Error('Not enough buffer segments yet, please wait a bit longer');
    }

    // Get file stats to determine order
    const withStats = await Promise.all(
      segFiles.map(async (f) => {
        const s = await stat(join(this.bufferDir, f));
        return { name: f, mtime: s.mtimeMs, size: s.size };
      })
    );

    // Sort by mtime ascending (oldest first)
    withStats.sort((a, b) => a.mtime - b.mtime);

    // Skip the most recent segment (likely still being written)
    const completed = withStats.slice(0, -1);
    if (completed.length === 0) {
      throw new Error('Not enough completed segments yet');
    }

    // Take the last N segments to cover requested duration
    const segmentsNeeded = Math.ceil(durationSeconds / this.segmentDuration);
    const selected = completed.slice(-segmentsNeeded);

    // Create ffmpeg concat list
    const concatFile = join(this.bufferDir, 'concat.txt');
    const concatContent = selected
      .map(s => `file '${join(this.bufferDir, s.name)}'`)
      .join('\n');
    await writeFile(concatFile, concatContent);

    const outputFile = join(this.bufferDir, `clip-${Date.now()}.mp4`);

    // Re-encode to ensure Discord-friendly size (<25MB)
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-t', String(durationSeconds),
        '-vf', 'scale=-2:720',
        '-c:v', 'libx264',
        '-b:v', '1500k',
        '-maxrate', '2000k',
        '-bufsize', '3000k',
        '-preset', 'fast',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        outputFile,
      ], { timeout: 120000 }, (error) => {
        if (error) reject(new Error(`FFmpeg clip failed: ${error.message}`));
        else resolve();
      });
    });

    const buffer = await readFile(outputFile);
    await unlink(outputFile).catch(() => {});
    await unlink(concatFile).catch(() => {});

    return buffer;
  }

  async captureGif(durationSeconds: number = 5): Promise<Buffer> {
    if (this.capturing) {
      throw new Error('A clip is already being captured, please wait');
    }

    this.capturing = true;
    try {
      return await this._doCaptureGif(durationSeconds);
    } finally {
      this.capturing = false;
    }
  }

  private async _doCaptureGif(durationSeconds: number): Promise<Buffer> {
    const files = await readdir(this.bufferDir);
    const segFiles = files.filter(f => f.endsWith('.ts'));

    if (segFiles.length < 2) {
      throw new Error('Not enough buffer segments yet, please wait a bit longer');
    }

    // Get file stats to determine order
    const withStats = await Promise.all(
      segFiles.map(async (f) => {
        const s = await stat(join(this.bufferDir, f));
        return { name: f, mtime: s.mtimeMs, size: s.size };
      })
    );

    // Sort by mtime ascending (oldest first)
    withStats.sort((a, b) => a.mtime - b.mtime);

    // Skip the most recent segment (likely still being written)
    const completed = withStats.slice(0, -1);
    if (completed.length === 0) {
      throw new Error('Not enough completed segments yet');
    }

    // Take the last N segments to cover requested duration
    const segmentsNeeded = Math.ceil(durationSeconds / this.segmentDuration);
    const selected = completed.slice(-segmentsNeeded);

    // Create ffmpeg concat list
    const concatFile = join(this.bufferDir, 'concat-gif.txt');
    const concatContent = selected
      .map(s => `file '${join(this.bufferDir, s.name)}'`)
      .join('\n');
    await writeFile(concatFile, concatContent);

    const outputFile = join(this.bufferDir, `gif-${Date.now()}.gif`);

    // Convert to GIF with optimization
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-t', String(durationSeconds),
        '-vf', 'fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
        '-loop', '0',
        outputFile,
      ], { timeout: 120000 }, (error) => {
        if (error) reject(new Error(`FFmpeg GIF failed: ${error.message}`));
        else resolve();
      });
    });

    const buffer = await readFile(outputFile);
    await unlink(outputFile).catch(() => {});
    await unlink(concatFile).catch(() => {});

    return buffer;
  }

  async stop(): Promise<void> {
    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }
    await rm(this.bufferDir, { recursive: true, force: true }).catch(() => {});
  }
}
