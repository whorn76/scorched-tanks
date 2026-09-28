import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_WS_URL, launch } from './helpers.mjs';
import { playOnline } from './online.mjs';

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

test('two browsers play online through the relay server the page came from', async () => {
  // Like "npm start" behind cloudflared or on Render: the relay is this site's own.
  const { relayDefault } = await playOnline(browser, { transport: 'relay', label: 'relay', turns: 4 });
  assert.equal(relayDefault, RELAY_WS_URL, 'the relay field is filled in with this site');
});
