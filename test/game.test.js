import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Game, Phase, maxPower } from '../src/core/game.js';
import { hashGame } from '../src/core/hash.js';
import { loadSnapshot, makeSnapshot } from '../src/core/snapshot.js';
import { HIT_LOST, HIT_TANK, HIT_TERRAIN, HIT_WALL, launchVector, traceShot, barrelTip } from '../src/core/physics.js';
import { HEIGHT, TANK, WIDTH, DEATH_BLAST } from '../src/core/constants.js';
import { AIR } from '../src/core/terrain.js';
import { planRound } from '../src/core/terrainGen.js';
import { Rng } from '../src/core/rng.js';
import { ECONOMY } from '../src/core/economy.js';
import { fire, fireAndSettle, flatGame, launch, players } from './helpers.js';

/** Runs the world (outside a turn) until everything is at rest. */
function runWorld(game) {
  const s = game.state;
  s.phase = Phase.BUSY;
  s.pendingTurnEnd = false;
  s.quietNeeded = 1;
  game.settle();
  return game.drainEvents();
}

/** Binary-searches the power that lands a shot at `targetX` on flat ground. */
function powerFor(game, shooter, angle, targetX) {
  let lo = 50;
  let hi = maxPower(shooter);
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const v = launchVector(angle, mid);
    const tip = barrelTip(shooter, v.ux, v.uy);
    const r = traceShot(game.env, { x: tip.x, y: tip.y, vx: v.vx, vy: v.vy, owner: shooter.id });
    const dir = Math.sign(targetX - shooter.x);
    if ((r.x - targetX) * dir < 0) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

test('a new round puts every tank on its pad and starts the first turn', () => {
  const game = Game.create({ settings: {}, players: players(4) });
  const plan = planRound({ settings: game.state.settings, tankCount: 4, round: 1, rng: new Rng(9) });
  assert.equal(game.apply({ type: 'newRound', ...plan }).ok, true);
  const s = game.state;
  assert.equal(s.phase, Phase.AIM);
  assert.equal(s.round, 1);
  assert.equal(s.turnId, 1);
  assert.equal(s.active, plan.first);
  for (const tank of s.tanks) {
    assert.ok(game.supported(tank), `${tank.name} stands on ground`);
    assert.equal(game.terrain.isSolid(tank.x, tank.y - 1), false, 'nothing on top of it');
    assert.equal(tank.health, 100);
  }
  const xs = s.tanks.map((t) => t.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] > 120, 'tanks start spread out');
});

test('shots that break the rules are rejected', () => {
  const game = flatGame();
  const s = game.state;
  const base = { turnId: s.turnId, playerId: 0, weaponId: 'baby', angle: 45, power: 500, seed: 1, ...launchVector(45, 500) };
  const bad = (changes, expected) => {
    const result = game.apply({ type: 'shot', ...base, ...changes });
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
  };
  bad({ turnId: s.turnId + 1 }, 'stale turn');
  bad({ playerId: 1 }, 'not your turn');
  bad({ playerId: 7 }, 'not your turn');
  bad({ angle: 181 }, 'bad angle');
  bad({ angle: NaN }, 'bad angle');
  bad({ power: 1001 }, 'bad power');
  bad({ power: '500' }, 'bad power');
  bad({ weaponId: 'laser' }, 'unknown weapon');
  bad({ weaponId: 'nuke' }, 'out of ammo');
  bad({ vx: 1e9 }, 'bad velocity');
  bad({ seed: -1 }, 'bad seed');
  assert.equal(game.apply({ type: 'teleport' }).ok, false);
  assert.equal(game.apply(null).ok, false);

  assert.equal(game.apply({ type: 'shot', ...base }).ok, true);
  assert.equal(game.apply({ type: 'shot', ...base }).error, 'not waiting for a move', 'no second shot while busy');
});

test('max power is capped by health (health × 10)', () => {
  const game = flatGame();
  const tank = game.state.tanks[0];
  tank.health = 42;
  assert.equal(maxPower(tank), 420);
  assert.equal(fire(game, { angle: 45, power: 421 }).error, 'bad power');
  assert.equal(fire(game, { angle: 45, power: 420 }).ok, true);
});

test('a full-power 45° shot with no wind crosses the map', () => {
  const game = flatGame({ xs: [40, 1200], height: 600, settings: { wind: 'off' } });
  const shooter = game.state.tanks[0];
  const v = launchVector(45, 1000);
  const tip = barrelTip(shooter, v.ux, v.uy);
  const r = traceShot({ ...game.env, tanks: null }, { x: tip.x, y: tip.y, vx: v.vx, vy: v.vy });
  assert.ok(r.code === HIT_LOST || r.x > WIDTH * 0.85, `landed at ${r.x.toFixed(0)}`);
  const flight = r.ticks / 60;
  assert.ok(flight > 2 && flight < 4, `flight time ${flight.toFixed(2)}s`);
});

test('trial shots predict the real shot exactly', () => {
  const game = flatGame({ wind: 7 });
  const shooter = game.state.tanks[0];
  const v = launchVector(52.3, 611);
  const tip = barrelTip(shooter, v.ux, v.uy);
  const predicted = traceShot(game.env, { x: tip.x, y: tip.y, vx: v.vx, vy: v.vy, owner: 0 });
  fireAndSettle(game, { angle: 52.3, power: 611 });
  const impact = game.state.lastShot.impact;
  assert.equal(impact.x, predicted.x);
  assert.equal(impact.y, predicted.y);
});

test('a direct hit damages the target and pays the shooter', () => {
  const game = flatGame({ xs: [300, 900], settings: { wind: 'off' } });
  const [a, b] = game.state.tanks;
  const power = powerFor(game, a, 45, b.x);
  const events = fireAndSettle(game, { angle: 45, power });
  assert.ok(events.some((e) => e.type === 'explosion'));
  assert.ok(b.health < 100, 'target took damage');
  const lost = 100 - b.health;
  assert.ok(lost >= 25, `lost ${lost}`);
  assert.equal(a.money, lost * ECONOMY.damageReward);
  assert.equal(a.stats.damage, lost);
  assert.equal(game.state.active, 1, 'turn passed to the other tank');
  assert.equal(game.state.turnId, 2);
});

test('blast damage falls off with distance and stops at the edge', () => {
  const game = flatGame({ xs: [200, 500, 800, 1100], settings: { wind: 'off' } });
  const tanks = game.state.tanks;
  const r = 60;
  // Directly on tank 1, 30 px from tank 2's hull, out of range of the others. No craters, so
  // nobody takes fall damage on top.
  game.explode(500, tanks[1].y - 8, r, 80, -1, { carve: false });
  game.explode(800 + TANK.hitHalfWidth + 30, tanks[2].y - 8, r, 80, -1, { carve: false });
  runWorld(game);
  assert.equal(tanks[0].health, 100);
  assert.equal(tanks[1].health, 100 - 80, 'full damage at the center');
  assert.equal(tanks[2].health, 100 - Math.round(80 * (1 - (0.7 * 30) / r)), 'partial damage further out');
  assert.equal(tanks[3].health, 100);
});

test('shields soak up damage until they break', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  const tank = game.state.tanks[1];
  tank.shield = 30;
  tank.shieldType = 'shield';
  game.damageTank(tank, 20, 0);
  assert.equal(tank.shield, 10);
  assert.equal(tank.health, 100);
  const events = game.drainEvents();
  assert.ok(events.some((e) => e.type === 'shieldDamage'));
  game.damageTank(tank, 25, 0);
  assert.equal(tank.shield, 0);
  assert.equal(tank.shieldType, null);
  assert.equal(tank.health, 85);
  assert.ok(game.drainEvents().some((e) => e.type === 'shieldBreak'));
});

test('shells hit a shield bubble before the hull', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  const target = game.state.tanks[1];
  target.shield = 60;
  target.shieldType = 'shield';
  const shell = launch(game, { x: target.x - 100, y: target.y - 8, vx: 600, vy: -2 });
  const p = { ...shell };
  const r = traceShot({ ...game.env, gravity: 0 }, { x: p.x, y: p.y, vx: 600, vy: 0 });
  assert.equal(r.tank, 1);
  assert.ok(r.x < target.x - TANK.hitHalfWidth, 'stopped at the bubble');
});

test('tanks fall when the ground is blown away and take fall damage', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  const tank = game.state.tanks[1];
  const startY = tank.y;
  game.terrain.carve(tank.x, tank.y + 40, 50);
  const events = runWorld(game);
  assert.ok(tank.y > startY + 60, `fell to ${tank.y}`);
  assert.ok(game.supported(tank));
  const land = events.find((e) => e.type === 'land' && e.tank === 1);
  assert.ok(land && land.damage > 0, 'took fall damage');
  assert.equal(tank.health, 100 - land.damage);
});

test('a parachute opens on a long fall and prevents fall damage', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  const tank = game.state.tanks[1];
  tank.stock.parachute = 2;
  game.terrain.carve(tank.x, tank.y + 40, 50);
  const events = runWorld(game);
  assert.ok(events.some((e) => e.type === 'parachute' && e.tank === 1));
  assert.equal(tank.stock.parachute, 1, 'one chute used');
  assert.equal(tank.health, 100);
});

test('short drops do not open parachutes or hurt', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  const tank = game.state.tanks[1];
  tank.stock.parachute = 1;
  for (let x = tank.x - 10; x <= tank.x + 10; x++) for (let y = tank.y; y < tank.y + 8; y++) game.terrain.data[y * WIDTH + x] = AIR;
  runWorld(game);
  assert.equal(tank.stock.parachute, 1);
  assert.equal(tank.health, 100);
});

test('wind pushes shells downwind', () => {
  const landing = (wind) => {
    const game = flatGame({ wind, settings: { wind: 'high' } });
    const shooter = game.state.tanks[0];
    const v = launchVector(60, 600);
    const tip = barrelTip(shooter, v.ux, v.uy);
    return traceShot({ ...game.env, tanks: null }, { x: tip.x, y: tip.y, vx: v.vx, vy: v.vy }).x;
  };
  const calm = landing(0);
  assert.ok(landing(10) > calm + 60, 'tailwind carries it further');
  assert.ok(landing(-10) < calm - 60, 'headwind holds it back');
});

test('fast shells cannot pass through a one-pixel wall', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  for (let y = 0; y < HEIGHT; y++) game.terrain.data[y * WIDTH + 640] = 5;
  const r = traceShot({ ...game.env, tanks: null, gravity: 0 }, { x: 100, y: 300.37, vx: 599, vy: 7 });
  assert.equal(r.code, HIT_TERRAIN);
  assert.ok(r.x >= 640 && r.x < 641, `stopped at ${r.x}`);
});

test('wall modes: open, wrap, rubber and concrete', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  const start = { x: 1200, y: 200, vx: 300, vy: -100 };
  const run = (walls) => traceShot({ ...game.env, tanks: null, walls }, start);
  assert.equal(run('open').code, HIT_LOST);
  const concrete = run('concrete');
  assert.equal(concrete.code, HIT_WALL);
  assert.equal(concrete.x, WIDTH - 1);
  const wrapped = run('wrap');
  assert.equal(wrapped.code, HIT_TERRAIN);
  assert.ok(wrapped.x < 600, `wrapped around to ${wrapped.x.toFixed(0)}`);
  const bounced = run('rubber');
  assert.equal(bounced.code, HIT_TERRAIN);
  assert.ok(bounced.x > 700 && bounced.x < 1200, `bounced back to ${bounced.x.toFixed(0)}`);
});

test('shells can fly above the top of the screen and come back down', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  const r = traceShot({ ...game.env, tanks: null }, { x: 640, y: 400, vx: 0, vy: -700 });
  assert.ok(r.apexY < -300, `apex ${r.apexY.toFixed(0)}`);
  assert.equal(r.code, HIT_TERRAIN);
});

test('turns rotate through living tanks and the round ends with one survivor', () => {
  const game = flatGame({ xs: [200, 640, 1080], settings: { wind: 'off' } });
  const s = game.state;
  const [a, b, c] = s.tanks;
  fireAndSettle(game, { angle: 90, power: 100 });
  assert.equal(s.active, 1);
  b.health = 1;
  game.damageTank(b, 5, 0);
  assert.equal(b.alive, false);
  runWorld(game);
  assert.equal(s.phase, Phase.AIM);
  fireAndSettle(game, { angle: 90, power: 100, playerId: s.active });
  assert.equal(s.active, 0, 'dead tank is skipped');
  c.health = 1;
  game.damageTank(c, 5, 0);
  runWorld(game);
  assert.equal(s.phase, Phase.ROUND_OVER);
  assert.equal(s.results.winner, 0);
  assert.equal(a.stats.wins, 1);
  assert.equal(a.stats.kills, 2);
  const winnerRow = s.results.earnings.find((e) => e.tank === 0);
  assert.equal(winnerRow.bonus, ECONOMY.roundIncome + 2 * ECONOMY.survivalBonus + ECONOMY.winBonus);
  const loserRow = s.results.earnings.find((e) => e.tank === 2);
  assert.equal(loserRow.bonus, ECONOMY.roundIncome + ECONOMY.survivalBonus, 'outlived one tank');
});

test('destroyed tanks explode and can set off their neighbours', () => {
  const game = flatGame({ xs: [100, 560, 610, 660], settings: { wind: 'off' } });
  const tanks = game.state.tanks;
  for (const t of tanks.slice(1)) t.health = 12;
  game.damageTank(tanks[1], 20, 0);
  const events = runWorld(game);
  const deaths = events.filter((e) => e.type === 'death').map((e) => e.tank);
  assert.deepEqual(deaths.sort(), [1, 2, 3], 'the blast chain took out all three');
  assert.ok(events.filter((e) => e.type === 'explosion' && e.kind === 'death').length >= 3);
  assert.ok(tanks.slice(1).every((t) => t.wreck));
  assert.equal(tanks[0].stats.kills, 3, 'the killer gets credit for the chain');
  assert.ok(DEATH_BLAST.radius > 0);
});

test('damaging yourself costs money', () => {
  const game = flatGame({ settings: { wind: 'off' } });
  const a = game.state.tanks[0];
  a.money = 5000;
  game.damageTank(a, 10, 0);
  assert.equal(a.money, 5000 - 10 * ECONOMY.selfDamageCost);
  assert.equal(a.stats.selfDamage, 10);
});

test('the same commands always produce the same state', () => {
  const play = () => {
    const game = Game.create({ settings: {}, players: players(3) });
    const rng = new Rng(2024);
    game.apply({ type: 'newRound', ...planRound({ settings: game.state.settings, tankCount: 3, round: 1, rng }) });
    const hashes = [];
    for (let i = 0; i < 8 && game.phase === Phase.AIM; i++) {
      const tank = game.activeTank;
      const angle = 30 + ((i * 37) % 120);
      const power = Math.min(maxPower(tank), 300 + ((i * 131) % 600));
      fireAndSettle(game, { angle, power, seed: rng.nextU32() });
      hashes.push(hashGame(game));
    }
    return hashes;
  };
  const first = play();
  assert.ok(first.length >= 4);
  assert.deepEqual(play(), first);
});

test('snapshots round-trip to an identical state', async () => {
  const game = flatGame({ xs: [200, 700, 1100], settings: { wind: 'medium' } });
  fireAndSettle(game, { angle: 70, power: 480 });
  fireAndSettle(game, { angle: 110, power: 520 });
  game.state.tanks[2].stock.missile = 3;
  const snap = await makeSnapshot(game);
  const text = JSON.stringify(snap);
  assert.ok(text.length < 60000, `snapshot is ${text.length} bytes`);
  const copy = await loadSnapshot(JSON.parse(text));
  assert.equal(hashGame(copy), hashGame(game));
  // And they stay in step afterwards.
  fireAndSettle(game, { angle: 80, power: 300, seed: 5 });
  fireAndSettle(copy, { angle: 80, power: 300, seed: 5 });
  assert.equal(hashGame(copy), hashGame(game));
});

test('broken snapshots are rejected', async () => {
  const game = flatGame();
  const snap = await makeSnapshot(game);
  await assert.rejects(loadSnapshot({ ...snap, v: 999 }));
  await assert.rejects(loadSnapshot({ ...snap, terrain: { ...snap.terrain, data: 'not base64!' } }));
  await assert.rejects(loadSnapshot({ ...snap, state: { ...snap.state, tanks: [] } }));
  await assert.rejects(loadSnapshot({ ...snap, terrain: { ...snap.terrain, packedLength: 1 } }));
  await assert.rejects(loadSnapshot({ ...snap, terrain: { ...snap.terrain, method: 'deflate', data: 'AAAAAAAA' } }));
  await assert.rejects(loadSnapshot({ ...snap, state: { ...snap.state, phase: 'busy' } }), 'never taken mid-flight');
});

test('snapshots with missing or junk fields load safely', async () => {
  const game = flatGame();
  const snap = JSON.parse(JSON.stringify(await makeSnapshot(game)));
  delete snap.state.tanks[0].stats;
  delete snap.state.tanks[1].round;
  snap.state.tanks[1].weapon = 'constructor';
  snap.state.wind = 'gale';
  snap.state.walls = { evil: true };
  snap.state.projectiles = [{ x: 'NaN' }];
  const copy = await loadSnapshot(snap);
  assert.equal(copy.state.tanks[0].stats.kills, 0);
  assert.equal(copy.state.tanks[1].round.damage, 0);
  assert.equal(copy.state.tanks[1].weapon, 'baby');
  assert.equal(copy.state.wind, 0);
  assert.equal(copy.state.walls, 'open');
  assert.deepEqual(copy.state.projectiles, []);
  assert.match(hashGame(copy), /^[0-9a-f]{16}$/);
  fireAndSettle(copy, { angle: 70, power: 400 });
});

test('the hash notices any change to the world', () => {
  const game = flatGame();
  const before = hashGame(game);
  game.terrain.data[400 * WIDTH + 3] ^= 1;
  const afterTerrain = hashGame(game);
  assert.notEqual(afterTerrain, before);
  game.state.tanks[0].money += 1;
  assert.notEqual(hashGame(game), afterTerrain);
});

test('the core never uses non-deterministic or engine-dependent APIs', () => {
  const dir = new URL('../src/core/', import.meta.url);
  const forbidden = /Math\.random|Date\.now|new Date|performance\.now|document\.|window\.|setTimeout|requestAnimationFrame/;
  const trig = /Math\.(sin|cos|tan|asin|acos|atan|atan2|pow|exp|log|hypot|cbrt)\b|(?<![/*])\*\*(?![/*])/g;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(new URL(file, dir), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(!forbidden.test(source), `${file} uses a forbidden API`);
    if (file === 'terrainGen.js') continue; // authority-only; its output is sent, not recomputed
    const uses = [...source.matchAll(trig)];
    if (file === 'physics.js') {
      const start = source.indexOf('export function launchVector');
      const end = source.indexOf('\n}\n', start);
      for (const m of uses) assert.ok(m.index > start && m.index < end, `physics.js uses ${m[0]} outside launchVector`);
    } else {
      assert.equal(uses.length, 0, `${file} uses ${uses.map((m) => m[0]).join(', ')}`);
    }
  }
});

test('driving uses fuel, climbs gentle slopes and stops at cliffs', () => {
  const heights = new Int16Array(WIDTH).fill(500);
  for (let x = 700; x < WIDTH; x++) heights[x] = 500 - Math.min(20, Math.floor((x - 700) / 2));
  for (let x = 1000; x < WIDTH; x++) heights[x] = 300;
  const game = flatGame({ xs: [650, 200], heights, settings: { wind: 'off' } });
  const tank = game.state.tanks[0];
  assert.equal(game.apply({ type: 'move', turnId: 1, playerId: 0, dir: 1 }).error, 'no fuel');
  tank.stock.fuel = 400;
  let moves = 0;
  while (game.phase === Phase.AIM && tank.stock.fuel > 0 && moves < 60) {
    if (!game.apply({ type: 'move', turnId: game.state.turnId, playerId: 0, dir: 1 }).ok) break;
    game.settle();
    moves++;
    if (tank.x >= 990) break;
  }
  assert.ok(tank.x > 760, `drove up the slope to ${tank.x}`);
  assert.ok(tank.y < 500, 'climbed');
  assert.ok(tank.stock.fuel < 400);
  assert.ok(tank.x < 1000 - TANK.foot, 'the cliff stopped it');
  assert.equal(game.state.active, 0, 'driving does not end the turn');
});

test('a round that drags on ends on time and the healthiest tank wins', () => {
  const game = flatGame({ xs: [300, 900], settings: { wind: 'off' } });
  const s = game.state;
  s.tanks[1].health = 40;
  s.roundTurns = game.turnLimit() - 1;
  fireAndSettle(game, { angle: 90, power: 0, weaponId: 'baby' });
  assert.equal(s.phase, Phase.AIM, 'the last allowed turn still happens');
  s.tanks[0].health = 90;
  fireAndSettle(game, { angle: 90, power: 50, weaponId: 'baby', playerId: s.active });
  assert.equal(s.phase, Phase.ROUND_OVER);
  assert.equal(s.results.timeUp, true);
  assert.equal(s.results.winner, s.tanks[0].health > s.tanks[1].health ? 0 : 1);
});

test('the direct-hit code reports which tank was hit', () => {
  const game = flatGame({ xs: [300, 900], settings: { wind: 'off' } });
  const target = game.state.tanks[1];
  const r = traceShot({ ...game.env, gravity: 0 }, { x: target.x - 200, y: target.y - 6, vx: 500, vy: 0 });
  assert.equal(r.code, HIT_TANK);
  assert.equal(r.tank, 1);
});
