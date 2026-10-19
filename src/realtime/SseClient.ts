import { test } from '@playwright/test';

export type SseEvent = { event: string; id?: string; data: string; json?: Record<string, unknown> };

/**
 * An SSE client on fetch: parses `event:`, `id:`, `data:`, `retry:` and comments exactly as the
 * EventSource specification says, keeps the last event id, and can reconnect with Last-Event-ID.
 */
export class SseClient {
  readonly events: SseEvent[] = [];
  readonly comments: string[] = [];
  readonly log: string[] = [];
  status = 0;
  headers: Record<string, string> = {};
  body = '';
  retry?: number;
  lastEventId = '';
  ended = false;
  private abort?: AbortController;
  private waiters: (() => void)[] = [];

  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}

  private note(line: string) {
    this.log.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    this.waiters.forEach((w) => w());
  }

  /** Opens the stream; resolves once the response headers arrived (the body keeps streaming). */
  async open(query: string, opts: { token?: string | null; lastEventId?: string; accept?: string } = {}) {
    this.abort = new AbortController();
    this.ended = false;
    const token = opts.token === undefined ? this.token : opts.token;
    const headers: Record<string, string> = { Accept: opts.accept ?? 'text/event-stream' };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (opts.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
    this.note(`GET /sse?${query}${opts.lastEventId ? `  Last-Event-ID: ${opts.lastEventId}` : ''}`);
    const res = await fetch(`${this.baseUrl}/sse?${query}`, { headers, signal: this.abort.signal });
    this.status = res.status;
    this.headers = Object.fromEntries(res.headers.entries());
    this.note(`${res.status} ${this.headers['content-type'] ?? ''}`);
    if (!this.headers['content-type']?.startsWith('text/event-stream')) {
      this.body = await res.text();
      this.ended = true;
      this.note(this.body);
      return this;
    }
    void this.read(res.body!);
    return this;
  }

  private async read(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = '';
    let cur: Partial<SseEvent> & { data?: string } = {};
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.search(/\r\n|\n|\r/)) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
          if (line === '') {
            if (cur.data !== undefined) {
              const e: SseEvent = { event: cur.event ?? 'message', id: cur.id, data: cur.data };
              if (cur.id !== undefined) this.lastEventId = cur.id;
              try {
                e.json = JSON.parse(e.data);
              } catch {
                /* not JSON */
              }
              this.events.push(e);
              this.note(`event ${e.event}${e.id ? ` id=${e.id}` : ''} ${e.data.slice(0, 200)}`);
            }
            cur = {};
            continue;
          }
          if (line.startsWith(':')) {
            this.comments.push(line.slice(1).trim());
            this.note(`comment ${line}`);
            continue;
          }
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'data') cur.data = cur.data === undefined ? value : `${cur.data}\n${value}`;
          else if (field === 'event') cur.event = value;
          else if (field === 'id') cur.id = value;
          else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
        }
      }
    } catch {
      /* aborted */
    }
    this.ended = true;
    this.note('stream ended');
  }

  quotes(pair?: string) {
    return this.events
      .filter((e) => e.event === 'quote' && (!pair || e.json?.pair === pair))
      .map((e) => e.json as { pair: string; bid: string; ask: string; seq: number; time: string });
  }

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

  /** Closes the stream from the client side (like closing the browser tab). */
  close() {
    this.note('(client closes the stream)');
    this.abort?.abort();
  }

  async attach(name = 'SSE transcript') {
    await test.info().attach(name, {
      contentType: 'text/plain',
      body: [`${this.baseUrl}/sse  (Authorization: Bearer ***)`, ...this.log].join('\n'),
    });
  }
}
