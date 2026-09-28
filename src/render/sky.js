// Sky themes: a pre-rendered backdrop (gradient, sun or moon, far hills) plus a few things that
// move every frame: twinkling stars, drifting clouds, rain and lightning.
import { HEIGHT, WIDTH } from '../core/constants.js';
import { Rng } from '../core/rng.js';
import { makeCanvas } from './terrainLayer.js';

const THEMES = {
  day: {
    stops: [[0, '#2a78c8'], [0.5, '#6db6ee'], [1, '#d4efff']],
    far: 'rgba(120,170,205,0.55)',
    near: 'rgba(95,145,180,0.6)',
    cloud: [255, 255, 255, 0.9],
    clouds: 6,
  },
  sunset: {
    stops: [[0, '#1b1242'], [0.32, '#5d2a6e'], [0.62, '#d4506a'], [0.86, '#ff9a55'], [1, '#ffd08a']],
    far: 'rgba(150,70,110,0.55)',
    near: 'rgba(95,45,90,0.65)',
    cloud: [255, 176, 150, 0.6],
    clouds: 5,
  },
  night: {
    stops: [[0, '#02040c'], [0.55, '#0a1330'], [1, '#1c2c56']],
    far: 'rgba(30,44,80,0.8)',
    near: 'rgba(20,30,58,0.85)',
    cloud: [110, 130, 180, 0.16],
    clouds: 3,
  },
  storm: {
    stops: [[0, '#10141b'], [0.55, '#2b3441'], [1, '#56606d']],
    far: 'rgba(58,66,80,0.8)',
    near: 'rgba(42,48,60,0.85)',
    cloud: [36, 42, 52, 0.92],
    clouds: 9,
  },
};

function silhouette(ctx, rng, baseY, amplitude, color) {
  const waves = [0, 1, 2].map((i) => ({
    amp: (amplitude / (i + 1)) * rng.range(0.6, 1),
    freq: rng.range(1.5, 3.5) * (i + 1),
    phase: rng.range(0, Math.PI * 2),
  }));
  ctx.beginPath();
  ctx.moveTo(0, HEIGHT);
  for (let x = 0; x <= WIDTH; x += 8) {
    let y = baseY;
    for (const w of waves) y += w.amp * Math.sin((x / WIDTH) * w.freq * Math.PI + w.phase);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(WIDTH, HEIGHT);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function cloudSprite(rng, [r, g, b, a], scale) {
  const w = Math.round(200 * scale);
  const h = Math.round(80 * scale);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const puffs = 6 + rng.int(5);
  for (let i = 0; i < puffs; i++) {
    const px = w * rng.range(0.2, 0.8);
    const py = h * rng.range(0.45, 0.7);
    const pr = h * rng.range(0.22, 0.42);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
    grad.addColorStop(0, `rgba(${r},${g},${b},${a})`);
    grad.addColorStop(0.6, `rgba(${r},${g},${b},${a * 0.7})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
  }
  return canvas;
}

export class Sky {
  constructor() {
    this.canvas = makeCanvas(WIDTH, HEIGHT);
    this.ctx = this.canvas.getContext('2d');
    this.key = null;
    this.theme = 'day';
    this.stars = [];
    this.clouds = [];
    this.rain = [];
    this.lightning = 0;
    this.nextLightning = 4;
    this.bolt = null;
  }

  prepare(theme, seed) {
    const key = `${theme}:${seed}`;
    if (key === this.key) return;
    this.key = key;
    this.theme = THEMES[theme] ? theme : 'day';
    const t = THEMES[this.theme];
    const rng = new Rng(seed ^ 0x5eed);
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    for (const [at, color] of t.stops) grad.addColorStop(at, color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    if (this.theme === 'day') this.drawSun(ctx, rng.range(860, 1180), rng.range(80, 140), 34, '#fff7c2', 'rgba(255,240,170,');
    if (this.theme === 'sunset') this.drawSun(ctx, rng.range(200, 1080), rng.range(430, 520), 78, '#ffd27a', 'rgba(255,150,80,');
    if (this.theme === 'night') this.drawMoon(ctx, rng.range(120, 1160), rng.range(70, 150), rng);

    silhouette(ctx, rng, HEIGHT * 0.52, 70, t.far);
    silhouette(ctx, rng, HEIGHT * 0.62, 55, t.near);

    this.stars = [];
    if (this.theme === 'night' || this.theme === 'sunset') {
      const count = this.theme === 'night' ? 170 : 40;
      for (let i = 0; i < count; i++) {
        this.stars.push({
          x: rng.range(0, WIDTH),
          y: rng.range(0, this.theme === 'night' ? HEIGHT * 0.62 : HEIGHT * 0.25),
          r: rng.chance(0.12) ? 1.8 : rng.range(0.7, 1.3),
          phase: rng.range(0, Math.PI * 2),
          speed: rng.range(0.8, 3.2),
        });
      }
    }
    this.clouds = [];
    for (let i = 0; i < t.clouds; i++) {
      const scale = rng.range(0.7, 1.5) * (this.theme === 'storm' ? 1.5 : 1);
      this.clouds.push({
        sprite: cloudSprite(rng, t.cloud, scale),
        x: rng.range(-200, WIDTH),
        y: rng.range(this.theme === 'storm' ? -30 : 40, this.theme === 'storm' ? 140 : 260),
        speed: rng.range(0.4, 1.2),
      });
    }
    this.rain = [];
    if (this.theme === 'storm') {
      for (let i = 0; i < 160; i++) {
        this.rain.push({ x: rng.range(0, WIDTH), y: rng.range(0, HEIGHT), len: rng.range(8, 18), speed: rng.range(500, 800) });
      }
    }
  }

  drawSun(ctx, x, y, r, core, glow) {
    const halo = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 4);
    halo.addColorStop(0, `${glow}0.55)`);
    halo.addColorStop(1, `${glow}0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  drawMoon(ctx, x, y, rng) {
    const halo = ctx.createRadialGradient(x, y, 10, x, y, 110);
    halo.addColorStop(0, 'rgba(200,215,255,0.28)');
    halo.addColorStop(1, 'rgba(200,215,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(x - 110, y - 110, 220, 220);
    ctx.fillStyle = '#e8ecf5';
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(160,170,190,0.55)';
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.arc(x + rng.range(-14, 14), y + rng.range(-14, 14), rng.range(2.5, 6), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Draws the sky. `wind` nudges clouds and rain; `dt` is the frame time in seconds. */
  draw(ctx, time, dt, wind) {
    ctx.drawImage(this.canvas, 0, 0, WIDTH, HEIGHT);
    if (this.stars.length) {
      ctx.fillStyle = '#fffff0';
      for (const star of this.stars) {
        ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(time * star.speed + star.phase));
        ctx.fillRect(star.x, star.y, star.r, star.r);
      }
      ctx.globalAlpha = 1;
    }
    for (const cloud of this.clouds) {
      cloud.x += (cloud.speed * 6 + wind * 2.2) * dt;
      const w = cloud.sprite.width;
      if (cloud.x > WIDTH + 20) cloud.x = -w - 20;
      if (cloud.x < -w - 40) cloud.x = WIDTH + 10;
      ctx.drawImage(cloud.sprite, cloud.x, cloud.y);
    }
    if (this.theme === 'storm') this.drawStorm(ctx, dt, wind);
  }

  drawStorm(ctx, dt, wind) {
    ctx.strokeStyle = 'rgba(170,190,220,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const slant = wind * 0.9;
    for (const drop of this.rain) {
      drop.y += drop.speed * dt;
      drop.x += slant * 12 * dt;
      if (drop.y > HEIGHT) {
        drop.y = -20;
        drop.x = Math.random() * WIDTH;
      }
      if (drop.x < 0) drop.x += WIDTH;
      if (drop.x > WIDTH) drop.x -= WIDTH;
      ctx.moveTo(drop.x, drop.y);
      ctx.lineTo(drop.x + slant * 0.6, drop.y + drop.len);
    }
    ctx.stroke();

    this.nextLightning -= dt;
    if (this.nextLightning <= 0) {
      this.nextLightning = 3 + Math.random() * 7;
      this.lightning = 1;
      this.bolt = this.makeBolt();
    }
    if (this.lightning > 0) {
      if (this.bolt && this.lightning > 0.6) {
        ctx.strokeStyle = `rgba(235,240,255,${this.lightning.toFixed(2)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.bolt[0], this.bolt[1]);
        for (let i = 2; i < this.bolt.length; i += 2) ctx.lineTo(this.bolt[i], this.bolt[i + 1]);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(210,220,255,${(this.lightning * 0.22).toFixed(3)})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      this.lightning = Math.max(0, this.lightning - dt * 3);
    }
  }

  makeBolt() {
    const points = [];
    let x = 100 + Math.random() * (WIDTH - 200);
    let y = 0;
    points.push(x, y);
    while (y < HEIGHT * 0.45) {
      x += (Math.random() - 0.5) * 50;
      y += 20 + Math.random() * 30;
      points.push(x, y);
    }
    return points;
  }
}
