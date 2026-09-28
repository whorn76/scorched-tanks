import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSession } from '../src/session/session.js';
import { Brain } from '../src/ai/brain.js';
import { PERSONALITIES } from '../src/ai/personality.js';
import { isBuried, searchAim, trial, scoreImpact } from '../src/ai/aim.js';
import { Phase } from '../src/core/game.js';
import { WIDTH } from '../src/core/constants.js';
import { flatGame } from './helpers.js';

/**
 * An AI tank (id 0) against a dummy (id 1) that only fires harmless tracers into the air.
 * Returns how many shots the AI needed to damage the dummy (Infinity if it never did).
 */
function duel({ level, wind = 0, windSetting = 'high', xs = [250, 1010], heights = null, seed = 1, maxShots = 8 }) {
  const session = new LocalSession({ settings: { startCash: 0 }, players: [{ name: 'AI', ai: level }, { name: 'Dummy' }], seed, aiFast: true });
  const game = flatGame({ xs, heights, wind, settings: { wind: windSetting, windChange: false } });
  game.state.tanks[0].ai = level;
  game.state.tanks[1].stock.tracer = 99;
  session.game = game;
  session.brain = new Brain(session, { seed, fast: true });
  const dummy = game.state.tanks[1];
  let shots = 0;
  for (let i = 0; i < 20000 && shots < maxShots; i++) {
    const s = game.state;
    if (s.phase === Phase.AIM && s.active === 1) {
      session.submit({ type: 'fire', turnId: s.turnId, playerId: 1, angle: 90, power: 0, weaponId: 'tracer' });
    }
    const before = s.turnId;
    session.update();
    if (s.turnId !== before && s.active === 1) {
      shots++;
      if (dummy.health < 100) return shots;
    }
    if (s.phase === Phase.ROUND_OVER) return dummy.alive ? Infinity : shots;
  }
  return dummy.health < 100 ? shots : Infinity;
}

test('the AI hits a target within a few shots when there is no wind', () => {
  for (const seed of [1, 2, 3]) {
    const shots = duel({ level: 'gunner', windSetting: 'off', seed });
    assert.ok(shots <= 3, `gunner needed ${shots} shots (seed ${seed})`);
  }
});

test('the Cyborg reads the wind and still hits in a gale', () => {
  for (const wind of [-12, 12]) {
    const shots = duel({ level: 'cyborg', wind, seed: 4 });
    assert.ok(shots <= 2, `cyborg needed ${shots} shots in wind ${wind}`);
  }
});

test('the Spotter corrects for the wind after missing', () => {
  const shots = duel({ level: 'spotter', wind: 11, seed: 5 });
  assert.ok(shots <= 4, `spotter needed ${shots} shots`);
});

test('the Gunner ignores the wind, so a strong wind throws it off', () => {
  const session = new LocalSession({ players: [{ name: 'G', ai: 'gunner' }, { name: 'C', ai: 'cyborg' }], aiFast: true });
  const game = flatGame({ wind: 12, settings: { wind: 'high' } });
  session.game = game;
  const brain = new Brain(session, { fast: true });
  const m = brain.mem(game.state.tanks[0]);
  assert.equal(brain.windEnv(game, PERSONALITIES.gunner, m).windAccel, 0);
  assert.equal(brain.windEnv(game, PERSONALITIES.cyborg, m).windAccel, game.env.windAccel);
  assert.ok(game.env.windAccel !== 0);
});

test('difficulty spreads accuracy: rookies miss far more than cyborgs', () => {
  const tally = (level) => {
    let total = 0;
    for (const seed of [11, 12, 13, 14, 15, 16]) total += Math.min(8, duel({ level, wind: 6, seed }));
    return total;
  };
  const rookie = tally('rookie');
  const cyborg = tally('cyborg');
  assert.ok(cyborg <= 9, `cyborg took ${cyborg} shots over six duels`);
  assert.ok(rookie > cyborg * 1.8, `rookie took ${rookie} vs cyborg ${cyborg}`);
});

test('the trial search finds an aim that really lands on the target', () => {
  const game = flatGame({ xs: [200, 900], wind: 5, settings: { wind: 'medium' } });
  const [me, them] = game.state.tanks;
  const job = searchAim(game.env, me, them, { blast: 20 });
  let step;
  let yields = 0;
  do {
    step = job.next();
    yields++;
  } while (!step.done);
  const best = step.value;
  assert.ok(yields >= 3, 'the search yields so it can be spread across frames');
  const r = trial(game.env, me, best.angle, best.power);
  assert.ok(scoreImpact(r, me, them) < 15, `lands ${scoreImpact(r, me, them).toFixed(1)} px away`);
});

test('AI planning never blocks a frame for long', () => {
  const session = new LocalSession({
    settings: { startCash: 0, terrain: 'mountains', wind: 'high' },
    players: [{ name: 'A', ai: 'cyborg' }, { name: 'B', ai: 'spotter' }, { name: 'C', ai: 'gunner' }],
    seed: 21,
  });
  session.brain = new Brain(session, { seed: 9, budgetMs: 3 });
  session.start();
  let worst = 0;
  let shots = 0;
  let tries = 0;
  for (let i = 0; i < 6000 && shots < 4; i++) {
    const before = session.game.state.turnId;
    const t0 = performance.now();
    session.update();
    worst = Math.max(worst, performance.now() - t0);
    if (session.brain.plan?.tries) tries = Math.max(tries, session.brain.plan.tries);
    if (session.game.state.turnId !== before && session.game.state.round > 0) shots++;
  }
  assert.ok(shots >= 4, 'the AIs took their turns');
  assert.ok(tries > 50, `a real search ran (${tries} trial shots)`);
  assert.ok(session.brain.maxStepMs < 15, `longest planning slice ${session.brain.maxStepMs.toFixed(1)} ms`);
  assert.ok(worst < 60, `longest update ${worst.toFixed(1)} ms`);
});

test('a buried AI digs itself out with a Riot Charge', () => {
  const session = new LocalSession({ players: [{ name: 'A', ai: 'gunner' }, { name: 'B', ai: 'gunner' }], aiFast: true });
  const game = flatGame({ xs: [300, 900], settings: { wind: 'off' } });
  session.game = game;
  session.brain = new Brain(session, { fast: true });
  const tank = game.state.tanks[0];
  tank.ai = 'gunner';
  tank.stock.riot = 1;
  game.terrain.addDirt(tank.x, tank.y - 10, 45, 3);
  game.terrain.settleAll();
  assert.ok(isBuried(game.terrain, tank));
  let fired = null;
  for (let i = 0; i < 50 && !fired; i++) {
    session.update();
    fired = session.drainEvents().find((e) => e.type === 'fire');
  }
  assert.equal(fired?.weapon, 'riot');
  game.settle();
  assert.equal(isBuried(game.terrain, tank), false);
});

test('a hurt AI uses a battery and raises a shield before shooting', () => {
  const session = new LocalSession({ players: [{ name: 'A', ai: 'cyborg' }, { name: 'B', ai: 'gunner' }], aiFast: true });
  const game = flatGame({ xs: [300, 900], settings: { wind: 'off' } });
  session.game = game;
  session.brain = new Brain(session, { fast: true });
  const tank = game.state.tanks[0];
  tank.ai = 'cyborg';
  tank.health = 30;
  tank.stock.battery = 1;
  tank.stock.shield = 1;
  for (let i = 0; i < 5; i++) session.update();
  assert.equal(tank.stock.battery, 0);
  assert.equal(tank.health, 55);
  assert.equal(tank.stock.shield, 0);
  assert.ok(tank.shield > 0);
});

test('an AI too weak to reach its target drives closer', () => {
  const session = new LocalSession({ players: [{ name: 'A', ai: 'cyborg' }, { name: 'B' }], aiFast: true });
  const game = flatGame({ xs: [150, 1100], settings: { wind: 'off' } });
  session.game = game;
  session.brain = new Brain(session, { fast: true });
  const tank = game.state.tanks[0];
  tank.ai = 'cyborg';
  tank.health = 45; // max power 450: nowhere near enough for 950 px
  tank.stock.fuel = 300;
  const startX = tank.x;
  let fired = false;
  for (let i = 0; i < 3000 && !fired; i++) {
    session.update();
    fired = session.drainEvents().some((e) => e.type === 'fire');
  }
  assert.ok(tank.x > startX + 40, `drove from ${startX} to ${tank.x}`);
  assert.ok(tank.stock.fuel < 300);
  assert.ok(fired, 'and then fired');
});

test('AI targets by personality: weakest for the Spotter, revenge for the Cyborg', () => {
  const session = new LocalSession({ players: [{ name: 'A' }, { name: 'B' }], aiFast: true });
  const game = flatGame({ xs: [100, 400, 700, 1000] });
  session.game = game;
  const brain = new Brain(session, { fast: true });
  const [me, near, weak, far] = game.state.tanks;
  weak.health = 20;
  assert.equal(brain.chooseTarget(game, me, PERSONALITIES.gunner).id, near.id);
  assert.equal(brain.chooseTarget(game, me, PERSONALITIES.spotter).id, weak.id);
  me.lastDamagedBy = far.id;
  assert.equal(brain.chooseTarget(game, me, PERSONALITIES.cyborg).id, far.id);
  far.alive = false;
  far.stats.wins = 0;
  near.stats.wins = 2;
  assert.equal(brain.chooseTarget(game, me, PERSONALITIES.cyborg).id, near.id, 'then the leader');
});

test('the Cyborg picks strong weapons but not ones that would hurt itself', () => {
  const session = new LocalSession({ players: [{ name: 'A' }, { name: 'B' }], aiFast: true });
  const game = flatGame({ xs: [300, 1000] });
  session.game = game;
  const brain = new Brain(session, { fast: true });
  const [me, them] = game.state.tanks;
  me.stock.nuke = 1;
  me.stock.missile = 5;
  const m = brain.mem(me);
  assert.equal(brain.chooseWeapon(game, me, them, PERSONALITIES.cyborg, m, false), 'nuke');
  them.x = me.x + 90;
  assert.equal(brain.chooseWeapon(game, me, them, PERSONALITIES.cyborg, m, false), 'missile', 'too close for a nuke');
  them.x = 1000;
  them.health = 20;
  assert.equal(brain.chooseWeapon(game, me, them, PERSONALITIES.cyborg, m, false), 'missile', 'no nukes on a nearly dead tank');
});

test('AI tanks go shopping with their money', () => {
  const session = new LocalSession({ settings: { startCash: 35000 }, players: [{ name: 'A', ai: 'cyborg' }, { name: 'B', ai: 'rookie' }, { name: 'C', ai: 'spotter' }], aiFast: true, seed: 3 });
  session.start();
  let sawShop = false;
  for (let i = 0; i < 400 && session.game.state.round === 0; i++) {
    session.update();
    if (session.game.phase === Phase.SHOP) sawShop = true;
  }
  assert.ok(sawShop, 'the shop opened before round 1');
  assert.equal(session.game.state.round, 1, 'and the round started once the AIs were done');
  for (const tank of session.game.state.tanks) {
    assert.ok(tank.money < 35000, `${tank.name} spent money`);
    const bought = Object.values(tank.stock).reduce((a, b) => a + b, 0);
    assert.ok(bought > 0, `${tank.name} bought something`);
  }
  const cyborg = session.game.state.tanks[0];
  assert.ok(cyborg.stock.parachute > 0 || cyborg.stock.heavyshield > 0 || cyborg.shield > 0, 'the cyborg bought protection');
});

test('an all-AI game plays itself to the end', () => {
  const session = new LocalSession({
    settings: { rounds: 2, startCash: 10000, wind: 'medium' },
    players: [{ name: 'A', ai: 'cyborg' }, { name: 'B', ai: 'spotter' }, { name: 'C', ai: 'gunner' }, { name: 'D', ai: 'rookie' }],
    aiFast: true,
    seed: 77,
  });
  session.start();
  let ticks = 0;
  while (session.game.phase !== Phase.GAME_OVER && ticks < 200000) {
    session.update();
    session.drainEvents();
    ticks++;
  }
  assert.equal(session.game.phase, Phase.GAME_OVER, `finished after ${ticks} ticks`);
  const standings = session.game.standings();
  assert.equal(standings.reduce((n, t) => n + t.stats.wins, 0) <= 2, true);
  assert.ok(standings[0].stats.damage > 0);
  assert.ok(WIDTH > 0);
});
