// The terrain bitmap mirrored into an offscreen canvas. Only the rectangles the simulation
// marked dirty are converted to pixels and uploaded, so explosions and falling dirt stay cheap.
import { HEIGHT, WIDTH } from '../core/constants.js';

export function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export class TerrainLayer {
  constructor() {
    this.canvas = makeCanvas(WIDTH, HEIGHT);
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(WIDTH, HEIGHT);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.palette = null;
    this.paletteKey = null;
    this.terrain = null;
    this.uploads = 0; // rectangles uploaded (for the debug overlay)
  }

  /** Brings the canvas up to date with the terrain. */
  update(terrain, palette, paletteKey) {
    if (paletteKey !== this.paletteKey || terrain !== this.terrain) {
      this.palette = palette;
      this.paletteKey = paletteKey;
      this.terrain = terrain;
      terrain.fullDirty = true;
    }
    const { pixels, image, ctx } = this;
    const data = terrain.data;
    const colors = this.palette.rgba;
    terrain.consumeDirty((x, y, w, h) => {
      for (let row = y; row < y + h; row++) {
        let i = row * WIDTH + x;
        const end = i + w;
        for (; i < end; i++) pixels[i] = colors[data[i]];
      }
      ctx.putImageData(image, 0, 0, x, y, w, h);
      this.uploads++;
    });
  }
}
