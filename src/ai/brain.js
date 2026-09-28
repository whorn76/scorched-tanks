// Drives AI tanks. It runs only on the authority (a local game or the online host) and plays
// through the same intents as a human: aim previews while the barrel swings, then `fire`.
// Planning is split across frames with a small time budget so it never stalls rendering.
import { WIDTH } from '../core/constants.js';
import { Phase, maxPower } from '../core/game.js';
import { Rng } from '../core/rng.js';
import { FREE_WEAPON, WEAPON_BY_ID } from '../core/weapons.js';
import { searchAim } from './aim.js';

const defaultNow = () => (globalThis.performance ? performance.now() : Date.now());

export const PERSONALITIES = {
  rookie: { angleError: 7, powerError: 0.14, knowsWind: false, think: [40, 80] },
  gunner: { angleError: 2.2, powerError: 0.05, knowsWind: false, think: [35, 65] },
  spotter: { angleError: 3, powerError: 0.07, knowsWind: false, think: [35, 65] },
  cyborg: { angleError: 0.5, powerError: 0.012, knowsWind: true, think: [30, 55] },
};

export class Brain {
  constructor(session, { seed = 1, now = defaultNow, budgetMs = 3, fast = false, acts = (tank) => !!tank.ai } = {}) {
    this.session = session;
    this.acts = acts; // which tanks this brain plays
    this.rng = new Rng(seed);
    this.now = now;
    this.budgetMs = budgetMs;
    this.fast = fast; // skip the think pause and barrel swing (tests)
    this.turnId = -1;
    this.stage = 'idle';
    this.job = null;
    this.plan = null;
  }

  personality(tank) {
    return PERSONALITIES[tank.ai] ?? PERSONALITIES.gunner;
  }

  update() {
    const game = this.session.game;
    if (!game) return;
    const s = game.state;
    if (s.phase !== Phase.AIM) {
      if (s.phase !== Phase.BUSY) this.stage = 'idle';
      return;
    }
    const tank = s.tanks[s.active];
    if (!tank || !tank.alive || !this.acts(tank)) {
      this.stage = 'idle';
      return;
    }
    if (this.turnId !== s.turnId || this.stage === 'idle') this.beginTurn(game, tank);
    if (this.stage === 'think') this.think(game, tank);
    if (this.stage === 'swing') this.swing(game, tank);
  }

  chooseTarget(game, tank) {
    const enemies = game.state.tanks.filter((t) => t.alive && t.id !== tank.id);
    enemies.sort((a, b) => Math.abs(a.x - tank.x) - Math.abs(b.x - tank.x) || a.id - b.id);
    return enemies[0] ?? null;
  }

  beginTurn(game, tank) {
    const s = game.state;
    this.turnId = s.turnId;
    const target = this.chooseTarget(game, tank);
    const p = this.personality(tank);
    const env = { ...game.env, windAccel: p.knowsWind ? game.env.windAccel : 0 };
    const weaponId = FREE_WEAPON;
    this.plan = null;
    this.target = target;
    this.weaponId = weaponId;
    this.job = target ? searchAim(env, tank, target, { blast: WEAPON_BY_ID[weaponId].radius ?? 20 }) : null;
    this.startTick = this.session.ticks;
    this.thinkTicks = this.fast ? 0 : p.think[0] + this.rng.int(p.think[1] - p.think[0] + 1);
    this.stage = 'think';
  }

  think(game, tank) {
    if (this.job) {
      const start = this.now();
      do {
        const step = this.job.next();
        if (step.done) {
          this.plan = step.value;
          this.job = null;
          break;
        }
      } while (this.now() - start < this.budgetMs || this.fast);
    } else if (!this.plan) {
      this.plan = { angle: tank.x < WIDTH / 2 ? 60 : 120, power: Math.min(500, maxPower(tank)) };
    }
    if (!this.plan || this.session.ticks - this.startTick < this.thinkTicks) return;
    const p = this.personality(tank);
    const angle = this.plan.angle + (this.rng.float() * 2 - 1) * p.angleError;
    const power = this.plan.power * (1 + (this.rng.float() * 2 - 1) * p.powerError);
    this.final = {
      angle: Math.round(Math.min(180, Math.max(0, angle)) * 10) / 10,
      power: Math.round(Math.min(maxPower(tank), Math.max(0, power))),
    };
    this.swingFrom = { angle: tank.angle, power: tank.power };
    this.swingTicks = this.fast ? 0 : 18 + Math.round(Math.abs(this.final.angle - tank.angle) / 4);
    this.swingTick = 0;
    this.stage = 'swing';
  }

  swing(game, tank) {
    const s = game.state;
    this.swingTick++;
    const t = this.swingTicks ? Math.min(1, this.swingTick / this.swingTicks) : 1;
    const ease = t * t * (3 - 2 * t);
    const angle = this.swingFrom.angle + (this.final.angle - this.swingFrom.angle) * ease;
    const power = this.swingFrom.power + (this.final.power - this.swingFrom.power) * ease;
    if (t < 1) {
      if (this.swingTick % 3 === 0) {
        this.session.submit({ type: 'aim', playerId: tank.id, turnId: s.turnId, angle, power: Math.round(power), weaponId: this.weaponId });
      }
      return;
    }
    this.stage = 'fired';
    const result = this.session.submit({
      type: 'fire',
      playerId: tank.id,
      turnId: s.turnId,
      angle: this.final.angle,
      power: Math.min(this.final.power, maxPower(tank)),
      weaponId: this.weaponId,
    });
    if (!result?.ok) {
      // Try again next tick with the plain free missile (e.g. if the weapon ran out).
      this.failures = (this.failures ?? 0) + 1;
      this.weaponId = FREE_WEAPON;
      this.stage = this.failures < 5 ? 'swing' : 'idle';
    } else {
      this.failures = 0;
    }
  }
}
