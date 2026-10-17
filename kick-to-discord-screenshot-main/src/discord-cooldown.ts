/**
 * Last line of defense: same Kick/Twitch user + same command should not hit Discord
 * multiple times within a short window (handles duplicate sockets / duplicate emits).
 */
const COOLDOWN_MS = 15000;
const lastSend = new Map<string, number>();

/** Key: platform + stable sender id + command name */
export function shouldSkipDiscordSend(key: string): boolean {
  const now = Date.now();
  const prev = lastSend.get(key);
  if (prev !== undefined && now - prev < COOLDOWN_MS) {
    console.log(`[Bot] Discord cooldown: skip duplicate (${key}) ${now - prev}ms since last send`);
    return true;
  }
  lastSend.set(key, now);
  if (lastSend.size > 800) {
    const cutoff = now - COOLDOWN_MS * 2;
    for (const [k, t] of lastSend) {
      if (t < cutoff) lastSend.delete(k);
    }
  }
  return false;
}
