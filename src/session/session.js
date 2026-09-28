// Sessions sit between input (keyboard, AI, network) and the deterministic core. Players send
// *intents* ("fire at 45° with power 600"). The authority (a local game or the online host)
// turns each intent into a *command* with everything random or trig-based already decided
// (launch velocity, seeds, terrain), applies it, and in online games broadcasts it. Local,
// AI and network input all flow through the same handleIntent() → resolve() → commit() path.
import { Game, Phase, maxPower } from '../core/game.js';
import { Rng } from '../core/rng.js';
import { launchVector } from '../core/physics.js';
import { planRound } from '../core/terrainGen.js';
import { TICKS_PER_SECOND, clamp } from '../core/constants.js';
import { FREE_WEAPON, WEAPON_BY_ID } from '../core/weapons.js';
import { Brain } from '../ai/brain.js';
import { freshSeed } from './seed.js';

export const ROUND_SUMMARY_TICKS = TICKS_PER_SECOND * 4;
export const SETUP_DELAY_TICKS = 20;

const roundTo = (value, step) => Math.round(value / step) * step;

/** What every session has: a game, the players this client controls, aim previews and events. */
export class Session {
  constructor() {
    this.game = null;
    this.localPlayers = new Set();
    this.previews = new Map(); // playerId → { angle, power, weaponId } shown for tanks aiming elsewhere
    this.events = []; // game and session events for the UI, drained every frame
    this.ready = new Set(); // players who finished shopping
    this.ticks = 0;
    this.turnStartTick = 0;
    this.closed = false;
    this.online = false;
    this.isAuthority = false;
  }

  get state() {
    return this.game?.state ?? null;
  }

  controls(playerId) {
    return this.localPlayers.has(playerId);
  }

  /** The id of the tank the person at this screen should be aiming right now, or -1. */
  myTurn() {
    const s = this.state;
    if (!s || s.phase !== Phase.AIM) return -1;
    const tank = s.tanks[s.active];
    return tank && tank.alive && !tank.ai && this.controls(tank.id) ? tank.id : -1;
  }

  /** Humans at this screen who still need to shop, in order. */
  localShoppers() {
    const s = this.state;
    if (!s || s.phase !== Phase.SHOP) return [];
    return s.tanks.filter((t) => !t.ai && this.controls(t.id) && !this.ready.has(t.id)).map((t) => t.id);
  }

  pushEvent(event) {
    this.events.push(event);
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  collectGameEvents() {
    for (const event of this.game.drainEvents()) {
      if (event.type === 'turn') {
        this.turnStartTick = this.ticks;
        this.previews.delete(event.tank);
      }
      if (event.type === 'shop') this.ready.clear();
      this.events.push(event);
    }
  }

  /** Seconds left on the turn timer, or null when there's no timer. */
  turnTimeLeft() {
    const s = this.state;
    const limit = s?.settings.turnTimer ?? 0;
    if (!limit || s.phase !== Phase.AIM) return null;
    const tank = s.tanks[s.active];
    if (!tank || tank.ai) return null;
    return Math.max(0, limit - (this.ticks - this.turnStartTick) / TICKS_PER_SECOND);
  }

  setPreview(playerId, angle, power, weaponId) {
    this.previews.set(playerId, { angle, power, weaponId });
  }

  close() {
    this.closed = true;
  }
}

/**
 * The session that owns the truth: a local game, or the host of an online game. It holds the
 * authority RNG (separate from the game's) and decides seeds, velocities and terrain.
 */
export class AuthoritySession extends Session {
  constructor({ settings = null, players = null, seed = freshSeed(), localPlayers = [], aiFast = false } = {}) {
    super();
    this.isAuthority = true;
    this.rng = new Rng(seed);
    this.seq = 0; // number of commands applied; guests use it to order and resync
    this.flowPhase = null;
    this.flowTimer = 0;
    this.started = false;
    this.brain = new Brain(this, { seed: this.rng.nextU32(), fast: aiFast });
    for (const id of localPlayers) this.localPlayers.add(id);
    if (players) this.setupGame(settings, players);
  }

  setupGame(settings, players) {
    this.game = Game.create({ settings, players });
    this.flowPhase = null;
    this.flowTimer = 0;
    this.ready.clear();
    return this.game;
  }

  /** Begins play: the first shop (with starting cash) or straight into round 1. */
  start() {
    this.started = true;
  }

  /** Local input. */
  submit(intent) {
    return this.handleIntent(intent);
  }

  handleIntent(intent) {
    if (!intent || typeof intent !== 'object') return { ok: false, error: 'bad intent' };
    if (intent.type === 'ready') return this.markReady(intent.playerId);
    if (intent.type === 'aim') {
      this.setPreview(intent.playerId, intent.angle, intent.power, intent.weaponId);
      this.onPreview(intent.playerId);
      return { ok: true };
    }
    const cmd = this.resolve(intent);
    if (cmd.error) return { ok: false, error: cmd.error };
    return this.commit(cmd);
  }

  /** Turns a player intent into a fully specified core command. */
  resolve(intent) {
    const s = this.game.state;
    const tank = s.tanks[intent.playerId];
    if (!tank) return { error: 'unknown player' };
    switch (intent.type) {
      case 'fire': {
        const weapon = WEAPON_BY_ID[intent.weaponId] ? intent.weaponId : FREE_WEAPON;
        const angle = roundTo(clamp(Number(intent.angle) || 0, 0, 180), 0.1);
        const power = Math.round(clamp(Number(intent.power) || 0, 0, maxPower(tank)));
        const { vx, vy, ux, uy } = launchVector(angle, power);
        return {
          type: 'shot',
          turnId: intent.turnId,
          playerId: tank.id,
          weaponId: weapon,
          angle,
          power,
          vx,
          vy,
          ux,
          uy,
          seed: this.rng.nextU32(),
        };
      }
      case 'move':
        return { type: 'move', turnId: intent.turnId, playerId: tank.id, dir: intent.dir };
      case 'use':
        return { type: 'use', turnId: intent.turnId, playerId: tank.id, item: intent.item };
      case 'buy':
      case 'sell':
        return { type: intent.type, playerId: tank.id, item: intent.item };
      default:
        return { error: 'unknown intent' };
    }
  }

  commit(cmd) {
    if (!this.game.isIdle()) return { ok: false, error: 'busy' };
    const result = this.game.apply(cmd);
    if (result.ok) {
      this.seq++;
      this.onCommit(cmd);
      this.collectGameEvents();
    }
    return result;
  }

  /** Hooks for the online host. */
  onCommit() {}
  onSettled() {}
  onPreview() {}

  markReady(playerId) {
    const s = this.game.state;
    if (s.phase !== Phase.SHOP || !s.tanks[playerId]) return { ok: false, error: 'not shopping' };
    this.ready.add(playerId);
    this.pushEvent({ type: 'ready', tank: playerId });
    return { ok: true };
  }

  /** Humans who still have to finish shopping. */
  waitingShoppers() {
    return this.game.state.tanks.filter((t) => !t.ai && !this.ready.has(t.id)).map((t) => t.id);
  }

  planNextRound() {
    const s = this.game.state;
    return { type: 'newRound', ...planRound({ settings: s.settings, tankCount: s.tanks.length, round: s.round + 1, rng: this.rng }) };
  }

  /** One fixed step: simulation, then round flow, AI and the turn timer. */
  update() {
    this.ticks++;
    if (!this.game) return;
    const wasBusy = this.game.phase === Phase.BUSY;
    this.game.tick();
    this.collectGameEvents();
    if (wasBusy && this.game.isIdle()) this.onSettled();
    this.flow();
    this.brain?.update();
    this.checkTurnTimer();
  }

  flow() {
    const s = this.game.state;
    if (s.phase !== this.flowPhase) {
      this.flowPhase = s.phase;
      this.flowTimer = 0;
    } else {
      this.flowTimer++;
    }
    if (!this.started) return;
    switch (s.phase) {
      case Phase.SETUP:
        if (this.flowTimer >= SETUP_DELAY_TICKS) this.commit(s.settings.startCash > 0 ? { type: 'openShop' } : this.planNextRound());
        break;
      case Phase.ROUND_OVER:
        if (this.flowTimer >= ROUND_SUMMARY_TICKS) this.commit(this.game.isLastRound() ? { type: 'endGame' } : { type: 'openShop' });
        break;
      case Phase.SHOP:
        if (this.flowTimer >= 2 && this.waitingShoppers().length === 0) this.commit(this.planNextRound());
        break;
    }
  }

  checkTurnTimer() {
    const left = this.turnTimeLeft();
    if (left === null || left > 0) return;
    const s = this.game.state;
    const tank = s.tanks[s.active];
    const preview = this.previews.get(tank.id);
    const weaponId = preview && (preview.weaponId === FREE_WEAPON || tank.stock[preview.weaponId] > 0) ? preview.weaponId : FREE_WEAPON;
    this.pushEvent({ type: 'timeout', tank: tank.id });
    this.handleIntent({
      type: 'fire',
      turnId: s.turnId,
      playerId: tank.id,
      angle: preview?.angle ?? tank.angle,
      power: Math.min(preview?.power ?? tank.power, maxPower(tank)),
      weaponId,
    });
  }
}

/** A game on one screen: hot-seat humans and AI tanks. */
export class LocalSession extends AuthoritySession {
  constructor(options) {
    super(options);
    for (const tank of this.game.state.tanks) if (!tank.ai) this.localPlayers.add(tank.id);
  }
}
