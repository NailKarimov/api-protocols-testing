import { test as base, expect } from '@playwright/test';
import * as allure from 'allure-js-commons';

const OWNER = 'Nail Karimov';

/** Base test with Allure labels; src/quotes/fixtures.ts adds the servers. */
export const test = base.extend<{ allureLabels: void }>({
  allureLabels: [
    // Playwright requires a destructuring pattern for the fixtures argument.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      await allure.owner(OWNER);
      await allure.layer('api');
      await allure.severity(testInfo.tags.includes('@smoke') ? 'critical' : 'normal');
      await allure.epic('FX quotes: gRPC, WebSocket, SSE');
      await use();
    },
    { auto: true },
  ],
});

export { expect };
