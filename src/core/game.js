// The whole game simulation: rounds, turns, shells, explosions, falling dirt and tanks, damage
// and money. It has no DOM, canvas, timer or network code. Everything that happens goes through
// `apply(command)`; `tick()` advances the world by one fixed 1/60 s step while something is in
// motion. Given the same commands, every client ends up with the same state (see hash.js).
import {
  DEATH_BLAST,
  DT,
  FALL,
  FREE_DRIVE,
  FUEL_PER_CLIMB,
  FUEL_PER_PIXEL,
  GRAVITY,
  GROUND_THEMES,
  HEIGHT,
  MAX_HEALTH,
  MAX_POWER,
  MOVE_STEP,
  SKY_THEMES,
  SPEED_PER_POWER,
  SUDDEN_DEATH,
  TANK,
  TERRAIN_STYLES,
  TIMING,
  TURNS_PER_TANK,
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
  HIT_TERRAIN,
  HIT_WALL,
  barrelTip,
  distanceToTank,
  stepProjectile,
} from './physics.js';
import { ECONOMY, buyProblem, clampMoney, sellProblem, sellUnits, sellValue } from './economy.js';
import { base64ToInt16 } from './bytes.js';

export const CORE_VERSION = 2; // 2: free driving each turn (tank.driveFrom), sudden death

export const Phase = Object.freeze({
  SETUP: 'setup', // created, before the first round (or its shop)
  AIM: 'aim', // waiting for the active tank to act
  BUSY: 'busy', // shells flying, dirt falling, tanks moving
  ROUND_OVER: 'roundOver',
  SHOP: 'shop',
  GAME_OVER: 'gameOver',
});

/**
 * Rounds of turns left before sudden death starts (0 once it has started), or null when it's
 * switched off. A "round of turns" is complete when every surviving tank has had a turn.
 */
export function suddenDeathIn(state) {
  const after = state.settings.suddenDeath;
  if (!after) return null;
  return Math.max(0, after + 1 - state.rotation);
}

/** The columns a tank can drive between this turn without fuel: [left, right]. */
export function freeDriveZone(tank) {
  return [tank.driveFrom - FREE_DRIVE, tank.driveFrom + FREE_DRIVE];
}

/** True if driving onto column `x` this turn is free (within the tank's free zone). */
export function freeDriveAt(tank, x) {
  return Math.abs(x - tank.driveFrom) <= FREE_DRIVE;
}

/**
 * Why the tank can't start driving in direction `dir` (-1 or 1) right now, or null if it can.
 * Every tank can drive within its free zone; beyond it, driving takes fuel. (Slopes and the
 * map's edges can still stop a drive once it's started.)
 */
export function driveProblem(tank, dir) {
  if (dir !== -1 && dir !== 1) return 'bad direction';
  if (freeDriveAt(tank, tank.x + dir) || tank.stock.fuel > 0) return null;
  return 'no more driving this turn (fuel lets you go further)';
}

const isUint32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export const emptyStock = () => Object.fromEntries(STOCK_IDS.map((id) => [id, 0]));

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
    lastDamagedBy: -1,
    burn: 0,
    moving: 0,
    moveDir: 0,
    driveFrom: 0, // where this tank started its current turn (the middle of its free drive zone)
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
    roundTurns: 0,
    rotation: 0, // rounds of turns so far this round (1 while the first tanks take their turns)
    turnMask: 0, // bit per tank that has had a turn in the current round of turns
    volleyTurn: -1, // the turn whose sudden-death volley has already fallen
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
        if (!isNum(cmd.power, 0, MAX_POWER)) return 'bad power';
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
        return driveProblem(tank, cmd.dir);
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
    s.roundTurns = 1;
    s.rotation = 1;
    s.turnMask = 1 << cmd.first;
    s.volleyTurn = -1;
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
      lastDamagedBy: -1,
      falling: false,
      vy: 0,
      fallFrom: y,
      chute: false,
      moving: 0,
      moveDir: 0,
      driveFrom: x,
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
    if (p.mode === 'roll') {
      this.updateRoller(p);
      return;
    }
    if (p.mode === 'dig') {
      this.updateDigger(p);
      return;
    }
    const code = stepProjectile(p, this.env);
    if (code === HIT_NONE) {
      if (p.kind === 'mirv' && p.vy >= 0) this.splitMirv(p);
      return;
    }
    if (code === HIT_LOST) {
      p.dead = true;
      this.emit({ type: 'lost', x: p.x, y: p.y });
      return;
    }
    this.impact(p, code);
  }

  /** A shell has hit something: dirt, a tank, a shield or a concrete wall. */
  impact(p, code) {
    const s = this.state;
    const weapon = WEAPON_BY_ID[p.weapon];
    const direct = code === HIT_TANK || code === HIT_SHIELD;
    if (!p.child && !p.sky && s.lastShot && !s.lastShot.impact) s.lastShot.impact = { x: p.x, y: p.y, tank: direct ? p.hitTank : -1 };
    if (code === HIT_SHIELD) this.emit({ type: 'shieldHit', tank: p.hitTank, x: p.x, y: p.y });
    if (direct) this.emit({ type: 'directHit', tank: p.hitTank });
    if (code === HIT_WALL) this.emit({ type: 'wallHit', x: p.x, y: p.y });
    const radius = p.radius ?? weapon.radius;
    const damage = p.damage ?? weapon.damage;
    switch (p.kind) {
      case 'tracer':
        p.dead = true;
        this.emit({ type: 'tracerEnd', x: p.x, y: p.y });
        return;
      case 'roller':
        if (code === HIT_TERRAIN) {
          this.startRolling(p);
          return;
        }
        break;
      case 'digger':
        if (code === HIT_TERRAIN) {
          this.startDigging(p, weapon);
          return;
        }
        break;
      case 'napalm':
        p.dead = true;
        this.spawnNapalm(p, weapon);
        return;
      case 'dirt': {
        p.dead = true;
        const added = this.terrain.addDirt(p.x, p.y, weapon.radius, s.rng.nextU32());
        this.emit({ type: 'dirt', x: p.x, y: p.y, radius: weapon.radius, added });
        return;
      }
      case 'funky':
        p.dead = true;
        this.explode(p.x, p.y, radius, damage, p.owner, { then: { kind: 'funky', weapon: weapon.id } });
        return;
      case 'leapfrog': {
        p.dead = true;
        const hops = (p.hops ?? weapon.hops) - 1;
        const then = hops > 0 ? { kind: 'leap', weapon: weapon.id, hops, vx: p.vx * 0.72, vy: -Math.max(230, Math.abs(p.vy) * 0.62) } : null;
        this.explode(p.x, p.y, radius, damage, p.owner, { then });
        return;
      }
    }
    p.dead = true;
    this.explode(p.x, p.y, radius, damage, p.owner, { flash: !!weapon.flash && !p.child });
  }

  splitMirv(p) {
    const weapon = WEAPON_BY_ID[p.weapon];
    const mid = (weapon.warheads - 1) / 2;
    for (let i = 0; i < weapon.warheads; i++) {
      this.spawnShell(weapon, p.owner, p.x, p.y, p.vx + (i - mid) * weapon.spread, p.vy, {
        kind: 'warhead',
        child: true,
        armed: true,
        radius: weapon.radius,
        damage: weapon.damage,
      });
    }
    p.dead = true;
    this.emit({ type: 'split', x: p.x, y: p.y, count: weapon.warheads });
  }

  /** Follow-ups that start once a blast has dug its crater: bomblets and leapfrog hops. */
  afterBlast(e) {
    const then = e.then;
    const s = this.state;
    const weapon = WEAPON_BY_ID[then.weapon];
    if (then.kind === 'funky') {
      for (let i = 0; i < weapon.bomblets; i++) {
        const vx = s.rng.range(-290, 290);
        const vy = s.rng.range(-560, -230);
        this.spawnShell(weapon, e.owner, e.x, e.y - 2, vx, vy, {
          kind: 'warhead',
          child: true,
          armed: true,
          radius: weapon.bombletRadius,
          damage: weapon.bombletDamage,
          funky: true,
        });
      }
      this.emit({ type: 'split', x: e.x, y: e.y, count: weapon.bomblets });
    } else if (then.kind === 'leap') {
      this.spawnShell(weapon, e.owner, e.x, e.y - 3, then.vx, then.vy, { child: true, armed: true, hops: then.hops });
      this.emit({ type: 'bounce', x: e.x, y: e.y });
    }
  }

  riotCharge(tank, weapon) {
    const cx = tank.x;
    const cy = tank.y - TANK.pivotY;
    const result = this.terrain.carveAbove(cx, cy, weapon.radius, tank.y);
    this.emit({ type: 'riot', tank: tank.id, x: cx, y: cy, radius: weapon.radius, material: result.material });
  }

  // --- Rollers -------------------------------------------------------------------------------

  /** Row of the first solid pixel in column x within ±range of y (y + range + 1 if none). */
  surfaceNear(x, y, range = 8) {
    for (let r = y - range; r <= y + range; r++) if (this.terrain.isSolid(x, r)) return r;
    return y + range + 1;
  }

  startRolling(p) {
    const t = this.terrain;
    const x = Math.max(0, Math.min(WIDTH - 1, Math.floor(p.x)));
    let y = Math.floor(p.y);
    while (y > 0 && t.isSolid(x, y)) y--;
    const left = this.surfaceNear(x - 4, y);
    const right = this.surfaceNear(x + 4, y);
    p.mode = 'roll';
    p.x = x;
    p.y = y;
    p.dir = left > right ? -1 : right > left ? 1 : p.vx < 0 ? -1 : 1;
    p.speed = clamp(Math.abs(p.vx) * DT * 0.45 + 0.7, 0.7, 3.5);
    p.acc = 0;
    p.rollAge = p.rollAge ?? 0;
    p.turns = p.turns ?? 0;
    this.emit({ type: 'roll', x, y });
  }

  rollerHitsTank(x, y) {
    for (const tank of this.state.tanks) {
      if (!tank.alive) continue;
      if (Math.abs(x - tank.x) <= TANK.hitHalfWidth + 2 && y >= tank.y - TANK.hitTop - 3 && y <= tank.y + 3) return true;
    }
    return false;
  }

  rollerBoom(p) {
    const weapon = WEAPON_BY_ID[p.weapon];
    p.dead = true;
    this.explode(p.x, p.y - 3, weapon.radius, weapon.damage, p.owner);
  }

  updateRoller(p) {
    const t = this.terrain;
    p.rollAge++;
    if (p.rollAge > 60 * 9) return this.rollerBoom(p);
    p.acc += p.speed;
    while (p.acc >= 1) {
      p.acc -= 1;
      let nx = p.x + p.dir;
      if (nx < 0 || nx >= WIDTH) {
        const walls = this.env.walls;
        if (walls === 'wrap') nx = (nx + WIDTH) % WIDTH;
        else if (walls === 'rubber') {
          p.dir = -p.dir;
          continue;
        } else if (walls === 'concrete') return this.rollerBoom(p);
        else {
          p.dead = true;
          this.emit({ type: 'lost', x: p.x, y: p.y });
          return;
        }
      }
      if (this.rollerHitsTank(nx, p.y)) {
        p.x = nx;
        return this.rollerBoom(p);
      }
      let ny = p.y;
      if (t.isSolid(nx, ny)) {
        let up = 0;
        while (up < 4 && t.isSolid(nx, ny - up)) up++;
        if (up >= 4) {
          // A wall: bounce back with less speed.
          p.dir = -p.dir;
          p.speed *= 0.5;
          p.turns++;
          if (p.turns > 3 || p.speed < 0.2) return this.rollerBoom(p);
          continue;
        }
        ny -= up;
        p.speed -= up * 0.3;
      } else {
        let down = 0;
        while (down < 5 && !t.isSolid(nx, ny + 1 + down)) down++;
        if (down >= 5) {
          // Off a ledge: fly again, and roll on when it lands.
          p.x = nx;
          p.y = ny;
          p.mode = 'fly';
          p.vx = p.dir * Math.max(40, p.speed * 60);
          p.vy = 20;
          p.armed = true;
          return;
        }
        ny += down;
        p.speed += down * 0.25;
      }
      p.x = nx;
      p.y = ny;
      p.speed = Math.min(6, p.speed - 0.015);
      if (p.speed <= 0.05) {
        // Stopped. Roll back if the other way is downhill, otherwise go off.
        const back = this.surfaceNear(p.x - p.dir * 3, p.y);
        if (back > p.y + 1 && p.turns < 2) {
          p.dir = -p.dir;
          p.speed = 0.35;
          p.turns++;
        } else {
          return this.rollerBoom(p);
        }
      }
    }
  }

  // --- Diggers -------------------------------------------------------------------------------

  startDigging(p, weapon) {
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
    let dx = p.vx / speed;
    let dy = p.vy / speed;
    if (dy < 0.4) dy = 0.4;
    const len = Math.sqrt(dx * dx + dy * dy);
    dx /= len;
    dy /= len;
    const extra = { mode: 'dig', left: weapon.tunnel, air: 0, child: true, armed: true };
    p.mode = 'dig';
    p.dx = dx;
    p.dy = dy;
    p.left = weapon.tunnel;
    p.air = 0;
    if (weapon.burrowers > 1) {
      // Fan the others out by ±26° (cos/sin precomputed so no trig runs here).
      const c = 0.898794046299167;
      const sn = 0.4383711467890774;
      this.spawnShell(weapon, p.owner, p.x, p.y, 0, 0, { ...extra, dx: dx * c - dy * sn, dy: Math.max(0.25, dx * sn + dy * c) });
      this.spawnShell(weapon, p.owner, p.x, p.y, 0, 0, { ...extra, dx: dx * c + dy * sn, dy: Math.max(0.25, -dx * sn + dy * c) });
    }
    this.emit({ type: 'dig', x: p.x, y: p.y });
  }

  updateDigger(p) {
    const t = this.terrain;
    const weapon = WEAPON_BY_ID[p.weapon];
    const boom = () => {
      p.dead = true;
      this.explode(p.x, p.y, weapon.radius, weapon.damage, p.owner);
    };
    for (let i = 0; i < 3; i++) {
      p.x += p.dx;
      p.y += p.dy;
      p.left--;
      if (p.x < 1 || p.x >= WIDTH - 1 || p.y >= HEIGHT - 2 || p.left <= 0) return boom();
      // Look past the tunnel it's cutting to tell whether it's still in the ground.
      if (t.isSolid(p.x + p.dx * 7, p.y + p.dy * 7)) p.air = 0;
      else if (++p.air > 8) return boom();
      if ((p.left & 1) === 0) t.carve(p.x, p.y, 5, 0);
      for (const tank of this.state.tanks) {
        if (tank.alive && distanceToTank(tank, p.x, p.y) < 2) return boom();
      }
    }
  }

  // --- Napalm --------------------------------------------------------------------------------

  spawnNapalm(p, weapon) {
    const s = this.state;
    for (let i = 0; i < weapon.particles; i++) {
      s.napalm.push({
        x: p.x + s.rng.range(-4, 4),
        y: p.y - 2 - s.rng.range(0, 4),
        vx: s.rng.range(-2.2, 2.2),
        vy: s.rng.range(-3.4, -0.6),
        life: Math.round(weapon.burn * s.rng.range(0.7, 1.15)),
        heat: weapon.heat,
        owner: p.owner,
        flow: false,
        spread: 40,
        side: i & 1 ? 1 : -1,
      });
    }
    this.emit({ type: 'napalm', x: p.x, y: p.y, heat: weapon.heat });
  }

  updateNapalm() {
    const s = this.state;
    const list = s.napalm;
    if (!list.length) return;
    const t = this.terrain;
    const occupied = new Set();
    for (const n of list) if (n.flow) occupied.add(n.y * WIDTH + n.x);
    const free = (x, y) => x >= 0 && x < WIDTH && y < HEIGHT && !t.isSolid(x, y) && !occupied.has(y * WIDTH + x);
    for (const n of list) {
      n.life--;
      if (!n.flow) {
        n.vy += 0.16;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(n.vx), Math.abs(n.vy))));
        for (let k = 0; k < steps; k++) {
          const nx = n.x + n.vx / steps;
          const ny = n.y + n.vy / steps;
          if (nx < 0 || nx >= WIDTH) {
            n.life = 0;
            break;
          }
          if (ny >= HEIGHT - 1 || t.isSolid(nx, ny)) {
            n.flow = true;
            n.x = Math.floor(n.x);
            n.y = Math.min(HEIGHT - 1, Math.floor(n.y));
            occupied.add(n.y * WIDTH + n.x);
            break;
          }
          n.x = nx;
          n.y = ny;
        }
      } else if (t.isSolid(n.x, n.y)) {
        n.life = 0; // smothered by falling dirt
      } else {
        const { x, y } = n;
        let tx = x;
        let ty = y;
        if (free(x, y + 1)) ty = y + 1;
        else if (free(x + n.side, y + 1)) {
          tx = x + n.side;
          ty = y + 1;
        } else if (free(x - n.side, y + 1)) {
          tx = x - n.side;
          ty = y + 1;
        } else if (n.spread > 0 && free(x + n.side, y)) {
          tx = x + n.side;
          n.spread--;
        } else {
          n.side = -n.side;
        }
        if (tx !== x || ty !== y) {
          occupied.delete(y * WIDTH + x);
          occupied.add(ty * WIDTH + tx);
          n.x = tx;
          n.y = ty;
        }
      }
      if (n.life <= 0 && n.flow) t.scorch(n.x, n.y + 1);
    }
    s.napalm = list.filter((n) => n.life > 0);
    // Burn tanks standing in the fire: at most ten flames count at once.
    for (const tank of s.tanks) {
      if (!tank.alive) continue;
      let heat = 0;
      let count = 0;
      let owner = -1;
      for (const n of s.napalm) {
        if (Math.abs(n.x - tank.x) <= TANK.halfWidth + 3 && n.y >= tank.y - TANK.hitTop - 4 && n.y <= tank.y + 3) {
          if (count < 10) heat += n.heat;
          if (owner < 0) owner = n.owner;
          count++;
        }
      }
      if (!count) continue;
      tank.burn += heat * 0.016;
      if (tank.burn >= 1) {
        const dmg = Math.floor(tank.burn);
        tank.burn -= dmg;
        this.damageTank(tank, dmg, owner);
      }
    }
  }

  // --- Explosions ----------------------------------------------------------------------------

  explode(x, y, radius, damage, owner, { flash = false, kind = 'blast', carve = true, then = null } = {}) {
    const e = {
      x,
      y,
      radius,
      damage,
      owner,
      age: 0,
      grow: Math.max(6, Math.round(radius / 3.5)),
      fade: Math.max(10, Math.round(radius / 2.5)),
      flash,
      kind,
      carve,
      then,
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
    if (e.then) this.afterBlast(e);
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
    if (attacker >= 0 && attacker !== tank.id) tank.lastDamagedBy = attacker;
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
    if (!freeDriveAt(tank, nx)) {
      const cost = FUEL_PER_PIXEL + climb * FUEL_PER_CLIMB;
      if (tank.stock.fuel < cost) return stop(tank.stock.fuel > 0 ? 'fuel' : 'range');
      tank.stock.fuel -= cost;
    }
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
    this.updateNapalm();
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
    if (s.pendingTurnEnd || !active?.alive) {
      // Sudden death: shells fall from the sky at the end of every turn.
      if (suddenDeathIn(s) === 0 && s.volleyTurn !== s.turnId) {
        s.volleyTurn = s.turnId;
        if (this.skyVolley()) return;
      }
      // A round can't go on forever (say, two tanks that keep missing each other).
      if (s.roundTurns >= this.turnLimit()) {
        this.endRound(true);
        return;
      }
      this.nextTurn();
    } else s.phase = Phase.AIM;
  }

  /**
   * Drops a sudden-death volley: shells fall from above the screen near random survivors, more
   * with every round of turns. The world stays busy until they've landed. Returns false if
   * there was nothing to drop.
   */
  skyVolley() {
    const s = this.state;
    const living = s.tanks.filter((t) => t.alive);
    if (!living.length) return false;
    const into = s.rotation - s.settings.suddenDeath; // 1 in the first round of sudden death
    const count = Math.min(SUDDEN_DEATH.maxShells, Math.max(1, into));
    for (let i = 0; i < count; i++) {
      const target = living[s.rng.int(living.length)];
      const x = clamp(target.x + s.rng.intRange(-SUDDEN_DEATH.spread, SUDDEN_DEATH.spread), TANK.halfWidth, WIDTH - 1 - TANK.halfWidth);
      const heavy = into >= SUDDEN_DEATH.heavyAfter && s.rng.chance(0.5);
      const weapon = WEAPON_BY_ID[heavy ? 'babynuke' : 'missile'];
      const vx = s.rng.intRange(-SUDDEN_DEATH.drift, SUDDEN_DEATH.drift);
      this.spawnShell(weapon, -1, x, -SUDDEN_DEATH.height - i * SUDDEN_DEATH.gap, vx, 0, { armed: true, sky: true });
    }
    s.phase = Phase.BUSY;
    s.quiet = 0;
    this.emit({ type: 'skyVolley', count, heavy: into >= SUDDEN_DEATH.heavyAfter });
    return true;
  }

  /** Turns in a round before time is called: plenty for every tank to get its shots in. */
  turnLimit() {
    return TURNS_PER_TANK * this.state.tanks.length;
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
    // A round of turns is over when the turn comes back to a tank that already had one.
    const bit = 1 << s.active;
    if (s.turnMask & bit) {
      s.rotation++;
      s.turnMask = 0;
      if (suddenDeathIn(s) === 0 && s.rotation === s.settings.suddenDeath + 1) this.emit({ type: 'suddenDeath', round: s.round });
    }
    s.turnMask |= bit;
    const windMax = WIND_MAX[s.settings.wind] ?? 0;
    if (s.settings.windChange && windMax > 0 && s.rng.chance(0.6)) {
      s.wind = clamp(s.wind + s.rng.intRange(-2, 2), -windMax, windMax);
    }
    for (const tank of s.tanks) tank.lastHitBy = -1;
    const tank = s.tanks[s.active];
    tank.driveFrom = tank.x;
    if (tank.weapon !== FREE_WEAPON && !(tank.stock[tank.weapon] > 0)) tank.weapon = FREE_WEAPON;
    s.turnId++;
    s.roundTurns++;
    s.phase = Phase.AIM;
    this.refreshEnv();
    this.emit({ type: 'turn', tank: s.active, turnId: s.turnId });
  }

  /** Ends the round. With `timeUp`, the healthiest survivor wins (if there's a single one). */
  endRound(timeUp = false) {
    const s = this.state;
    const alive = s.tanks.filter((t) => t.alive);
    let winner = alive.length === 1 ? alive[0].id : -1;
    if (timeUp && alive.length > 1) {
      const best = Math.max(...alive.map((t) => t.health));
      const leaders = alive.filter((t) => t.health === best);
      if (leaders.length === 1) winner = leaders[0].id;
    }
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
    s.results = { round: s.round, winner, earnings, timeUp };
    s.phase = Phase.ROUND_OVER;
    this.emit({ type: 'roundOver', round: s.round, winner, timeUp });
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
