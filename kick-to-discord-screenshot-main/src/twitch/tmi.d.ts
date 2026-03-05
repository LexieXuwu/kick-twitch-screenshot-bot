declare module 'tmi.js' {
  export interface ClientOptions {
    options?: { debug?: boolean };
    identity?: { username: string; password: string };
    channels?: string[];
  }

  export interface ChatUserstate {
    'display-name'?: string;
    username?: string;
  }

  export class Client {
    constructor(opts: ClientOptions);
    connect(): Promise<[string, number]>;
    disconnect(): void;
    on(event: 'message', handler: (channel: string, tags: ChatUserstate, message: string, self: boolean) => void): this;
    on(event: 'connected', handler: (address: string, port: number) => void): this;
    on(event: 'disconnected', handler: (reason: string) => void): this;
    on(event: 'error', handler: (err: Error) => void): this;
  }
}
