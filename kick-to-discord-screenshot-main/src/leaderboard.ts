import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { DiscordEmbed } from './discord';

export type RequestType = 'pic' | 'clip' | 'gif';

export interface UserStats {
  pics: number;
  clips: number;
  gifs: number;
}

function total(stats: UserStats): number {
  return stats.pics + stats.clips + stats.gifs;
}

const DEFAULT_STATS: UserStats = { pics: 0, clips: 0, gifs: 0 };

export class Leaderboard {
  private data: Record<string, UserStats> = {};
  private filePath: string;

  constructor(dataDir: string = process.cwd()) {
    this.filePath = join(dataDir, 'leaderboard.json');
  }

  private typeToKey(type: RequestType): keyof UserStats {
    return type === 'pic' ? 'pics' : type === 'clip' ? 'clips' : 'gifs';
  }

  increment(username: string, type: RequestType): void {
    const key = username.trim().toLowerCase() || 'unknown';
    if (!this.data[key]) {
      this.data[key] = { ...DEFAULT_STATS };
    }
    this.data[key][this.typeToKey(type)] += 1;
    this.save().catch((err) => console.error('[Leaderboard] Save failed:', err.message));
  }

  getTopRequesters(n: number = 10): { username: string; stats: UserStats; total: number }[] {
    const entries = Object.entries(this.data)
      .map(([username, stats]) => ({
        username,
        stats,
        total: total(stats),
      }))
      .filter((e) => e.total > 0)
      .sort((a, b) => b.total - a.total);
    return entries.slice(0, n);
  }

  /** Plain-text version (fallback). */
  formatForDiscord(channelName: string, requestedBy?: string): string {
    const top = this.getTopRequesters(10);
    const lines: string[] = [
      `📊 **${channelName}** — Request leaderboard`,
      '',
    ];
    if (requestedBy) {
      lines.push(`*Requested by ${requestedBy}*`);
      lines.push('');
    }
    if (top.length === 0) {
      lines.push('*No requests yet. Use !pic, !clip, or !gif in chat!*');
      return lines.join('\n');
    }
    const medal = (i: number) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`);
    top.forEach((e, i) => {
      const parts = [`${medal(i)} **${e.username}** — ${e.total} total`];
      const sub: string[] = [];
      if (e.stats.pics) sub.push(`${e.stats.pics} pic`);
      if (e.stats.clips) sub.push(`${e.stats.clips} clip`);
      if (e.stats.gifs) sub.push(`${e.stats.gifs} gif`);
      if (sub.length) parts.push(`   (${sub.join(', ')})`);
      lines.push(parts.join(' '));
    });
    return lines.join('\n');
  }

  /** Build a Discord embed object for a nicer UI. */
  buildEmbed(channelName: string, requestedBy?: string): DiscordEmbed {
    const top = this.getTopRequesters(10);
    const totalRequests = top.reduce((sum, e) => sum + e.total, 0);
    const embed: DiscordEmbed = {
      author: { name: channelName, icon_url: 'https://kick.com/favicon.ico' },
      title: '📊 Top Requesters',
      description: [
        '> *Who\'s been capturing the best moments?*',
        '',
        '```',
        `  Total requests  ·  ${totalRequests}`,
        '```',
      ].join('\n'),
      color: 0x6366f1, // indigo
      fields: [],
      footer: requestedBy ? { text: `Requested by ${requestedBy}` } : undefined,
      timestamp: new Date().toISOString(),
    };

    if (top.length === 0) {
      embed.description = [
        '> *No requests yet.*',
        '',
        'Use `!pic`, `!clip`, or `!gif` in chat to get on the board!',
      ].join('\n');
      return embed;
    }

    const medal = (i: number) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '▫️');
    const ord = (i: number) => (i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`);
    top.forEach((e, i) => {
      const sub: string[] = [];
      if (e.stats.pics) sub.push(`📸 ${e.stats.pics}`);
      if (e.stats.clips) sub.push(`🎬 ${e.stats.clips}`);
      if (e.stats.gifs) sub.push(`🎞️ ${e.stats.gifs}`);
      const breakdown = sub.length ? `\n${sub.join('  ·  ')}` : '';
      embed.fields!.push({
        name: `${medal(i)} ${ord(i)}`,
        value: `**${e.username}**\n${e.total} total${breakdown}`,
        inline: true,
      });
    });

    return embed;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, UserStats>;
      this.data = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.pics === 'number' && typeof v.clips === 'number' && typeof v.gifs === 'number') {
          this.data[k] = { pics: v.pics, clips: v.clips, gifs: v.gifs };
        }
      }
    } catch {
      // no file or invalid — start fresh
    }
  }

  async save(): Promise<void> {
    try {
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      throw err;
    }
  }
}
