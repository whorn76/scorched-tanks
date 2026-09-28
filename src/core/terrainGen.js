// Round setup that only the authority (the local game or the online host) runs. It may use
// trig and floating-point noise freely because its output (an integer height map, tank
// positions and a few choices) is sent to every client instead of being recomputed.
import { GROUND_THEMES, HEIGHT, SKY_THEMES, TERRAIN_STYLES, WALL_MODES, WIDTH, WIND_MAX } from './constants.js';

const TOP_LIMIT = 150; // keep some sky above the highest peak
const BOTTOM_LIMIT = HEIGHT - 40;
const PAD_HALF = 18;

function clampHeights(values, width) {
  const heights = new Int16Array(width);
  for (let x = 0; x < width; x++) {
    const v = Math.round(values[x]);
    heights[x] = v < TOP_LIMIT ? TOP_LIMIT : v > BOTTOM_LIMIT ? BOTTOM_LIMIT : v;
  }
  return heights;
}

function smooth(values, radius) {
  const out = new Float64Array(values.length);
  for (let x = 0; x < values.length; x++) {
    let sum = 0;
    let n = 0;
    for (let d = -radius; d <= radius; d++) {
      const i = x + d;
      if (i < 0 || i >= values.length) continue;
      sum += values[i];
      n++;
    }
    out[x] = sum / n;
  }
  return out;
}

function hills(rng, width, height) {
  const base = height * rng.range(0.5, 0.64);
  const waves = [];
  for (let i = 0; i < 4; i++) {
    waves.push({
      amp: rng.range(30, 80) / (i + 1),
      freq: (rng.range(0.7, 1.5) * (i + 1) * 2 * Math.PI) / width,
      phase: rng.range(0, Math.PI * 2),
    });
  }
  const values = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    let h = base;
    for (const w of waves) h += w.amp * Math.sin(w.freq * x + w.phase);
    values[x] = h;
  }
  return values;
}

function mountains(rng, width, height) {
  const size = 1024;
  const points = new Float64Array(size + 1);
  points[0] = height * rng.range(0.35, 0.7);
  points[size] = height * rng.range(0.35, 0.7);
  let displacement = height * 0.42;
  for (let step = size; step > 1; step /= 2) {
    const half = step / 2;
    for (let i = half; i < size; i += step) {
      points[i] = (points[i - half] + points[i + half]) / 2 + rng.range(-displacement, displacement);
    }
    displacement *= 0.56;
  }
  const values = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const t = (x / (width - 1)) * size;
    const i = Math.min(size - 1, Math.floor(t));
    const f = t - i;
    values[x] = points[i] * (1 - f) + points[i + 1] * f + 40;
  }
  return smooth(values, 2);
}

function canyons(rng, width, height) {
  const plateau = height * rng.range(0.36, 0.46);
  const values = new Float64Array(width);
  const phase = rng.range(0, Math.PI * 2);
  for (let x = 0; x < width; x++) values[x] = plateau + 14 * Math.sin((x / width) * 7 + phase);
  const count = rng.intRange(1, 3);
  for (let v = 0; v < count; v++) {
    const center = width * rng.range(0.15, 0.85);
    const half = rng.range(80, 200);
    const depth = rng.range(150, 300);
    for (let x = Math.max(0, Math.floor(center - half)); x < Math.min(width, Math.ceil(center + half)); x++) {
      const t = (x - center) / half;
      values[x] += depth * (0.5 + 0.5 * Math.cos(Math.PI * t)) ** 0.8;
    }
  }
  return smooth(values, 3);
}

function flat(rng, width, height) {
  const base = height * rng.range(0.6, 0.72);
  const amp = rng.range(4, 12);
  const freq = rng.range(3, 7);
  const phase = rng.range(0, Math.PI * 2);
  const values = new Float64Array(width);
  for (let x = 0; x < width; x++) values[x] = base + amp * Math.sin((x / width) * freq * Math.PI * 2 + phase);
  return values;
}

const GENERATORS = { hills, mountains, canyons, flat };

export function generateHeights(style, rng, width = WIDTH, height = HEIGHT) {
  const generator = GENERATORS[style] ?? hills;
  return clampHeights(generator(rng, width, height), width);
}

/** Spreads `count` tanks across the map with some jitter, then shuffles who stands where. */
export function placeTanks(count, rng, width = WIDTH) {
  const margin = 50;
  const slot = (width - margin * 2) / count;
  const xs = [];
  for (let i = 0; i < count; i++) {
    xs.push(Math.round(margin + slot * (i + 0.5) + rng.range(-slot * 0.22, slot * 0.22)));
  }
  return rng.shuffle(xs);
}

/** Levels a pad under each tank and blends it into the surrounding ground. */
export function flattenPads(heights, xs, half = PAD_HALF) {
  const blend = 10;
  for (const x of xs) {
    let sum = 0;
    let n = 0;
    for (let d = -half; d <= half; d++) {
      const i = x + d;
      if (i < 0 || i >= heights.length) continue;
      sum += heights[i];
      n++;
    }
    const pad = Math.round(sum / n);
    for (let d = -half - blend; d <= half + blend; d++) {
      const i = x + d;
      if (i < 0 || i >= heights.length) continue;
      const t = Math.min(1, Math.max(0, (Math.abs(d) - half) / blend));
      heights[i] = Math.round(pad * (1 - t) + heights[i] * t);
    }
  }
  return heights;
}

/**
 * Everything random about a new round, decided once by the authority. The result is plain data
 * (the heights are an Int16Array) and becomes the payload of a `newRound` command.
 */
export function planRound({ settings, tankCount, round, rng }) {
  const style = settings.terrain === 'random' ? rng.pick(TERRAIN_STYLES) : settings.terrain;
  const heights = generateHeights(style, rng);
  const xs = placeTanks(tankCount, rng);
  flattenPads(heights, xs);
  const windMax = WIND_MAX[settings.wind] ?? 0;
  return {
    round,
    style,
    heights,
    xs,
    colorSeed: rng.nextU32(),
    seed: rng.nextU32(),
    ground: rng.int(GROUND_THEMES),
    sky: settings.sky === 'random' ? rng.pick(SKY_THEMES) : settings.sky,
    walls: settings.walls === 'random' ? rng.pick(WALL_MODES) : settings.walls,
    wind: windMax ? rng.intRange(-windMax, windMax) : 0,
    first: rng.int(tankCount),
  };
}
