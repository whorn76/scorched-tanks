import { test, before, after } from 'node:test';
import { launch } from './helpers.mjs';
import { playOnline } from './online.mjs';

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

test('two browsers play online through the relay server', async () => {
  await playOnline(browser, { transport: 'relay', label: 'relay', turns: 4 });
});
