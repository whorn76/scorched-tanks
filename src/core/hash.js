// A 64-bit fingerprint of the game state (two independent 32-bit lanes). The host broadcasts it
// after every shot; a guest whose own hash differs asks for a full snapshot.
import { STOCK_IDS } from './weapons.js';

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

export class Hasher {
  constructor() {
    this.a = 0x811c9dc5; // FNV-1a lane
    this.b = 0x9747b28c; // multiply-rotate lane
  }

  u32(value) {
    const v = value >>> 0;
    this.a = Math.imul(this.a ^ v, 16777619) >>> 0;
    let b = (this.b ^ Math.imul(v, 0xcc9e2d51)) >>> 0;
    b = ((b << 13) | (b >>> 19)) >>> 0;
    this.b = (Math.imul(b, 5) + 0xe6546b64) >>> 0;
    return this;
  }

  int(value) {
    return this.u32(value | 0);
  }

  bool(value) {
    return this.u32(value ? 1 : 0);
  }

  /** Hashes the exact bits of a double (-0 is folded into 0). */
  num(value) {
    f64[0] = value + 0;
    this.u32(u32[0]);
    return this.u32(u32[1]);
  }

  str(value) {
    const s = String(value ?? '');
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) this.u32(s.charCodeAt(i));
    return this;
  }

  bytes(data) {
    const words = Math.floor(data.length / 4);
    const view = new Uint32Array(data.buffer, data.byteOffset, words);
    this.u32(data.length);
    for (let i = 0; i < words; i++) this.u32(view[i]);
    for (let i = words * 4; i < data.length; i++) this.u32(data[i]);
    return this;
  }

  hex() {
    return this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0');
  }
}

function hashTank(h, t) {
  h.int(t.id).str(t.name).str(t.color).str(t.ai);
  h.num(t.x).num(t.y).bool(t.alive).bool(t.wreck).num(t.health);
  h.num(t.angle).num(t.power).str(t.weapon).num(t.money);
  for (const id of STOCK_IDS) h.num(t.stock[id] ?? 0);
  h.num(t.shield).str(t.shieldType).bool(t.falling).num(t.vy).num(t.fallFrom).bool(t.chute);
  h.int(t.dying).int(t.killer).int(t.lastHitBy).int(t.lastDamagedBy ?? -1).num(t.burn).int(t.moving).int(t.moveDir);
  const s = t.stats;
  h.int(s.kills).num(s.damage).int(s.wins).int(s.deaths).num(s.selfDamage);
  h.num(t.round.damage).int(t.round.kills).num(t.round.earned);
}

function hashObjectList(h, list) {
  h.u32(list.length);
  for (const item of list) {
    for (const key of Object.keys(item).sort()) {
      const v = item[key];
      h.str(key);
      if (typeof v === 'number') h.num(v);
      else if (typeof v === 'boolean') h.bool(v);
      else if (v !== null && typeof v === 'object') h.str(JSON.stringify(v));
      else h.str(v);
    }
  }
}

/** Fingerprint of everything that affects the simulation. */
export function hashGame(game) {
  const s = game.state;
  const h = new Hasher();
  h.int(s.v).str(s.phase).int(s.round).int(s.turnId).int(s.active).num(s.wind);
  h.str(s.walls).str(s.sky).int(s.ground).str(s.style).u32(s.rng.state).int(s.tick).int(s.roundTurns ?? 0);
  h.int(s.quiet).int(s.quietNeeded).bool(s.pendingTurnEnd).int(s.nextId);
  for (const key of Object.keys(s.settings).sort()) h.str(key).str(s.settings[key]);
  h.u32(s.tanks.length);
  for (const tank of s.tanks) hashTank(h, tank);
  hashObjectList(h, s.projectiles);
  hashObjectList(h, s.explosions);
  hashObjectList(h, s.napalm);
  h.u32(s.deaths.length);
  for (const id of s.deaths) h.int(id);
  h.bytes(game.terrain.data);
  return h.hex();
}
