// The whole game simulation: rounds, turns, shells, explosions, falling dirt and tanks, damage
// and money. It has no DOM, canvas, timer or network code. Everything that happens goes through
// `apply(command)`; `tick()` advances the world by one fixed 1/60 s step while something is in
// motion. Given the same commands, every client ends up with the same state (see hash.js).
import {
  DEATH_BLAST,
  DT,
  FALL,
  FUEL_PER_CLIMB,
  FUEL_PER_PIXEL,
  GRAVITY,
  GROUND_THEMES,
  HEIGHT,
  MAX_HEALTH,
  MAX_POWER,
  MOVE_STEP,
  POWER_PER_HEALTH,
  SKY_THEMES,
  SPEED_PER_POWER,
  TANK,
  TERRAIN_STYLES,
  TIMING,
  WALL_MODES,
  WIDTH,
  WIND_ACCEL,
  WIND_MAX,
  AI_LEVELS,
  clamp,
  sanitizeSettings,
} from './constants.js';
import { Rng } from './rng.js';
import { Terrain } from './terrain.js';
import { FREE_WEAPON, ITEM_BY_ID, STOCK_IDS, WEAPON_BY_ID } from './weapons.js';
import {
  HIT_LOST,
  HIT_NONE,
  HIT_SHIELD,
  HIT_TANK,
  HIT_WALL,
  barrelTip,
  distanceToTank,
  stepProjectile,
} from './physics.js';
import { ECONOMY, buyProblem, clampMoney, sellProblem, sellUnits, sellValue } from './economy.js';
import { base64ToInt16 } from './bytes.js';

export const CORE_VERSION = 1;

export const Phase = Object.freeze({
  SETUP: 'setup', // created, before the first round (or its shop)
  AIM: 'aim', // waiting for the active tank to act
  BUSY: 'busy', // shells flying, dirt falling, tanks moving
  ROUND_OVER: 'roundOver',
  SHOP: 'shop',
  GAME_OVER: 'gameOver',
});

const isUint32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export const emptyStock = () => Object.fromEntries(STOCK_IDS.map((id) => [id, 0]));

export const maxPower = (tank) => Math.min(MAX_POWER, tank.health * POWER_PER_HEALTH);

/** A tank's state. Plain data so it can be hashed, snapshotted and sent over the network. */
export function createTank(player, index, money) {
  return {
    id: index,
    name: String(player.name ?? `Tank ${index + 1}`).slice(0, 16),
    color: String(player.color ?? '#e8453c'),
    ai: AI_LEVELS.includes(player.ai) ? player.ai : null,
    x: 0,
    y: 0,
    alive: true,
    wreck: false,
    health: MAX_HEALTH,
    angle: 45,
    power: 500,
    weapon: FREE_WEAPON,
    money,
    stock: emptyStock(),
    shield: 0,
    shieldType: null,
    falling: false,
    vy: 0,
    fallFrom: 0,
    chute: false,
    dying: 0,
    killer: -1,
    lastHitBy: -1,
    burn: 0,
    moving: 0,
    moveDir: 0,
    stats: { kills: 0, damage: 0, wins: 0, deaths: 0, selfDamage: 0 },
    round: { damage: 0, kills: 0, earned: 0 },
  };
}

export function createState({ settings, players }) {
  const clean = sanitizeSettings(settings);
  return {
    v: CORE_VERSION,
    settings: clean,
    phase: Phase.SETUP,
    round: 0,
    turnId: 0,
    active: -1,
    wind: 0,
    walls: 'open',
    sky: 'day',
    ground: 0,
    style: 'hills',
    roundInfo: null, // { heights, colorSeed } of the current round, to rebuild the base terrain
    rng: new Rng(1),
    tick: 0,
    quiet: 0,
    quietNeeded: 1,
    pendingTurnEnd: false,
    tanks: players.map((player, i) => createTank(player, i, clean.startCash)),
    projectiles: [],
    explosions: [],
    napalm: [],
    deaths: [], // tank ids in the order they died this round
    nextId: 1,
    lastShot: null,
    results: null,
  };
}

function toHeights(value) {
  let heights;
  try {
    if (typeof value === 'string') heights = base64ToInt16(value);
    else if (value instanceof Int16Array) heights = value;
    else if (Array.isArray(value)) heights = Int16Array.from(value);
    else return null;
  } catch {
    return null;
  }
  if (heights.length !== WIDTH) return null;
  for (let i = 0; i < heights.length; i++) if (heights[i] < 0 || heights[i] > HEIGHT) return null;
  return heights;
}

export class Game {
  constructor(state, terrain = new Terrain()) {
    this.state = state;
    this.terrain = terrain;
    this.events = [];
    this.silent = false; // when true, no events are queued (headless use)
    this.env = { terrain, gravity: 0, windAccel: 0, walls: 'open', tanks: state.tanks };
    this.refreshEnv();
  }

  static create({ settings, players }) {
    return new Game(createState({ settings, players }));
  }

  get phase() {
    return this.state.phase;
  }

  get tanks() {
    return this.state.tanks;
  }

  get activeTank() {
    return this.state.tanks[this.state.active] ?? null;
  }

  /** True when the world is at rest and commands can be applied. */
  isIdle() {
    return this.state.phase !== Phase.BUSY;
  }

  refreshEnv() {
    const s = this.state;
    this.env.tanks = s.tanks;
    this.env.terrain = this.terrain;
    this.env.gravity = GRAVITY[s.settings.gravity] ?? GRAVITY.normal;
    this.env.windAccel = s.wind * WIND_ACCEL;
    this.env.walls = s.walls;
  }

  emit(event) {
    if (!this.silent) this.events.push(event);
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  // --- Commands ------------------------------------------------------------------------------

  /** Why `cmd` can't be applied right now, or null if it can. */
  problem(cmd) {
    const s = this.state;
    if (!cmd || typeof cmd !== 'object') return 'bad command';
    const tank = Number.isInteger(cmd.playerId) ? s.tanks[cmd.playerId] : null;
    const turnCheck = () => {
      if (s.phase !== Phase.AIM) return 'not waiting for a move';
      if (cmd.turnId !== s.turnId) return 'stale turn';
      if (!tank || cmd.playerId !== s.active) return 'not your turn';
      if (!tank.alive) return 'tank destroyed';
      return null;
    };
    switch (cmd.type) {
      case 'shot': {
        const bad = turnCheck();
        if (bad) return bad;
        const weapon = WEAPON_BY_ID[cmd.weaponId];
        if (!weapon) return 'unknown weapon';
        if (weapon.id !== FREE_WEAPON && !(tank.stock[weapon.id] > 0)) return 'out of ammo';
        if (!isNum(cmd.angle, 0, 180)) return 'bad angle';
        if (!isNum(cmd.power, 0, maxPower(tank))) return 'bad power';
        const maxSpeed = MAX_POWER * SPEED_PER_POWER + 1;
        if (!isNum(cmd.vx, -maxSpeed, maxSpeed) || !isNum(cmd.vy, -maxSpeed, maxSpeed)) return 'bad velocity';
        if (!isNum(cmd.ux, -1.0001, 1.0001) || !isNum(cmd.uy, -1.0001, 1.0001)) return 'bad direction';
        if (cmd.vx * cmd.vx + cmd.vy * cmd.vy > maxSpeed * maxSpeed) return 'bad velocity';
        if (!isUint32(cmd.seed)) return 'bad seed';
        return null;
      }
      case 'move': {
        const bad = turnCheck();
        if (bad) return bad;
        if (cmd.dir !== -1 && cmd.dir !== 1) return 'bad direction';
        if (!(tank.stock.fuel > 0)) return 'no fuel';
        return null;
      }
      case 'use': {
        const bad = turnCheck();
        if (bad) return bad;
        const item = ITEM_BY_ID[cmd.item];
        if (!item || !['shield', 'heavyshield', 'battery'].includes(item.id)) return 'cannot use that';
        if (!(tank.stock[item.id] > 0)) return 'none left';
        if (item.id === 'battery' && tank.health >= MAX_HEALTH) return 'already at full health';
        if (item.id !== 'battery' && tank.shield >= item.strength) return 'shield already up';
        return null;
      }
      case 'buy':
      case 'sell': {
        if (s.phase !== Phase.SHOP) return 'the shop is closed';
        if (!tank) return 'unknown player';
        return cmd.type === 'buy' ? buyProblem(tank, cmd.item) : sellProblem(tank, cmd.item);
      }
      case 'newRound': {
        if (![Phase.SETUP, Phase.ROUND_OVER, Phase.SHOP].includes(s.phase)) return 'not between rounds';
        if (cmd.round !== s.round + 1 || cmd.round > s.settings.rounds) return 'wrong round';
        if (!toHeights(cmd.heights)) return 'bad terrain';
        const n = s.tanks.length;
        if (!Array.isArray(cmd.xs) || cmd.xs.length !== n) return 'bad positions';
        if (!cmd.xs.every((x) => isInt(x, TANK.halfWidth, WIDTH - 1 - TANK.halfWidth))) return 'bad positions';
        if (!isUint32(cmd.colorSeed) || !isUint32(cmd.seed)) return 'bad seed';
        if (!isInt(cmd.ground, 0, GROUND_THEMES - 1)) return 'bad ground';
        if (!SKY_THEMES.includes(cmd.sky) || !WALL_MODES.includes(cmd.walls)) return 'bad theme';
        if (!TERRAIN_STYLES.includes(cmd.style)) return 'bad style';
        const windMax = WIND_MAX[s.settings.wind] ?? 0;
        if (!isInt(cmd.wind, -windMax, windMax)) return 'bad wind';
        if (!isInt(cmd.first, 0, n - 1)) return 'bad first player';
        return null;
      }
      case 'openShop':
        if (s.phase !== Phase.SETUP && s.phase !== Phase.ROUND_OVER) return 'cannot open the shop now';
        if (s.round >= s.settings.rounds) return 'no rounds left';
        return null;
      case 'endGame':
        if (s.phase !== Phase.ROUND_OVER) return 'the round is not over';
        return null;
      case 'control':
        if (!tank) return 'unknown player';
        if (cmd.ai !== null && !AI_LEVELS.includes(cmd.ai)) return 'bad ai level';
        return null;
      default:
        return 'unknown command';
    }
  }

  /** Applies a command if it's valid. Returns { ok, error }. */
  apply(cmd) {
    const error = this.problem(cmd);
    if (error) return { ok: false, error };
    switch (cmd.type) {
      case 'shot':
        this.applyShot(cmd);
        break;
      case 'move':
        this.applyMove(cmd);
        break;
      case 'use':
        this.applyUse(cmd);
        break;
      case 'buy':
        this.applyBuy(cmd);
        break;
      case 'sell':
        this.applySell(cmd);
        break;
      case 'newRound':
        this.applyNewRound(cmd);
        break;
      case 'openShop':
        this.state.phase = Phase.SHOP;
        this.emit({ type: 'shop' });
        break;
      case 'endGame':
        this.state.phase = Phase.GAME_OVER;
        this.emit({ type: 'gameOver' });
        break;
      case 'control':
        this.state.tanks[cmd.playerId].ai = cmd.ai;
        break;
    }
    return { ok: true };
  }

  applyNewRound(cmd) {
    const s = this.state;
    const heights = toHeights(cmd.heights);
    s.round = cmd.round;
    s.style = cmd.style;
    s.sky = cmd.sky;
    s.ground = cmd.ground;
    s.walls = cmd.walls;
    s.wind = cmd.wind;
    s.roundInfo = { heights, colorSeed: cmd.colorSeed };
    this.terrain.fillFromHeights(heights, cmd.colorSeed);
    s.rng = new Rng(cmd.seed);
    s.projectiles = [];
    s.explosions = [];
    s.napalm = [];
    s.deaths = [];
    s.results = null;
    s.lastShot = null;
    s.tick = 0;
    s.quiet = 0;
    s.pendingTurnEnd = false;
    s.tanks.forEach((tank, i) => this.resetTankForRound(tank, cmd.xs[i], heights[cmd.xs[i]]));
    s.active = cmd.first;
    s.turnId++;
    s.phase = Phase.AIM;
    this.refreshEnv();
    this.emit({ type: 'round', round: s.round });
    this.emit({ type: 'turn', tank: s.active, turnId: s.turnId });
  }

  resetTankForRound(tank, x, y) {
    Object.assign(tank, {
      x,
      y,
      alive: true,
      wreck: false,
      health: MAX_HEALTH,
      dying: 0,
      killer: -1,
      lastHitBy: -1,
      falling: false,
      vy: 0,
      fallFrom: y,
      chute: false,
      moving: 0,
      moveDir: 0,
      burn: 0,
      angle: x < WIDTH / 2 ? 60 : 120,
      shield: 0,
      shieldType: null,
      round: { damage: 0, kills: 0, earned: 0 },
    });
    if (tank.weapon !== FREE_WEAPON && !(tank.stock[tank.weapon] > 0)) tank.weapon = FREE_WEAPON;
    // Shields in stock go up automatically at the start of a round, strongest first.
    if (tank.stock.heavyshield > 0) this.raiseShield(tank, 'heavyshield');
    else if (tank.stock.shield > 0) this.raiseShield(tank, 'shield');
  }

  raiseShield(tank, id) {
    tank.stock[id]--;
    tank.shield = ITEM_BY_ID[id].strength;
    tank.shieldType = id;
    this.emit({ type: 'shieldUp', tank: tank.id });
  }

  applyShot(cmd) {
    const s = this.state;
    const tank = s.tanks[cmd.playerId];
    const weapon = WEAPON_BY_ID[cmd.weaponId];
    tank.angle = cmd.angle;
    tank.power = cmd.power;
    tank.weapon = weapon.id;
    if (weapon.id !== FREE_WEAPON) tank.stock[weapon.id]--;
    s.rng = new Rng(cmd.seed);
    s.lastShot = { playerId: tank.id, weaponId: weapon.id, angle: cmd.angle, power: cmd.power, turnId: s.turnId, impact: null };
    s.phase = Phase.BUSY;
    s.pendingTurnEnd = true;
    s.quiet = 0;
    s.quietNeeded = TIMING.afterShot;
    const tip = barrelTip(tank, cmd.ux, cmd.uy);
    this.emit({ type: 'fire', tank: tank.id, weapon: weapon.id, x: tip.x, y: tip.y, power: cmd.power });
    if (weapon.kind === 'riot') this.riotCharge(tank, weapon);
    else this.spawnShell(weapon, tank.id, tip.x, tip.y, cmd.vx, cmd.vy);
  }

  applyMove(cmd) {
    const s = this.state;
    const tank = s.tanks[cmd.playerId];
    tank.moving = MOVE_STEP;
    tank.moveDir = cmd.dir;
    s.phase = Phase.BUSY;
    s.pendingTurnEnd = false;
    s.quiet = 0;
    s.quietNeeded = 1;
  }

  applyUse(cmd) {
    const tank = this.state.tanks[cmd.playerId];
    if (cmd.item === 'battery') {
      tank.stock.battery--;
      tank.health = Math.min(MAX_HEALTH, tank.health + ITEM_BY_ID.battery.restore);
      this.emit({ type: 'battery', tank: tank.id });
    } else {
      this.raiseShield(tank, cmd.item);
    }
  }

  applyBuy(cmd) {
    const tank = this.state.tanks[cmd.playerId];
    const product = WEAPON_BY_ID[cmd.item] ?? ITEM_BY_ID[cmd.item];
    tank.money = clampMoney(tank.money - product.price);
    tank.stock[product.id] += product.bundle;
    this.emit({ type: 'buy', tank: tank.id, item: product.id });
  }

  applySell(cmd) {
    const tank = this.state.tanks[cmd.playerId];
    const product = WEAPON_BY_ID[cmd.item] ?? ITEM_BY_ID[cmd.item];
    const units = sellUnits(tank, product.id);
    tank.stock[product.id] -= units;
    tank.money = clampMoney(tank.money + sellValue(product, units));
    if (tank.weapon === product.id && tank.stock[product.id] <= 0) tank.weapon = FREE_WEAPON;
    this.emit({ type: 'sell', tank: tank.id, item: product.id });
  }

  // --- Shells --------------------------------------------------------------------------------

  spawnShell(weapon, owner, x, y, vx, vy, extra = null) {
    const s = this.state;
    const p = {
      id: s.nextId++,
      weapon: weapon.id,
      kind: weapon.kind,
      owner,
      x,
      y,
      vx,
      vy,
      age: 0,
      armed: false,
      hitTank: -1,
      mode: 'fly',
      child: false,
    };
    if (extra) Object.assign(p, extra);
    s.projectiles.push(p);
    return p;
  }

  updateProjectiles() {
    const s = this.state;
    const list = s.projectiles;
    const count = list.length; // shells spawned during this pass start moving next tick
    let removed = false;
    for (let i = 0; i < count; i++) {
      const p = list[i];
      if (p.dead) continue;
      this.updateProjectile(p);
      if (p.dead) removed = true;
    }
    if (removed) s.projectiles = s.projectiles.filter((p) => !p.dead);
  }

  updateProjectile(p) {
    const code = stepProjectile(p, this.env);
    if (code === HIT_NONE) return;
    p.dead = true;
    if (code === HIT_LOST) {
      this.emit({ type: 'lost', x: p.x, y: p.y });
      return;
    }
    this.impact(p, code);
  }

  /** A shell has hit something: dirt, a tank, a shield or a concrete wall. */
  impact(p, code) {
    const s = this.state;
    const weapon = WEAPON_BY_ID[p.weapon];
    if (!p.child && s.lastShot && !s.lastShot.impact) s.lastShot.impact = { x: p.x, y: p.y, tank: p.hitTank };
    if (code === HIT_SHIELD) this.emit({ type: 'shieldHit', tank: p.hitTank, x: p.x, y: p.y });
    if (code === HIT_TANK || code === HIT_SHIELD) this.emit({ type: 'directHit', tank: p.hitTank });
    if (code === HIT_WALL) this.emit({ type: 'wallHit', x: p.x, y: p.y });
    switch (p.kind) {
      case 'tracer':
        this.emit({ type: 'tracerEnd', x: p.x, y: p.y });
        break;
      default:
        this.explode(p.x, p.y, weapon.radius, weapon.damage, p.owner, { flash: !!weapon.flash });
    }
  }

  riotCharge(tank, weapon) {
    const cx = tank.x;
    const cy = tank.y - TANK.pivotY;
    const result = this.terrain.carveAbove(cx, cy, weapon.radius, tank.y);
    this.emit({ type: 'riot', tank: tank.id, x: cx, y: cy, radius: weapon.radius, material: result.material });
  }

  // --- Explosions ----------------------------------------------------------------------------

  explode(x, y, radius, damage, owner, { flash = false, kind = 'blast', carve = true } = {}) {
    const e = {
      x,
      y,
      radius,
      damage,
      owner,
      age: 0,
      grow: Math.max(5, Math.round(radius / 4)),
      fade: Math.max(8, Math.round(radius / 3)),
      flash,
      kind,
      carve,
    };
    this.state.explosions.push(e);
    this.emit({ type: 'explosion', x, y, radius, flash, kind });
    return e;
  }

  updateExplosions() {
    const s = this.state;
    const list = s.explosions;
    const count = list.length;
    let removed = false;
    for (let i = 0; i < count; i++) {
      const e = list[i];
      e.age++;
      if (e.age === e.grow) this.detonate(e);
      if (e.age >= e.grow + e.fade) removed = true;
    }
    if (removed) s.explosions = s.explosions.filter((e) => e.age < e.grow + e.fade);
  }

  /** The fireball reaches full size: dig the crater and hurt everything inside it. */
  detonate(e) {
    if (e.carve) {
      const { removed, material } = this.terrain.carve(e.x, e.y, e.radius);
      if (removed > 0) this.emit({ type: 'carve', x: e.x, y: e.y, radius: e.radius, removed, material });
    }
    for (const tank of this.state.tanks) {
      if (!tank.alive) continue;
      const d = distanceToTank(tank, e.x, e.y);
      if (d < e.radius + 24) tank.lastHitBy = e.owner;
      if (d >= e.radius || e.damage <= 0) continue;
      this.damageTank(tank, Math.round(e.damage * (1 - (0.7 * d) / e.radius)), e.owner);
    }
  }

  // --- Damage and money ----------------------------------------------------------------------

  /** Damages a tank (shields first). Returns the health actually lost. */
  damageTank(tank, amount, attacker) {
    if (!tank.alive || amount <= 0) return 0;
    if (tank.shield > 0) {
      const absorbed = Math.min(tank.shield, amount);
      tank.shield -= absorbed;
      amount -= absorbed;
      this.emit({ type: 'shieldDamage', tank: tank.id, amount: absorbed });
      if (tank.shield <= 0) {
        tank.shield = 0;
        tank.shieldType = null;
        this.emit({ type: 'shieldBreak', tank: tank.id });
      }
      if (amount <= 0) return 0;
    }
    const dealt = Math.min(amount, tank.health);
    tank.health -= dealt;
    this.emit({ type: 'damage', tank: tank.id, amount: dealt, attacker });
    this.credit(attacker, tank, dealt);
    if (tank.health <= 0) this.destroy(tank, attacker);
    return dealt;
  }

  credit(attackerId, victim, dealt) {
    const attacker = this.state.tanks[attackerId];
    if (!attacker) return;
    if (attacker === victim) {
      attacker.money = clampMoney(attacker.money - dealt * ECONOMY.selfDamageCost);
      attacker.stats.selfDamage += dealt;
      return;
    }
    const pay = dealt * ECONOMY.damageReward;
    attacker.money = clampMoney(attacker.money + pay);
    attacker.stats.damage += dealt;
    attacker.round.damage += dealt;
    attacker.round.earned += pay;
  }

  destroy(tank, attackerId) {
    tank.alive = false;
    tank.health = 0;
    tank.dying = TIMING.deathDelay;
    tank.killer = attackerId;
    tank.moving = 0;
    tank.shield = 0;
    tank.shieldType = null;
    tank.stats.deaths++;
    this.state.deaths.push(tank.id);
    const attacker = this.state.tanks[attackerId];
    if (attacker && attacker !== tank) {
      attacker.stats.kills++;
      attacker.round.kills++;
      attacker.money = clampMoney(attacker.money + ECONOMY.killReward);
      attacker.round.earned += ECONOMY.killReward;
    }
    this.emit({ type: 'death', tank: tank.id, killer: attackerId });
  }

  // --- Tanks ---------------------------------------------------------------------------------

  /** True if there's ground under the tank's footprint. */
  supported(tank) {
    const y = Math.floor(tank.y);
    if (y >= HEIGHT) return true;
    const x0 = tank.x - TANK.foot;
    const x1 = tank.x + TANK.foot;
    for (let x = x0; x <= x1; x++) if (this.terrain.isSolid(x, y)) return true;
    return false;
  }

  /** First row in [fromY, toY] where the footprint at column x touches dirt, or -1. */
  footGround(x, fromY, toY) {
    for (let y = Math.max(0, fromY); y <= toY; y++) {
      if (y >= HEIGHT) return HEIGHT;
      for (let c = x - TANK.foot; c <= x + TANK.foot; c++) if (this.terrain.isSolid(c, y)) return y;
    }
    return -1;
  }

  updateTanks() {
    for (const tank of this.state.tanks) {
      if (tank.dying > 0) {
        tank.dying--;
        if (tank.dying === 0) {
          tank.wreck = true;
          this.explode(tank.x, tank.y - 6, DEATH_BLAST.radius, DEATH_BLAST.damage, tank.killer, { kind: 'death' });
        }
      }
      if (tank.moving > 0) this.driveStep(tank);
      this.updateFalling(tank);
    }
  }

  driveStep(tank) {
    const nx = tank.x + tank.moveDir;
    const stop = (reason) => {
      tank.moving = 0;
      if (reason) this.emit({ type: 'blocked', tank: tank.id, reason });
    };
    if (!tank.alive || tank.falling) return stop(null);
    if (nx < TANK.halfWidth || nx > WIDTH - 1 - TANK.halfWidth) return stop('edge');
    const top = tank.y - TANK.maxClimb - 1;
    const ground = this.footGround(nx, top, tank.y + TANK.maxClimb);
    if (ground !== -1 && ground <= top) return stop('steep');
    const climb = ground === -1 ? 0 : Math.max(0, tank.y - ground);
    const cost = FUEL_PER_PIXEL + climb * FUEL_PER_CLIMB;
    if (tank.stock.fuel < cost) return stop('fuel');
    tank.stock.fuel -= cost;
    tank.x = nx;
    tank.moving--;
    if (ground !== -1) tank.y = Math.min(HEIGHT, ground);
    this.emit({ type: 'drive', tank: tank.id });
  }

  updateFalling(tank) {
    if (!tank.falling) {
      if (this.supported(tank)) return;
      tank.falling = true;
      tank.vy = 0;
      tank.fallFrom = tank.y;
      tank.chute = false;
      tank.moving = 0;
    }
    const gravity = this.env.gravity;
    tank.vy += gravity * DT;
    const cap = tank.chute ? FALL.chuteSpeed : FALL.maxSpeed;
    if (tank.vy > cap) tank.vy = cap;
    let remaining = tank.vy * DT;
    while (remaining > 0) {
      const step = remaining >= 1 ? 1 : remaining;
      tank.y += step;
      remaining -= step;
      if (this.supported(tank)) {
        this.land(tank);
        return;
      }
    }
    if (!tank.chute && tank.alive && tank.y - tank.fallFrom >= FALL.chuteTrigger && tank.stock.parachute > 0) {
      tank.stock.parachute--;
      tank.chute = true;
      if (tank.vy > FALL.chuteSpeed) tank.vy = FALL.chuteSpeed;
      this.emit({ type: 'parachute', tank: tank.id });
    }
  }

  land(tank) {
    tank.y = Math.min(HEIGHT, Math.floor(tank.y));
    tank.falling = false;
    tank.vy = 0;
    const distance = tank.y - tank.fallFrom;
    let damage = 0;
    if (!tank.chute && tank.alive && distance > FALL.safeDistance) {
      damage = Math.floor((distance - FALL.safeDistance) * FALL.damagePerPixel);
    }
    tank.chute = false;
    this.emit({ type: 'land', tank: tank.id, distance, damage });
    if (damage > 0) this.damageTank(tank, damage, tank.lastHitBy);
  }

  // --- Time ----------------------------------------------------------------------------------

  isQuiet() {
    const s = this.state;
    if (s.projectiles.length || s.explosions.length || s.napalm.length || this.terrain.settling) return false;
    for (const tank of s.tanks) if (tank.falling || tank.dying > 0 || tank.moving > 0) return false;
    return true;
  }

  /** Advances the world one fixed step. Does nothing unless something is in motion. */
  tick() {
    const s = this.state;
    if (s.phase !== Phase.BUSY) return;
    s.tick++;
    this.updateProjectiles();
    this.updateExplosions();
    this.terrain.settleStep();
    this.updateTanks();
    if (this.isQuiet()) {
      s.quiet++;
      if (s.quiet >= s.quietNeeded) this.finishAction();
    } else {
      s.quiet = 0;
    }
  }

  /** Runs ticks until the world is at rest (tests and tools). Returns the number of ticks. */
  settle(maxTicks = 60 * 120) {
    let ticks = 0;
    while (this.state.phase === Phase.BUSY && ticks < maxTicks) {
      this.tick();
      ticks++;
    }
    return ticks;
  }

  finishAction() {
    const s = this.state;
    s.quiet = 0;
    const alive = s.tanks.filter((t) => t.alive).length;
    if (alive <= 1) {
      this.endRound();
      return;
    }
    const active = s.tanks[s.active];
    if (s.pendingTurnEnd || !active?.alive) this.nextTurn();
    else s.phase = Phase.AIM;
  }

  nextTurn() {
    const s = this.state;
    const n = s.tanks.length;
    s.pendingTurnEnd = false;
    for (let k = 1; k <= n; k++) {
      const j = (s.active + k) % n;
      if (s.tanks[j].alive) {
        s.active = j;
        break;
      }
    }
    const windMax = WIND_MAX[s.settings.wind] ?? 0;
    if (s.settings.windChange && windMax > 0 && s.rng.chance(0.6)) {
      s.wind = clamp(s.wind + s.rng.intRange(-2, 2), -windMax, windMax);
    }
    for (const tank of s.tanks) tank.lastHitBy = -1;
    const tank = s.tanks[s.active];
    if (tank.weapon !== FREE_WEAPON && !(tank.stock[tank.weapon] > 0)) tank.weapon = FREE_WEAPON;
    s.turnId++;
    s.phase = Phase.AIM;
    this.refreshEnv();
    this.emit({ type: 'turn', tank: s.active, turnId: s.turnId });
  }

  endRound() {
    const s = this.state;
    const alive = s.tanks.filter((t) => t.alive);
    const winner = alive.length === 1 ? alive[0].id : -1;
    const dead = s.deaths.length;
    const earnings = s.tanks.map((tank) => {
      const deathIndex = s.deaths.indexOf(tank.id);
      const outlived = deathIndex === -1 ? dead : deathIndex;
      const bonus = ECONOMY.roundIncome + outlived * ECONOMY.survivalBonus + (tank.id === winner ? ECONOMY.winBonus : 0);
      tank.money = clampMoney(tank.money + bonus);
      if (tank.id === winner) tank.stats.wins++;
      return {
        tank: tank.id,
        damage: tank.round.damage,
        kills: tank.round.kills,
        combat: tank.round.earned,
        bonus,
        total: tank.round.earned + bonus,
      };
    });
    s.results = { round: s.round, winner, earnings };
    s.phase = Phase.ROUND_OVER;
    this.emit({ type: 'roundOver', round: s.round, winner });
  }

  // --- Queries -------------------------------------------------------------------------------

  isLastRound() {
    return this.state.round >= this.state.settings.rounds;
  }

  /** Final ranking: rounds won, then kills, then damage, then money. */
  standings() {
    return [...this.state.tanks].sort(
      (a, b) =>
        b.stats.wins - a.stats.wins ||
        b.stats.kills - a.stats.kills ||
        b.stats.damage - a.stats.damage ||
        b.money - a.money ||
        a.id - b.id,
    );
  }
}
