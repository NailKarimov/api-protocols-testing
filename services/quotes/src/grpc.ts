import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { HealthImplementation } from 'grpc-health-check';
import { QuoteFeed, type Quote } from './feed.ts';

/**
 * gRPC face of the quote feed (proto/quotes/v1/quotes.proto, docs/grpc.md).
 *
 * Rules the tests rely on:
 * - every call needs `authorization: Bearer <token>` metadata → otherwise UNAUTHENTICATED;
 * - a pair is six upper-case letters (INVALID_ARGUMENT) and must be listed (NOT_FOUND);
 * - work stops when the client's deadline passes or the client cancels;
 * - `x-request-id` metadata is echoed back in the response headers and trailers;
 * - requests above 64 KiB are refused by the transport (RESOURCE_EXHAUSTED).
 */
export const PROTO_DIR = path.resolve('proto');
export const PROTO_FILE = 'quotes/v1/quotes.proto';
export const SERVICE = 'quotes.v1.QuoteService';
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_ORDERS_PER_STREAM = 1_000;

export const loadOptions: protoLoader.Options = {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
};

export function loadDefinition() {
  return protoLoader.loadSync(PROTO_FILE, loadOptions);
}

const PAIR = /^[A-Z]{6}$/;
const AMOUNT = /^(?:[1-9]\d{0,6})(?:\.\d{1,2})?$/;

class RpcError extends Error {
  readonly code: grpc.status;
  constructor(code: grpc.status, message: string) {
    super(message);
    this.code = code;
  }
}

const toMessage = (q: Quote) => ({
  pair: q.pair,
  bid: q.bid,
  ask: q.ask,
  seq: q.seq,
  time: { seconds: Math.floor(q.time.getTime() / 1000), nanos: (q.time.getTime() % 1000) * 1e6 },
});

function checkPair(pair: unknown): string {
  if (typeof pair !== 'string' || !PAIR.test(pair)) {
    throw new RpcError(grpc.status.INVALID_ARGUMENT, `pair must be six upper-case letters such as "EURUSD"`);
  }
  if (!QuoteFeed.isKnown(pair)) throw new RpcError(grpc.status.NOT_FOUND, `unknown pair ${pair}`);
  return pair;
}

type OrderMsg = { client_order_id: string; pair: string; side: string; amount: string };
const EMPTY_ORDER: OrderMsg = { client_order_id: '', pair: '', side: 'SIDE_UNSPECIFIED', amount: '' };

/** Why an order is refused, or undefined when it is valid. */
function orderProblem(o: OrderMsg, seen: Set<string>): string | undefined {
  if (!o.client_order_id) return 'client_order_id is required';
  if (seen.has(o.client_order_id)) return 'duplicate client_order_id';
  seen.add(o.client_order_id);
  if (!PAIR.test(o.pair) || !QuoteFeed.isKnown(o.pair)) return `unknown pair ${o.pair}`;
  if (o.side !== 'SIDE_BUY' && o.side !== 'SIDE_SELL') return 'side must be SIDE_BUY or SIDE_SELL';
  if (!AMOUNT.test(o.amount) || Number(o.amount) > 1_000_000)
    return 'amount must be 1 … 1000000 with at most 2 places';
  return undefined;
}

export type GrpcOptions = { token: string };
export type GrpcStats = { delayedCallsAbandoned: number; activeStreams: number };

export function buildGrpcServer(feed: QuoteFeed, opts: GrpcOptions) {
  const definition = loadDefinition();
  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    quotes: { v1: { QuoteService: grpc.ServiceClientConstructor } };
  };
  const server = new grpc.Server({
    'grpc.max_receive_message_length': MAX_REQUEST_BYTES,
  });
  const stats: GrpcStats = { delayedCallsAbandoned: 0, activeStreams: 0 };

  type Call = { metadata: grpc.Metadata; sendMetadata(m: grpc.Metadata): void };
  /** Authentication and request id, common to every call. Returns the trailers to send. */
  function begin(call: Call): grpc.Metadata {
    const auth = call.metadata.get('authorization')[0];
    if (auth !== `Bearer ${opts.token}`) {
      throw new RpcError(grpc.status.UNAUTHENTICATED, 'missing or invalid bearer token');
    }
    const id = call.metadata.get('x-request-id')[0];
    const headers = new grpc.Metadata();
    const trailers = new grpc.Metadata();
    if (typeof id === 'string') {
      headers.set('x-request-id', id);
      trailers.set('x-request-id', id);
    }
    call.sendMetadata(headers);
    return trailers;
  }
  const fail = (e: unknown): Partial<grpc.StatusObject> =>
    e instanceof RpcError
      ? { code: e.code, details: e.message }
      : { code: grpc.status.INTERNAL, details: 'internal error' }; // never leak a stack trace

  const impl: grpc.UntypedServiceImplementation = {
    GetQuote(
      call: grpc.ServerUnaryCall<{ pair: string; delay_ms: number }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) {
      let trailers: grpc.Metadata;
      try {
        trailers = begin(call);
        const pair = checkPair(call.request.pair);
        const delay = call.request.delay_ms;
        if (delay > 10_000) throw new RpcError(grpc.status.INVALID_ARGUMENT, 'delay_ms must be 0 … 10000');
        if (!delay) return cb(null, { quote: toMessage(feed.current(pair)) }, trailers);
        const timer = setTimeout(() => cb(null, { quote: toMessage(feed.current(pair)) }, trailers), delay);
        call.on('cancelled', () => {
          clearTimeout(timer); // the client gave up (deadline or cancel): stop the work
          stats.delayedCallsAbandoned++;
        });
      } catch (e) {
        cb(fail(e));
      }
    },

    Subscribe(call: grpc.ServerWritableStream<{ pairs: string[]; max_updates: number }, unknown>) {
      let trailers: grpc.Metadata;
      const pairs = call.request.pairs;
      try {
        trailers = begin(call);
        if (pairs.length < 1 || pairs.length > 10) {
          throw new RpcError(grpc.status.INVALID_ARGUMENT, 'pairs must list 1 … 10 pairs');
        }
        if (new Set(pairs).size !== pairs.length)
          throw new RpcError(grpc.status.INVALID_ARGUMENT, 'pairs must be distinct');
        pairs.forEach(checkPair);
      } catch (e) {
        call.emit('error', fail(e));
        return;
      }
      const max = call.request.max_updates;
      let sent = 0;
      stats.activeStreams++;
      let unsubscribe = () => {};
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        unsubscribe();
        stats.activeStreams--;
      };
      const send = (q: Quote) => {
        if (done) return;
        call.write({ quote: toMessage(q) });
        sent++;
        if (max && sent >= max) {
          finish();
          call.end(trailers);
        }
      };
      // A snapshot of every pair first, then live updates.
      for (const p of pairs) send(feed.current(p));
      if (!done) unsubscribe = feed.subscribe((q) => pairs.includes(q.pair) && send(q));
      call.on('cancelled', finish);
      call.on('close', finish);
    },

    SubmitOrders(
      call: grpc.ServerReadableStream<{ order: OrderMsg | null }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) {
      let trailers: grpc.Metadata;
      try {
        trailers = begin(call);
      } catch (e) {
        return cb(fail(e));
      }
      const seen = new Set<string>();
      const rejections: { client_order_id: string; reason: string }[] = [];
      let accepted = 0;
      let totalCents = 0n;
      let count = 0;
      let aborted = false;
      call.on('data', ({ order }: { order: OrderMsg | null }) => {
        if (aborted) return;
        const o = order ?? EMPTY_ORDER;
        if (++count > MAX_ORDERS_PER_STREAM) {
          aborted = true;
          return cb({
            code: grpc.status.RESOURCE_EXHAUSTED,
            details: `at most ${MAX_ORDERS_PER_STREAM} orders per stream`,
          });
        }
        const problem = orderProblem(o, seen);
        if (problem) return void rejections.push({ client_order_id: o.client_order_id, reason: problem });
        accepted++;
        const [whole, frac = ''] = o.amount.split('.');
        totalCents += BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
      });
      call.on('end', () => {
        if (aborted) return;
        const total = `${totalCents / 100n}.${String(totalCents % 100n).padStart(2, '0')}`;
        cb(null, { accepted, rejected: rejections.length, total_amount: total, rejections }, trailers);
      });
    },

    Trade(call: grpc.ServerDuplexStream<{ order: OrderMsg | null }, unknown>) {
      let trailers: grpc.Metadata;
      try {
        trailers = begin(call);
      } catch (e) {
        call.emit('error', fail(e));
        return;
      }
      const seen = new Set<string>();
      call.on('data', ({ order }: { order: OrderMsg | null }) => {
        const o = order ?? EMPTY_ORDER;
        const problem = orderProblem(o, seen);
        if (problem)
          return call.write({ client_order_id: o.client_order_id, accepted: false, reason: problem });
        const q = feed.current(o.pair);
        call.write({
          client_order_id: o.client_order_id,
          accepted: true,
          price: o.side === 'SIDE_BUY' ? q.ask : q.bid, // a buyer pays the ask, a seller gets the bid
          quote_seq: q.seq,
        });
      });
      call.on('end', () => call.end(trailers)); // the client half-closed: finish cleanly
    },
  };

  server.addService(pkg.quotes.v1.QuoteService.service, impl);
  const health = new HealthImplementation({ '': 'SERVING', [SERVICE]: 'SERVING' });
  health.addToServer(server);
  // Reflection describes every service on the server, the standard health service included, so tools such as
  // grpcurl can call it without a .proto file.
  const healthProto = path.resolve('node_modules/grpc-health-check/proto/health/v1/health.proto');
  new ReflectionService(protoLoader.loadSync([PROTO_FILE, healthProto], loadOptions)).addToServer(server);

  return {
    server,
    stats,
    health,
    /** Binds to 127.0.0.1 on a free port (insecure: TLS is out of scope for the in-process test server). */
    listen: (port = 0) =>
      new Promise<number>((resolve, reject) =>
        server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (err, p) =>
          err ? reject(err) : resolve(p),
        ),
      ),
    close: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}
