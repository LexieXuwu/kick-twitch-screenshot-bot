import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOCK_FILE = 'bot.lock';

/** Prevent multiple npm start processes (each would post duplicate Discord webhooks). */
export function acquireSingleInstanceLock(cwd: string = process.cwd()): void {
  const lockPath = join(cwd, LOCK_FILE);
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const oldPid = parseInt(raw, 10);
    if (!Number.isNaN(oldPid) && oldPid > 0) {
      try {
        process.kill(oldPid, 0);
        console.error(
          `\nAnother bot instance is already running (PID ${oldPid}).\n` +
            'Stop it first, or delete bot.lock if that process is gone.\n',
        );
        process.exit(1);
      } catch {
        unlinkSync(lockPath);
      }
    } else {
      unlinkSync(lockPath);
    }
  }
  writeFileSync(lockPath, String(process.pid), 'utf8');
}

export function releaseSingleInstanceLock(cwd: string = process.cwd()): void {
  try {
    const lockPath = join(cwd, LOCK_FILE);
    if (existsSync(lockPath)) {
      const raw = readFileSync(lockPath, 'utf8').trim();
      if (raw === String(process.pid)) {
        unlinkSync(lockPath);
      }
    }
  } catch {
    /* ignore */
  }
}
