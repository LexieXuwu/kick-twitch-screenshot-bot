import WebSocket from 'ws';
import axios from 'axios';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

/**
 * Kick chat listener.
 *
 * Kick no longer serves chat through a fixed Pusher app key. The website now asks
 * `web.kick.com/api/v1/realtime/...` which realtime provider to use and gets back
 * either a Centrifugo websocket URL (current) or Pusher credentials (legacy).
 * We do the same, so the bot keeps working if Kick moves regions or providers.
 */

const KICK_WEB_API = 'https://web.kick.com/api/v1';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const KICK_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'x-app-platform': 'web',
  Origin: 'https://kick.com',
  Referer: 'https://kick.com/',
  'User-Agent': USER_AGENT,
};

const CHAT_MESSAGE_EVENT = 'App\\Events\\ChatMessageEvent';
const RECENT_MSG_MAX = 200;
/** Same user + same command within this window = one emit (Kick can duplicate events). */
const COMMAND_DEDUP_MS = 12000;
const CONNECT_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 5000;
/** Centrifugo pings every ~25s; if we hear nothing for this long the socket is dead. */
const PING_WATCHDOG_MS = 90000;
/** Refresh the connection token this long before it expires. */
const TOKEN_REFRESH_MARGIN_S = 60;

/** Network errors (DNS, connect) often carry an empty message and only a code, or a list of inner errors. */
export function describeNetworkError(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { message?: string; code?: string; errors?: { message?: string; code?: string }[] };
    if (err.message) return err.message;
    if (err.code) return err.code;
    const inner = err.errors?.find((x) => x?.code || x?.message);
    if (inner) return inner.code || inner.message || 'network error';
  }
  return String(e) || 'network error';
}

type RealtimeTarget =
  | { provider: 'centrifugo'; url: string }
  | { provider: 'pusher'; appKey: string; cluster: string };

interface KickRealtimeConnectionResponse {
  data?: {
    connections?: {
      provider?: string;
      credentials?: { url?: string; app_key?: string; cluster?: string };
    }[];
  };
}

interface ChatSender {
  id?: number;
  username?: string;
  slug?: string;
}

interface ChatMessage {
  id?: string;
  content?: string;
  sender?: ChatSender;
}

export class KickChatListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private chatroomId: number;
  private clientId = randomUUID();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private pingWatchdog: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private nextCommandId = 1;
  private pendingSubscribe: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private subscribeCommandId = -1;
  private refreshCommandId = -1;
  private activeProvider: RealtimeTarget['provider'] | null = null;
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

  // ───────────────────────── Kick realtime discovery ─────────────────────────

  private async discoverTarget(): Promise<RealtimeTarget> {
    const body = {
      client: { id: this.clientId, type: 'web' },
      capabilities: { accepted_providers: [{ provider: 'centrifugo' }, { provider: 'pusher' }] },
    };
    const res = await axios.post<KickRealtimeConnectionResponse>(
      `${KICK_WEB_API}/realtime/connection`,
      body,
      { headers: KICK_HEADERS, timeout: 10000 },
    );
    const connections = res.data?.data?.connections ?? [];
    for (const c of connections) {
      if (c.provider === 'centrifugo' && c.credentials?.url) {
        return { provider: 'centrifugo', url: c.credentials.url };
      }
    }
    for (const c of connections) {
      if (c.provider === 'pusher' && c.credentials?.app_key && c.credentials?.cluster) {
        return { provider: 'pusher', appKey: c.credentials.app_key, cluster: c.credentials.cluster };
      }
    }
    throw new Error(`Kick realtime: no usable provider in ${JSON.stringify(res.data).slice(0, 200)}`);
  }

  private async fetchConnectionToken(): Promise<string> {
    const res = await axios.post<{ data?: { token?: string } }>(
      `${KICK_WEB_API}/realtime/auth/connection`,
      { client_id: this.clientId },
      { headers: KICK_HEADERS, timeout: 10000 },
    );
    const token = res.data?.data?.token;
    if (!token) throw new Error('Kick realtime: empty connection token');
    return token;
  }

  private async fetchChannelToken(channel: string): Promise<string> {
    try {
      const res = await axios.post<{ data?: { token?: string } }>(
        `${KICK_WEB_API}/realtime/auth/channel`,
        { channel },
        { headers: KICK_HEADERS, timeout: 10000 },
      );
      return res.data?.data?.token ?? '';
    } catch {
      // Public chat channels do not need a token; fall back to none.
      return '';
    }
  }

  private get channelName(): string {
    return `chatrooms.${this.chatroomId}.v2`;
  }

  // ───────────────────────────── connection ─────────────────────────────

  async connect(): Promise<void> {
    this.manualStop = false;
    this.clearTimers();
    this.closeSocket();

    const target = await this.discoverTarget();
    this.activeProvider = target.provider;

    if (target.provider === 'centrifugo') {
      const token = await this.fetchConnectionToken();
      const channelToken = await this.fetchChannelToken(this.channelName);
      await this.openCentrifugo(target.url, token, channelToken);
    } else {
      await this.openPusher(target.appKey, target.cluster);
    }
  }

  private openCentrifugo(url: string, token: string, channelToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        this.pendingSubscribe = null;
        if (err) reject(err);
        else resolve();
      };

      const ws = new WebSocket(url, { headers: { Origin: 'https://kick.com', 'User-Agent': USER_AGENT } });
      this.ws = ws;

      this.connectionTimeout = setTimeout(() => {
        finish(new Error('Connection timeout'));
        this.closeSocket();
        this.scheduleReconnect();
      }, CONNECT_TIMEOUT_MS);

      const connectId = this.nextCommandId++;
      this.subscribeCommandId = this.nextCommandId++;
      this.pendingSubscribe = { resolve: () => finish(), reject: (e) => finish(e) };

      ws.on('open', () => {
        this.armPingWatchdog();
        ws.send(JSON.stringify({ id: connectId, connect: { token, name: 'js' } }));
      });

      ws.on('message', (data: Buffer) => {
        this.armPingWatchdog();
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(trimmed);
          } catch {
            continue;
          }
          this.handleCentrifugoFrame(frame, connectId, channelToken);
        }
      });

      ws.on('error', (error: Error) => {
        console.error(`[Chat] WebSocket error: ${describeNetworkError(error)}`);
        finish(error);
      });

      ws.on('close', (code: number) => {
        if (this.ws !== ws) return;
        console.log(`[Chat] Disconnected (code ${code})`);
        this.clearTimers();
        this.ws = null;
        finish(new Error(`Socket closed (${code})`));
        this.scheduleReconnect();
      });
    });
  }

  private handleCentrifugoFrame(frame: Record<string, unknown>, connectId: number, channelToken: string): void {
    const ws = this.ws;
    if (!ws) return;

    // Server ping is an empty object; reply with an empty object.
    if (Object.keys(frame).length === 0) {
      if (ws.readyState === WebSocket.OPEN) ws.send('{}');
      return;
    }

    const id = typeof frame.id === 'number' ? frame.id : undefined;
    const error = frame.error as { code?: number; message?: string } | undefined;

    if (id === connectId) {
      if (error) {
        this.pendingSubscribe?.reject(new Error(`Connect rejected: ${error.message ?? error.code}`));
        this.closeSocket();
        return;
      }
      const reply = frame.connect as { ttl?: number; expires?: boolean; ping?: number } | undefined;
      console.log('[Chat] Connected to Kick realtime (centrifugo)');
      if (reply?.expires && reply.ttl) this.scheduleTokenRefresh(reply.ttl);
      const subscribe: Record<string, unknown> = { channel: this.channelName };
      if (channelToken) subscribe.token = channelToken;
      ws.send(JSON.stringify({ id: this.subscribeCommandId, subscribe }));
      return;
    }

    if (id === this.subscribeCommandId) {
      if (error) {
        this.pendingSubscribe?.reject(new Error(`Subscribe rejected: ${error.message ?? error.code}`));
        this.closeSocket();
        return;
      }
      console.log(`[Chat] Subscribed to chatroom ${this.chatroomId}`);
      this.pendingSubscribe?.resolve();
      return;
    }

    if (id === this.refreshCommandId) {
      if (error) {
        console.error('[Chat] Token refresh rejected, reconnecting:', error.message ?? error.code);
        this.closeSocket();
        this.scheduleReconnect();
        return;
      }
      const reply = frame.refresh as { ttl?: number; expires?: boolean } | undefined;
      if (reply?.expires && reply.ttl) this.scheduleTokenRefresh(reply.ttl);
      return;
    }

    const push = frame.push as
      | { channel?: string; pub?: { data?: { event?: string; data?: unknown } } }
      | undefined;
    if (push?.pub?.data) {
      this.handleEvent(push.pub.data.event, push.pub.data.data);
      return;
    }

    const disconnect = frame.disconnect as { code?: number; reason?: string } | undefined;
    if (disconnect) {
      console.log(`[Chat] Server asked to disconnect: ${disconnect.reason ?? disconnect.code}`);
      this.closeSocket();
      this.scheduleReconnect();
    }
  }

  private scheduleTokenRefresh(ttlSeconds: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(10, ttlSeconds - TOKEN_REFRESH_MARGIN_S) * 1000;
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      try {
        const token = await this.fetchConnectionToken();
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.refreshCommandId = this.nextCommandId++;
          this.ws.send(JSON.stringify({ id: this.refreshCommandId, refresh: { token } }));
        }
      } catch (e) {
        console.error('[Chat] Token refresh failed, reconnecting:', e instanceof Error ? e.message : e);
        this.closeSocket();
        this.scheduleReconnect();
      }
    }, delay);
  }

  private armPingWatchdog(): void {
    if (this.pingWatchdog) clearTimeout(this.pingWatchdog);
    this.pingWatchdog = setTimeout(() => {
      this.pingWatchdog = null;
      console.error('[Chat] No data from Kick for a while, reconnecting...');
      this.closeSocket();
      this.scheduleReconnect();
    }, PING_WATCHDOG_MS);
  }

  // ───────────────────────── legacy Pusher transport ─────────────────────────

  private openPusher(appKey: string, cluster: string): Promise<void> {
    const url = `wss://ws-${cluster}.pusher.com/app/${appKey}?protocol=7&client=js&version=8.4.0&flash=false`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        if (err) reject(err);
        else resolve();
      };

      const ws = new WebSocket(url);
      this.ws = ws;

      this.connectionTimeout = setTimeout(() => {
        finish(new Error('Connection timeout'));
        this.closeSocket();
        this.scheduleReconnect();
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        console.log('[Chat] Connected to Kick realtime (pusher)');
        ws.send(JSON.stringify({
          event: 'pusher:subscribe',
          data: { auth: '', channel: this.channelName },
        }));
        this.pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
        }, 30000);
      });

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as { event: string; data: unknown };
          if (message.event === 'pusher_internal:subscription_succeeded') {
            console.log(`[Chat] Subscribed to chatroom ${this.chatroomId}`);
            finish();
          } else if (message.event === 'pusher:error') {
            const err = typeof message.data === 'object' && message.data
              ? (message.data as { message?: string }).message
              : String(message.data);
            finish(new Error(`Pusher error: ${err}`));
          } else {
            this.handleEvent(message.event, message.data);
          }
        } catch {
          // ignore parse errors
        }
      });

      ws.on('error', (error: Error) => {
        console.error(`[Chat] WebSocket error: ${describeNetworkError(error)}`);
        finish(error);
      });

      ws.on('close', () => {
        if (this.ws !== ws) return;
        console.log('[Chat] Disconnected');
        this.clearTimers();
        this.ws = null;
        finish(new Error('Socket closed'));
        this.scheduleReconnect();
      });
    });
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /**
   * Make sure a reconnect is on the way (used by the caller when the very first
   * connect() rejects, e.g. a network blip at startup). Safe to call repeatedly.
   */
  ensureReconnect(): void {
    if (this.ws) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manualStop || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log('[Chat] Reconnecting...');
      this.connect().catch((e) => {
        console.error('[Chat] Reconnect failed:', e instanceof Error ? e.message : e);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private clearTimers(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pingWatchdog) {
      clearTimeout(this.pingWatchdog);
      this.pingWatchdog = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
    } catch {
      /* ignore */
    }
  }

  disconnect(): void {
    this.manualStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearTimers();
    this.closeSocket();
  }

  get provider(): string | null {
    return this.activeProvider;
  }

  // ───────────────────────── chat message handling ─────────────────────────

  /** Stable key for dedup: prefer numeric user id, then slug, then username */
  private static senderKey(data: ChatMessage): string {
    const s = data.sender;
    if (s?.id != null && Number.isFinite(s.id)) return `id:${s.id}`;
    if (s?.slug) return `slug:${String(s.slug).toLowerCase()}`;
    return `name:${(s?.username || 'unknown').toLowerCase()}`;
  }

  private handleEvent(event: string | undefined, rawData: unknown): void {
    if (event !== CHAT_MESSAGE_EVENT) return;
    try {
      const data: ChatMessage = typeof rawData === 'string' ? JSON.parse(rawData) : (rawData as ChatMessage);
      if (!data) return;

      const msgId = data.id;
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

      const cmd = content.trim().toLowerCase().replace(/ /g, ' ').replace(/\s+/g, ' ');

      const emitCommand = (eventName: string, payload: { sender: string; content?: string }) => {
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
        this.emit(eventName, payload);
      };

      switch (cmd) {
        case '!pic': emitCommand('pic', { sender, content }); break;
        case '!clip': emitCommand('clip', { sender, content }); break;
        case '!gif': emitCommand('gif', { sender, content }); break;
        case '!emoji': emitCommand('emoji', { sender, content }); break;
        case '!emoji2': emitCommand('emoji2', { sender, content }); break;
        case '!sticker': emitCommand('sticker', { sender, content }); break;
        case '!sticker2': emitCommand('sticker2', { sender, content }); break;
        default: break;
      }
    } catch {
      // ignore malformed chat messages
    }
  }
}
