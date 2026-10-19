import { test as base, expect } from '../fixtures';
import { QuoteFeed } from '../../services/quotes/src/feed.ts';
import { buildGrpcServer, type GrpcStats } from '../../services/quotes/src/grpc.ts';
import { QuotesClient } from '../grpc/QuotesClient';
import { buildRealtimeServer, type RealtimeStats } from '../../services/quotes/src/realtime.ts';
import { WsClient, type WsOptions } from '../realtime/WsClient';
import { SseClient } from '../realtime/SseClient';
import { env } from '../../config/env';

/**
 * A separate feed with its own gRPC and HTTP (WebSocket + SSE) servers, for tests that need their own market:
 * a quiet one, a short history, a server to shut down. Call close().
 */
export async function startQuotes(
  feedOpts: ConstructorParameters<typeof QuoteFeed>[0] & { ticking?: boolean; heartbeatMs?: number } = {},
) {
  const feed = new QuoteFeed({ seed: env.seed, tickMs: 20, ...feedOpts });
  if (feedOpts.ticking !== false) feed.start();
  const server = buildGrpcServer(feed, { token: TEST_TOKEN });
  const port = await server.listen();
  const realtime = buildRealtimeServer(feed, { token: TEST_TOKEN, heartbeatMs: feedOpts.heartbeatMs ?? 200 });
  const httpBase = `http://127.0.0.1:${await realtime.listen()}`;
  const client = new QuotesClient(`127.0.0.1:${port}`, TEST_TOKEN);
  let realtimeOpen = true;
  const closeRealtime = async () => {
    if (realtimeOpen) await realtime.close();
    realtimeOpen = false;
  };
  return {
    feed,
    client,
    httpBase,
    realtime,
    ws: () => new WsClient(`${httpBase.replace('http', 'ws')}/ws`, TEST_TOKEN),
    sse: () => new SseClient(httpBase, TEST_TOKEN),
    closeRealtime,
    close: async () => {
      client.close();
      await server.close();
      await closeRealtime();
      feed.stop();
    },
  };
}

/** Test value of the in-process server; it guards nothing outside a test run. */
export const TEST_TOKEN = 'test-only-quotes-token';

type QuotesEnv = {
  feed: QuoteFeed;
  grpcAddress: string;
  grpcStats: GrpcStats;
  health: ReturnType<typeof buildGrpcServer>['health'];
  httpBase: string;
  realtimeStats: RealtimeStats;
};

/**
 * One quote feed, one gRPC server and one HTTP server (WebSocket + SSE) per Playwright worker, in-process on a free port. The feed ticks every
 * 20 ms, so streaming tests get hundreds of updates in seconds. Tests read the feed directly as an oracle
 * (which price was current at seq N).
 */
export const test = base.extend<
  {
    quotes: QuotesClient;
    feed: QuoteFeed;
    grpcStats: GrpcStats;
    quotesEnv: QuotesEnv;
    realtimeStats: RealtimeStats;
    /** Opens a WebSocket client; closed and attached to the report after the test. */
    openWs: (opts?: WsOptions) => Promise<WsClient>;
    /** An SSE client; closed and attached to the report after the test. */
    newSse: () => SseClient;
  },
  { quotesWorker: QuotesEnv }
>({
  quotesWorker: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const feed = new QuoteFeed({ seed: env.seed, tickMs: 20 }).start();
      const grpcServer = buildGrpcServer(feed, { token: TEST_TOKEN });
      const port = await grpcServer.listen();
      // heartbeat 200 ms: dead connections are found within half a second
      const realtime = buildRealtimeServer(feed, { token: TEST_TOKEN, heartbeatMs: 200 });
      const httpPort = await realtime.listen();
      await use({
        feed,
        grpcAddress: `127.0.0.1:${port}`,
        grpcStats: grpcServer.stats,
        health: grpcServer.health,
        httpBase: `http://127.0.0.1:${httpPort}`,
        realtimeStats: realtime.stats,
      });
      await grpcServer.close();
      await realtime.close();
      feed.stop();
    },
    { scope: 'worker' },
  ],
  quotesEnv: async ({ quotesWorker }, use) => use(quotesWorker),
  feed: async ({ quotesWorker }, use) => use(quotesWorker.feed),
  grpcStats: async ({ quotesWorker }, use) => use(quotesWorker.grpcStats),
  realtimeStats: async ({ quotesWorker }, use) => use(quotesWorker.realtimeStats),
  openWs: async ({ quotesWorker }, use) => {
    const opened: WsClient[] = [];
    await use(async (opts) => {
      const c = new WsClient(`${quotesWorker.httpBase.replace('http', 'ws')}/ws`, TEST_TOKEN);
      opened.push(c);
      return c.connect(opts);
    });
    for (const [i, c] of opened.entries()) {
      await c.close();
      await c.attach(`WebSocket transcript ${i + 1}`);
    }
  },
  newSse: async ({ quotesWorker }, use) => {
    const opened: SseClient[] = [];
    await use(() => {
      const c = new SseClient(quotesWorker.httpBase, TEST_TOKEN);
      opened.push(c);
      return c;
    });
    for (const [i, c] of opened.entries()) {
      c.close();
      await c.attach(`SSE transcript ${i + 1}`);
    }
  },
  quotes: async ({ quotesWorker }, use) => {
    const client = new QuotesClient(quotesWorker.grpcAddress, TEST_TOKEN);
    await use(client);
    client.close();
  },
});

export { expect };
