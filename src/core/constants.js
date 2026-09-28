// Tunable simulation constants. Units are logical pixels, ticks (1/60 s) and seconds.
// Everything in src/core is deterministic and DOM-free: the same commands produce the same
// state, bit for bit, in every browser and in Node.

export const WIDTH = 1280;
export const HEIGHT = 720;
export const TICKS_PER_SECOND = 60;
export const DT = 1 / TICKS_PER_SECOND;

/** Gravity in px/s² for each setting. */
export const GRAVITY = { low: 190, normal: 300, high: 450 };

/** Launch speed (px/s) per point of power. Max power at 45° with no wind crosses the map. */
export const SPEED_PER_POWER = 0.6;
export const MAX_POWER = 1000;
export const MAX_HEALTH = 100;
/** The classic rule: a tank can't fire harder than health × 10. */
export const POWER_PER_HEALTH = 10;

/** Largest wind (in wind units) for each setting, and the push of one unit in px/s². */
export const WIND_MAX = { off: 0, low: 4, medium: 8, high: 14 };
export const WIND_ACCEL = 5;

export const TANK = {
  halfWidth: 14, // drawn body half-width
  height: 12, // body height above the ground contact row
  pivotY: 12, // barrel pivot height above the ground contact row
  barrel: 17, // barrel length; shells spawn at its tip
  foot: 7, // support footprint half-width
  hitHalfWidth: 13,
  hitTop: 17, // hit box reaches this far above the contact row
  shieldRadius: 27,
  maxClimb: 4, // tallest step (px) a tank can drive up in one pixel of travel
};

export const MIN_TANKS = 2;
export const MAX_TANKS = 6;

export const FALL = {
  maxSpeed: 540, // px/s
  chuteSpeed: 55, // px/s under a parachute
  chuteTrigger: 18, // a parachute opens after falling this far
  safeDistance: 16, // falls shorter than this never hurt
  damagePerPixel: 0.36,
};

export const MOVE_STEP = 10; // px driven per move command
export const FUEL_PER_PIXEL = 1;
export const FUEL_PER_CLIMB = 2; // extra fuel per pixel climbed

export const TIMING = {
  afterShot: 36, // quiet ticks after a shot before the next turn starts
  deathDelay: 26, // ticks between a tank's destruction and its explosion
  maxProjectileAge: 60 * 25, // shells that fly this long are dropped
};

export const DEATH_BLAST = { radius: 48, damage: 45 };

export const WALL_MODES = ['open', 'wrap', 'rubber', 'concrete'];
export const SKY_THEMES = ['day', 'sunset', 'night', 'storm'];
export const TERRAIN_STYLES = ['hills', 'mountains', 'canyons', 'flat'];
export const GROUND_THEMES = 6; // number of dirt palettes the renderer knows

export const DEFAULT_SETTINGS = Object.freeze({
  rounds: 5,
  startCash: 10000,
  wind: 'medium',
  windChange: true,
  gravity: 'normal',
  walls: 'random',
  terrain: 'random',
  sky: 'random',
  talk: true,
  turnTimer: 0,
  volume: 70,
});

export const SETTING_OPTIONS = Object.freeze({
  rounds: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20],
  startCash: [0, 5000, 10000, 20000, 35000, 50000, 100000],
  wind: ['off', 'low', 'medium', 'high'],
  windChange: [true, false],
  gravity: ['low', 'normal', 'high'],
  walls: ['open', 'wrap', 'rubber', 'concrete', 'random'],
  terrain: ['hills', 'mountains', 'canyons', 'flat', 'random'],
  sky: ['day', 'sunset', 'night', 'storm', 'random'],
  talk: [true, false],
  turnTimer: [0, 30, 60, 90],
});

/** Returns a clean settings object: unknown keys dropped, bad values replaced by defaults. */
export function sanitizeSettings(input) {
  const out = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object') return out;
  for (const [key, options] of Object.entries(SETTING_OPTIONS)) {
    if (options.includes(input[key])) out[key] = input[key];
  }
  const volume = Number(input.volume);
  if (Number.isFinite(volume)) out.volume = Math.max(0, Math.min(100, Math.round(volume)));
  return out;
}

export const TANK_COLORS = [
  '#e8453c', // red
  '#3d8bff', // blue
  '#45d16b', // green
  '#ffc233', // yellow
  '#c46bff', // purple
  '#ff8a2b', // orange
  '#35e0e0', // cyan
  '#ff6fb5', // pink
];

export const AI_LEVELS = ['rookie', 'gunner', 'spotter', 'cyborg'];
export const AI_CHOICES = ['rookie', 'gunner', 'spotter', 'cyborg', 'random'];

export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
