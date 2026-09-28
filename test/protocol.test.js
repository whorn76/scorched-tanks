import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  ROOM_ALPHABET,
  RateLimiter,
  cleanText,
  makeRoomCode,
  normalizeRoomCode,
  parseGuestMessage,
  parseHostMessage,
} from '../src/net/protocol.js';
import { normalizeRelayUrl, sameOriginRelayUrl } from '../src/net/relayTransport.js';
import { iceServers } from '../src/net/peerTransport.js';

test('room codes are 5 characters from an alphabet without look-alikes', () => {
  for (const bad of '0O1IL5S2Z8BUV') assert.ok(!ROOM_ALPHABET.includes(bad), `${bad} is excluded`);
  for (let i = 0; i < 200; i++) {
    const code = makeRoomCode();
    assert.equal(code.length, 5);
    for (const c of code) assert.ok(ROOM_ALPHABET.includes(c));
  }
  assert.equal(normalizeRoomCode(' ac-e f g '), 'ACEFG');
  assert.equal(normalizeRoomCode('acef'), '', 'too short');
  assert.equal(normalizeRoomCode('ACEFGH'), '', 'too long');
});

test('guest messages are validated and trimmed to known fields', () => {
  assert.deepEqual(parseGuestMessage({ t: 'hello', v: PROTOCOL_VERSION, name: '  Ann\u0000ie  ', admin: true }), { t: 'hello', v: PROTOCOL_VERSION, name: 'Annie' });
  assert.deepEqual(parseGuestMessage({ t: 'fire', turnId: 3, angle: 45.5, power: 700, weaponId: 'missile', vx: 1e9 }), {
    t: 'fire',
    turnId: 3,
    angle: 45.5,
    power: 700,
    weaponId: 'missile',
  });
  assert.deepEqual(parseGuestMessage({ t: 'move', turnId: 1, dir: -1 }), { t: 'move', turnId: 1, dir: -1 });
  assert.equal(parseGuestMessage({ t: 'chat', text: 'x'.repeat(500) }).text.length, 200);
});

test('bad protocol messages are rejected', () => {
  const bad = [
    null,
    'fire',
    42,
    [],
    {},
    { t: 'unknown' },
    { t: 'hello', v: '1', name: 'x' },
    { t: 'fire', turnId: 1, angle: 181, power: 10, weaponId: 'baby' },
    { t: 'fire', turnId: 1, angle: -1, power: 10, weaponId: 'baby' },
    { t: 'fire', turnId: 1, angle: NaN, power: 10, weaponId: 'baby' },
    { t: 'fire', turnId: 1, angle: 45, power: Infinity, weaponId: 'baby' },
    { t: 'fire', turnId: 1, angle: 45, power: 1001, weaponId: 'baby' },
    { t: 'fire', turnId: 1, angle: 45, power: 100, weaponId: 'deathray' },
    { t: 'fire', turnId: 1.5, angle: 45, power: 100, weaponId: 'baby' },
    { t: 'fire', turnId: -2, angle: 45, power: 100, weaponId: 'baby' },
    { t: 'fire', angle: 45, power: 100, weaponId: 'baby' },
    { t: 'fire', turnId: 1, angle: '45', power: 100, weaponId: 'baby' },
    { t: 'move', turnId: 1, dir: 2 },
    { t: 'use', turnId: 1, item: 'nuke' },
    { t: 'buy', item: '__proto__' },
    { t: 'buy', item: { id: 'missile' } },
    { t: 'chat', text: '   ' },
    { t: 'chat', text: 17 },
    { t: 'ping', id: 'x' },
  ];
  for (const msg of bad) assert.equal(parseGuestMessage(msg), null, JSON.stringify(msg));
});

test('host messages are validated too', () => {
  assert.equal(parseHostMessage({ t: 'cmd', seq: 0, cmd: { type: 'shot' } }), null, 'seq starts at 1');
  assert.equal(parseHostMessage({ t: 'cmd', seq: 1, cmd: null }), null);
  assert.equal(parseHostMessage({ t: 'sync', seq: 1, hash: 'x'.repeat(100) }), null);
  assert.equal(parseHostMessage({ t: 'snapshot', id: 1, part: 3, total: 2, data: '' }), null);
  assert.equal(parseHostMessage({ t: 'snapshot', id: 1, part: 0, total: 500, seq: 1, data: '' }), null);
  assert.equal(parseHostMessage({ t: 'lobby', players: [{ slot: 1, name: 'x', kind: 'overlord' }] }), null);
  const lobby = parseHostMessage({ t: 'lobby', players: [{ slot: 0, name: '<b>Bob</b>', color: 'red', kind: 'host' }], code: 'ACEFG' });
  assert.equal(lobby.players[0].name, '<b>Bob</b>', 'names stay plain text (the UI uses textContent)');
  assert.equal(lobby.players[0].color, '#888888', 'bad colors are replaced');
  const chat = parseHostMessage({ t: 'chat', name: 'Al', color: '#ff0000', text: 'hi\u202e there' });
  assert.equal(chat.text, 'hi there');
});

test('cleanText strips control and direction-override characters', () => {
  assert.equal(cleanText('a\u0007b\u202ec\n d', 50), 'abc d');
  assert.equal(cleanText(null, 5), '');
  assert.equal(cleanText('abcdefgh', 3), 'abc');
});

test('rate limiter allows bursts, then the sustained rate', () => {
  let now = 0;
  const limiter = new RateLimiter(10, 20, () => now);
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (limiter.allow()) allowed++;
  assert.equal(allowed, 20);
  now += 1000;
  allowed = 0;
  for (let i = 0; i < 100; i++) if (limiter.allow()) allowed++;
  assert.equal(allowed, 10);
});

test('relay URLs are normalized', () => {
  assert.equal(normalizeRelayUrl('https://example.com'), 'wss://example.com/ws');
  assert.equal(normalizeRelayUrl('http://localhost:8080'), 'ws://localhost:8080/ws');
  assert.equal(normalizeRelayUrl('example.trycloudflare.com'), 'wss://example.trycloudflare.com/ws');
  assert.equal(normalizeRelayUrl('wss://x.org/custom'), 'wss://x.org/custom');
  assert.equal(normalizeRelayUrl('ftp://x.org'), '');
  assert.equal(normalizeRelayUrl(''), '');
  assert.equal(sameOriginRelayUrl({ protocol: 'https:', host: 'game.example' }), 'wss://game.example/ws');
  assert.equal(sameOriginRelayUrl({ protocol: 'file:', host: '' }), '');
});

test('ICE servers include Google STUN and an optional TURN server', () => {
  assert.ok(iceServers().every((s) => s.urls.startsWith('stun:')));
  const withTurn = iceServers({ turnUrl: 'turn:turn.example.com:3478, turns:turn.example.com:5349', turnUser: 'u', turnPass: 'p' });
  const turn = withTurn.find((s) => Array.isArray(s.urls));
  assert.deepEqual(turn, { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'u', credential: 'p' });
  assert.equal(iceServers({ turnUrl: 'http://nope' }).length, 2, 'non-TURN URLs are ignored');
});
