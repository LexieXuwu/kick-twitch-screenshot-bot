import { spawn, execFile, ChildProcess } from 'child_process';
import { readFile, unlink, mkdir, readdir, stat, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

/** Returns a fresh HLS playback URL (Kick's URLs carry a token that expires). */
export type StreamUrlProvider = () => Promise<string>;

const INITIAL_SEGMENT_WAIT_MS = 25000;
const RESTART_DELAY_MS = 5000;
const RESTART_RETRY_DELAY_MS = 30000;
const RESTART_MAX_DELAY_MS = 60000;

export class RollingBuffer {
  private ffmpeg: ChildProcess | null = null;
  private bufferDir: string;
  private segmentDuration = 10;
  private segmentWrap = 5; // 5 x 10s = 50s window, gives comfortable 30s margin
  private capturing = false;
  private running = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private quickFailures = 0;
  private getUrl: StreamUrlProvider;

  constructor(getUrl: StreamUrlProvider) {
    this.getUrl = getUrl;
    this.bufferDir = join(tmpdir(), `kick-buffer-${randomBytes(4).toString('hex')}`);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start recording. Resolves once the first segment has been written (or after a grace period). */
  async start(m3u8Url?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    await rm(this.bufferDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(this.bufferDir, { recursive: true });

    const url = m3u8Url ?? (await this.getUrl());
    this.spawnFfmpeg(url);

    console.log('[Buffer] Waiting for initial segments...');
    const deadline = Date.now() + INITIAL_SEGMENT_WAIT_MS;
    while (Date.now() < deadline && this.running) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const segs = await this.listSegments().catch(() => []);
      // The newest segment is still being written; we need at least one completed one.
      if (segs.length >= 2) break;
    }
    if (this.running) console.log('[Buffer] Rolling buffer active');
  }

  private spawnFfmpeg(m3u8Url: string): void {
    const proc = spawn('ffmpeg', [
      '-nostdin',
      '-loglevel', 'error',
      '-i', m3u8Url,
      '-f', 'segment',
      '-segment_time', String(this.segmentDuration),
      '-segment_wrap', String(this.segmentWrap),
      '-reset_timestamps', '1',
      '-c', 'copy',
      // Kick's HLS only carries SPS/PPS every couple of seconds; repeat them at every
      // keyframe so each segment decodes cleanly from its first frame.
      '-bsf:v', 'dump_extra=freq=keyframe',
      '-map', '0',
      join(this.bufferDir, 'seg%03d.ts'),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.ffmpeg = proc;

    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[Buffer] ${msg}`);
    });

    proc.on('error', (err) => {
      console.error('[Buffer] FFmpeg error:', err.message);
    });

    const startedAt = Date.now();
    proc.on('exit', (code, signal) => {
      if (this.ffmpeg !== proc) return;
      this.ffmpeg = null;
      if (!this.running) return;
      // Back off when FFmpeg keeps dying right away (e.g. stream ended, playlist 404s).
      if (Date.now() - startedAt < 15000) this.quickFailures += 1;
      else this.quickFailures = 0;
      const delay = Math.min(RESTART_DELAY_MS * 2 ** Math.min(this.quickFailures, 4), RESTART_MAX_DELAY_MS);
      console.error(`[Buffer] FFmpeg stopped (code ${code ?? signal}); restarting in ${Math.round(delay / 1000)}s...`);
      this.scheduleRestart(delay);
    });
  }

  private scheduleRestart(delayMs: number): void {
    if (this.restartTimer || !this.running) return;
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (!this.running) return;
      try {
        const url = await this.getUrl();
        if (!this.running) return;
        console.log('[Buffer] Restarting FFmpeg with a fresh stream URL');
        this.spawnFfmpeg(url);
      } catch (e) {
        console.error('[Buffer] Could not get a stream URL:', e instanceof Error ? e.message : e);
        this.scheduleRestart(RESTART_RETRY_DELAY_MS);
      }
    }, delayMs);
  }

  private async listSegments(): Promise<{ name: string; mtime: number; size: number }[]> {
    const files = await readdir(this.bufferDir);
    const segFiles = files.filter((f) => /^seg\d+\.ts$/.test(f));
    const withStats = await Promise.all(
      segFiles.map(async (f) => {
        const s = await stat(join(this.bufferDir, f));
        return { name: f, mtime: s.mtimeMs, size: s.size };
      }),
    );
    // Oldest first. With segment_wrap the filenames cycle, so mtime is the real order.
    withStats.sort((a, b) => a.mtime - b.mtime);
    return withStats;
  }

  /** Pick the completed segments covering the requested duration and write a concat list. */
  private async prepareConcat(durationSeconds: number, listName: string): Promise<string> {
    if (!this.running || !this.ffmpeg) {
      throw new Error('Buffer is not recording right now (stream offline?)');
    }
    const segments = await this.listSegments();
    if (segments.length < 2) {
      throw new Error('Not enough buffer segments yet, please wait a bit longer');
    }

    // Skip the most recent segment (still being written)
    const completed = segments.slice(0, -1).filter((s) => s.size > 0);
    if (completed.length === 0) {
      throw new Error('Not enough completed segments yet');
    }

    const segmentsNeeded = Math.ceil(durationSeconds / this.segmentDuration);
    const selected = completed.slice(-segmentsNeeded);

    const concatFile = join(this.bufferDir, listName);
    const concatContent = selected
      .map((s) => `file '${join(this.bufferDir, s.name).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    await writeFile(concatFile, concatContent);
    return concatFile;
  }

  private async runCapture(durationSeconds: number, listName: string, outputName: string, args: string[], label: string): Promise<Buffer> {
    if (this.capturing) {
      throw new Error('A capture is already in progress, please wait');
    }
    this.capturing = true;
    let concatFile: string;
    try {
      concatFile = await this.prepareConcat(durationSeconds, listName);
    } catch (e) {
      this.capturing = false;
      throw e;
    }

    const outputFile = join(this.bufferDir, outputName);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('ffmpeg', [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFile,
          '-t', String(durationSeconds),
          ...args,
          outputFile,
        ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error) => {
          if (error) reject(new Error(`FFmpeg ${label} failed: ${error.message}`));
          else resolve();
        });
      });

      const buffer = await readFile(outputFile);
      return buffer;
    } finally {
      this.capturing = false;
      await unlink(outputFile).catch(() => {});
      await unlink(concatFile).catch(() => {});
    }
  }

  /** Last N seconds as a 1080p MP4 (re-encoded for Discord's size limits). */
  captureClip(durationSeconds: number = 30): Promise<Buffer> {
    return this.runCapture(durationSeconds, 'concat.txt', `clip-${Date.now()}.mp4`, [
      '-vf', 'scale=-2:1080',
      '-c:v', 'libx264',
      '-b:v', '4000k',
      '-maxrate', '5000k',
      '-bufsize', '6000k',
      '-preset', 'fast',
      '-threads', '0',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
    ], 'clip');
  }

  /** Last N seconds as a 720p GIF. */
  captureGif(durationSeconds: number = 5): Promise<Buffer> {
    return this.runCapture(durationSeconds, 'concat-gif.txt', `gif-${Date.now()}.gif`, [
      '-threads', '0',
      '-vf', 'fps=12,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=dither=sierra2_4a',
      '-loop', '0',
    ], 'GIF');
  }

  captureEmojiGif(durationSeconds: number = 2.5): Promise<Buffer> {
    return this.captureResizedGif(durationSeconds, 500, 8);
  }

  captureStickerGif(durationSeconds: number = 2.5): Promise<Buffer> {
    return this.captureResizedGif(durationSeconds, 320, 10);
  }

  private captureResizedGif(durationSeconds: number, size: number, fps: number): Promise<Buffer> {
    const scaleFilter = `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`;
    const paletteFilter = `fps=${fps},${scaleFilter},split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=dither=sierra2_4a`;
    return this.runCapture(durationSeconds, `concat-resized-${size}.txt`, `resized-${size}-${Date.now()}.gif`, [
      '-threads', '0',
      '-vf', paletteFilter,
      '-loop', '0',
    ], 'resized GIF');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.ffmpeg;
    this.ffmpeg = null;
    if (proc) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        try { proc.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
      });
    }
    await rm(this.bufferDir, { recursive: true, force: true }).catch(() => {});
  }
}
