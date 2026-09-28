// Shared helpers for the tests: small games on hand-made terrain, and a way to fire shots the
// same way the authority does.
import { Game } from '../src/core/game.js';
import { launchVector } from '../src/core/physics.js';
import { WIDTH } from '../src/core/constants.js';
import { WEAPON_BY_ID } from '../src/core/weapons.js';

export function players(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, color: '#ff0000', ...extra }));
}

/** A new game whose first round is flat ground at `height`, with tanks at `xs`. */
export function flatGame({ xs = [300, 900], height = 500, settings = {}, heights = null, walls = 'open', wind = 0, first = 0, seed = 1 } = {}) {
  const game = Game.create({ settings: { wind: 'high', startCash: 0, ...settings }, players: players(xs.length) });
  const h = heights ?? new Int16Array(WIDTH).fill(height);
  const result = game.apply({
    type: 'newRound',
    round: 1,
    style: 'flat',
    heights: h,
    xs,
    colorSeed: 12345,
    seed,
    ground: 0,
    sky: 'day',
    walls,
    wind,
    first,
  });
  if (!result.ok) throw new Error(result.error);
  game.drainEvents();
  return game;
}

/** Fires for the active tank with the authority's math. Returns the apply result. */
export function fire(game, { angle, power, weaponId = 'baby', seed = 7, playerId = game.state.active }) {
  return game.apply({
    type: 'shot',
    turnId: game.state.turnId,
    playerId,
    weaponId,
    angle,
    power,
    seed,
    ...launchVector(angle, power),
  });
}

/** Fires and runs the world until it's at rest again. */
export function fireAndSettle(game, shot) {
  const result = fire(game, shot);
  if (!result.ok) throw new Error(result.error);
  game.settle();
  return game.drainEvents();
}

/** Spawns a bare shell with an exact velocity (bypassing turns); call game.settle() after. */
export function launch(game, { x, y, vx, vy, weaponId = 'baby', owner = -1 }) {
  const s = game.state;
  s.phase = 'busy';
  s.pendingTurnEnd = false;
  s.quietNeeded = 1;
  return game.spawnShell(WEAPON_BY_ID[weaponId], owner, x, y, vx, vy, owner < 0 ? { armed: true } : null);
}
