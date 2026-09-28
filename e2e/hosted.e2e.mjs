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
  await page.waitForFunction(() => window.__scorched.app.demo?.game?.state.round === 1, null, { timeout: 10000 });
  await page.click('#btn-host');
  await page.check('input[name=transport][value=relay]');
  await page.waitForFunction(() => window.__scorched.app.relayChecked);
  assert.equal(await page.inputValue('#relay-url'), '', 'no relay address is made up');
  assert.match(await page.textContent('#relay-hint'), /does not run a relay/);
  await page.click('#btn-create-room');
  await page.waitForFunction(() => document.getElementById('net-status')?.textContent.includes('npm start'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'static-relay-hint.png') });
  assert.deepEqual(page.errors, [], 'no console errors (not even a 404)');
  await page.context().close();
});

test('a game on a static host plays online through a relay hosted somewhere else', async () => {
  const { relayDefault } = await playOnline(browser, { transport: 'relay', label: 'static-relay', turns: 3, baseUrl: STATIC_URL, relayUrl: RELAY_WS_URL });
  assert.equal(relayDefault, '');
});
