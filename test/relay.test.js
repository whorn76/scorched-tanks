import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/server.js';
import { hostRelay, joinRelay } from '../src/net/relayTransport.js';
import { HostSession } from '../src/session/host.js';
import { GuestSession } from '../src/session/guest.js';
import { Brain } from '../src/ai/brain.js';
import { Phase } from '../src/core/game.js';
import { hashGame } from '../src/core/hash.js';

let server;
let url;
let base;

before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  url = `ws://127.0.0.1:${server.port}/ws`;
  base = `http://127.0.0.1:${server.port}`;
  assert.ok(server.relay, 'the relay is running (ws is installed)');
});

after(async () => {
  await server.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(5);
  }
}

function rawSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.addEventListener('message', (e) => messages.push(JSON.parse(e.data)));
    ws.addEventListener('open', () => resolve({ ws, messages }));
    ws.addEventListener('error', reject);
  });
}

test('the server serves the game but not the project internals', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<canvas id="game"/);
  assert.equal((await fetch(`${base}/src/main.js`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/peerjs/peerjs.min.js`)).status, 200);
  for (const hidden of ['/package.json', '/server/relay.js', '/test/game.test.js', '/../package.json', '/node_modules/ws/package.json']) {
    assert.equal((await fetch(`${base}${hidden}`)).status, 404, hidden);
  }
});

test('encoded dot-dot paths cannot escape the allow-list', async () => {
  const { request } = await import('node:http');
  const get = (path) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path, method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
  for (const path of ['/src/..%2fpackage.json', '/src/..%2f.git%2fconfig', '/src/..%5cpackage.json', '/src/%2e%2e/package.json', '/vendor/..%2fserver%2frelay.js', '/src/core%00.js']) {
    assert.equal(await get(path), 404, path);
  }
  assert.equal(await get('/src/core/game.js'), 200);
});

test('pathologically nested messages do not take the relay down', async () => {
  const host = await hostRelay(url);
  const { ws } = await rawSocket();
  ws.send(JSON.stringify({ type: 'join', code: host.code, v: 1 }));
  await sleep(50);
  const depth = 20000;
  ws.send(`{"type":"data","data":${'['.repeat(depth)}${']'.repeat(depth)}}`);
  await sleep(200);
  // Still alive: a fresh room can be created and used.
  const again = await hostRelay(url);
  assert.match(again.code, /^[ACEFGHKMNPRTWXY34679]{5}$/);
  again.close();
  host.close();
  ws.close();
});

test('host and guest exchange messages through a room', async () => {
  const host = await hostRelay(url);
  assert.match(host.code, /^[ACEFGHKMNPRTWXY34679]{5}$/);
  const hostSide = [];
  host.onConnection((conn) => {
    hostSide.push(conn);
    conn.onMessage((msg) => conn.send({ echo: msg }));
  });
  const guest = await joinRelay(url, host.code);
  const received = [];
  guest.onMessage((msg) => received.push(msg));
  guest.send({ hello: 'world', n: 1 });
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], { echo: { hello: 'world', n: 1 } });
  assert.equal(hostSide.length, 1);

  // Guest leaves: the host hears about it.
  let closed = false;
  hostSide[0].onClose(() => (closed = true));
  guest.close();
  await waitFor(() => closed);
  host.close();
  await waitFor(() => server.relay.rooms.size === 0);
});

test('rooms are limited in size and unknown codes are refused', async () => {
  const host = await hostRelay(url);
  const guests = [];
  for (let i = 0; i < 5; i++) guests.push(await joinRelay(url, host.code));
  await assert.rejects(joinRelay(url, host.code), /full/);
  await assert.rejects(joinRelay(url, 'AAAAA'), /No room/);
  for (const g of guests) g.close();
  host.close();
});

test('when the host leaves, guests are disconnected and the room is cleaned up', async () => {
  const host = await hostRelay(url);
  const guest = await joinRelay(url, host.code);
  let reason = null;
  guest.onClose((r) => (reason = r));
  assert.equal(server.relay.rooms.has(host.code), true);
  host.close();
  await waitFor(() => reason !== null);
  assert.equal(reason, 'host-left');
  await waitFor(() => !server.relay.rooms.has(host.code));
});

test('oversized messages close the connection', async () => {
  const host = await hostRelay(url);
  const { ws } = await rawSocket();
  ws.send(JSON.stringify({ type: 'join', code: host.code, v: 1 }));
  await sleep(50);
  let closeCode = null;
  ws.addEventListener('close', (e) => (closeCode = e.code));
  ws.send(JSON.stringify({ type: 'data', data: 'x'.repeat(100 * 1024) }));
  await waitFor(() => closeCode !== null);
  assert.equal(closeCode, 1009, 'message too big');
  host.close();
});

test('message floods are rate limited', async () => {
  const host = await hostRelay(url);
  let delivered = 0;
  host.onConnection((conn) => conn.onMessage(() => delivered++));
  const { ws } = await rawSocket();
  ws.send(JSON.stringify({ type: 'join', code: host.code, v: 1 }));
  await sleep(50);
  let closed = false;
  ws.addEventListener('close', () => (closed = true));
  const droppedBefore = server.relay.stats.dropped;
  for (let i = 0; i < 1000; i++) ws.send(JSON.stringify({ type: 'data', data: { i } }));
  await waitFor(() => closed || server.relay.stats.dropped - droppedBefore > 250, 5000);
  await sleep(100);
  assert.ok(delivered < 400, `only ${delivered} of 1000 got through`);
  assert.ok(server.relay.stats.dropped - droppedBefore > 250);
  host.close();
});

test('junk and wrong-version hellos are refused', async () => {
  const { ws, messages } = await rawSocket();
  ws.send('not json');
  ws.send(JSON.stringify({ type: 'host', v: 999 }));
  await waitFor(() => messages.length > 0);
  assert.deepEqual(messages[0], { type: 'error', reason: 'version' });
  ws.close();
});

test('a full online game over the relay stays in sync', async () => {
  const transport = await hostRelay(url);
  const host = new HostSession({ transport, name: 'Relay host', settings: { rounds: 1, startCash: 0, wind: 'medium' }, seed: 777, aiFast: true });
  const guest = new GuestSession({ conn: await joinRelay(url, transport.code), name: 'Relay guest' });
  await waitFor(() => guest.status === 'lobby' && host.lobbyPlayers.length === 2);
  host.addAi('gunner');
  await host.startGame();
  await waitFor(() => guest.game !== null);
  const pilots = [
    new Brain(host, { fast: true, seed: 3, acts: (t) => t.id === 0 }),
    new Brain(guest, { fast: true, seed: 4, acts: (t) => t.id === guest.you }),
  ];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    host.update();
    guest.update();
    pilots[0].update();
    pilots[1].update();
    await new Promise((resolve) => setImmediate(resolve));
    if (host.game.phase === Phase.GAME_OVER && guest.game.phase === Phase.GAME_OVER && guest.queue.length === 0) break;
  }
  assert.equal(guest.game.phase, Phase.GAME_OVER);
  assert.equal(guest.stats.mismatches, 0);
  assert.equal(guest.stats.syncChecks, host.syncsSent);
  assert.ok(host.syncsSent > 3);
  assert.equal(hashGame(guest.game), hashGame(host.game));
  host.close();
  guest.close();
});
