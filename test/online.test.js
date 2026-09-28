import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackHub } from '../src/net/transport.js';
import { HostSession } from '../src/session/host.js';
import { GuestSession } from '../src/session/guest.js';
import { Brain } from '../src/ai/brain.js';
import { Phase } from '../src/core/game.js';
import { hashGame } from '../src/core/hash.js';
import { PROTOCOL_VERSION } from '../src/net/protocol.js';
import { flatGame } from './helpers.js';

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Sets up a host and guests on a manual loopback network, all still in the lobby. */
function makeRoom({ guests = 1, settings = {}, seed = 1234 } = {}) {
  const hub = new LoopbackHub({ manual: true });
  const host = new HostSession({
    transport: hub.host('ROOM1'),
    name: 'Hosty',
    settings: { rounds: 2, startCash: 0, wind: 'high', walls: 'random', turnTimer: 0, ...settings },
    seed,
    aiFast: true,
  });
  const guestSessions = [];
  for (let i = 0; i < guests; i++) guestSessions.push(new GuestSession({ conn: hub.connectNow('ROOM1'), name: `Guest ${i + 1}` }));
  hub.flush();
  return { hub, host, guests: guestSessions };
}

/**
 * Plays until the game is over everywhere. Humans are driven by AI "autopilots" that send their
 * shots through their own session, so guests' shots really travel over the network.
 */
async function play({ hub, host, guests }, { maxFrames = 80000, onFrame = null } = {}) {
  const pilots = [
    new Brain(host, { fast: true, seed: 5, acts: (t) => t.id === 0 && !t.ai }),
    ...guests.map((g, i) => new Brain(g, { fast: true, seed: 50 + i, acts: (t) => t.id === g.you && !t.ai })),
  ];
  let frame = 0;
  for (; frame < maxFrames; frame++) {
    host.update();
    if (host.game?.phase === Phase.SHOP && !host.ready.has(0)) host.submit({ type: 'ready', playerId: 0 });
    pilots[0].update();
    guests.forEach((g, i) => {
      if (g.status !== 'playing') return;
      g.update();
      if (g.game?.phase === Phase.SHOP && !g.ready.has(g.you)) g.submit({ type: 'ready' });
      pilots[i + 1].update();
    });
    hub.flush();
    onFrame?.(frame);
    if (frame % 20 === 0) await yieldToEventLoop();
    const done = host.game?.phase === Phase.GAME_OVER && guests.every((g) => g.status !== 'playing' || (g.game?.phase === Phase.GAME_OVER && g.queue.length === 0 && !g.loading));
    if (done) break;
  }
  return frame;
}

async function startRoom(room, ai = []) {
  for (const level of ai) room.host.addAi(level);
  room.hub.flush();
  const result = await room.host.startGame();
  assert.equal(result.ok, true);
  room.hub.flush();
  const deadline = Date.now() + 5000;
  while (room.guests.some((g) => !g.game) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  for (const g of room.guests) {
    assert.equal(g.status, 'playing');
    assert.ok(g.game, 'guest loaded the starting snapshot');
  }
}

function assertInSync(host, guests) {
  const finalHash = hashGame(host.game);
  for (const g of guests) {
    assert.equal(g.stats.mismatches, 0, `${g.name} never drifted`);
    assert.equal(g.stats.resyncs, 0, `${g.name} never needed a snapshot`);
    assert.equal(g.stats.syncChecks, host.syncsSent, `${g.name} checked every hash the host sent`);
    assert.equal(g.seq, host.seq, `${g.name} applied every command`);
    assert.equal(hashGame(g.game), finalHash);
  }
}

test('host + 1 guest play full AI-driven rounds with matching hashes after every shot', async () => {
  const room = makeRoom({ guests: 1, settings: { rounds: 2 } });
  assert.equal(room.guests[0].status, 'lobby');
  assert.equal(room.host.lobbyPlayers.length, 2);
  await startRoom(room, ['cyborg']);
  let shots = 0;
  const hashesPerShot = [];
  const frames = await play(room, {
    onFrame: () => {
      for (const e of room.host.events.splice(0)) {
        if (e.type === 'fire') shots++;
      }
      for (const g of room.guests) g.events.length = 0;
      if (room.guests[0].lastHash && hashesPerShot.at(-1) !== room.guests[0].lastHash) hashesPerShot.push(room.guests[0].lastHash);
    },
  });
  assert.equal(room.host.game.phase, Phase.GAME_OVER, `finished in ${frames} frames`);
  assert.equal(room.host.game.state.round, 2);
  assert.ok(shots >= 4, `${shots} shots fired`);
  assert.ok(room.host.syncsSent >= shots, 'a hash went out after every shot');
  assertInSync(room.host, room.guests);
});

test('host + 2 guests stay in sync through full rounds', async () => {
  const room = makeRoom({ guests: 2, settings: { rounds: 2, walls: 'wrap', wind: 'medium' }, seed: 99 });
  assert.equal(room.host.lobbyPlayers.length, 3);
  await startRoom(room, ['rookie']);
  await play(room);
  assert.equal(room.host.game.phase, Phase.GAME_OVER);
  assertInSync(room.host, room.guests);
  const standings = room.guests[1].game.standings().map((t) => t.id);
  assert.deepEqual(standings, room.host.game.standings().map((t) => t.id), 'everyone sees the same final standings');
});

test('a guest who drifts out of sync is repaired with a snapshot', async () => {
  const room = makeRoom({ guests: 1, settings: { rounds: 1 } });
  await startRoom(room, []);
  let corrupted = false;
  await play(room, {
    onFrame: () => {
      const g = room.guests[0];
      if (!corrupted && g.game?.phase === Phase.AIM && g.game.state.turnId >= 2) {
        g.game.terrain.data[600 * 1280 + 5] ^= 0x3; // cosmic ray
        corrupted = true;
      }
    },
  });
  const g = room.guests[0];
  assert.ok(corrupted);
  assert.ok(g.stats.mismatches >= 1, 'the drift was detected');
  assert.ok(g.stats.resyncs >= 1, 'a snapshot was requested');
  assert.equal(hashGame(g.game), hashGame(room.host.game), 'and the guest ended up identical to the host');
});

test('when a guest drops out mid-game, an AI takes over and the game goes on', async () => {
  const room = makeRoom({ guests: 2, settings: { rounds: 1 } });
  await startRoom(room, []);
  const [stayer, leaver] = room.guests;
  let dropped = false;
  await play(room, {
    onFrame: () => {
      if (!dropped && room.host.game.state.turnId >= 3) {
        leaver.close();
        dropped = true;
      }
    },
  });
  assert.ok(dropped);
  const tank = room.host.game.state.tanks[leaver.you];
  assert.equal(tank.ai, 'gunner', 'the AI took the dropped tank');
  assert.equal(room.host.game.phase, Phase.GAME_OVER);
  assertInSync(room.host, [stayer]);
});

test('the host rejects version mismatches, full rooms and games in progress', async () => {
  const room = makeRoom({ guests: 3 });
  assert.equal(room.host.humans(), 4);
  // A fifth human doesn't fit.
  const late = new GuestSession({ conn: room.hub.connectNow('ROOM1'), name: 'Late' });
  room.hub.flush();
  assert.equal(late.status, 'ended');
  assert.match(late.endReason, /full/i);

  // Wrong protocol version.
  const conn = room.hub.connectNow('ROOM1');
  const replies = [];
  conn.onMessage((m) => replies.push(m));
  conn.send({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Old' });
  room.hub.flush();
  assert.equal(replies[0].t, 'reject');
  assert.match(replies[0].reason, /version/i);

  // Game already started.
  room.guests[2].close();
  room.hub.flush();
  await startRoom({ ...room, guests: room.guests.slice(0, 2) });
  const tooLate = new GuestSession({ conn: room.hub.connectNow('ROOM1'), name: 'Too late' });
  room.hub.flush();
  assert.equal(tooLate.status, 'ended');
  assert.match(tooLate.endReason, /already started/i);
});

test('the host ignores shots from players whose turn it is not and from bad messages', async () => {
  const room = makeRoom({ guests: 1, settings: { rounds: 1 } });
  await startRoom(room, []);
  // Run until round 1 starts.
  for (let i = 0; i < 100 && room.host.game.phase !== Phase.AIM; i++) {
    room.host.update();
    room.hub.flush();
  }
  const s = room.host.game.state;
  const guest = room.guests[0];
  const other = s.active === guest.you ? 0 : guest.you;
  const seqBefore = room.host.seq;
  const errors = [];
  guest.events.length = 0;
  // Pretend it's the guest's turn when it isn't, and send junk.
  if (s.active !== guest.you) guest.conn.send({ t: 'fire', turnId: s.turnId, angle: 45, power: 500, weaponId: 'baby' });
  guest.conn.send({ t: 'fire', turnId: s.turnId, angle: 45, power: 99999, weaponId: 'baby' });
  guest.conn.send({ t: 'fire', turnId: s.turnId, angle: 45, power: 500, weaponId: 'nuke' });
  guest.conn.send({ t: 'buy', item: 'nuke' });
  guest.conn.send({ junk: true });
  room.hub.flush();
  for (const e of guest.drainEvents()) if (e.type === 'net') errors.push(e.text);
  assert.equal(room.host.seq, seqBefore, 'nothing was applied');
  assert.ok(errors.length >= 2, `guest was told why: ${errors.join('; ')}`);
  assert.ok(other >= 0);
});

test('guests see each other’s aim previews and chat', async () => {
  const room = makeRoom({ guests: 2, settings: { rounds: 1 } });
  room.guests[0].sendChat('hello <b>there</b>');
  room.hub.flush();
  const chat = room.guests[1].drainEvents().find((e) => e.type === 'chat' && !e.system);
  assert.equal(chat.text, 'hello <b>there</b>');
  assert.equal(chat.name, 'Guest 1');
  await startRoom(room, []);
  for (let i = 0; i < 100 && room.host.game.phase !== Phase.AIM; i++) {
    room.host.update();
    room.guests.forEach((g) => g.update());
    room.hub.flush();
  }
  const s = room.host.game.state;
  const shooter = room.guests.find((g) => g.you === s.active);
  if (shooter) {
    shooter.submit({ type: 'aim', playerId: shooter.you, turnId: s.turnId, angle: 77, power: 432, weaponId: 'baby' });
    room.hub.flush();
    for (let i = 0; i < 10; i++) {
      room.host.update();
      room.hub.flush();
    }
    const watcher = room.guests.find((g) => g !== shooter);
    assert.deepEqual(watcher.previews.get(shooter.you), { angle: 77, power: 432, weaponId: 'baby' });
    assert.deepEqual(room.host.previews.get(shooter.you), { angle: 77, power: 432, weaponId: 'baby' });
  }
});

test('a guest who leaves while the game is starting is handed to the AI', async () => {
  const room = makeRoom({ guests: 2, settings: { rounds: 1, startCash: 5000 } });
  const [stayer, leaver] = room.guests;
  const starting = room.host.startGame();
  leaver.close(); // before the starting snapshot has even been sent
  room.hub.flush();
  await starting;
  room.hub.flush();
  const deadline = Date.now() + 5000;
  while (!stayer.game && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  const leaverId = room.host.lobbyPlayers.find((p) => p.name === 'Guest 2').playerId;
  await play({ hub: room.hub, host: room.host, guests: [stayer] });
  assert.equal(room.host.game.state.tanks[leaverId].ai, 'gunner', 'the AI took over');
  assert.equal(room.host.game.phase, Phase.GAME_OVER, 'and the shop did not wait for the missing player');
  assertInSync(room.host, [stayer]);
});

test('a guest that misses a command asks for a snapshot and catches up', async () => {
  const room = makeRoom({ guests: 1, settings: { rounds: 1 } });
  await startRoom(room, []);
  const guest = room.guests[0];
  // Lose exactly one command on its way to the guest.
  const original = guest.onMessage.bind(guest);
  let dropped = false;
  guest.conn.messageHandlers[0] = (msg) => {
    if (!dropped && msg.t === 'cmd' && msg.cmd.type === 'shot') {
      dropped = true;
      return;
    }
    original(msg);
  };
  await play(room);
  assert.ok(dropped);
  assert.ok(guest.stats.resyncs >= 1, 'it noticed the gap');
  assert.equal(hashGame(guest.game), hashGame(room.host.game));
  assert.equal(room.host.game.phase, Phase.GAME_OVER);
});

test('chat floods from one guest are throttled before reaching the others', () => {
  const room = makeRoom({ guests: 2 });
  const [spammer, reader] = room.guests;
  reader.drainEvents();
  for (let i = 0; i < 40; i++) spammer.sendChat(`spam ${i}`);
  room.hub.flush();
  const received = reader.drainEvents().filter((e) => e.type === 'chat' && !e.system).length;
  assert.ok(received >= 1 && received <= 5, `${received} of 40 got through`);
});

test('commands naming inherited object properties are rejected, not applied', () => {
  const game = flatGame();
  game.state.phase = Phase.SHOP;
  for (const item of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(game.apply({ type: 'buy', playerId: 0, item }).ok, false, item);
    assert.equal(game.apply({ type: 'sell', playerId: 0, item }).ok, false, item);
  }
  assert.ok(Number.isFinite(game.state.tanks[0].money));
});
