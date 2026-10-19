import { test, expect, TEST_TOKEN } from '../../src/quotes/fixtures';
import { quoteProblems, timestamp } from '../../src/quotes/invariants';

/** Unary GetQuote: the response contract and the status codes, the gRPC equivalent of HTTP statuses. */
test.describe('gRPC unary: GetQuote', () => {
  test(
    'a quote has the contract: decimals per pair, bid < ask, 1–3 pip spread, fresh time',
    { tag: '@smoke' },
    async ({ quotes }) => {
      for (const pair of ['EURUSD', 'USDJPY']) {
        const res = await quotes.getQuote(pair);

        expect(res.status).toBe('OK');
        expect(res.value!.pair).toBe(pair);
        expect(quoteProblems(res.value!)).toEqual([]);
        const t = timestamp.parse(res.value!.time);
        expect(Math.abs(t.seconds * 1000 - Date.now())).toBeLessThan(5_000);
      }
      expect((await quotes.getQuote('USDJPY')).value!.bid).toMatch(/^\d+\.\d{3}$/);
    },
  );

  test('the report shows the call but never the token', async ({ quotes }) => {
    await quotes.getQuote('EURUSD');
    const bodies = test.info().attachments.map((a) => String(a.body));

    expect(bodies.join('\n')).toContain('GetQuote');
    expect(bodies.join('\n')).not.toContain(TEST_TOKEN);
  });

  test('two calls in a row: seq never goes back', async ({ quotes }) => {
    const a = await quotes.getQuote('GBPUSD');
    const b = await quotes.getQuote('GBPUSD');
    expect(b.value!.seq).toBeGreaterThanOrEqual(a.value!.seq);
  });

  const invalid = ['eurusd', 'EUR/USD', 'EURUSDX', 'EUR', '', 'EURUS1'];
  for (const pair of invalid) {
    test(`pair "${pair}" → INVALID_ARGUMENT, no quote`, async ({ quotes }) => {
      const res = await quotes.getQuote(pair);

      expect(res.status).toBe('INVALID_ARGUMENT');
      expect(res.details).toContain('six upper-case letters');
      expect(res.value).toBeUndefined();
    });
  }

  test('a well-formed but unlisted pair → NOT_FOUND', async ({ quotes }) => {
    const res = await quotes.getQuote('ABCDEF');
    expect([res.status, res.details]).toEqual(['NOT_FOUND', 'unknown pair ABCDEF']);
  });

  test('no token or a wrong token → UNAUTHENTICATED', async ({ quotes }) => {
    const none = await quotes.getQuote('EURUSD', { token: null });
    const wrong = await quotes.getQuote('EURUSD', { token: 'guess' });

    expect(none.status).toBe('UNAUTHENTICATED');
    expect(wrong.status).toBe('UNAUTHENTICATED');
    expect(wrong.value).toBeUndefined();
  });

  test('x-request-id is echoed in the response headers and trailers', async ({ quotes }) => {
    const res = await quotes.getQuote('EURUSD', { requestId: 'req-42' });
    expect([res.headers['x-request-id'], res.trailers['x-request-id']]).toEqual(['req-42', 'req-42']);
  });

  test('deadline shorter than the work → DEADLINE_EXCEEDED on time, and the server stops working', async ({
    quotes,
    grpcStats,
  }) => {
    const before = grpcStats.delayedCallsAbandoned;
    const res = await quotes.getQuote('EURUSD', { delayMs: 2_000, deadlineMs: 200 });

    expect(res.status).toBe('DEADLINE_EXCEEDED');
    expect(res.durationMs).toBeLessThan(1_000); // the client did not wait for the 2 s of work
    await expect.poll(() => grpcStats.delayedCallsAbandoned).toBeGreaterThan(before); // the server noticed
  });

  test('deadline longer than the work → OK (boundary pair: 100 ms work, 1 s deadline)', async ({
    quotes,
  }) => {
    const res = await quotes.getQuote('EURUSD', { delayMs: 100, deadlineMs: 1_000 });
    expect(res.status).toBe('OK');
    expect(res.durationMs).toBeGreaterThanOrEqual(100);
  });

  test('delay_ms above 10 000 → INVALID_ARGUMENT (boundary)', async ({ quotes }) => {
    expect((await quotes.getQuote('EURUSD', { delayMs: 10_001 })).status).toBe('INVALID_ARGUMENT');
  });

  test('a request over 64 KiB → RESOURCE_EXHAUSTED from the transport', async ({ quotes }) => {
    const res = await quotes.getQuote('E'.repeat(70 * 1024));
    expect(res.status).toBe('RESOURCE_EXHAUSTED');
  });

  test('an unknown method → UNIMPLEMENTED', async ({ quotes }) => {
    const res = await new Promise<{ code: number }>((resolve) => {
      quotes.raw.makeUnaryRequest(
        '/quotes.v1.QuoteService/DeleteEverything',
        () => Buffer.alloc(0),
        (b: Buffer) => b,
        {},
        quotes.metadata(),
        (err) => resolve({ code: err?.code ?? 0 }),
      );
    });
    expect(res.code).toBe(12); // UNIMPLEMENTED
  });
});
