// Runs the browser tests: makes sure Playwright's Chromium is installed, starts the game server
// (with the relay) on a free port, runs e2e/*.e2e.mjs with Node's test runner, then shuts down.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run "npm install" first.');
  process.exit(1);
}

if (!existsSync(chromium.executablePath())) {
  console.log('Installing Chromium for Playwright…');
  const result = spawnSync('npx', ['playwright', 'install', 'chromium'], { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const { startServer } = await import('../server/server.js');
const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
if (!server.relay) {
  console.error('The relay needs the "ws" package. Run "npm install" first.');
  await server.close();
  process.exit(1);
}
const baseUrl = `http://127.0.0.1:${server.port}/`;
mkdirSync(join(root, 'test-results', 'e2e'), { recursive: true });
console.log(`Game server at ${baseUrl}`);

const files = readdirSync(here)
  .filter((f) => f.endsWith('.e2e.mjs'))
  .map((f) => join(here, f));
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, E2E_BASE_URL: baseUrl },
});
const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
await server.close();
console.log(`Screenshots are in ${join('test-results', 'e2e')}`);
process.exit(code);
