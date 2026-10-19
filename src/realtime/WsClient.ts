import { test } from '@playwright/test';
import WebSocket from 'ws';

export type Msg = { type: string; [k: string]: unknown };
export type WsOptions = { token?: string | null; protocols?: string[]; autoPong?: boolean };

/**
 * A WebSocket test client: keeps every message and event in order, waits for conditions, and attaches the
 * transcript to the report (token masked) when the test ends.
 */
export class WsClient {
  readonly messages: Msg[] = [];
  readonly log: string[] = [];
  private ws?: WebSocket;
  closed?: { code: number; reason: string };
  handshake?: { status?: number; error?: string };
  private waiters: (() => void)[] = [];

  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  private note(line: string) {
    this.log.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    this.waiters.forEach((w) => w());
  }

  /** Opens the socket; resolves on open or on a refused handshake (see `handshake`). */
  connect(opts: WsOptions = {}): Promise<this> {
    const token = opts.token === undefined ? this.token : opts.token;
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url, opts.protocols ?? ['quotes.v1'], {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
        autoPong: opts.autoPong ?? true,
      });
      this.ws = ws;
      ws.on('open', () => {
        this.note(`open (subprotocol ${ws.protocol || 'none'})`);
        resolve(this);
      });
      ws.on('unexpected-response', (_req, res) => {
        this.handshake = { status: res.statusCode };
        this.note(`handshake refused: HTTP ${res.statusCode}`);
        resolve(this);
      });
      ws.on('message', (data) => {
        const text = String(data);
        this.note(`← ${text.slice(0, 300)}`);
        try {
          this.messages.push(JSON.parse(text));
        } catch {
          this.messages.push({ type: '(not json)', text });
        }
      });
      ws.on('ping', () => this.note('← ping'));
      ws.on('close', (code, reason) => {
        this.closed = { code, reason: String(reason) };
        this.note(`close ${code} ${String(reason)}`);
        resolve(this);
      });
      ws.on('error', (e) => {
        this.handshake ??= { error: e.message };
        this.note(`error ${e.message}`);
        resolve(this);
      });
    });
  }

  get protocol() {
    return this.ws?.protocol ?? '';
  }

  send(msg: unknown) {
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.note(`→ ${text.slice(0, 300)}`);
    this.ws!.send(text);
  }

  sendBinary(buf: Buffer) {
    this.note(`→ (binary ${buf.length} bytes)`);
    this.ws!.send(buf);
  }

  /** Waits until `cond` holds, re-checking on every event; rejects after `ms` with the transcript tail. */
  until(cond: () => boolean, ms = 5_000, what = 'condition'): Promise<void> {
    if (cond()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${ms} ms waiting for ${what}\n${this.log.slice(-8).join('\n')}`));
      }, ms);
      const check = () => {
        if (cond()) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
      };
      this.waiters.push(check);
    });
  }

  quotes(pair?: string) {
    return this.messages.filter((m) => m.type === 'quote' && (!pair || m.pair === pair)) as unknown as {
      pair: string;
      bid: string;
      ask: string;
      seq: number;
      time: string;
    }[];
  }

  ofType(type: string) {
    return this.messages.filter((m) => m.type === type);
  }

  /** Drops the TCP connection without a close frame (a phone going into a tunnel). */
  drop() {
    this.note('(drop: socket destroyed without a close frame)');
    this.ws?.terminate();
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'bye');
      await this.until(() => !!this.closed, 2_000, 'close').catch(() => {});
    }
  }

  async attach(name = 'WebSocket transcript') {
    await test.info().attach(name, {
      contentType: 'text/plain',
      body: [`${this.url}  (Authorization: Bearer ***)`, ...this.log].join('\n'),
    });
  }
}
