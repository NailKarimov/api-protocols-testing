import * as grpc from '@grpc/grpc-js';
import { test } from '@playwright/test';
import { loadDefinition } from '../../services/quotes/src/grpc.ts';

export type Quote = {
  pair: string;
  bid: string;
  ask: string;
  seq: number;
  time: { seconds: number; nanos: number };
};
export type Order = { client_order_id: string; pair: string; side: string; amount: string };
export type Fill = {
  client_order_id: string;
  accepted: boolean;
  price: string;
  reason: string;
  quote_seq: number;
};
export type Summary = {
  accepted: number;
  rejected: number;
  total_amount: string;
  rejections: { client_order_id: string; reason: string }[];
};

/** What a finished call looked like: the response(s), the status and both metadata sets. */
export type Outcome<T> = {
  code: grpc.status;
  /** Name of the status code, e.g. "DEADLINE_EXCEEDED". */
  status: string;
  details: string;
  value?: T;
  messages: T[];
  headers: Record<string, string>;
  trailers: Record<string, string>;
  durationMs: number;
};

export type CallOptions = {
  token?: string | null;
  deadlineMs?: number;
  requestId?: string;
  metadata?: Record<string, string>;
};

const statusName = (code: number) => grpc.status[code] ?? String(code);
const flat = (m?: grpc.Metadata) =>
  Object.fromEntries(Object.entries(m?.getMap() ?? {}).map(([k, v]) => [k, String(v)]));

/**
 * Test client of quotes.v1.QuoteService. Every method resolves (never throws) with an Outcome, so a test asserts on
 * the status code like on an HTTP status, and every call is attached to the report with the token masked.
 */
export class QuotesClient {
  readonly raw: grpc.Client & Record<string, (...args: unknown[]) => unknown>;

  constructor(
    readonly address: string,
    readonly token: string,
  ) {
    const pkg = grpc.loadPackageDefinition(loadDefinition()) as unknown as {
      quotes: { v1: { QuoteService: grpc.ServiceClientConstructor } };
    };
    this.raw = new pkg.quotes.v1.QuoteService(address, grpc.credentials.createInsecure(), {
      // the client may send more than the server accepts: the limit under test is the server's
      'grpc.max_send_message_length': 16 * 1024 * 1024,
    }) as never;
  }

  close() {
    this.raw.close();
  }

  metadata(opts: CallOptions = {}): grpc.Metadata {
    const m = new grpc.Metadata();
    const token = opts.token === undefined ? this.token : opts.token;
    if (token !== null) m.set('authorization', `Bearer ${token}`);
    if (opts.requestId) m.set('x-request-id', opts.requestId);
    for (const [k, v] of Object.entries(opts.metadata ?? {})) m.set(k, v);
    return m;
  }

  private callOptions(opts: CallOptions): grpc.CallOptions {
    return opts.deadlineMs ? { deadline: new Date(Date.now() + opts.deadlineMs) } : {};
  }

  private async report<T>(method: string, request: unknown, o: Outcome<T>, opts: CallOptions) {
    const shown = { ...opts, token: opts.token === null ? '(none)' : '***' };
    await test.info().attach(`gRPC ${method} → ${o.status}`, {
      contentType: 'text/plain',
      body: [
        `${method}  (${o.durationMs} ms)`,
        `Call options: ${JSON.stringify(shown)}`,
        `Request: ${JSON.stringify(request).slice(0, 2_000)}`,
        `Status: ${o.status} ${o.details}`,
        `Headers: ${JSON.stringify(o.headers)}`,
        `Trailers: ${JSON.stringify(o.trailers)}`,
        `Messages (${o.messages.length}):`,
        ...o.messages.slice(0, 50).map((m) => `  ${JSON.stringify(m)}`),
      ].join('\n'),
    });
    return o;
  }

  /** Unary call. */
  unary<T>(method: string, request: unknown, opts: CallOptions = {}): Promise<Outcome<T>> {
    const started = Date.now();
    return new Promise((resolve) => {
      let headers: Record<string, string> = {};
      let value: T | undefined;
      const call = (this.raw[method] as (...a: unknown[]) => grpc.ClientUnaryCall)(
        request,
        this.metadata(opts),
        this.callOptions(opts),
        (_err: grpc.ServiceError | null, v: T) => (value = v ?? undefined),
      );
      call.on('metadata', (m) => (headers = flat(m)));
      // the response callback and 'status' fire in the same tick; read the value after both
      call.on('status', (s: grpc.StatusObject) =>
        setImmediate(() => {
          const o: Outcome<T> = {
            code: s.code,
            status: statusName(s.code),
            details: s.details,
            value,
            messages: value ? [value] : [],
            headers,
            trailers: flat(s.metadata),
            durationMs: Date.now() - started,
          };
          void this.report(method, request, o, opts).then(resolve);
        }),
      );
    });
  }

  async getQuote(pair: string, opts: CallOptions & { delayMs?: number } = {}): Promise<Outcome<Quote>> {
    const o = await this.unary<{ quote: Quote }>('GetQuote', { pair, delay_ms: opts.delayMs ?? 0 }, opts);
    const value = o.value?.quote;
    return { ...o, value, messages: value ? [value] : [] };
  }

  /**
   * Server streaming. `onMessage` may return true to cancel the call (the client stops listening).
   */
  subscribe(
    pairs: string[],
    maxUpdates = 0,
    opts: CallOptions & { onMessage?: (q: Quote, all: Quote[]) => boolean | void } = {},
  ): Promise<Outcome<Quote>> {
    const started = Date.now();
    const request = { pairs, max_updates: maxUpdates };
    return new Promise((resolve) => {
      const call = (this.raw.Subscribe as (...a: unknown[]) => grpc.ClientReadableStream<{ quote: Quote }>)(
        request,
        this.metadata(opts),
        this.callOptions(opts),
      );
      const messages: Quote[] = [];
      let headers: Record<string, string> = {};
      call.on('metadata', (m) => (headers = flat(m)));
      call.on('data', ({ quote: q }: { quote: Quote }) => {
        messages.push(q);
        if (opts.onMessage?.(q, messages)) call.cancel();
      });
      call.on('error', () => {}); // the status event carries the outcome
      call.on('status', (s: grpc.StatusObject) => {
        const o: Outcome<Quote> = {
          code: s.code,
          status: statusName(s.code),
          details: s.details,
          messages,
          headers,
          trailers: flat(s.metadata),
          durationMs: Date.now() - started,
        };
        void this.report('Subscribe', request, o, opts).then(resolve);
      });
    });
  }

  /** Client streaming: writes every order, half-closes, waits for the one summary. */
  submitOrders(orders: Order[], opts: CallOptions = {}): Promise<Outcome<Summary>> {
    const started = Date.now();
    return new Promise((resolve) => {
      let value: Summary | undefined;
      let headers: Record<string, string> = {};
      const call = (
        this.raw.SubmitOrders as (...a: unknown[]) => grpc.ClientWritableStream<{ order: Order }>
      )(this.metadata(opts), this.callOptions(opts), (_err: unknown, v: Summary) => (value = v));
      call.on('metadata', (m) => (headers = flat(m)));
      call.on('status', (s: grpc.StatusObject) => {
        // the callback runs before 'status' for a successful call
        setImmediate(() => {
          const o: Outcome<Summary> = {
            code: s.code,
            status: statusName(s.code),
            details: s.details,
            value,
            messages: value ? [value] : [],
            headers,
            trailers: flat(s.metadata),
            durationMs: Date.now() - started,
          };
          void this.report(
            'SubmitOrders',
            { orders: orders.length, first: orders.slice(0, 3) },
            o,
            opts,
          ).then(resolve);
        });
      });
      call.on('error', () => {});
      for (const o of orders) call.write({ order: o });
      call.end();
    });
  }

  /**
   * Bidirectional streaming, ping-pong: sends one order, waits for its fill, then the next.
   * Returns the fills in arrival order.
   */
  trade(orders: Order[], opts: CallOptions = {}): Promise<Outcome<Fill>> {
    const started = Date.now();
    return new Promise((resolve) => {
      const call = (this.raw.Trade as (...a: unknown[]) => grpc.ClientDuplexStream<{ order: Order }, Fill>)(
        this.metadata(opts),
        this.callOptions(opts),
      );
      const fills: Fill[] = [];
      let headers: Record<string, string> = {};
      let i = 0;
      const sendNext = () => (i < orders.length ? call.write({ order: orders[i++] }) : call.end());
      call.on('metadata', (m) => (headers = flat(m)));
      call.on('data', (f: Fill) => {
        fills.push(f);
        sendNext();
      });
      call.on('error', () => {});
      call.on('status', (s: grpc.StatusObject) => {
        const o: Outcome<Fill> = {
          code: s.code,
          status: statusName(s.code),
          details: s.details,
          messages: fills,
          headers,
          trailers: flat(s.metadata),
          durationMs: Date.now() - started,
        };
        void this.report('Trade', { orders: orders.length, first: orders.slice(0, 3) }, o, opts).then(
          resolve,
        );
      });
      sendNext();
    });
  }
}
