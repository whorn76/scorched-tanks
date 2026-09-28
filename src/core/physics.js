// Projectile motion shared by the real simulation and the AI's side-effect-free trial shots.
// Per-tick math is limited to + − × ÷, Math.sqrt, Math.abs and floor/ceil so every engine
// produces identical results. Trig is only used by launchVector, which runs on the authority.
import { DT, HEIGHT, SPEED_PER_POWER, TANK, TIMING, WIDTH } from './constants.js';

export const HIT_NONE = 0;
export const HIT_TERRAIN = 1;
export const HIT_TANK = 2;
export const HIT_SHIELD = 3;
export const HIT_WALL = 4;
export const HIT_LOST = 5;

/**
 * Authority-only: turns an aim into a launch velocity and barrel direction. The results travel
 * inside the `shot` command, so clients never evaluate trig during the simulation.
 */
export function launchVector(angle, power) {
  const rad = (angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = -Math.sin(rad);
  const speed = power * SPEED_PER_POWER;
  return { vx: ux * speed, vy: uy * speed, ux, uy };
}

export function barrelTip(tank, ux, uy) {
  return { x: tank.x + ux * TANK.barrel, y: tank.y - TANK.pivotY + uy * TANK.barrel };
}

/** Distance from a point to a tank's hit box (0 when inside). */
export function distanceToTank(tank, x, y) {
  const x0 = tank.x - TANK.hitHalfWidth;
  const x1 = tank.x + TANK.hitHalfWidth;
  const y0 = tank.y - TANK.hitTop;
  const y1 = tank.y;
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

export const shieldCenterY = (tank) => tank.y - 8;

/**
 * Returns the index of the tank (or its shield) that a point touches, or -1. The shooter's own
 * tank is ignored until the shell has cleared it once (`p.armed`).
 */
function touchTank(p, x, y, tanks) {
  for (let i = 0; i < tanks.length; i++) {
    const t = tanks[i];
    if (!t.alive) continue;
    const r = TANK.shieldRadius;
    const dx = x - t.x;
    const dy = y - shieldCenterY(t);
    const inShield = t.shield > 0 && dx * dx + dy * dy <= r * r;
    const inHull = dx >= -TANK.hitHalfWidth && dx <= TANK.hitHalfWidth && y >= t.y - TANK.hitTop && y <= t.y + 1;
    if (i === p.owner && !p.armed) {
      if (!inShield && !inHull) p.armed = true;
      continue;
    }
    if (inShield) {
      p.hitTank = i;
      return HIT_SHIELD;
    }
    if (inHull) {
      p.hitTank = i;
      return HIT_TANK;
    }
  }
  return HIT_NONE;
}

/**
 * Advances a flying projectile by one tick, in sub-steps of at most one pixel so fast shells
 * can't skip through thin dirt or tanks. Mutates p (x, y, vx, vy, age, armed, hitTank) and returns
 * a HIT_* code.
 *
 * env: { terrain, gravity, windAccel, walls, tanks }
 */
export function stepProjectile(p, env) {
  p.age++;
  p.vx += env.windAccel * DT;
  p.vy += env.gravity * DT;
  const dx = p.vx * DT;
  const dy = p.vy * DT;
  const adx = dx < 0 ? -dx : dx;
  const ady = dy < 0 ? -dy : dy;
  const n = Math.max(1, Math.ceil(adx > ady ? adx : ady));
  let sx = dx / n;
  const sy = dy / n;
  let x = p.x;
  let y = p.y;
  const { terrain, tanks } = env;
  for (let i = 0; i < n; i++) {
    x += sx;
    y += sy;
    if (x < 0 || x >= WIDTH) {
      const walls = env.walls;
      if (walls === 'wrap') {
        x = x < 0 ? x + WIDTH : x - WIDTH;
      } else if (walls === 'rubber') {
        x = x < 0 ? -x : WIDTH - (x - WIDTH) - 0.001;
        sx = -sx;
        p.vx = -p.vx;
        p.bounces = (p.bounces || 0) + 1;
      } else if (walls === 'concrete') {
        p.x = x < 0 ? 0 : WIDTH - 1;
        p.y = y;
        return HIT_WALL;
      } else {
        p.x = x;
        p.y = y;
        return HIT_LOST;
      }
    }
    if (y >= HEIGHT) {
      p.x = x;
      p.y = HEIGHT - 1;
      return HIT_TERRAIN;
    }
    if (y >= 0 && terrain.isSolid(x, y)) {
      p.x = x;
      p.y = y;
      return HIT_TERRAIN;
    }
    if (tanks) {
      const hit = touchTank(p, x, y, tanks);
      if (hit !== HIT_NONE) {
        p.x = x;
        p.y = y;
        return hit;
      }
    }
  }
  p.x = x;
  p.y = y;
  if (p.age > TIMING.maxProjectileAge) return HIT_LOST;
  return HIT_NONE;
}

/**
 * Flies a plain shell from `start` until it lands, without touching the world. Used by the AI
 * to test aims. Returns { x, y, code, tank, ticks, apexY }.
 */
export function traceShot(env, start, maxTicks = TIMING.maxProjectileAge, path = null) {
  const p = { x: start.x, y: start.y, vx: start.vx, vy: start.vy, age: 0, owner: start.owner ?? -1, armed: false, hitTank: -1 };
  let apexY = p.y;
  let code = HIT_NONE;
  let ticks = 0;
  while (ticks < maxTicks) {
    code = stepProjectile(p, env);
    ticks++;
    if (p.y < apexY) apexY = p.y;
    if (path && ticks % 2 === 0) path.push(p.x, p.y);
    if (code !== HIT_NONE) break;
  }
  return { x: p.x, y: p.y, code, tank: code === HIT_TANK || code === HIT_SHIELD ? p.hitTank : -1, ticks, apexY };
}
