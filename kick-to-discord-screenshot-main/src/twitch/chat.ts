import tmi from 'tmi.js';
import { EventEmitter } from 'events';

export class TwitchChatListener extends EventEmitter {
  private client: tmi.Client | null = null;
  private channel: string;

  constructor(channel: string, oauthToken: string, username?: string) {
    super();
    this.channel = channel.toLowerCase().replace('#', '');

    const token = oauthToken.startsWith('oauth:') ? oauthToken : `oauth:${oauthToken}`;

    this.client = new tmi.Client({
      options: { debug: false },
      identity: {
        username: username || this.channel,
        password: token,
      },
      channels: [this.channel],
    });

    this.client.on('message', (ch: string, tags: { 'display-name'?: string; username?: string }, message: string, self: boolean) => {
      if (self) return;

      const cmd = message.trim().toLowerCase();
      const sender = tags['display-name'] || tags.username || 'unknown';

      if (cmd === '!pic') {
        console.log(`[Twitch] !pic command from ${sender}`);
        this.emit('pic', { sender, content: message });
      } else if (cmd === '!clip') {
        console.log(`[Twitch] !clip command from ${sender}`);
        this.emit('clip', { sender, content: message });
      } else if (cmd === '!gif') {
        console.log(`[Twitch] !gif command from ${sender}`);
        this.emit('gif', { sender, content: message });
      } else if (cmd === '!stats') {
        console.log(`[Twitch] !stats command from ${sender}`);
        this.emit('stats', { sender });
      }
    });

    this.client.on('connected', () => {
      console.log('[Twitch] Connected to chat');
    });

    this.client.on('disconnected', (reason: string) => {
      console.log('[Twitch] Disconnected:', reason);
    });

    this.client.on('error', (err: Error) => {
      console.error('[Twitch] Error:', err.message);
    });
  }

  async connect(): Promise<void> {
    if (!this.client) return;
    await this.client.connect();
    console.log(`[Twitch] Subscribed to #${this.channel}`);
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }
}
