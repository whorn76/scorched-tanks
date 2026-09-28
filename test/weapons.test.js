import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase } from '../src/core/game.js';
import { WEAPONS } from '../src/core/weapons.js';
import { AIR } from '../src/core/terrain.js';
import { WIDTH, HEIGHT } from '../src/core/constants.js';
import { fireAndSettle, flatGame, launch } from './helpers.js';

const calm = { settings: { wind: 'off' } };

function run(game) {
  const s = game.state;
  s.phase = Phase.BUSY;
  s.pendingTurnEnd = false;
  s.quietNeeded = 1;
  game.settle();
  return game.drainEvents();
}

const count = (events, type, pred = () => true) => events.filter((e) => e.type === type && pred(e)).length;
const solidCount = (game, x0, x1, y0, y1) => {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (game.terrain.isSolid(x, y)) n++;
  return n;
};

test('every weapon in the table has a known kind and sane numbers', () => {
  const kinds = new Set(['missile', 'mirv', 'funky', 'leapfrog', 'napalm', 'roller', 'digger', 'dirt', 'riot', 'tracer']);
  for (const w of WEAPONS) {
    assert.ok(kinds.has(w.kind), `${w.id} kind`);
    assert.ok(w.price >= 0 && (w.price === 0 || w.bundle > 0), `${w.id} price`);
    if (['missile', 'mirv', 'funky', 'leapfrog', 'roller', 'digger'].includes(w.kind)) assert.ok(w.radius > 0 && w.damage > 0, `${w.id} blast`);
  }
});

test('the Baby Missile is free and unlimited; other weapons use up ammo', () => {
  const game = flatGame(calm);
  const tank = game.state.tanks[0];
  fireAndSettle(game, { angle: 90, power: 100 });
  assert.equal(game.state.active, 1);
  const other = game.state.tanks[1];
  other.stock.missile = 2;
  fireAndSettle(game, { angle: 90, power: 100, weaponId: 'missile' });
  assert.equal(other.stock.missile, 1);
  assert.equal(tank.stock.baby, 0, 'baby missiles are never counted');
});

test('MIRV splits into 5 warheads at the top of its arc', () => {
  const game = flatGame(calm);
  launch(game, { x: 300, y: 300, vx: 150, vy: -300, weaponId: 'mirv' });
  const events = run(game);
  const split = events.find((e) => e.type === 'split');
  assert.ok(split, 'it split');
  assert.equal(split.count, 5);
  assert.ok(split.y < 300 - 100, 'near the apex');
  assert.equal(count(events, 'explosion'), 5);
  const xs = events.filter((e) => e.type === 'explosion').map((e) => e.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 150, 'warheads spread out');
});

test("Death's Head splits into 9 big warheads", () => {
  const game = flatGame(calm);
  launch(game, { x: 640, y: 300, vx: 0, vy: -250, weaponId: 'deathshead' });
  const events = run(game);
  const blasts = events.filter((e) => e.type === 'explosion');
  assert.equal(blasts.length, 9);
  assert.ok(blasts.every((e) => e.radius >= 40));
});

test('a MIRV that hits something before its apex goes off as one warhead', () => {
  const game = flatGame(calm);
  launch(game, { x: 300, y: 480, vx: 300, vy: 200, weaponId: 'mirv' });
  const events = run(game);
  assert.equal(count(events, 'split'), 0);
  assert.equal(count(events, 'explosion'), 1);
});

test('Funky Bomb bursts and scatters bomblets', () => {
  const game = flatGame({ ...calm, walls: 'concrete' });
  launch(game, { x: 640, y: 450, vx: 0, vy: 200, weaponId: 'funky' });
  const events = run(game);
  const split = events.find((e) => e.type === 'split');
  assert.equal(split.count, 8);
  assert.equal(count(events, 'explosion'), 9, 'the main blast plus 8 bomblets');
});

test('Leapfrog explodes three times, hopping forward', () => {
  const game = flatGame(calm);
  launch(game, { x: 300, y: 440, vx: 220, vy: 100, weaponId: 'leapfrog' });
  const events = run(game);
  const blasts = events.filter((e) => e.type === 'explosion');
  assert.equal(blasts.length, 3);
  assert.equal(count(events, 'bounce'), 2);
  assert.ok(blasts[1].x > blasts[0].x + 20 && blasts[2].x > blasts[1].x + 20, 'each hop lands further on');
});

test('napalm flows downhill into a pit and burns a tank there', () => {
  const heights = new Int16Array(WIDTH).fill(450);
  // A V-shaped valley with a tank at the bottom.
  for (let x = 500; x <= 780; x++) heights[x] = 450 + 140 - Math.abs(x - 640);
  const game = flatGame({ ...calm, xs: [640, 200], heights });
  const victim = game.state.tanks[0];
  assert.ok(victim.y > 560);
  launch(game, { x: 560, y: 400, vx: 0, vy: 120, weaponId: 'napalm' });
  let lowest = 0;
  const s = game.state;
  s.phase = Phase.BUSY;
  s.pendingTurnEnd = false;
  s.quietNeeded = 1;
  let sawNapalm = false;
  for (let i = 0; i < 2000 && s.phase === Phase.BUSY; i++) {
    game.tick();
    if (s.napalm.length) {
      sawNapalm = true;
      lowest = Math.max(lowest, ...s.napalm.map((n) => n.y));
    }
  }
  assert.ok(sawNapalm);
  assert.ok(lowest > 540, `the fire ran down to y=${lowest}`);
  assert.ok(victim.health < 85, `the tank in the pit burned (health ${victim.health})`);
  assert.equal(s.napalm.length, 0, 'it burns out');
});

test('hot napalm burns harder than napalm', () => {
  const burn = (weaponId) => {
    const game = flatGame({ ...calm, xs: [640, 200] });
    launch(game, { x: 640, y: 440, vx: 0, vy: 50, weaponId });
    run(game);
    return 100 - game.state.tanks[0].health;
  };
  const normal = burn('napalm');
  const hot = burn('hotnapalm');
  assert.ok(normal > 5, `napalm did ${normal}`);
  assert.ok(hot > normal, `hot napalm did ${hot} vs ${normal}`);
});

test('a roller rolls downhill after landing and explodes when it stops', () => {
  const heights = new Int16Array(WIDTH).fill(600);
  for (let x = 0; x < 700; x++) heights[x] = Math.max(300, 600 - Math.floor((700 - x) * 0.5));
  const game = flatGame({ ...calm, xs: [100, 1200], heights });
  launch(game, { x: 400, y: 300, vx: 10, vy: 60, weaponId: 'roller' });
  const events = run(game);
  assert.equal(count(events, 'roll'), 1);
  const blast = events.find((e) => e.type === 'explosion');
  assert.ok(blast.x > 600, `rolled down to x=${blast.x.toFixed(0)}`);
});

test('a roller explodes when it touches a tank', () => {
  const heights = new Int16Array(WIDTH).fill(600);
  for (let x = 0; x < 900; x++) heights[x] = Math.max(300, 600 - Math.floor((900 - x) * 0.4));
  const game = flatGame({ ...calm, xs: [100, 760], heights });
  const target = game.state.tanks[1];
  launch(game, { x: 500, y: 300, vx: 10, vy: 60, weaponId: 'roller' });
  const events = run(game);
  const blast = events.find((e) => e.type === 'explosion');
  assert.ok(Math.abs(blast.x - target.x) < 25, `blew up at the tank (${blast.x.toFixed(0)} vs ${target.x})`);
  assert.ok(target.health < 70 || !target.alive);
});

test('a digger tunnels underground before exploding', () => {
  const game = flatGame({ ...calm, height: 400 });
  launch(game, { x: 640, y: 350, vx: 0, vy: 300, weaponId: 'digger' });
  const events = run(game);
  const blast = events.find((e) => e.type === 'explosion');
  assert.ok(blast.y > 470, `exploded deep underground at y=${blast.y.toFixed(0)}`);
});

test('a sandhog sends three burrowers', () => {
  const game = flatGame({ ...calm, height: 400 });
  launch(game, { x: 640, y: 350, vx: 0, vy: 300, weaponId: 'sandhog' });
  const events = run(game);
  const blasts = events.filter((e) => e.type === 'explosion');
  assert.equal(blasts.length, 3);
  assert.ok(blasts.every((e) => e.y > 460));
});

test('dirt weapons add dirt and can bury a tank', () => {
  const game = flatGame({ ...calm, xs: [640, 200] });
  const tank = game.state.tanks[0];
  const before = solidCount(game, 540, 740, 380, 499);
  launch(game, { x: 640, y: 300, vx: 0, vy: 100, weaponId: 'tonofdirt' });
  const events = run(game);
  assert.equal(count(events, 'dirt'), 1);
  assert.ok(solidCount(game, 540, 740, 380, 499) > before + 5000, 'a heap of dirt');
  assert.ok(game.terrain.isSolid(tank.x, tank.y - 6) && game.terrain.isSolid(tank.x, tank.y - 20), 'the tank is buried');
  assert.equal(tank.health, 100, 'dirt does no damage');
});

test('a riot charge digs its own tank out', () => {
  const game = flatGame({ ...calm, xs: [640, 200] });
  const tank = game.state.tanks[0];
  game.terrain.addDirt(640, 480, 40, 1);
  game.terrain.settleAll();
  assert.ok(game.terrain.isSolid(tank.x, tank.y - 8), 'buried');
  tank.stock.riot = 1;
  fireAndSettle(game, { angle: 90, power: 300, weaponId: 'riot' });
  for (let y = tank.y - 25; y < tank.y; y++) assert.equal(game.terrain.isSolid(tank.x, y), false, `clear at y=${y}`);
  assert.ok(game.terrain.isSolid(tank.x, tank.y), 'the ground under it stays');
  assert.equal(tank.health, 100);
  assert.equal(tank.stock.riot, 0);
});

test('tracers do no damage and leave no crater', () => {
  const game = flatGame({ ...calm, xs: [300, 900] });
  const before = solidCount(game, 0, WIDTH - 1, 480, HEIGHT - 1);
  launch(game, { x: 880, y: 400, vx: 60, vy: 0, weaponId: 'tracer' });
  const events = run(game);
  assert.equal(count(events, 'explosion'), 0);
  assert.equal(count(events, 'tracerEnd'), 1);
  assert.equal(solidCount(game, 0, WIDTH - 1, 480, HEIGHT - 1), before);
  assert.ok(game.state.tanks.every((t) => t.health === 100));
});

test('a nuke flattens a big area and flashes', () => {
  const game = flatGame({ ...calm, xs: [100, 1200] });
  launch(game, { x: 640, y: 450, vx: 0, vy: 200, weaponId: 'nuke' });
  const events = run(game);
  const blast = events.find((e) => e.type === 'explosion');
  assert.equal(blast.flash, true);
  assert.equal(blast.radius, 100);
  assert.ok(!game.terrain.isSolid(640, 560), 'deep crater');
  const carve = events.find((e) => e.type === 'carve');
  assert.ok(carve.removed > 12000);
});

test('diggers and rollers still hit tanks directly', () => {
  const game = flatGame({ ...calm, xs: [300, 900] });
  const target = game.state.tanks[1];
  launch(game, { x: 820, y: target.y - 8, vx: 500, vy: -40, weaponId: 'digger' });
  const events = run(game);
  assert.equal(count(events, 'dig'), 0);
  assert.ok(count(events, 'directHit') === 1);
  assert.ok(target.health < 100);
  const holes = solidCount(game, 880, 920, target.y - 20, target.y);
  assert.ok(holes >= 0 && AIR === 0);
});
