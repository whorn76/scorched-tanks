// The game served the way GitHub Pages serves it: static files under a subpath, no relay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RELAY_WS_URL, SHOTS, STATIC_URL, launch, openPage } from './helpers.mjs';
import { playOnline } from './online.mjs';

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

test('on a static host the game loads cleanly and does not assume a relay', async () => {
  const page = await openPage(browser, { name: 'static', url: STATIC_URL });
  await page.waitForSelector('#title-screen');
  // Packaged like the Pages workflow does it: the game lives under v/<version>/.
  const main = await page.evaluate(() => document.querySelector('script[type=module]').src);
  const version = /\/v\/([\w.-]+)\/src\/main\.js$/.exec(main)?.[1];
  assert.ok(version, `the game loads from a versioned folder (${main})`);
  assert.match(await page.textContent('#title-screen .fineprint'), new RegExp(`Version ${version.slice(0, 7)}`));
  await page.waitForFunction(() => window.__scorched.app.demo?.game?.state.round === 1, null, { timeout: 10000 });
  await page.click('#btn-host');
  await page.check('input[name=transport][value=relay]');
  await page.waitForFunction(() => window.__scorched.app.relayChecked);
  assert.equal(await page.inputValue('#relay-url'), '', 'no relay address is made up');
  assert.match(await page.textContent('#relay-hint'), /does not run a relay/);
  await page.click('#btn-create-room');
  await page.waitForFunction(() => document.getElementById('net-status')?.textContent.includes('npm run online'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'static-relay-hint.png') });
  assert.deepEqual(page.errors, [], 'no console errors (not even a 404)');
  await page.context().close();
});

test('an out-of-date copy of the game offers to reload before joining', async () => {
  const page = await openPage(browser, { name: 'stale', url: STATIC_URL });
  // The site has published a newer version since this page loaded.
  await page.route('**/version.json', (route) => route.fulfill({ contentType: 'application/json', body: '{"version":"newer"}' }));
  await page.evaluate(() => (location.hash = '#join=ACEFG'));
  await page.waitForSelector('#join-screen');
  await page.fill('#join-name', 'Stale');
  await page.click('#btn-join-room');
  await page.waitForSelector('#message');
  assert.match(await page.textContent('#message h2'), /Update available/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'static-update-available.png') });
  await Promise.all([page.waitForEvent('load'), page.click('#message .btn.primary')]);
  await page.waitForFunction(() => !!window.__scorched);
  assert.equal(new URL(page.url()).hash, '#join=ACEFG', 'comes back to the same invite');
  await page.waitForSelector('#join-screen');
  assert.equal(await page.inputValue('#join-code'), 'ACEFG');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a game on a static host plays online through a relay hosted somewhere else', async () => {
  const { relayDefault } = await playOnline(browser, { transport: 'relay', label: 'static-relay', turns: 3, baseUrl: STATIC_URL, relayUrl: RELAY_WS_URL });
  assert.equal(relayDefault, '');
});
