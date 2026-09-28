// The destructible world: a bitmap with one material byte per pixel (0 = air). Materials are
// palette indices, so the renderer decides the actual colors and the simulation only cares about
// air versus dirt. Unsupported dirt falls straight down, column by column, keeping its color.
import { HEIGHT, WIDTH } from './constants.js';
import { hash3 } from './rng.js';

export const AIR = 0;
export const LAYERS = 8; // layer 0 is topsoil, 1–7 are strata bands
export const SHADES = 8;
export const STRATA = 1; // STRATA + layer * SHADES + shade
export const SCORCHED = STRATA + LAYERS * SHADES; // blackened rim of a crater
export const LOOSE = SCORCHED + SHADES; // dirt added by dirt weapons
export const MATERIALS = LOOSE + SHADES;

const FALL_ACCEL = 5; // settling acceleration, in 1/16 px per tick²
const FALL_MAX = 16 * 9; // settling speed cap: 9 px per tick

export const shadeOf = (material) => (material - 1) % SHADES;

/** Texture noise for a pixel: blotchy 0–7 values, integer math only. */
export function shadeNoise(x, y, seed) {
  const coarse = hash3(x >> 2, y >> 2, seed ^ 0x51ed) & 3;
  const fine = hash3(x, y, seed ^ 0xa5a5) & 7;
  return coarse + (fine >> 1); // 0..6, weighted to the middle
}

export class Terrain {
  constructor(width = WIDTH, height = HEIGHT) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
    this.active = new Uint8Array(width); // columns that may hold floating dirt
    this.activeCount = 0;
    this.fallSpeed = new Int32Array(width);
    this.fallAcc = new Int32Array(width);
    // Dirty bookkeeping for the renderer (not part of the game state).
    this.dirtyTop = new Int16Array(width).fill(height);
    this.dirtyBottom = new Int16Array(width).fill(-1);
    this.dirtyMinX = width;
    this.dirtyMaxX = -1;
    this.fullDirty = true;
  }

  get settling() {
    return this.activeCount > 0;
  }

  index(x, y) {
    return y * this.width + x;
  }

  /** Material at a pixel. Below the bottom edge counts as solid bedrock; the sides and sky are air. */
  get(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (y >= this.height) return 255;
    if (x < 0 || x >= this.width || y < 0) return AIR;
    return this.data[y * this.width + x];
  }

  isSolid(x, y) {
    return this.get(x, y) !== AIR;
  }

  /** First solid row in column x at or below `fromY` (height if there's none). */
  groundBelow(x, fromY = 0) {
    x = Math.floor(x);
    if (x < 0 || x >= this.width) return this.height;
    const { data, width, height } = this;
    for (let y = Math.max(0, Math.floor(fromY)); y < height; y++) {
      if (data[y * width + x] !== AIR) return y;
    }
    return height;
  }

  surfaceY(x) {
    return this.groundBelow(x, 0);
  }

  // --- Generation ----------------------------------------------------------------------------

  /** Builds layered, textured ground under a height map. Integer math only (deterministic). */
  fillFromHeights(heights, seed) {
    const { width: W, height: H, data } = this;
    data.fill(AIR);
    const cell = 80;
    const wobble = new Int32Array(W);
    for (let x = 0; x < W; x++) {
      const c = Math.floor(x / cell);
      const f = x - c * cell;
      const a = hash3(c, 17, seed) % 44;
      const b = hash3(c + 1, 17, seed) % 44;
      wobble[x] = a + Math.floor(((b - a) * f) / cell);
    }
    // Strata bands of varying thickness, indexed by a wobbly, partly surface-following depth.
    const span = H + 44 + (H >> 2) + 1;
    const bands = new Uint8Array(span);
    let layer = 1 + (hash3(1, 2, seed) % (LAYERS - 1));
    for (let y = 0, band = 0; y < span; band++) {
      const thickness = 14 + (hash3(band, 5, seed) % 40);
      for (let k = 0; k < thickness && y < span; k++) bands[y++] = layer;
      layer = 1 + ((layer - 1 + 1 + (hash3(band, 9, seed) % (LAYERS - 2))) % (LAYERS - 1));
    }
    for (let x = 0; x < W; x++) {
      const top = Math.max(0, Math.min(H, heights[x] | 0));
      const topsoil = 5 + (hash3(x >> 3, 3, seed) % 4);
      for (let y = top; y < H; y++) {
        const depth = y - top;
        const layerHere = depth < topsoil ? 0 : bands[y + wobble[x] + (depth >> 2)];
        data[y * W + x] = STRATA + layerHere * SHADES + shadeNoise(x, y, seed);
      }
    }
    this.resetSettling();
    this.fullDirty = true;
  }

  resetSettling() {
    this.active.fill(0);
    this.activeCount = 0;
    this.fallSpeed.fill(0);
    this.fallAcc.fill(0);
  }

  // --- Editing -------------------------------------------------------------------------------

  /**
   * Removes a disc of dirt and blackens a thin rim around it. Returns how many pixels were
   * removed and a sample material for debris colors.
   */
  carve(cx, cy, r, rim = 3) {
    const { width: W, height: H, data } = this;
    const outer = r + rim;
    const r2 = r * r;
    const o2 = outer * outer;
    const x0 = Math.max(0, Math.floor(cx - outer));
    const x1 = Math.min(W - 1, Math.ceil(cx + outer));
    const y0 = Math.max(0, Math.floor(cy - outer));
    const y1 = Math.min(H - 1, Math.ceil(cy + outer));
    let removed = 0;
    let sample = AIR;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        const v = data[row + x];
        if (v === AIR) continue;
        const dx = x - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) {
          if (sample === AIR || removed % 97 === 0) sample = v;
          data[row + x] = AIR;
          removed++;
        } else if (d2 <= o2 && (v < SCORCHED || v >= LOOSE)) {
          data[row + x] = SCORCHED + shadeOf(v);
        }
      }
    }
    if (x1 >= x0 && y1 >= y0) {
      this.markDirtyRect(x0, x1, y0, y1);
      this.activate(x0, x1);
    }
    return { removed, material: sample };
  }

  /** Clears dirt in a disc, but only above row `maxY` (the riot charge digs a tank out). */
  carveAbove(cx, cy, r, maxY) {
    const { width: W, data } = this;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.min(Math.ceil(cy + r), maxY - 1));
    let removed = 0;
    let sample = AIR;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (data[i] === AIR) continue;
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) {
          if (sample === AIR) sample = data[i];
          data[i] = AIR;
          removed++;
        }
      }
    }
    if (x1 >= x0 && y1 >= y0) {
      this.markDirtyRect(x0, x1, y0, y1);
      this.activate(x0, x1);
    }
    return { removed, material: sample };
  }

  /** Fills the air inside a disc with loose dirt. Returns the number of pixels added. */
  addDirt(cx, cy, r, seed) {
    const { width: W, height: H, data } = this;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(H - 1, Math.ceil(cy + r));
    let added = 0;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (data[i] !== AIR) continue;
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) {
          data[i] = LOOSE + shadeNoise(x, y, seed);
          added++;
        }
      }
    }
    if (x1 >= x0 && y1 >= y0) {
      this.markDirtyRect(x0, x1, y0, y1);
      this.activate(x0, x1);
    }
    return added;
  }

  /** Blackens one solid pixel (napalm residue). */
  scorch(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    const v = this.data[i];
    if (v === AIR || (v >= SCORCHED && v < LOOSE)) return;
    this.data[i] = SCORCHED + shadeOf(v);
    this.markDirty(x, y, y);
  }

  // --- Settling ------------------------------------------------------------------------------

  activate(x0, x1) {
    x0 = Math.max(0, Math.floor(x0));
    x1 = Math.min(this.width - 1, Math.floor(x1));
    for (let x = x0; x <= x1; x++) {
      if (!this.active[x]) {
        this.active[x] = 1;
        this.activeCount++;
        this.fallSpeed[x] = 0;
        this.fallAcc[x] = 0;
      }
    }
  }

  /**
   * Moves floating dirt down by this tick's fall distance, one column at a time. Each column
   * accelerates while it has floating dirt and goes quiet once everything rests on something.
   * Returns true while any column is still settling.
   */
  settleStep() {
    if (this.activeCount === 0) return false;
    const { width: W, height: H, data, active } = this;
    for (let x = 0; x < W; x++) {
      if (!active[x]) continue;
      let speed = this.fallSpeed[x] + FALL_ACCEL;
      if (speed > FALL_MAX) speed = FALL_MAX;
      this.fallSpeed[x] = speed;
      const acc = this.fallAcc[x] + speed;
      const step = acc >> 4;
      this.fallAcc[x] = acc & 15;

      let floor = H - 1; // lowest free row for the next pixel up
      let floating = false;
      let top = H;
      let bottom = -1;
      for (let y = H - 1; y >= 0; y--) {
        const i = y * W + x;
        const v = data[i];
        if (v === AIR) continue;
        if (y === floor) {
          floor--;
          continue;
        }
        let target = y + step;
        if (target > floor) target = floor;
        if (target !== y) {
          data[target * W + x] = v;
          data[i] = AIR;
          if (y < top) top = y;
          if (target > bottom) bottom = target;
        }
        if (target < floor) floating = true;
        floor = target - 1;
      }
      if (bottom >= 0) this.markDirty(x, top, bottom);
      if (!floating) {
        active[x] = 0;
        this.activeCount--;
        this.fallSpeed[x] = 0;
        this.fallAcc[x] = 0;
      }
    }
    return this.activeCount > 0;
  }

  /** Settles everything instantly (used by tests and tools). */
  settleAll(maxSteps = 10000) {
    let steps = 0;
    while (this.settleStep() && steps < maxSteps) steps++;
    return steps;
  }

  // --- Dirty tracking for the renderer -------------------------------------------------------

  markDirty(x, y0, y1) {
    if (y0 < this.dirtyTop[x]) this.dirtyTop[x] = y0;
    if (y1 > this.dirtyBottom[x]) this.dirtyBottom[x] = y1;
    if (x < this.dirtyMinX) this.dirtyMinX = x;
    if (x > this.dirtyMaxX) this.dirtyMaxX = x;
  }

  markDirtyRect(x0, x1, y0, y1) {
    for (let x = x0; x <= x1; x++) this.markDirty(x, y0, y1);
  }

  /**
   * Calls `visit(x, y, w, h)` for rectangles covering everything that changed since the last
   * call, then clears the record. Neighbouring dirty columns are merged into strips.
   */
  consumeDirty(visit, maxStrip = 48) {
    if (this.fullDirty) {
      this.fullDirty = false;
      this.clearDirty();
      visit(0, 0, this.width, this.height);
      return;
    }
    if (this.dirtyMaxX < 0) return;
    let x = this.dirtyMinX;
    const end = this.dirtyMaxX;
    while (x <= end) {
      if (this.dirtyBottom[x] < 0) {
        x++;
        continue;
      }
      const start = x;
      let top = this.height;
      let bottom = -1;
      while (x <= end && this.dirtyBottom[x] >= 0 && x - start < maxStrip) {
        if (this.dirtyTop[x] < top) top = this.dirtyTop[x];
        if (this.dirtyBottom[x] > bottom) bottom = this.dirtyBottom[x];
        x++;
      }
      visit(start, top, x - start, bottom - top + 1);
    }
    this.clearDirty();
  }

  clearDirty() {
    if (this.dirtyMaxX >= 0) {
      this.dirtyTop.fill(this.height, this.dirtyMinX, this.dirtyMaxX + 1);
      this.dirtyBottom.fill(-1, this.dirtyMinX, this.dirtyMaxX + 1);
    }
    this.dirtyMinX = this.width;
    this.dirtyMaxX = -1;
  }

  // --- Copies --------------------------------------------------------------------------------

  /** A copy of the pixels only (no settling or dirty state). */
  clone() {
    const copy = new Terrain(this.width, this.height);
    copy.data.set(this.data);
    return copy;
  }
}
