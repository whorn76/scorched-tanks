// AI aiming: search angle and power by flying trial shells through the real physics (no side
// effects), then add personality-dependent error. The search is a generator that yields every
// few trial shots so the caller can spread it across frames.
import { MAX_POWER, TANK, WIDTH, WIND_ACCEL } from '../core/constants.js';
import { maxPower } from '../core/game.js';
import { HIT_LOST, HIT_SHIELD, HIT_TANK, barrelTip, launchVector, traceShot } from '../core/physics.js';

/** Where a shot at (angle, power) from `tank` would land, using `env` (which may lie about wind). */
export function trial(env, tank, angle, power) {
  const v = launchVector(angle, power);
  const tip = barrelTip(tank, v.ux, v.uy);
  return traceShot(env, { x: tip.x, y: tip.y, vx: v.vx, vy: v.vy, owner: tank.id });
}

/** How good an impact is for hitting `target` from `shooter`: lower is better. */
export function scoreImpact(result, shooter, target, blast = 20) {
  if (result.code === HIT_LOST) return 5000;
  const hitTarget = (result.code === HIT_TANK || result.code === HIT_SHIELD) && result.tank === target.id;
  const dx = result.x - target.x;
  const dy = result.y - (target.y - 8);
  let score = hitTarget ? 0 : Math.sqrt(dx * dx + dy * dy);
  const sx = result.x - shooter.x;
  const sy = result.y - (shooter.y - 8);
  const selfDistance = Math.sqrt(sx * sx + sy * sy);
  if (selfDistance < blast + 30) score += 900 - selfDistance * 4;
  return score;
}

/** Angles worth trying toward a target: direct-ish arcs plus high lobs, on the target's side. */
export function candidateAngles(shooter, target) {
  const right = target.x >= shooter.x;
  const angles = [];
  for (let a = 18; a <= 84; a += 6) angles.push(right ? a : 180 - a);
  angles.push(right ? 88 : 92);
  return angles;
}

/**
 * Generator that searches for the best (angle, power) to hit `target`. Yields between small
 * batches of trial shots; returns { angle, power, score, tries }.
 */
export function* searchAim(env, shooter, target, { blast = 20, powerCap = maxPower(shooter), angles = null } = {}) {
  const cap = Math.max(60, Math.min(MAX_POWER, powerCap));
  let best = { angle: shooter.x < WIDTH / 2 ? 60 : 120, power: Math.min(500, cap), score: Infinity };
  let tries = 0;
  const consider = (angle, power) => {
    tries++;
    const result = trial(env, shooter, angle, power);
    const score = scoreImpact(result, shooter, target, blast);
    if (score < best.score) best = { angle, power, score, result };
    return score;
  };
  const list = angles ?? candidateAngles(shooter, target);
  const steps = 22;
  for (const angle of list) {
    let localBest = Infinity;
    let localPower = 0;
    for (let i = 1; i <= steps; i++) {
      const power = Math.round((cap * i) / steps);
      const score = consider(angle, power);
      if (score < localBest) {
        localBest = score;
        localPower = power;
      }
      if (i % 8 === 0) yield best.score;
    }
    // Refine power around the best coarse sample.
    let span = cap / steps;
    let center = localPower;
    for (let k = 0; k < 7; k++) {
      span /= 2;
      const lo = Math.max(0, Math.round(center - span));
      const hi = Math.min(cap, Math.round(center + span));
      const sLo = consider(angle, lo);
      const sHi = consider(angle, hi);
      if (sLo < localBest && sLo <= sHi) {
        localBest = sLo;
        center = lo;
      } else if (sHi < localBest) {
        localBest = sHi;
        center = hi;
      }
    }
    yield best.score;
    if (best.score === 0) break;
  }
  // Fine-tune the angle around the winner.
  for (const da of [-2, -1, -0.5, 0.5, 1, 2]) {
    const angle = Math.min(180, Math.max(0, best.angle + da));
    for (const dp of [-6, 0, 6]) consider(angle, Math.min(cap, Math.max(0, best.power + dp)));
    yield best.score;
  }
  best.tries = tries;
  return best;
}

/**
 * The wind (as px/s² of push) that would explain where a shot actually landed. The Spotter uses
 * this to correct its aim after a miss instead of reading the wind gauge.
 */
export function fitWind(env, tank, angle, power, impactX) {
  let lo = -WIND_ACCEL * 22;
  let hi = WIND_ACCEL * 22;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const r = trial({ ...env, windAccel: mid }, tank, angle, power);
    const x = r.code === HIT_LOST ? (r.x < WIDTH / 2 ? -1e6 : 1e6) : r.x;
    if (x < impactX) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** True when dirt sits right in front of the barrel (the tank is buried). */
export function isBuried(terrain, tank) {
  let solid = 0;
  for (const [dx, dy] of [[0, -TANK.pivotY - 4], [-6, -TANK.pivotY], [6, -TANK.pivotY], [0, -TANK.pivotY - 12], [-10, -TANK.pivotY - 6], [10, -TANK.pivotY - 6]]) {
    if (terrain.isSolid(tank.x + dx, tank.y + dy)) solid++;
  }
  return solid >= 3;
}

/** True when the ground on both sides of a tank is higher: rollers will run down to it. */
export function inValley(terrain, tank) {
  const left = terrain.surfaceY(Math.max(0, tank.x - 45));
  const right = terrain.surfaceY(Math.min(WIDTH - 1, tank.x + 45));
  return left < tank.y - 18 && right < tank.y - 18;
}
