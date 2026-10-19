import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 2,
  timeout: 30_000,
  reporter: [[isCI ? 'github' : 'list'], ['html', { open: 'never' }], ['allure-playwright']],
  projects: [
    // gRPC: quotes.v1.QuoteService in-process per worker (docs/grpc.md).
    { name: 'grpc', testDir: './tests/grpc' },
    // The .proto contract: buf breaking against the approved snapshot, with a self-test of typical edits.
    { name: 'contract', testDir: './tests/contract' },
  ],
});
