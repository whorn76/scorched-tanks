// Full-state snapshots, used to start guests and to repair a guest that fell out of sync.
// The terrain is stored as the difference from the round's freshly generated ground, which is
// mostly zeros, so it compresses to a few kilobytes.
import { GROUND_THEMES, HEIGHT, MAX_TANKS, MIN_TANKS, SKY_THEMES, TERRAIN_STYLES, WALL_MODES, WIDTH, WIND_MAX, sanitizeSettings } from './constants.js';
import { Game, CORE_VERSION, Phase, emptyStock } from './game.js';
import { Rng } from './rng.js';
import { Terrain } from './terrain.js';
import { STOCK_IDS, isWeapon } from './weapons.js';
import { base64ToBytes, base64ToInt16, bytesToBase64, int16ToBase64, zeroRunDecode, zeroRunEncode } from './bytes.js';
import { deflateBytes, inflateBytes } from './compress.js';

function baseTerrain(roundInfo) {
  const terrain = new Terrain(WIDTH, HEIGHT);
  if (roundInfo) terrain.fillFromHeights(roundInfo.heights, roundInfo.colorSeed);
  return terrain;
}

/** Serializes a game at rest into a JSON-safe object. */
export async function makeSnapshot(game) {
  const s = game.state;
  const { rng, roundInfo, ...rest } = s;
  const plain = JSON.parse(JSON.stringify(rest));
  plain.rng = rng.state;
  const info = roundInfo ? { heights: int16ToBase64(roundInfo.heights), colorSeed: roundInfo.colorSeed } : null;
  const base = baseTerrain(roundInfo);
  const diff = new Uint8Array(game.terrain.data.length);
  const current = game.terrain.data;
  for (let i = 0; i < diff.length; i++) diff[i] = current[i] ^ base.data[i];
  const packed = zeroRunEncode(diff);
  const { method, data } = await deflateBytes(packed);
  return {
    v: CORE_VERSION,
    state: plain,
    roundInfo: info,
    terrain: { method, packedLength: packed.length, data: bytesToBase64(data) },
  };
}

function checkTank(t, i) {
  if (!t || typeof t !== 'object' || t.id !== i) throw new Error('bad tank');
  for (const key of ['x', 'y', 'health', 'angle', 'power', 'money', 'shield', 'vy', 'fallFrom']) {
    if (typeof t[key] !== 'number' || !Number.isFinite(t[key])) throw new Error(`bad tank ${key}`);
  }
  const stock = emptyStock();
  for (const id of STOCK_IDS) {
    const v = t.stock?.[id];
    stock[id] = Number.isInteger(v) && v >= 0 ? v : 0;
  }
  t.stock = stock;
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const stats = t.stats ?? {};
  t.stats = { kills: count(stats.kills), damage: count(stats.damage), wins: count(stats.wins), deaths: count(stats.deaths), selfDamage: count(stats.selfDamage) };
  const round = t.round ?? {};
  t.round = { damage: count(round.damage), kills: count(round.kills), earned: count(round.earned) };
  for (const key of ['dying', 'killer', 'lastHitBy', 'lastDamagedBy', 'moving', 'moveDir', 'burn']) {
    if (typeof t[key] !== 'number' || !Number.isFinite(t[key])) t[key] = key === 'killer' || key.startsWith('last') ? -1 : 0;
  }
  if (!isWeapon(t.weapon)) t.weapon = 'baby';
  t.name = String(t.name ?? '').slice(0, 16);
  t.color = String(t.color ?? '#ffffff').slice(0, 16);
  return t;
}

/** Rebuilds a Game from a snapshot. Throws if the snapshot is malformed. */
export async function loadSnapshot(snap) {
  if (!snap || snap.v !== CORE_VERSION || !snap.state || !snap.terrain) throw new Error('bad snapshot');
  const state = snap.state;
  if (!Object.values(Phase).includes(state.phase) || state.phase === Phase.BUSY) throw new Error('bad phase');
  if (!Array.isArray(state.tanks) || state.tanks.length < MIN_TANKS || state.tanks.length > MAX_TANKS) {
    throw new Error('bad tanks');
  }
  state.tanks = state.tanks.map(checkTank);
  // Snapshots are only taken while the world is at rest, so nothing can be in flight.
  state.projectiles = [];
  state.explosions = [];
  state.napalm = [];
  state.deaths = Array.isArray(state.deaths) ? state.deaths.filter((id) => Number.isInteger(id) && id >= 0 && id < state.tanks.length) : [];
  for (const key of ['round', 'turnId', 'tick', 'quiet', 'quietNeeded', 'nextId', 'roundTurns']) {
    if (!Number.isInteger(state[key]) || state[key] < 0) state[key] = 0;
  }
  if (!Number.isInteger(state.active) || state.active < -1 || state.active >= state.tanks.length) state.active = 0;
  const windMax = WIND_MAX[sanitizeSettings(state.settings).wind] ?? 0;
  if (!Number.isInteger(state.wind) || Math.abs(state.wind) > windMax) state.wind = 0;
  if (!WALL_MODES.includes(state.walls)) state.walls = 'open';
  if (!SKY_THEMES.includes(state.sky)) state.sky = 'day';
  if (!TERRAIN_STYLES.includes(state.style)) state.style = 'hills';
  if (!Number.isInteger(state.ground) || state.ground < 0 || state.ground >= GROUND_THEMES) state.ground = 0;
  state.pendingTurnEnd = state.pendingTurnEnd === true;
  state.lastShot = null;
  if (!state.results || typeof state.results !== 'object' || !Array.isArray(state.results.earnings)) state.results = null;
  const settings = sanitizeSettings(state.settings);
  state.settings = settings;
  state.rng = new Rng(state.rng >>> 0);
  state.roundInfo = snap.roundInfo
    ? { heights: base64ToInt16(snap.roundInfo.heights), colorSeed: snap.roundInfo.colorSeed >>> 0 }
    : null;
  if (state.roundInfo && state.roundInfo.heights.length !== WIDTH) throw new Error('bad heights');

  const { method, packedLength, data } = snap.terrain;
  const total = WIDTH * HEIGHT;
  if (!Number.isInteger(packedLength) || packedLength < 0 || packedLength > total * 2) throw new Error('bad terrain');
  const packed = await inflateBytes(base64ToBytes(data), method, packedLength);
  const diff = zeroRunDecode(packed, total);
  const terrain = baseTerrain(state.roundInfo);
  const pixels = terrain.data;
  for (let i = 0; i < total; i++) pixels[i] ^= diff[i];
  terrain.resetSettling();
  terrain.fullDirty = true;
  return new Game(state, terrain);
}
