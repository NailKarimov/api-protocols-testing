import { test, expect } from '../../src/quotes/fixtures';

/** One feed, three protocols: gRPC, WebSocket and SSE must tell the same story for the same seq. */
test(
  'gRPC, WebSocket and SSE deliver identical quotes for the same seq',
  { tag: '@smoke' },
  async ({ quotes, openWs, newSse }) => {
    const ws = await openWs();
    ws.send({ type: 'subscribe', pairs: ['EURUSD'] });
    const sse = await newSse().open('pairs=EURUSD');
    const grpc = await quotes.subscribe(['EURUSD'], 40);
    await ws.until(() => ws.quotes().length >= 30);
    await sse.until(() => sse.quotes().length >= 30);

    const key = (q: { bid: string; ask: string }) => `${q.bid}/${q.ask}`;
    const g = new Map(grpc.messages.map((q) => [q.seq, key(q)]));
    const w = new Map(ws.quotes().map((q) => [q.seq, key(q)]));
    const common = [...g.keys()].filter((s) => w.has(s) && sse.quotes().some((q) => q.seq === s));

    expect(common.length).toBeGreaterThan(10);
    for (const seq of common) {
      expect(w.get(seq)).toBe(g.get(seq));
      expect(key(sse.quotes().find((q) => q.seq === seq)!)).toBe(g.get(seq));
    }
  },
);
