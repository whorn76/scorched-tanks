// Drives AI tanks. It runs only on the authority (a local game or the online host) and plays
// through the same intents as a human: aim previews while the barrel swings, then `fire`.
// Each personality picks targets, weapons and purchases its own way. Planning is split across
// frames with a small time budget so it never stalls rendering.
import { Phase, maxPower } from '../core/game.js';
import { Rng } from '../core/rng.js';
import { buyProblem } from '../core/economy.js';
import { FREE_WEAPON, ITEMS, WEAPONS, WEAPON_BY_ID, productById } from '../core/weapons.js';
import { fitWind, inValley, isBuried, searchAim } from './aim.js';
import { PERSONALITIES, SOLID, SPOTTER, STRONGEST } from './personality.js';

const defaultNow = () => (globalThis.performance ? performance.now() : Date.now());
const MAX_PURCHASES = 14;

const blastOf = (weapon) => weapon.radius ?? (weapon.kind === 'napalm' ? 60 : 20);

export class Brain {
  constructor(session, { seed = 1, now = defaultNow, budgetMs = 3, fast = false, acts = (tank) => !!tank.ai } = {}) {
    this.session = session;
    this.rng = new Rng(seed);
    this.now = now;
    this.budgetMs = budgetMs;
    this.fast = fast; // no think pause or barrel swing (tests)
    this.acts = acts; // which tanks this brain plays
    this.turnId = -1;
    this.stage = 'idle';
    this.job = null;
    this.plan = null;
    this.memory = new Map();
    this.shopKey = null;
    this.shopDone = new Set();
    this.shopReserve = new Map();
    this.shopCount = new Map();
    this.shopTick = 0;
    this.maxStepMs = 0; // longest planning slice, for tests
  }

  personality(tank) {
    return PERSONALITIES[tank.ai] ?? PERSONALITIES.gunner;
  }

  mem(tank) {
    let m = this.memory.get(tank.id);
    if (!m) {
      m = { targetId: -1, shotsAtTarget: 0, wind: 0, windKnown: false, seenTurn: -1, pending: null, round: -1 };
      this.memory.set(tank.id, m);
    }
    return m;
  }

  /** The AI tank whose turn it is and that this brain is thinking about, if any. */
  thinkingTank() {
    const s = this.session.game?.state;
    if (!s || s.phase !== Phase.AIM || this.stage !== 'think') return -1;
    return s.active;
  }

  update() {
    const game = this.session.game;
    if (!game) return;
    const s = game.state;
    this.observe(game);
    if (s.phase === Phase.SHOP) {
      this.shop(game);
      return;
    }
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

  /** Learns from where its own last shell landed (the Spotter's wind estimate). */
  observe(game) {
    const s = game.state;
    const shot = s.lastShot;
    if (!shot || !shot.impact || s.phase === Phase.BUSY) return;
    const tank = s.tanks[shot.playerId];
    if (!tank || !this.acts(tank)) return;
    const m = this.mem(tank);
    if (m.seenTurn === shot.turnId) return;
    m.seenTurn = shot.turnId;
    const pending = m.pending;
    if (!pending || pending.turnId !== shot.turnId || this.personality(tank).wind !== 'estimate') return;
    const shooter = { id: tank.id, x: pending.x, y: pending.y };
    const fitted = fitWind({ ...game.env, tanks: null }, shooter, shot.angle, shot.power, shot.impact.x);
    m.wind = m.windKnown ? m.wind * 0.3 + fitted * 0.7 : fitted;
    m.windKnown = true;
  }

  chooseTarget(game, tank, p, exclude = null) {
    const enemies = game.state.tanks.filter((t) => t.alive && t.id !== tank.id && t !== exclude);
    if (!enemies.length) return null;
    const byDistance = [...enemies].sort((a, b) => Math.abs(a.x - tank.x) - Math.abs(b.x - tank.x) || a.id - b.id);
    switch (p.target) {
      case 'sloppy':
        return this.rng.chance(0.3) ? this.rng.pick(enemies) : byDistance[0];
      case 'weakest':
        return [...byDistance].sort((a, b) => a.health + a.shield - (b.health + b.shield))[0];
      case 'revenge': {
        const foe = game.state.tanks[tank.lastDamagedBy];
        if (foe?.alive && foe !== exclude && foe.id !== tank.id) return foe;
        return [...byDistance].sort((a, b) => b.stats.wins - a.stats.wins || b.money - a.money)[0];
      }
      default:
        return byDistance[0];
    }
  }

  chooseWeapon(game, tank, target, p, m, buried) {
    const has = (id) => id === FREE_WEAPON || tank.stock[id] > 0;
    if (buried) return has('riot') ? 'riot' : FREE_WEAPON;
    if (!target) return FREE_WEAPON;
    const dx = target.x - tank.x;
    const dy = target.y - tank.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const usable = (id) => has(id) && blastOf(WEAPON_BY_ID[id]) + 30 < distance;
    switch (p.weapons) {
      case 'random': {
        if (!this.rng.chance(0.45)) return FREE_WEAPON;
        const owned = WEAPONS.filter((w) => w.kind !== 'riot' && w.kind !== 'dirt' && usable(w.id));
        return owned.length ? this.rng.pick(owned).id : FREE_WEAPON;
      }
      case 'solid':
        return SOLID.find(usable) ?? FREE_WEAPON;
      case 'spotter':
        if (m.shotsAtTarget === 0 && has('tracer') && m.tracedRound !== game.state.round && target.health > 40) {
          m.tracedRound = game.state.round;
          return 'tracer';
        }
        return SPOTTER.find(usable) ?? FREE_WEAPON;
      case 'strongest': {
        if (target.health + target.shield <= 34) return usable('missile') ? 'missile' : FREE_WEAPON;
        for (const id of STRONGEST) {
          if (!usable(id)) continue;
          if (WEAPON_BY_ID[id].kind === 'roller' && !inValley(game.terrain, target)) continue;
          return id;
        }
        return FREE_WEAPON;
      }
      default:
        return FREE_WEAPON;
    }
  }

  windEnv(game, p, m) {
    if (p.wind === 'exact') return game.env;
    return { ...game.env, windAccel: p.wind === 'estimate' && m.windKnown ? m.wind : 0 };
  }

  beginTurn(game, tank) {
    const s = game.state;
    const p = this.personality(tank);
    const m = this.mem(tank);
    if (m.round !== s.round) {
      m.round = s.round;
      m.targetId = -1;
      m.shotsAtTarget = 0;
    }
    this.turnId = s.turnId;
    this.plan = null;
    this.job = null;
    this.retargeted = false;
    this.fallback = null;
    this.failures = 0;
    // Patch up and put a shield up before shooting.
    if (tank.health <= 45 && tank.stock.battery > 0) this.session.submit({ type: 'use', turnId: s.turnId, playerId: tank.id, item: 'battery' });
    if (tank.shield <= 0) {
      const shield = tank.stock.heavyshield > 0 ? 'heavyshield' : tank.stock.shield > 0 ? 'shield' : null;
      if (shield) this.session.submit({ type: 'use', turnId: s.turnId, playerId: tank.id, item: shield });
    }
    const target = this.chooseTarget(game, tank, p);
    this.startPlan(game, tank, target);
    this.startTick = this.session.ticks;
    this.thinkTicks = this.fast ? 0 : p.think[0] + this.rng.int(p.think[1] - p.think[0] + 1);
    this.stage = 'think';
  }

  startPlan(game, tank, target) {
    const p = this.personality(tank);
    const m = this.mem(tank);
    if (target && target.id !== m.targetId) {
      m.targetId = target.id;
      m.shotsAtTarget = 0;
    }
    const buried = isBuried(game.terrain, tank);
    this.target = target;
    this.weaponId = this.chooseWeapon(game, tank, target, p, m, buried);
    if (this.weaponId === 'riot' || !target) {
      this.plan = { angle: tank.angle, power: Math.min(300, maxPower(tank)), score: 0 };
      this.job = null;
    } else {
      this.job = searchAim(this.windEnv(game, p, m), tank, target, { blast: blastOf(WEAPON_BY_ID[this.weaponId]) });
    }
  }

  think(game, tank) {
    if (this.job) {
      const start = this.now();
      for (;;) {
        const step = this.job.next();
        if (step.done) {
            this.plan = { ...step.value, weaponId: this.weaponId };
          this.job = null;
          break;
        }
        if (!this.fast && this.now() - start >= this.budgetMs) break;
      }
      this.maxStepMs = Math.max(this.maxStepMs, this.now() - start);
      // No decent shot at this target (hidden behind a mountain, say)? Try someone else once.
      if (this.plan && this.plan.score > 180 && !this.retargeted) {
        const other = this.chooseTarget(game, tank, { target: 'nearest' }, this.target);
        if (other) {
          this.retargeted = true;
            this.fallback = this.plan;
            this.plan = null;
            this.startPlan(game, tank, other);
          return;
        }
      }
        if (this.plan && this.fallback && this.fallback.score < this.plan.score) {
          this.plan = this.fallback;
          this.weaponId = this.fallback.weaponId;
        }
    }
    if (!this.plan || this.session.ticks - this.startTick < this.thinkTicks) return;
    this.fallback = null;
    const p = this.personality(tank);
    const m = this.mem(tank);
    const scale = p.learn ? Math.max(0.12, p.learn ** m.shotsAtTarget) : 1;
    const angle = this.plan.angle + (this.rng.float() * 2 - 1) * p.angleError * scale;
    const power = this.plan.power * (1 + (this.rng.float() * 2 - 1) * p.powerError * scale);
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
      this.failures++;
      this.weaponId = FREE_WEAPON;
      this.stage = this.failures < 5 ? 'swing' : 'idle';
      return;
    }
    const m = this.mem(tank);
    m.shotsAtTarget++;
    m.pending = { turnId: s.turnId, x: tank.x, y: tank.y };
  }

  // --- Shopping ------------------------------------------------------------------------------

  shop(game) {
    if (!this.session.isAuthority || !game.isIdle()) return;
    const s = game.state;
    const key = `${s.round}`;
    if (this.shopKey !== key) {
      this.shopKey = key;
      this.shopDone.clear();
      this.shopReserve.clear();
      this.shopCount.clear();
    }
    if (this.shopTick++ % 3 !== 0) return;
    for (const tank of s.tanks) {
      if (!this.acts(tank) || this.shopDone.has(tank.id)) continue;
      const item = this.nextPurchase(tank);
      if (!item) {
        this.shopDone.add(tank.id);
        continue;
      }
      const result = this.session.submit({ type: 'buy', playerId: tank.id, item });
      const count = (this.shopCount.get(tank.id) ?? 0) + 1;
      this.shopCount.set(tank.id, count);
      if (!result?.ok || count >= MAX_PURCHASES) this.shopDone.add(tank.id);
      return; // one purchase per step
    }
  }

  nextPurchase(tank) {
    const p = this.personality(tank);
    if (!this.shopReserve.has(tank.id)) this.shopReserve.set(tank.id, Math.floor(tank.money * (1 - p.spend)));
    const reserve = this.shopReserve.get(tank.id);
    const affordable = (id) => !buyProblem(tank, id) && tank.money - productById(id).price >= reserve;
    if (p.wishlist === 'random') {
      const options = [...WEAPONS, ...ITEMS].filter((x) => x.price > 0 && affordable(x.id));
      const first = !this.shopCount.get(tank.id);
      return options.length && (first || this.rng.chance(0.8)) ? this.rng.pick(options).id : null;
    }
    for (const [id, want] of p.wishlist) if ((tank.stock[id] ?? 0) < want && affordable(id)) return id;
    return null;
  }

  /** True once every AI tank has finished its shopping for this shop visit. */
  shoppingDone() {
    const s = this.session.game?.state;
    if (!s || s.phase !== Phase.SHOP || !this.session.isAuthority) return true;
    if (this.shopKey !== `${s.round}`) return s.tanks.every((t) => !this.acts(t));
    return s.tanks.every((t) => !this.acts(t) || this.shopDone.has(t.id));
  }
}
