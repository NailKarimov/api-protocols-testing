import { test as base, expect } from '../fixtures';
import { QuoteFeed } from '../../services/quotes/src/feed.ts';
import { buildGrpcServer, type GrpcStats } from '../../services/quotes/src/grpc.ts';
import { QuotesClient } from '../grpc/QuotesClient';
import { env } from '../../config/env';

/** A separate feed and gRPC server, for tests that need their own market (a quiet one, say). Call close(). */
export async function startQuotes(
  feedOpts: ConstructorParameters<typeof QuoteFeed>[0] & { ticking?: boolean } = {},
) {
  const feed = new QuoteFeed({ seed: env.seed, tickMs: 20, ...feedOpts });
  if (feedOpts.ticking !== false) feed.start();
  const server = buildGrpcServer(feed, { token: TEST_TOKEN });
  const port = await server.listen();
  const client = new QuotesClient(`127.0.0.1:${port}`, TEST_TOKEN);
  return {
    feed,
    client,
    close: async () => {
      client.close();
      await server.close();
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
};

/**
 * One quote feed and one gRPC server per Playwright worker, in-process on a free port. The feed ticks every
 * 20 ms, so streaming tests get hundreds of updates in seconds. Tests read the feed directly as an oracle
 * (which price was current at seq N).
 */
export const test = base.extend<
  { quotes: QuotesClient; feed: QuoteFeed; grpcStats: GrpcStats; quotesEnv: QuotesEnv },
  { quotesWorker: QuotesEnv }
>({
  quotesWorker: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const feed = new QuoteFeed({ seed: env.seed, tickMs: 20 }).start();
      const grpcServer = buildGrpcServer(feed, { token: TEST_TOKEN });
      const port = await grpcServer.listen();
      await use({
        feed,
        grpcAddress: `127.0.0.1:${port}`,
        grpcStats: grpcServer.stats,
        health: grpcServer.health,
      });
      await grpcServer.close();
      feed.stop();
    },
    { scope: 'worker' },
  ],
  quotesEnv: async ({ quotesWorker }, use) => use(quotesWorker),
  feed: async ({ quotesWorker }, use) => use(quotesWorker.feed),
  grpcStats: async ({ quotesWorker }, use) => use(quotesWorker.grpcStats),
  quotes: async ({ quotesWorker }, use) => {
    const client = new QuotesClient(quotesWorker.grpcAddress, TEST_TOKEN);
    await use(client);
    client.close();
  },
});

export { expect };
