import { test, expect, startQuotes } from '../../src/quotes/fixtures';
import { quoteProblems, seqGaps } from '../../src/quotes/invariants';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Server-Sent Events /sse: the stream format, cursors, resume with Last-Event-ID, heartbeats, errors. */
test.describe('Server-Sent Events', () => {
  test(
    'the stream: SSE headers, retry first, a snapshot per pair, quotes without gaps',
    { tag: '@smoke' },
    async ({ newSse }) => {
      const sse = await newSse().open('pairs=EURUSD,USDJPY');
      await sse.until(() => sse.quotes().length >= 30, 5_000, '30 quotes');

      expect(sse.status).toBe(200);
      expect(sse.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      expect(sse.headers['cache-control']).toBe('no-cache');
      expect(sse.headers['x-accel-buffering']).toBe('no');
      expect(sse.retry).toBe(1_000);
      expect(
        sse
          .quotes()
          .slice(0, 2)
          .map((q) => q.pair),
      ).toEqual(['EURUSD', 'USDJPY']);
      expect(seqGaps(sse.quotes())).toEqual([]);
      expect(sse.quotes().flatMap(quoteProblems)).toEqual([]);
    },
  );

  test('every event id is a cursor of all pairs: EURUSD=<seq>,USDJPY=<seq>', async ({ newSse }) => {
    const sse = await newSse().open('pairs=EURUSD,USDJPY');
    await sse.until(() => sse.quotes().length >= 10);
    sse.close();
    const last = (p: string) => sse.quotes(p).at(-1)!.seq;

    expect(sse.lastEventId).toBe(`EURUSD=${last('EURUSD')},USDJPY=${last('USDJPY')}`);
  });

  test('reconnect with Last-Event-ID: exactly the missed quotes, nothing twice', async ({ newSse }) => {
    const first = await newSse().open('pairs=EURUSD,GBPUSD');
    await first.until(() => first.quotes().length >= 6);
    first.close();
    await sleep(300); // the market moves on
    const second = await newSse().open('pairs=EURUSD,GBPUSD', { lastEventId: first.lastEventId });
    await second.until(() => second.quotes().length >= 10);

    const lastBefore = first.quotes('EURUSD').at(-1)!.seq;
    expect(second.quotes('EURUSD')[0]!.seq).toBe(lastBefore + 1);
    expect(seqGaps([...first.quotes(), ...second.quotes()])).toEqual([]);
  });

  test('a cursor older than the history → event reset, then a snapshot', async () => {
    const small = await startQuotes({ historySize: 5 });
    const sse = small.sse();
    try {
      await sleep(300);
      await sse.open('pairs=EURUSD', { lastEventId: 'EURUSD=1' });
      await sse.until(() => sse.quotes().length >= 1);

      expect(sse.events[0]).toMatchObject({ event: 'reset', json: { type: 'reset', pair: 'EURUSD' } });
      expect(sse.quotes()[0]!.seq).toBeGreaterThan(5);
    } finally {
      sse.close();
      await sse.attach();
      await small.close();
    }
  });

  test('heartbeat comments keep an idle connection alive through proxies', async ({ newSse }) => {
    const sse = await newSse().open('pairs=EURUSD');
    await sse.until(() => sse.comments.length >= 2, 2_000, 'two heartbeats');
    expect(sse.comments.slice(0, 2)).toEqual(['ping', 'ping']);
  });

  const refused: [string, string, Record<string, string | null>, number, string][] = [
    ['no token', 'pairs=EURUSD', { token: null }, 401, 'unauthorized'],
    ['Accept: application/json', 'pairs=EURUSD', { accept: 'application/json' }, 406, 'not_acceptable'],
    ['no pairs', 'pairs=', {}, 400, 'bad_pairs'],
    ['an unknown pair', 'pairs=EURUSD,ABCDEF', {}, 404, 'unknown_pair'],
    ['a malformed Last-Event-ID', 'pairs=EURUSD', { lastEventId: 'yesterday' }, 400, 'bad_cursor'],
  ];
  for (const [name, query, opts, status, code] of refused) {
    test(`refused: ${name} → ${status} ${code} as JSON, not a stream`, async ({ newSse }) => {
      const sse = await newSse().open(query, opts as never);

      expect(sse.status).toBe(status);
      expect(sse.headers['content-type']).toBe('application/json');
      expect(JSON.parse(sse.body)).toMatchObject({ code });
    });
  }

  test('a closed tab releases the server-side subscription', async ({ newSse, realtimeStats, feed }) => {
    const baseClients = realtimeStats.sseClients;
    const baseListeners = feed.subscribers;
    const streams = await Promise.all(Array.from({ length: 5 }, () => newSse().open('pairs=EURUSD')));
    expect(realtimeStats.sseClients).toBe(baseClients + 5);
    streams.forEach((s) => s.close());

    await expect.poll(() => realtimeStats.sseClients).toBe(baseClients);
    await expect.poll(() => feed.subscribers).toBe(baseListeners);
  });

  test('server shutdown ends the stream', async () => {
    const own = await startQuotes();
    const sse = own.sse();
    try {
      await sse.open('pairs=EURUSD');
      await sse.until(() => sse.quotes().length >= 1);
      await own.closeRealtime();
      await sse.until(() => sse.ended, 2_000, 'the stream to end');
      expect(sse.ended).toBe(true);
    } finally {
      await sse.attach();
      await own.close();
    }
  });
});
