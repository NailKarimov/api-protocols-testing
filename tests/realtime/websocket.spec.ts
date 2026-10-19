import { test, expect, startQuotes } from '../../src/quotes/fixtures';
import { quoteProblems, seqGaps } from '../../src/quotes/invariants';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** WebSocket /ws: the handshake, the message protocol, errors, heartbeats, reconnect and resume. */
test.describe('WebSocket', () => {
  test(
    'subscribe: an ack, a snapshot of each pair, then live quotes without gaps',
    { tag: '@smoke' },
    async ({ openWs }) => {
      const ws = await openWs();
      expect(ws.protocol).toBe('quotes.v1');
      ws.send({ type: 'subscribe', pairs: ['EURUSD', 'USDJPY'] });
      await ws.until(() => ws.quotes().length >= 30, 5_000, '30 quotes');

      expect(ws.messages[0]).toEqual({ type: 'subscribed', pairs: ['EURUSD', 'USDJPY'] });
      expect(ws.messages.slice(1, 3).map((m) => m.pair)).toEqual(['EURUSD', 'USDJPY']);
      expect(seqGaps(ws.quotes())).toEqual([]);
      expect(ws.quotes().flatMap(quoteProblems)).toEqual([]);
    },
  );

  test('handshake without a token → HTTP 401, no socket; unknown path → 404', async ({
    openWs,
    quotesEnv,
  }) => {
    const anon = await openWs({ token: null });
    expect(anon.handshake?.status).toBe(401);

    const { WsClient } = await import('../../src/realtime/WsClient');
    const wrong = await new WsClient(`${quotesEnv.httpBase.replace('http', 'ws')}/nope`, 'x').connect();
    expect(wrong.handshake?.status).toBe(404);
  });

  test('subprotocol: only quotes.v1 is spoken; offering another fails, offering none is closed with 1002', async ({
    openWs,
  }) => {
    const other = await openWs({ protocols: ['quotes.v2'] });
    const none = await openWs({ protocols: [] });

    expect(other.handshake?.error).toMatch(/subprotocol/i);
    await none.until(() => !!none.closed, 2_000, 'close');
    expect(none.closed?.code).toBe(1002);
  });

  test('application ping → pong with the same id', async ({ openWs }) => {
    const ws = await openWs();
    ws.send({ type: 'ping', id: 7 });
    await ws.until(() => ws.ofType('pong').length > 0);
    expect(ws.ofType('pong')[0]).toEqual({ type: 'pong', id: 7 });
  });

  const bad: [string, string | Buffer, string][] = [
    ['not JSON', '{oops', 'bad_json'],
    ['JSON but not an object', '42', 'bad_json'],
    ['an unknown type', JSON.stringify({ type: 'buy' }), 'unknown_type'],
    ['an unknown pair', JSON.stringify({ type: 'subscribe', pairs: ['ABCDEF'] }), 'unknown_pair'],
    ['11 pairs', JSON.stringify({ type: 'subscribe', pairs: Array(11).fill('EURUSD') }), 'bad_pairs'],
    ['a binary frame', Buffer.from([1, 2, 3]), 'binary_not_supported'],
  ];
  for (const [name, frame, code] of bad) {
    test(`${name} → error ${code}, and the connection stays usable`, async ({ openWs }) => {
      const ws = await openWs();
      if (Buffer.isBuffer(frame)) ws.sendBinary(frame);
      else ws.send(frame);
      ws.send({ type: 'ping', id: 1 });
      await ws.until(() => ws.ofType('pong').length > 0);

      expect(ws.ofType('error')[0]).toMatchObject({ type: 'error', code });
      expect(ws.closed).toBeUndefined();
    });
  }

  test('the 5th bad message closes the connection with 1008 (policy violation)', async ({ openWs }) => {
    const ws = await openWs();
    for (let i = 0; i < 5; i++) ws.send('{oops');
    await ws.until(() => !!ws.closed, 2_000, 'close');

    expect(ws.ofType('error')).toHaveLength(5);
    expect(ws.closed).toEqual({ code: 1008, reason: 'too many bad messages' });
  });

  test('a frame over 4 KiB closes the connection with 1009 (message too big)', async ({ openWs }) => {
    const ws = await openWs();
    ws.send({ type: 'ping', id: 'x'.repeat(5_000) });
    await ws.until(() => !!ws.closed, 2_000, 'close');
    expect(ws.closed?.code).toBe(1009);
  });

  test('unsubscribe: no more quotes of that pair', async ({ openWs }) => {
    const ws = await openWs();
    ws.send({ type: 'subscribe', pairs: ['EURUSD', 'GBPUSD'] });
    await ws.until(() => ws.quotes('GBPUSD').length >= 3);
    ws.send({ type: 'unsubscribe', pairs: ['GBPUSD'] });
    await ws.until(() => ws.ofType('unsubscribed').length > 0);
    const after = ws.quotes('GBPUSD').length;
    await ws
      .until(() => ws.quotes('EURUSD').length >= ws.quotes('EURUSD').length + 10 || false, 400)
      .catch(() => {});
    await sleep(300); // 15 more ticks: GBPUSD would have arrived by now

    expect(ws.quotes('GBPUSD')).toHaveLength(after);
    expect(ws.quotes('EURUSD').length).toBeGreaterThan(5);
  });

  test('reconnect with since: the missed quotes are replayed, no gap and no duplicate', async ({
    openWs,
  }) => {
    const first = await openWs();
    first.send({ type: 'subscribe', pairs: ['EURUSD'] });
    await first.until(() => first.quotes().length >= 5);
    first.drop(); // the network goes away without a close frame
    const lastSeq = first.quotes().at(-1)!.seq;
    await sleep(300); // ~15 quotes are produced meanwhile

    const second = await openWs();
    second.send({ type: 'subscribe', pairs: ['EURUSD'], since: { EURUSD: lastSeq } });
    await second.until(() => second.quotes().length >= 10);

    expect(second.quotes()[0]!.seq).toBe(lastSeq + 1);
    expect(seqGaps([...first.quotes(), ...second.quotes()])).toEqual([]);
  });

  test('since older than the history → reset, then a fresh snapshot', async () => {
    const small = await startQuotes({ historySize: 5 });
    const ws = small.ws();
    try {
      await ws.connect();
      await new Promise((r) => setTimeout(r, 300)); // far more than 5 ticks
      ws.send({ type: 'subscribe', pairs: ['EURUSD'], since: { EURUSD: 1 } });
      await ws.until(() => ws.quotes().length >= 1);

      expect(ws.messages[1]).toEqual({ type: 'reset', pair: 'EURUSD' });
      expect(ws.quotes()[0]!.seq).toBeGreaterThan(5);
    } finally {
      await ws.close();
      await ws.attach();
      await small.close();
    }
  });

  test('heartbeat: a client that never answers pings is dropped; one that does stays', async ({
    openWs,
    realtimeStats,
  }) => {
    const before = realtimeStats.wsTerminatedForSilence;
    const silent = await openWs({ autoPong: false });
    const healthy = await openWs();
    await silent.until(() => !!silent.closed, 3_000, 'the silent client to be dropped');

    expect(silent.closed?.code).toBe(1006); // terminated: no close frame
    expect(realtimeStats.wsTerminatedForSilence).toBeGreaterThan(before);
    expect(healthy.closed).toBeUndefined();
    expect(healthy.log.some((l) => l.endsWith('← ping'))).toBe(true);
  });

  test('server shutdown: clients get 1001 going away', async () => {
    const own = await startQuotes();
    const ws = own.ws();
    try {
      await ws.connect();
      await own.closeRealtime();
      await ws.until(() => !!ws.closed, 2_000, 'close');
      expect(ws.closed).toEqual({ code: 1001, reason: 'server shutting down' });
    } finally {
      await ws.attach();
      await own.close();
    }
  });

  test('fan-out: 20 clients see exactly the same prices for the same seq', async ({ openWs }) => {
    const clients = await Promise.all(Array.from({ length: 20 }, () => openWs()));
    clients.forEach((c) => c.send({ type: 'subscribe', pairs: ['USDCHF'] }));
    await Promise.all(clients.map((c) => c.until(() => c.quotes().length >= 15, 5_000)));

    const bySeq = new Map<number, string>();
    for (const c of clients)
      for (const q of c.quotes()) {
        const seen = bySeq.get(q.seq);
        if (seen) expect(`${q.bid}/${q.ask}`).toBe(seen);
        else bySeq.set(q.seq, `${q.bid}/${q.ask}`);
      }
    clients.forEach((c) => expect(seqGaps(c.quotes())).toEqual([]));
  });

  test('closed clients release their subscriptions on the server', async ({
    openWs,
    realtimeStats,
    feed,
  }) => {
    const baseClients = realtimeStats.wsClients;
    const baseListeners = feed.subscribers;
    const clients = await Promise.all(Array.from({ length: 5 }, () => openWs()));
    expect(realtimeStats.wsClients).toBe(baseClients + 5);
    await Promise.all(clients.map((c) => c.close()));

    await expect.poll(() => realtimeStats.wsClients).toBe(baseClients);
    await expect.poll(() => feed.subscribers).toBe(baseListeners);
  });
});
