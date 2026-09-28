import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSession } from '../src/session/session.js';
import { Phase } from '../src/core/game.js';
import { TICKS_PER_SECOND } from '../src/core/constants.js';

function startedSession(settings) {
  const session = new LocalSession({ settings: { startCash: 0, ...settings }, players: [{ name: 'A' }, { name: 'B' }], seed: 4 });
  session.start();
  for (let i = 0; i < 200 && session.game.phase !== Phase.AIM; i++) session.update();
  assert.equal(session.game.phase, Phase.AIM);
  session.drainEvents();
  return session;
}

test('the turn timer fires automatically when time runs out', () => {
  const session = startedSession({ turnTimer: 30 });
  const s = session.game.state;
  const turn = s.turnId;
  const shooter = s.active;
  session.submit({ type: 'aim', playerId: shooter, turnId: turn, angle: 77, power: 432, weaponId: 'baby' });
  assert.ok(session.turnTimeLeft() > 29);
  for (let i = 0; i < 30 * TICKS_PER_SECOND - 10; i++) session.update();
  assert.equal(s.phase, Phase.AIM, 'still waiting just before the deadline');
  assert.ok(session.turnTimeLeft() < 1);
  for (let i = 0; i < 20; i++) session.update();
  const events = session.drainEvents();
  assert.ok(events.some((e) => e.type === 'timeout'));
  const fire = events.find((e) => e.type === 'fire');
  assert.ok(fire, 'a shot went off');
  assert.equal(s.tanks[shooter].angle, 77, 'using the last aim');
  assert.equal(s.tanks[shooter].power, 432);
});

test('without a turn timer a human can take as long as they like', () => {
  const session = startedSession({ turnTimer: 0 });
  assert.equal(session.turnTimeLeft(), null);
  for (let i = 0; i < 120 * TICKS_PER_SECOND; i++) session.update();
  assert.equal(session.game.phase, Phase.AIM);
});

test('hot-seat players shop one at a time, then the next round starts', () => {
  const session = new LocalSession({ settings: { startCash: 20000, rounds: 2 }, players: [{ name: 'A' }, { name: 'B' }, { name: 'C', ai: 'gunner' }], seed: 5, aiFast: true });
  session.start();
  for (let i = 0; i < 100 && session.game.phase !== Phase.SHOP; i++) session.update();
  assert.equal(session.game.phase, Phase.SHOP);
  assert.deepEqual(session.localShoppers(), [0, 1], 'both humans, in order; the AI shops by itself');
  assert.equal(session.submit({ type: 'buy', playerId: 0, item: 'missile' }).ok, true);
  session.submit({ type: 'ready', playerId: 0 });
  assert.deepEqual(session.localShoppers(), [1]);
  for (let i = 0; i < 60; i++) session.update();
  assert.equal(session.game.phase, Phase.SHOP, 'still waiting for the second player');
  session.submit({ type: 'ready', playerId: 1 });
  for (let i = 0; i < 60 && session.game.phase === Phase.SHOP; i++) session.update();
  assert.equal(session.game.phase, Phase.AIM);
  assert.equal(session.game.state.round, 1);
  assert.equal(session.game.state.tanks[0].stock.missile, 5);
});
