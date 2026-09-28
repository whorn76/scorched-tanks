import { test, before, after } from 'node:test';
import { STATIC_URL, launch } from './helpers.mjs';
import { playOnline } from './online.mjs';

let browser;
let reachable = false;

before(async () => {
  try {
    const res = await fetch('https://0.peerjs.com/peerjs/id', { signal: AbortSignal.timeout(6000) });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  if (reachable) browser = await launch();
});
after(async () => {
  await browser?.close();
});

test('two browsers play online over PeerJS (WebRTC) from a static host like GitHub Pages', async (t) => {
  if (!reachable) {
    t.skip('the public PeerJS server (0.peerjs.com) is not reachable');
    return;
  }
  await playOnline(browser, { transport: 'peer', label: 'peer', turns: 4, baseUrl: STATIC_URL });
});
