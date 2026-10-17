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
/** An FFmpeg process that dies sooner than this counts as a quick failure (triggers back-off). */
const QUICK_FAILURE_MS = 15000;
/** A restarted FFmpeg that survives this long is considered healthy again. */
const RESTART_HEALTHY_MS = 15000;
/** How many captures may wait in line behind the one that is running. */
const MAX_QUEUED_CAPTURES = 3;

export class RollingBuffer {
  private ffmpeg: ChildProcess | null = null;
  private bufferDir: string;
  private segmentDuration = 10;
  private segmentWrap = 5; // 5 x 10s = 50s window, gives comfortable 30s margin
  private running = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private quickFailures = 0;
  private getUrl: StreamUrlProvider;
  /** Captures run one at a time in arrival order; each new one is chained onto this promise. */
  private captureChain: Promise<void> = Promise.resolve();
  /** Captures accepted but not finished yet (the running one plus those waiting). */
  private capturesPending = 0;

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
    let ready = false;
    while (Date.now() < deadline && this.running) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const segs = await this.listSegments().catch(() => []);
      // The newest segment is still being written; we need at least one completed one.
      if (segs.length >= 2) {
        ready = true;
        break;
      }
    }
    if (!this.running) return;
    console.log(ready
      ? '[Buffer] Rolling buffer active'
      : '[Buffer] No video received yet; the buffer keeps trying in the background');
  }

  private spawnFfmpeg(m3u8Url: string, isRestart = false): void {
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

    // When the stream has ended, FFmpeg repeats the (very long, token-carrying) playlist URL
    // and the HTTP status across several lines. Fold all of that into one short summary and
    // pass every other error line through unchanged.
    let playlistFailed = false;
    let playlistStatus: string | null = null;
    let playlistReported = false;
    let summaryTimer: NodeJS.Timeout | null = null;
    let pendingLine = '';

    const reportPlaylistFailure = () => {
      if (summaryTimer) {
        clearTimeout(summaryTimer);
        summaryTimer = null;
      }
      if (!playlistFailed || playlistReported) return;
      playlistReported = true;
      console.error(`[Buffer] Stream playlist not reachable${playlistStatus ? ` (${playlistStatus})` : ''}`);
    };

    const handleLine = (line: string) => {
      if (!line) return;
      const status = line.match(/(?:Server returned|HTTP error) (\d{3})/)?.[1] ?? null;
      const isPlaylistError =
        status !== null ||
        line.includes(m3u8Url) ||
        /[?&]token=/.test(line) ||
        /Error opening input/i.test(line) ||
        /Failed to reload playlist/i.test(line);
      if (!isPlaylistError) {
        console.error(`[Buffer] ${line}`);
        return;
      }
      playlistFailed = true;
      if (status && !playlistStatus) playlistStatus = status;
      // FFmpeg prints the status on a separate line from the URL; wait a moment so the
      // summary can include it.
      if (!playlistReported && !summaryTimer) summaryTimer = setTimeout(reportPlaylistFailure, 300);
    };

    proc.stderr?.on('data', (data: Buffer) => {
      pendingLine += data.toString();
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) handleLine(line.trim());
    });

    proc.on('error', (err) => {
      console.error('[Buffer] FFmpeg error:', err.message);
    });

    // After a restart, say so once the new process has clearly settled in.
    let healthyTimer: NodeJS.Timeout | null = null;
    if (isRestart) {
      healthyTimer = setTimeout(() => {
        healthyTimer = null;
        if (this.ffmpeg === proc && this.running && !playlistFailed) {
          this.quickFailures = 0;
          console.log('[Buffer] Rolling buffer is back');
        }
      }, RESTART_HEALTHY_MS);
    }

    const startedAt = Date.now();
    let closeHandled = false;
    // 'close' (not 'exit') so that every stderr line has been read before we report the stop.
    proc.on('close', (code, signal) => {
      if (closeHandled) return;
      closeHandled = true;
      if (healthyTimer) {
        clearTimeout(healthyTimer);
        healthyTimer = null;
      }
      handleLine(pendingLine.trim());
      pendingLine = '';
      reportPlaylistFailure();

      if (this.ffmpeg !== proc) return; // stopped on purpose (stop() or replaced)
      this.ffmpeg = null;
      if (!this.running) return;

      // Back off when FFmpeg keeps dying right away or the playlist is gone (stream ended).
      const diedQuickly = Date.now() - startedAt < QUICK_FAILURE_MS;
      if (diedQuickly || playlistFailed) this.quickFailures += 1;
      else this.quickFailures = 0;
      const delay = Math.min(RESTART_DELAY_MS * 2 ** Math.min(this.quickFailures, 4), RESTART_MAX_DELAY_MS);
      const reason = playlistFailed ? 'stream appears to have ended' : `code ${code ?? signal}`;
      console.error(`[Buffer] FFmpeg stopped (${reason}); restarting in ${Math.round(delay / 1000)}s...`);
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
        this.spawnFfmpeg(url, true);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.error(`[Buffer] Could not get a stream URL (${why}); trying again in ${Math.round(RESTART_RETRY_DELAY_MS / 1000)}s...`);
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

  /**
   * Queue a capture. Captures run one at a time in arrival order, so a !clip typed right
   * after a !gif waits its turn instead of being dropped. At most MAX_QUEUED_CAPTURES may wait.
   */
  private runCapture(durationSeconds: number, listName: string, outputName: string, args: string[], label: string): Promise<Buffer> {
    // One running + MAX_QUEUED_CAPTURES waiting is the most we accept.
    if (this.capturesPending > MAX_QUEUED_CAPTURES) {
      return Promise.reject(new Error(`Too many captures waiting (${MAX_QUEUED_CAPTURES} already in line), please try again in a moment`));
    }
    const ahead = this.capturesPending;
    if (ahead > 0) console.log(`[Buffer] ${label} capture queued (${ahead} ahead)`);
    this.capturesPending += 1;

    const result = this.captureChain.then(async () => {
      try {
        return await this.doCapture(durationSeconds, listName, outputName, args, label);
      } finally {
        this.capturesPending -= 1;
      }
    });
    // A failed capture must not block the ones behind it.
    this.captureChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async doCapture(durationSeconds: number, listName: string, outputName: string, args: string[], label: string): Promise<Buffer> {
    const concatFile = await this.prepareConcat(durationSeconds, listName);
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
        ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
          if (!error) {
            resolve();
            return;
          }
          // Keep the log short: FFmpeg's last error line says what went wrong, the rest is its banner.
          const lastLine = String(stderr ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
          const reason = error.killed ? 'timed out' : (lastLine || error.message);
          reject(new Error(`FFmpeg ${label} failed: ${reason}`));
        });
      });

      const buffer = await readFile(outputFile);
      return buffer;
    } finally {
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
