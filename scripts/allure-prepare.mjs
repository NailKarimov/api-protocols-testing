// Adds report metadata to allure-results before `allure generate`:
// categories (how failures are grouped), environment (what was tested) and executor (where it ran).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';

const dir = 'allure-results';
mkdirSync(dir, { recursive: true });
copyFileSync('allure/categories.json', `${dir}/categories.json`);

const env = process.env;
const lines = {
  'Node.js': process.version,
  OS: process.platform,
  Run: env.CI ? 'GitHub Actions' : 'local',
  Branch: env.GITHUB_REF_NAME ?? 'local',
  Commit: (env.GITHUB_SHA ?? 'local').slice(0, 7),
  Servers: 'in-process per worker (gRPC, WebSocket, SSE)',
  'Feed seed': env.QUOTES_SEED ?? '7',
};
writeFileSync(
  `${dir}/environment.properties`,
  Object.entries(lines)
    .map(([k, v]) => `${k.replace(/ /g, '_')}=${v}`)
    .join('\n') + '\n',
);

if (env.GITHUB_RUN_ID) {
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  writeFileSync(
    `${dir}/executor.json`,
    JSON.stringify({
      name: 'GitHub Actions',
      type: 'github',
      buildName: `Run #${env.GITHUB_RUN_NUMBER}`,
      buildUrl: `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      reportUrl: `https://${env.GITHUB_REPOSITORY_OWNER}.github.io/${env.GITHUB_REPOSITORY?.split('/')[1]}/`,
    }),
  );
}
console.log('Allure metadata written to', dir);
