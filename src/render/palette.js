// Colors for terrain materials. Each ground theme defines a topsoil color and seven strata
// colors; every one gets eight shades. The sky theme tints the whole palette (night is dark
// and blue, sunset warm, storms grey), so the same ground reads right under any sky.
import { LAYERS, LOOSE, MATERIALS, SCORCHED, SHADES, STRATA } from '../core/terrain.js';

export const GROUND_THEMES = [
  { name: 'meadow', layers: ['#5dbb3f', '#8a5a2b', '#9c6b35', '#7d4f26', '#b07c42', '#6e4521', '#a06a3a', '#835630'], loose: '#8f6436' },
  { name: 'desert', layers: ['#e9c07a', '#d9853b', '#c4622d', '#e0a054', '#b5542a', '#d27a3c', '#a94a26', '#cf8e4a'], loose: '#d59a55' },
  { name: 'tundra', layers: ['#f2f6fb', '#8a94a3', '#6f7a8c', '#9aa4b4', '#5f6b7d', '#7e8a9c', '#687386', '#8f99a9'], loose: '#b8c2cf' },
  { name: 'alien', layers: ['#b36bff', '#3f8f8a', '#2f6f7a', '#4ba39a', '#5a3f8f', '#357f86', '#6a4aa0', '#2c6570'], loose: '#5f8f9a' },
  { name: 'volcanic', layers: ['#4a4040', '#2e2626', '#5a2a22', '#3a302e', '#6e2e20', '#302828', '#7a3a24', '#3c3232'], loose: '#5a4a44' },
  { name: 'autumn', layers: ['#d8752f', '#7a4a2c', '#8e5a34', '#6c3f26', '#a36b3e', '#5f3822', '#946040', '#7c4c30'], loose: '#8a5a38' },
];

export const SKY_TINTS = {
  day: { mul: [1, 1, 1], add: [0, 0, 0] },
  sunset: { mul: [1.02, 0.84, 0.74], add: [18, 4, 10] },
  night: { mul: [0.42, 0.46, 0.62], add: [0, 2, 14] },
  storm: { mul: [0.62, 0.66, 0.72], add: [4, 6, 10] },
};

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Builds an RGBA palette (as little-endian Uint32 pixels for ImageData) for a ground and sky. */
export function buildPalette(groundIndex, sky) {
  const theme = GROUND_THEMES[groundIndex % GROUND_THEMES.length];
  const tint = SKY_TINTS[sky] ?? SKY_TINTS.day;
  const rgba = new Uint32Array(256);
  const css = new Array(256).fill('rgba(0,0,0,0)');
  const set = (index, [r, g, b]) => {
    const rr = clampByte(r * tint.mul[0] + tint.add[0]);
    const gg = clampByte(g * tint.mul[1] + tint.add[1]);
    const bb = clampByte(b * tint.mul[2] + tint.add[2]);
    rgba[index] = (255 << 24) | (bb << 16) | (gg << 8) | rr;
    css[index] = `rgb(${rr},${gg},${bb})`;
  };
  const shadeFactor = (shade) => 0.8 + shade * 0.05; // 0.8 … 1.15
  for (let layer = 0; layer < LAYERS; layer++) {
    const base = hexToRgb(theme.layers[layer]);
    for (let shade = 0; shade < SHADES; shade++) {
      const f = shadeFactor(shade);
      set(STRATA + layer * SHADES + shade, base.map((c) => c * f));
    }
  }
  for (let shade = 0; shade < SHADES; shade++) {
    const f = shadeFactor(shade);
    set(SCORCHED + shade, [38 * f, 30 * f, 26 * f]);
    set(LOOSE + shade, hexToRgb(theme.loose).map((c) => c * f));
  }
  for (let i = MATERIALS; i < 256; i++) set(i, [80, 70, 60]);
  rgba[0] = 0;
  return { rgba, css };
}
