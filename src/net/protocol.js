// The online protocol: message shapes, validation of everything that arrives from the network,
// and room codes. Every message is a JSON object with a string `t` (type). Anything malformed is
// dropped. Only whitelisted fields survive, strings are length-limited and stripped of control
// characters, and numbers must be finite and in range.
import { MAX_POWER } from '../core/constants.js';
import { STOCK_IDS, WEAPON_IDS } from '../core/weapons.js';

export const PROTOCOL_VERSION = 1;
export const MAX_HUMANS = 4; // host + 3 guests
export const MAX_NAME = 16;
export const MAX_CHAT = 200;
export const SNAPSHOT_CHUNK = 12000; // characters of base64 per snapshot message
export const MAX_SNAPSHOT_PARTS = 80;
export const PEER_PREFIX = 'scorchedtanks-';

/** Room code alphabet: no 0/O/Q/D, 1/I/L/J, 2/Z, 5/S, 8/B or U/V look-alikes. */
export const ROOM_ALPHABET = 'ACEFGHKMNPRTWXY34679';
export const ROOM_CODE_LENGTH = 5;

export function makeRoomCode(random = defaultRandom) {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)];
  return code;
}

function defaultRandom() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) return cryptoApi.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  return Math.random();
}

/** Uppercases and strips anything that can't be part of a room code. Returns '' if invalid. */
export function normalizeRoomCode(text) {
  const clean = String(text ?? '')
    .toUpperCase()
    .split('')
    .filter((c) => ROOM_ALPHABET.includes(c))
    .join('');
  return clean.length === ROOM_CODE_LENGTH ? clean : '';
}

// --- Field checks ------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Cleans user text: no control characters, collapsed whitespace, limited length. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const turnId = (v) => (isInt(v, 0, 1e9) ? v : null);

// --- Guest → host ------------------------------------------------------------------------------

/** Validates a message a guest sent to the host. Returns a clean copy or null. */
export function parseGuestMessage(msg) {
  if (!isObject(msg) || typeof msg.t !== 'string') return null;
  switch (msg.t) {
    case 'hello': {
      if (!isInt(msg.v, 0, 1e6)) return null;
      const name = cleanText(msg.name, MAX_NAME);
      return { t: 'hello', v: msg.v, name: name || 'Guest' };
    }
    case 'chat': {
      const text = cleanText(msg.text, MAX_CHAT);
      return text ? { t: 'chat', text } : null;
    }
    case 'aim':
    case 'fire': {
      const id = turnId(msg.turnId);
      if (id === null || !isNum(msg.angle, 0, 180) || !isNum(msg.power, 0, MAX_POWER)) return null;
      if (typeof msg.weaponId !== 'string' || !WEAPON_IDS.includes(msg.weaponId)) return null;
      return { t: msg.t, turnId: id, angle: msg.angle, power: msg.power, weaponId: msg.weaponId };
    }
    case 'move': {
      const id = turnId(msg.turnId);
      if (id === null || (msg.dir !== 1 && msg.dir !== -1)) return null;
      return { t: 'move', turnId: id, dir: msg.dir };
    }
    case 'use': {
      const id = turnId(msg.turnId);
      if (id === null || !['shield', 'heavyshield', 'battery'].includes(msg.item)) return null;
      return { t: 'use', turnId: id, item: msg.item };
    }
    case 'buy':
    case 'sell':
      return typeof msg.item === 'string' && STOCK_IDS.includes(msg.item) ? { t: msg.t, item: msg.item } : null;
    case 'ready':
      return { t: 'ready' };
    case 'resync':
      return { t: 'resync' };
    case 'ping':
      return isInt(msg.id, 0, 1e9) ? { t: 'ping', id: msg.id } : null;
    default:
      return null;
  }
}

// --- Host → guest ------------------------------------------------------------------------------

const cleanLobbyPlayer = (p) => {
  if (!isObject(p) || !isInt(p.slot, 0, 1e9)) return null;
  const kind = ['host', 'guest', 'ai'].includes(p.kind) ? p.kind : null;
  if (!kind) return null;
  return {
    slot: p.slot,
    name: cleanText(p.name, MAX_NAME) || '?',
    color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#888888',
    kind,
    ai: typeof p.ai === 'string' ? cleanText(p.ai, 12) : null,
  };
};

/** Validates a message the host sent to a guest. Returns a clean copy or null. */
export function parseHostMessage(msg) {
  if (!isObject(msg) || typeof msg.t !== 'string') return null;
  switch (msg.t) {
    case 'welcome':
      return isInt(msg.v, 0, 1e6) && isInt(msg.slot, 0, 1e9) ? { t: 'welcome', v: msg.v, slot: msg.slot } : null;
    case 'reject':
      return { t: 'reject', reason: cleanText(msg.reason, 200) || 'Rejected by the host.' };
    case 'lobby': {
      if (!Array.isArray(msg.players) || msg.players.length > 8) return null;
      const players = msg.players.map(cleanLobbyPlayer);
      if (players.some((p) => !p)) return null;
      return { t: 'lobby', players, settings: isObject(msg.settings) ? msg.settings : {}, code: cleanText(msg.code, 16) };
    }
    case 'start':
      if (!isInt(msg.seq, 0, 1e9) || !isInt(msg.you, 0, 16) || !isObject(msg.snapshot)) return null;
      return { t: 'start', seq: msg.seq, you: msg.you, snapshot: msg.snapshot };
    case 'cmd':
      if (!isInt(msg.seq, 1, 1e9) || !isObject(msg.cmd) || typeof msg.cmd.type !== 'string') return null;
      return { t: 'cmd', seq: msg.seq, cmd: msg.cmd };
    case 'sync':
      if (!isInt(msg.seq, 0, 1e9) || typeof msg.hash !== 'string' || msg.hash.length > 32) return null;
      return { t: 'sync', seq: msg.seq, hash: msg.hash };
    case 'snapshot': {
      if (!isInt(msg.id, 0, 1e9) || !isInt(msg.total, 1, MAX_SNAPSHOT_PARTS) || !isInt(msg.part, 0, msg.total - 1)) return null;
      if (typeof msg.data !== 'string' || msg.data.length > SNAPSHOT_CHUNK + 16) return null;
      if (msg.part === 0 && !isInt(msg.seq, 0, 1e9)) return null;
      return { t: 'snapshot', id: msg.id, part: msg.part, total: msg.total, seq: msg.seq, data: msg.data };
    }
    case 'aim':
      if (!isInt(msg.playerId, 0, 16) || !isNum(msg.angle, 0, 180) || !isNum(msg.power, 0, MAX_POWER)) return null;
      return { t: 'aim', playerId: msg.playerId, angle: msg.angle, power: msg.power, weaponId: WEAPON_IDS.includes(msg.weaponId) ? msg.weaponId : 'baby' };
    case 'chat': {
      const text = cleanText(msg.text, MAX_CHAT);
      if (!text) return null;
      return { t: 'chat', name: cleanText(msg.name, MAX_NAME), color: typeof msg.color === 'string' && /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#cccccc', text, system: msg.system === true };
    }
    case 'ready':
      return isInt(msg.playerId, 0, 16) ? { t: 'ready', playerId: msg.playerId, ready: msg.ready !== false } : null;
    case 'error':
      return { t: 'error', reason: cleanText(msg.reason, 200) };
    case 'pong':
      return isInt(msg.id, 0, 1e9) ? { t: 'pong', id: msg.id } : null;
    case 'end':
      return { t: 'end', reason: cleanText(msg.reason, 200) };
    default:
      return null;
  }
}

/** A token bucket: allows bursts of `burst` messages and `rate` per second on average. */
export class RateLimiter {
  constructor(rate = 25, burst = 50, now = () => Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.now = now;
    this.last = now();
    this.dropped = 0;
  }

  allow() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    this.dropped++;
    return false;
  }
}
