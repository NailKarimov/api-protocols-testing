import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { PAIRS, QuoteFeed, type Quote } from './feed.ts';

/**
 * WebSocket and Server-Sent Events faces of the quote feed (docs/realtime.md). The same quotes as gRPC.
 *
 * WebSocket `/ws`, subprotocol `quotes.v1`, JSON messages:
 *   client → { type: "subscribe", pairs, since? } | { type: "unsubscribe", pairs } | { type: "ping", id }
 *   server → { type: "subscribed" | "unsubscribed", pairs } | { type: "quote", … } | { type: "reset", pair }
 *            | { type: "pong", id } | { type: "error", code, message }
 *   Bad messages get an error and the connection stays; the 5th bad message closes it with 1008. Frames over
 *   4 KiB close with 1009. The server pings every heartbeat; a client that misses two pongs is dropped.
 *
 * SSE `GET /sse?pairs=EURUSD,USDJPY`: `retry:` first, then `event: quote` with `id:` = a cursor of every pair
 * (`EURUSD=57,USDJPY=33`), heartbeat comments. Reconnecting with `Last-Event-ID` resumes without a gap; a cursor
 * older than the history gets `event: reset` and a fresh snapshot.
 *
 * Both need `Authorization: Bearer <token>`.
 */
export const WS_PROTOCOL = 'quotes.v1';
export const MAX_FRAME_BYTES = 4 * 1024;
export const MAX_BAD_MESSAGES = 5;
const PAIR = /^[A-Z]{6}$/;

export type RealtimeOptions = { token: string; heartbeatMs?: number; sseRetryMs?: number };
export type RealtimeStats = { wsClients: number; sseClients: number; wsTerminatedForSilence: number };

type Problem = { code: string; message: string };

/** Pairs from a request: 1 … 10, distinct, well-formed, listed. */
function checkPairs(pairs: unknown): string[] | Problem {
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 10)
    return { code: 'bad_pairs', message: 'pairs must list 1 … 10 pairs' };
  if (new Set(pairs).size !== pairs.length) return { code: 'bad_pairs', message: 'pairs must be distinct' };
  for (const p of pairs) {
    if (typeof p !== 'string' || !PAIR.test(p))
      return { code: 'bad_pairs', message: 'a pair is six upper-case letters such as "EURUSD"' };
    if (!QuoteFeed.isKnown(p)) return { code: 'unknown_pair', message: `unknown pair ${p}` };
  }
  return pairs as string[];
}

const quoteJson = (q: Quote) => ({
  type: 'quote',
  pair: q.pair,
  bid: q.bid,
  ask: q.ask,
  seq: q.seq,
  time: q.time.toISOString(),
});

/** Parses an SSE cursor `EURUSD=57,USDJPY=33`; undefined when malformed. */
export function parseCursor(id: string): Map<string, number> | undefined {
  const out = new Map<string, number>();
  for (const part of id.split(',')) {
    const m = /^([A-Z]{6})=(\d{1,15})$/.exec(part);
    if (!m) return undefined;
    out.set(m[1]!, Number(m[2]));
  }
  return out;
}

export function buildRealtimeServer(feed: QuoteFeed, opts: RealtimeOptions) {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const stats: RealtimeStats = { wsClients: 0, sseClients: 0, wsTerminatedForSilence: 0 };
  const authorized = (req: http.IncomingMessage) => req.headers.authorization === `Bearer ${opts.token}`;
  const json = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  // ---------- Server-Sent Events ----------
  function sse(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (!authorized(req))
      return json(res, 401, { code: 'unauthorized', message: 'a Bearer token is required' });
    const accept = req.headers.accept ?? '*/*';
    if (!/text\/event-stream|\*\/\*/.test(accept)) {
      return json(res, 406, {
        code: 'not_acceptable',
        message: 'this endpoint only serves text/event-stream',
      });
    }
    const pairs = checkPairs((url.searchParams.get('pairs') ?? '').split(',').filter(Boolean));
    if (!Array.isArray(pairs)) return json(res, pairs.code === 'unknown_pair' ? 404 : 400, pairs);

    const lastId = req.headers['last-event-id'];
    let cursor: Map<string, number> | undefined;
    if (typeof lastId === 'string' && lastId) {
      cursor = parseCursor(lastId);
      if (!cursor)
        return json(res, 400, {
          code: 'bad_cursor',
          message: 'Last-Event-ID is not a cursor of this stream',
        });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell proxies (nginx) not to buffer the stream
    });
    stats.sseClients++;
    const last = new Map<string, number>();
    const idOf = () => pairs.map((p) => `${p}=${last.get(p) ?? 0}`).join(',');
    const send = (q: Quote) => {
      if ((last.get(q.pair) ?? 0) >= q.seq) return; // never twice, never backwards
      last.set(q.pair, q.seq);
      res.write(`event: quote\nid: ${idOf()}\ndata: ${JSON.stringify(quoteJson(q))}\n\n`);
    };
    res.write(`retry: ${opts.sseRetryMs ?? 1_000}\n\n`);
    for (const p of pairs) {
      const from = cursor?.get(p);
      if (from === undefined) {
        send(feed.current(p)); // first connection: a snapshot
      } else if (from < feed.oldestSeq(p) - 1) {
        // too old to replay: say so, then start from a snapshot
        res.write(`event: reset\ndata: ${JSON.stringify({ type: 'reset', pair: p })}\n\n`);
        send(feed.current(p));
      } else {
        last.set(p, from);
        for (const q of feed.since(p, from)) send(q); // resume: exactly what was missed
      }
    }
    const unsubscribe = feed.subscribe((q) => pairs.includes(q.pair) && send(q));
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), heartbeatMs);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      stats.sseClients--;
    };
    req.on('close', close);
    res.on('close', close);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', ws: stats.wsClients, sse: stats.sseClients });
    }
    if (req.method === 'GET' && url.pathname === '/sse') return sse(req, res, url);
    json(res, 404, { code: 'not_found', message: 'no such endpoint' });
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/ws') return refuse(404, 'Not Found');
    if (!authorized(req)) return refuse(401, 'Unauthorized'); // before the upgrade: no socket for strangers
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    if (ws.protocol !== WS_PROTOCOL) return ws.close(1002, `subprotocol ${WS_PROTOCOL} required`);
    stats.wsClients++;
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const subscribed = new Set<string>();
    const last = new Map<string, number>();
    let bad = 0;
    const out = (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const deliver = (q: Quote) => {
      if ((last.get(q.pair) ?? 0) >= q.seq) return;
      last.set(q.pair, q.seq);
      out(quoteJson(q));
    };
    const error = (p: Problem) => {
      out({ type: 'error', ...p });
      if (++bad >= MAX_BAD_MESSAGES) ws.close(1008, 'too many bad messages');
    };
    const unsubscribe = feed.subscribe((q) => subscribed.has(q.pair) && deliver(q));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return error({ code: 'binary_not_supported', message: 'send JSON text frames' });
      let msg: { type?: unknown; pairs?: unknown; since?: unknown; id?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return error({ code: 'bad_json', message: 'the message is not JSON' });
      }
      if (msg === null || typeof msg !== 'object')
        return error({ code: 'bad_json', message: 'the message must be an object' });
      if (msg.type === 'ping') return out({ type: 'pong', id: msg.id ?? null });
      if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
        const pairs = checkPairs(msg.pairs);
        if (!Array.isArray(pairs)) return error(pairs);
        if (msg.type === 'unsubscribe') {
          pairs.forEach((p) => subscribed.delete(p));
          return out({ type: 'unsubscribed', pairs });
        }
        const since = (msg.since ?? {}) as Record<string, unknown>;
        out({ type: 'subscribed', pairs });
        for (const p of pairs) {
          subscribed.add(p);
          const from = since[p];
          if (typeof from !== 'number') deliver(feed.current(p));
          else if (from < feed.oldestSeq(p) - 1) {
            out({ type: 'reset', pair: p });
            deliver(feed.current(p));
          } else {
            last.set(p, Math.max(last.get(p) ?? 0, from));
            feed.since(p, from).forEach(deliver);
          }
        }
        return;
      }
      error({ code: 'unknown_type', message: `unknown message type ${JSON.stringify(msg.type)}` });
    });
    ws.on('close', () => {
      unsubscribe();
      stats.wsClients--;
    });
    ws.on('error', () => {});
  });

  // Dead-connection detection: ping everyone; whoever did not answer the last ping is dropped.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        stats.wsTerminatedForSilence++;
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, heartbeatMs);

  return {
    server,
    stats,
    listen: (port = 0) =>
      new Promise<number>((resolve) =>
        server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
      ),
    /** Graceful shutdown: WebSocket clients get 1001 "going away", SSE streams end. */
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        for (const ws of wss.clients) ws.close(1001, 'server shutting down');
        server.close(() => resolve());
        // give the close handshakes a moment, then cut SSE streams and stragglers
        setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
          server.closeAllConnections();
        }, 200);
      }),
  };
}

export const KNOWN_PAIRS = Object.keys(PAIRS);
