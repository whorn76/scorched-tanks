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
  versionMismatchReason,
} from '../src/net/protocol.js';
import { detectSameOriginRelay, normalizeRelayUrl, relayUrlProblem, sameOriginRelayUrl } from '../src/net/relayTransport.js';
import { DIRECT_BLOCKED_GUEST, iceServers, peerError, turnProblem } from '../src/net/peerTransport.js';
import { DEFAULT_SETTINGS } from '../src/core/constants.js';

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

test('lobby settings from the host are sanitized before the UI shows them', () => {
  const players = [{ slot: 0, name: 'Hosty', color: '#e8453c', kind: 'host' }];
  const lobby = parseHostMessage({ t: 'lobby', players, code: 'ACEFG', settings: { rounds: 3, wind: 'hurricane', walls: { x: 1 }, admin: true } });
  assert.equal(lobby.settings.rounds, 3);
  assert.equal(lobby.settings.wind, DEFAULT_SETTINGS.wind, 'unknown values fall back to the defaults');
  assert.equal(lobby.settings.walls, DEFAULT_SETTINGS.walls);
  assert.equal('admin' in lobby.settings, false);
  assert.deepEqual(parseHostMessage({ t: 'lobby', players, code: 'ACEFG' }).settings, { ...DEFAULT_SETTINGS });
});

test('version mismatches tell whoever has the older copy to reload', () => {
  assert.match(versionMismatchReason(2, 3), /host is running an older version.*ask them to reload/i);
  assert.match(versionMismatchReason(3, 2), /your copy of the game is out of date.*reload the page/i);
  const current = parseHostMessage({ t: 'reject', reason: 'Nope', hostVersion: 7 });
  assert.deepEqual(current, { t: 'reject', reason: 'Nope', hostVersion: 7 });
  // Version 1 hosts only put their version in the text.
  const legacy = parseHostMessage({ t: 'reject', reason: 'Version mismatch: the host runs protocol v1 and you have v2. Reload the page to update.' });
  assert.equal(legacy.hostVersion, 1);
  assert.equal(parseHostMessage({ t: 'reject', reason: 'That room is full.' }).hostVersion, undefined);
  assert.equal(parseHostMessage({ t: 'reject', reason: 'x', hostVersion: 'v9' }).hostVersion, undefined, 'junk versions are ignored');
  assert.equal(parseHostMessage({ t: 'reject' }).reason, 'Rejected by the host.');
});

test('failed direct connections get a clear explanation instead of PeerJS jargon', () => {
  // What PeerJS reports when the two browsers can't reach each other.
  const negotiation = { type: 'negotiation-failed', message: 'Negotiation of connection to scorchedtanks-ACEFG failed.' };
  assert.equal(peerError(negotiation), DIRECT_BLOCKED_GUEST);
  assert.equal(peerError({ type: 'connection-closed' }), DIRECT_BLOCKED_GUEST);
  assert.equal(peerError({ type: 'direct-timeout' }), DIRECT_BLOCKED_GUEST);
  assert.match(DIRECT_BLOCKED_GUEST, /relay/);
  assert.match(peerError({ type: 'peer-unavailable' }), /No room with that code/);
  assert.match(peerError({ type: 'network' }), /signaling server/);
  assert.equal(peerError({ type: 'timeout', message: 'Timed out contacting the PeerJS server.' }), 'Timed out contacting the PeerJS server.');
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
  assert.equal(iceServers({ turnUrl: 'turn:x.example.com' }).length, 2, 'TURN without credentials is left out');
  assert.equal(turnProblem({}), '');
  assert.match(turnProblem({ turnUrl: 'turn:x.example.com' }), /username/);
  assert.match(turnProblem({ turnUrl: 'x.example.com', turnUser: 'u', turnPass: 'p' }), /turn:/);
  assert.equal(turnProblem({ turnUrl: 'turn:x.example.com', turnUser: 'u', turnPass: 'p' }), '');
});

test('the relay option only points at this site when it really runs a relay', async () => {
  const calls = [];
  const reply = (body, ok = true) => async (url) => {
    calls.push(url);
    return { ok, json: async () => body };
  };
  const pages = { protocol: 'https:', host: 'me.github.io', href: 'https://me.github.io/scorched-tanks/#join=ACEFG' };
  assert.equal(await detectSameOriginRelay(pages, reply({ relay: false })), '');
  assert.equal(calls[0], 'https://me.github.io/scorched-tanks/relay.json', 'asked next to the page, so subpaths work');
  assert.equal(await detectSameOriginRelay(pages, reply({}, false)), '');
  assert.equal(await detectSameOriginRelay(pages, async () => { throw new Error('offline'); }), '');
  const tunnel = { protocol: 'https:', host: 'x.trycloudflare.com', href: 'https://x.trycloudflare.com/' };
  assert.equal(await detectSameOriginRelay(tunnel, reply({ relay: true })), 'wss://x.trycloudflare.com/ws');
  const lan = { protocol: 'http:', host: '192.168.1.5:8080', href: 'http://192.168.1.5:8080/index.html' };
  assert.equal(await detectSameOriginRelay(lan, reply({ relay: true })), 'ws://192.168.1.5:8080/ws');
  assert.equal(await detectSameOriginRelay({ protocol: 'file:', href: 'file:///C:/game/index.html' }, reply({ relay: true })), '');
});

test('relay addresses that cannot work from this page are explained', () => {
  const https = { protocol: 'https:' };
  assert.match(relayUrlProblem('', https), /npm run online/);
  assert.match(relayUrlProblem('ws://203.0.113.5:8080/ws', https), /https/, 'browsers block ws:// from https pages');
  assert.equal(relayUrlProblem('ws://localhost:8080/ws', https), '');
  assert.equal(relayUrlProblem('wss://x.trycloudflare.com/ws', https), '');
  assert.equal(relayUrlProblem('ws://203.0.113.5:8080/ws', { protocol: 'http:' }), '');
});
