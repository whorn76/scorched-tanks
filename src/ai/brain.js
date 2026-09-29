// Drives AI tanks. It runs only on the authority (a local game or the online host) and plays
// through the same intents as a human: aim previews while the barrel swings, then `fire`.
// Each personality picks targets, weapons and purchases its own way. Planning is split across
// frames with a small time budget so it never stalls rendering.
import { FALL, HEIGHT, MAX_POWER, MOVE_STEP, TANK, WIDTH } from '../core/constants.js';
import { Phase, driveProblem, freeDriveAt } from '../core/game.js';
import { Rng } from '../core/rng.js';
import { buyProblem } from '../core/economy.js';
import { FREE_WEAPON, ITEMS, WEAPONS, WEAPON_BY_ID, productById } from '../core/weapons.js';
import { fitWind, inValley, isBuried, searchAim } from './aim.js';
import { DODGE_RANGE, PERSONALITIES, SOLID, SPOTTER, STRONGEST, TARGET_MOVED, aimErrorScale } from './personality.js';

const defaultNow = () => (globalThis.performance ? performance.now() : Date.now());
const MAX_PURCHASES = 14;

const blastOf = (weapon) => weapon.radius ?? (weapon.kind === 'napalm' ? 60 : 20);

/**
 * How far (px) the tank can drive in `dir` for free this turn without climbing anything too
 * steep or dropping far enough to get hurt. Follows the same rules as the core's driving.
 */
export function freeRoom(game, tank, dir) {
  let x = tank.x;
  let y = tank.y;
  let room = 0;
  for (;;) {
    const nx = x + dir;
    if (!freeDriveAt(tank, nx) || nx < TANK.halfWidth || nx > WIDTH - 1 - TANK.halfWidth) break;
    const top = y - TANK.maxClimb - 1;
    const ground = game.footGround(nx, top, y + TANK.maxClimb);
    if (ground !== -1 && ground <= top) break; // too steep
    let landing = ground === -1 ? game.footGround(nx, y, HEIGHT) : ground;
    if (landing === -1) landing = HEIGHT;
    if (landing - y > FALL.safeDistance) break; // a drop that would hurt
    x = nx;
    y = landing;
    room++;
  }
  return room;
}

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
    // A drive sent to an online host hasn't been applied yet: wait for it (but not forever).
    if (this.waitMove) {
      if (this.session.seq === this.waitMove.seq && this.session.ticks < this.waitMove.until) return;
      this.waitMove = null;
    }
    if (this.turnId !== s.turnId || this.stage === 'idle') this.beginTurn(game, tank);
    if (this.stage === 'think') this.think(game, tank);
    if (this.stage === 'swing') this.swing(game, tank);
  }

  /**
   * Learns from where shells landed: enemy shells that came close are something to dodge on
   * the next turn, and its own shells tell the Spotter about the wind.
   */
  observe(game) {
    const s = game.state;
    const shot = s.lastShot;
    if (!shot || !shot.impact || s.phase === Phase.BUSY) return;
    if (this.threatTurn !== shot.turnId) {
      this.threatTurn = shot.turnId;
      for (const t of s.tanks) {
        if (!t.alive || t.id === shot.playerId || !this.acts(t)) continue;
        if (shot.impact.tank === t.id || Math.abs(shot.impact.x - t.x) <= DODGE_RANGE) this.mem(t).threat = { round: s.round, x: shot.impact.x };
      }
    }
    const tank = s.tanks[shot.playerId];
    if (!tank || !this.acts(tank)) return;
    const m = this.mem(tank);
    if (m.seenTurn === shot.turnId) return;
    m.seenTurn = shot.turnId;
    const pending = m.pending;
    if (!pending || pending.turnId !== shot.turnId || this.personality(tank).wind !== 'estimate') return;
    const shooter = { id: tank.id, x: pending.x, y: pending.y };
    // Fly the fitted shells through the same tanks so a shot stopped by a hull fits correctly.
    const fitted = fitWind(game.env, shooter, shot.angle, shot.power, shot.impact.x);
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
        // A tracer first, to read a strong wind, when there's time for it.
        if (m.shotsAtTarget === 0 && has('tracer') && m.tracedRound !== game.state.round && target.health > 40 && Math.abs(game.state.wind) >= 5) {
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
      m.aimedFrom = null;
    }
    const sameTurn = this.turnId === s.turnId; // back after driving
    this.turnId = s.turnId;
    if (!sameTurn) {
      this.drives = 0;
      this.dodge = this.planDodge(game, tank, p, m);
    }
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
    // Zeroed in on? Scoot out of the way with the free drive before shooting back.
    if (this.dodge?.moves > 0 && freeRoom(game, tank, this.dodge.dir) >= MOVE_STEP) {
      this.dodge.moves--;
      this.drive(game, tank, this.dodge.dir);
      return;
    }
    const dodged = !!this.dodge;
    this.dodge = null;
    const target = this.chooseTarget(game, tank, p);
    this.startPlan(game, tank, target);
    this.startTick = this.session.ticks;
    this.thinkTicks = this.fast ? 0 : sameTurn && !dodged ? 4 : p.think[0] + this.rng.int(p.think[1] - p.think[0] + 1);
    this.stage = 'think';
  }

  /**
   * Whether to dodge this turn: after an enemy shell landed close, by personality, driving
   * away from where it landed (or the other way if that's blocked). Returns { dir, moves } or
   * null.
   */
  planDodge(game, tank, p, m) {
    const threat = m.threat;
    m.threat = null;
    if (threat?.round !== game.state.round || !this.rng.chance(p.dodge ?? 0) || isBuried(game.terrain, tank)) return null;
    const away = Math.sign(tank.x - threat.x) || (this.rng.chance(0.5) ? 1 : -1);
    for (const dir of [away, -away]) {
      const room = freeRoom(game, tank, dir);
      if (room < 2 * MOVE_STEP) continue;
      const distance = room * (0.6 + this.rng.float() * 0.4);
      return { dir, moves: Math.max(2, Math.floor(distance / MOVE_STEP)) };
    }
    return null;
  }

  startPlan(game, tank, target) {
    const p = this.personality(tank);
    const m = this.mem(tank);
    if (target && target.id !== m.targetId) {
      m.targetId = target.id;
      m.shotsAtTarget = 0;
    } else if (target && m.aimedFrom && Math.abs(target.x - m.aimedFrom.targetX) >= TARGET_MOVED) {
      // The target has moved since the last shot, so the shots have to be walked in again.
      m.shotsAtTarget = 0;
    }
    const buried = isBuried(game.terrain, tank);
    this.target = target;
    this.weaponId = this.chooseWeapon(game, tank, target, p, m, buried);
    if (this.weaponId === 'riot' || !target) {
      this.plan = { angle: tank.angle, power: 300, score: 0 };
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
    // Out of reach (too far in high gravity, or a hill in the way)? Drive closer if we can:
    // for free near where the turn started, further with fuel.
    const closer = this.target ? Math.sign(this.target.x - tank.x) || 1 : 0;
    if (this.plan.score > 140 && this.target && !driveProblem(tank, closer) && this.drives < 12 && this.weaponId !== 'riot') {
      this.drives++;
      this.drive(game, tank, closer);
      return;
    }
    const p = this.personality(tank);
    const m = this.mem(tank);
    // Aim error shrinks as the AI walks its shots in on the same target, but never below
    // its personality's floor, so even the best AI keeps missing now and then.
    const scale = aimErrorScale(p, m.shotsAtTarget);
    const angle = this.plan.angle + (this.rng.float() * 2 - 1) * p.angleError * scale;
    const power = this.plan.power * (1 + (this.rng.float() * 2 - 1) * p.powerError * scale);
    this.final = {
      angle: Math.round(Math.min(180, Math.max(0, angle)) * 10) / 10,
      power: Math.round(Math.min(MAX_POWER, Math.max(0, power))),
    };
    this.swingFrom = { angle: tank.angle, power: tank.power };
    this.swingTicks = this.fast ? 0 : 18 + Math.round(Math.abs(this.final.angle - tank.angle) / 4);
    this.swingTick = 0;
    this.stage = 'swing';
  }

  /** Drives one step, then plans again from wherever the tank ends up. */
  drive(game, tank, dir) {
    const seq = this.session.seq;
    const result = this.session.submit({ type: 'move', turnId: game.state.turnId, playerId: tank.id, dir });
    this.stage = 'idle';
    if (result?.pending) this.waitMove = { seq, until: this.session.ticks + 180 };
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
      power: this.final.power,
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
    m.aimedFrom = this.target ? { targetX: this.target.x } : null;
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
