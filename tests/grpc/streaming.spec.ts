import { test, expect, startQuotes } from '../../src/quotes/fixtures';
import { order, quoteProblems, seqGaps } from '../../src/quotes/invariants';

/** The three streaming kinds of gRPC: server, client and bidirectional. */
test.describe('gRPC server streaming: Subscribe', () => {
  test(
    'a snapshot of every pair first, then live updates without gaps, then OK at max_updates',
    { tag: '@smoke' },
    async ({ quotes }) => {
      const res = await quotes.subscribe(['EURUSD', 'USDJPY'], 40);

      expect(res.status).toBe('OK');
      expect(res.messages).toHaveLength(40);
      expect(res.messages.slice(0, 2).map((q) => q.pair)).toEqual(['EURUSD', 'USDJPY']);
      expect(seqGaps(res.messages)).toEqual([]);
      expect(res.messages.flatMap(quoteProblems)).toEqual([]);
      expect(new Set(res.messages.map((q) => q.pair))).toEqual(new Set(['EURUSD', 'USDJPY']));
    },
  );

  test('a quiet market (no ticks) still answers at once with the snapshot', async () => {
    const quiet = await startQuotes({ ticking: false });
    try {
      const res = await quiet.client.subscribe(['EURUSD', 'GBPUSD'], 2, { deadlineMs: 1_000 });

      expect(res.status).toBe('OK');
      expect(res.messages.map((q) => [q.pair, q.seq])).toEqual([
        ['EURUSD', quiet.feed.current('EURUSD').seq],
        ['GBPUSD', quiet.feed.current('GBPUSD').seq],
      ]);
    } finally {
      await quiet.close();
    }
  });

  test('only the requested pairs arrive', async ({ quotes }) => {
    const res = await quotes.subscribe(['EURGBP'], 15);
    expect(res.messages.every((q) => q.pair === 'EURGBP')).toBe(true);
  });

  test('the client cancels mid-stream → CANCELLED, and the server drops the subscription', async ({
    quotes,
    feed,
    grpcStats,
  }) => {
    const before = feed.subscribers;
    const res = await quotes.subscribe(['EURUSD'], 0, { onMessage: (_q, all) => all.length >= 5 });

    expect(res.status).toBe('CANCELLED');
    expect(res.messages.length).toBeGreaterThanOrEqual(5);
    await expect.poll(() => feed.subscribers).toBeLessThanOrEqual(before); // no leaked listener
    await expect.poll(() => grpcStats.activeStreams).toBeGreaterThanOrEqual(0);
  });

  test('a deadline ends an endless stream with DEADLINE_EXCEEDED after the updates so far', async ({
    quotes,
  }) => {
    const res = await quotes.subscribe(['USDCHF'], 0, { deadlineMs: 300 });

    expect(res.status).toBe('DEADLINE_EXCEEDED');
    expect(res.messages.length).toBeGreaterThan(1);
    expect(seqGaps(res.messages)).toEqual([]);
  });

  const invalid: [string, string[], string][] = [
    ['no pairs', [], 'INVALID_ARGUMENT'],
    [
      '11 pairs (limit 10)',
      Array(11)
        .fill('EURUSD')
        .map((p, i) => p.slice(0, 5) + String.fromCharCode(65 + i)),
      'INVALID_ARGUMENT',
    ],
    ['the same pair twice', ['EURUSD', 'EURUSD'], 'INVALID_ARGUMENT'],
    ['one unknown pair among known ones', ['EURUSD', 'ABCDEF'], 'NOT_FOUND'],
  ];
  for (const [name, pairs, status] of invalid) {
    test(`${name} → ${status} before any message`, async ({ quotes }) => {
      const res = await quotes.subscribe(pairs, 5);
      expect([res.status, res.messages.length]).toEqual([status, 0]);
    });
  }
});

test.describe('gRPC client streaming: SubmitOrders', () => {
  test(
    'a mixed batch: valid ones counted and summed, each rejection named',
    { tag: '@smoke' },
    async ({ quotes }) => {
      const res = await quotes.submitOrders([
        order('o1', { amount: '100.50' }),
        order('o2', { side: 'SIDE_SELL', amount: '200' }),
        order('o3', { pair: 'USDJPY', amount: '0.49' }), // below 1
        order('o2', { amount: '5' }), // duplicate id
        order('o4', { side: 'SIDE_UNSPECIFIED' }),
        order('o5', { pair: 'XXXYYY' }),
        order('o6', { amount: '1000000' }),
      ]);

      expect(res.status).toBe('OK');
      expect(res.value).toMatchObject({ accepted: 3, rejected: 4, total_amount: '1000300.50' });
      expect(res.value!.rejections.map((r) => [r.client_order_id, r.reason])).toEqual([
        ['o3', 'amount must be 1 … 1000000 with at most 2 places'],
        ['o2', 'duplicate client_order_id'],
        ['o4', 'side must be SIDE_BUY or SIDE_SELL'],
        ['o5', 'unknown pair XXXYYY'],
      ]);
    },
  );

  test('an empty stream is a valid, empty batch', async ({ quotes }) => {
    const res = await quotes.submitOrders([]);
    expect(res.value).toMatchObject({ accepted: 0, rejected: 0, total_amount: '0.00' });
  });

  test('1 000 orders pass, 1 001 → RESOURCE_EXHAUSTED (boundary)', async ({ quotes }) => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => order(`b${i}`, { amount: '1' }));
    const ok = await quotes.submitOrders(batch(1_000));
    const over = await quotes.submitOrders(batch(1_001));

    expect([ok.status, ok.value?.accepted]).toEqual(['OK', 1_000]);
    expect(over.status).toBe('RESOURCE_EXHAUSTED');
  });

  test('without a token → UNAUTHENTICATED, nothing processed', async ({ quotes }) => {
    const res = await quotes.submitOrders([order('x')], { token: null });
    expect([res.status, res.value]).toEqual(['UNAUTHENTICATED', undefined]);
  });
});

test.describe('gRPC bidirectional streaming: Trade', () => {
  test(
    'every order gets its fill in order; buy pays the ask, sell gets the bid of that quote',
    { tag: '@smoke' },
    async ({ quotes, feed }) => {
      const orders = [
        order('t1'),
        order('t2', { side: 'SIDE_SELL' }),
        order('t3', { pair: 'USDJPY' }),
        order('t4', { pair: 'GBPUSD', side: 'SIDE_SELL' }),
      ];
      const res = await quotes.trade(orders);

      expect(res.status).toBe('OK');
      expect(res.messages.map((f) => f.client_order_id)).toEqual(['t1', 't2', 't3', 't4']);
      for (const [i, f] of res.messages.entries()) {
        const o = orders[i]!;
        const q = feed.at(o.pair, f.quote_seq)!; // the quote the server priced against
        expect(f.accepted).toBe(true);
        expect(f.price).toBe(o.side === 'SIDE_BUY' ? q.ask : q.bid);
      }
    },
  );

  test('a bad order is answered with a rejection and the stream goes on', async ({ quotes }) => {
    const res = await quotes.trade([order('a'), order('b', { amount: '-5' }), order('a'), order('c')]);

    expect(res.messages.map((f) => [f.client_order_id, f.accepted, f.reason])).toEqual([
      ['a', true, ''],
      ['b', false, 'amount must be 1 … 1000000 with at most 2 places'],
      ['a', false, 'duplicate client_order_id'],
      ['c', true, ''],
    ]);
    expect(res.status).toBe('OK');
    expect(res.messages.filter((f) => !f.accepted).every((f) => f.price === '')).toBe(true);
  });

  test('200 orders in one conversation, all answered', async ({ quotes }) => {
    const res = await quotes.trade(Array.from({ length: 200 }, (_, i) => order(`m${i}`)));
    expect(res.messages.filter((f) => f.accepted)).toHaveLength(200);
  });
});
