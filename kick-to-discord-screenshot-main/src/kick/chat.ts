import WebSocket from 'ws';
import { EventEmitter } from 'events';

const PUSHER_WS_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

interface PusherMessage {
  event: string;
  data: string;
  channel?: string;
}

const RECENT_MSG_MAX = 200;
/** Same user + same command within this window = one emit (Kick/Pusher can duplicate events). */
const COMMAND_DEDUP_MS = 12000;

export class KickChatListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private chatroomId: number;
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  /** User closed on purpose — do not auto-reconnect */
  private manualStop = false;
  private recentMessageIds = new Set<string>();
  private recentMessageIdList: string[] = [];
  /** stable sender key + command → last emit time */
  private recentCommandEmit = new Map<string, number>();

  constructor(chatroomId: number) {
    super();
    this.chatroomId = chatroomId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      if (this.ws) {
        try {
          this.ws.removeAllListeners();
          this.ws.close();
        } catch {
          /* ignore */
        }
        this.ws = null;
      }

      this.ws = new WebSocket(PUSHER_WS_URL);

      this.connectionTimeout = setTimeout(() => {
        this.connectionTimeout = null;
        reject(new Error('Connection timeout'));
      }, 10000);

      this.ws.on('open', () => {
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        console.log('[Chat] Connected to Pusher');
        this.subscribe();
        this.startPing();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message: PusherMessage = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('[Chat] WebSocket error:', error.message);
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        reject(error);
      });

      this.ws.on('close', () => {
        console.log('[Chat] Disconnected');
        this.stopPing();
        if (this.manualStop) return;
        // Single reconnect — avoids stacking timers / parallel sockets
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          console.log('[Chat] Reconnecting...');
          this.connect().catch(console.error);
        }, 5000);
      });
    });
  }

  private subscribe(): void {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` },
    }));
    console.log(`[Chat] Subscribed to chatroom ${this.chatroomId}`);
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /** Stable key for dedup: prefer numeric user id, then slug, then username */
  private static senderKey(data: { sender?: { id?: number; username?: string; slug?: string } }): string {
    const s = data.sender;
    if (s?.id != null && Number.isFinite(s.id)) return `id:${s.id}`;
    if (s?.slug) return `slug:${String(s.slug).toLowerCase()}`;
    return `name:${(s?.username || 'unknown').toLowerCase()}`;
  }

  private handleMessage(message: PusherMessage): void {
    if (message.event === 'App\\Events\\ChatMessageEvent') {
      try {
        const data = JSON.parse(message.data);
        const msgId: string = data.id;
        if (msgId && this.recentMessageIds.has(msgId)) {
          return;
        }
        if (msgId) {
          this.recentMessageIds.add(msgId);
          this.recentMessageIdList.push(msgId);
          if (this.recentMessageIdList.length > RECENT_MSG_MAX) {
            const old = this.recentMessageIdList.shift()!;
            this.recentMessageIds.delete(old);
          }
        }

        const content: string = data.content || '';
        const sender = data.sender?.username || 'unknown';
        const senderKey = KickChatListener.senderKey(data);

        const raw = content.trim().toLowerCase().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
        const cmd = raw;

        const emitCommand = (event: string, payload: { sender: string; content?: string }) => {
          const dedupKey = `${senderKey}\0${cmd}`;
          const now = Date.now();
          const last = this.recentCommandEmit.get(dedupKey);
          if (last !== undefined && now - last < COMMAND_DEDUP_MS) {
            console.log(`[Chat] Skipping duplicate ${cmd} (${senderKey}) (${now - last}ms since last)`);
            return;
          }
          this.recentCommandEmit.set(dedupKey, now);
          if (this.recentCommandEmit.size > 500) {
            const cutoff = now - COMMAND_DEDUP_MS * 2;
            for (const [k, t] of this.recentCommandEmit) {
              if (t < cutoff) this.recentCommandEmit.delete(k);
            }
          }
          console.log(`[Chat] ${cmd} command from ${sender}`);
          this.emit(event, payload);
        };

        if (cmd === '!pic') {
          emitCommand('pic', { sender, content });
        } else if (cmd === '!clip') {
          emitCommand('clip', { sender, content });
        } else if (cmd === '!gif') {
          emitCommand('gif', { sender, content });
        } else if (cmd === '!emoji') {
          emitCommand('emoji', { sender, content });
        } else if (cmd === '!emoji2') {
          emitCommand('emoji2', { sender, content });
        } else if (cmd === '!sticker') {
          emitCommand('sticker', { sender, content });
        } else if (cmd === '!sticker2') {
          emitCommand('sticker2', { sender, content });
        } else if (cmd === '!stats') {
          emitCommand('stats', { sender });
        }
      } catch {
        // ignore malformed chat messages
      }
    }
  }

  disconnect(): void {
    this.manualStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    this.stopPing();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
