// Draws the game world and the HUD on a canvas. The playfield is a fixed 1280×720 logical space,
// letterboxed to fit the window and rendered at the display's full pixel density. The terrain
// comes from an offscreen canvas that only re-uploads dirty rectangles; everything else is
// vector drawing each frame. Game events (explosions, deaths…) spawn purely visual effects.
import { HEIGHT, MAX_POWER, TANK, WIDTH, WIND_MAX } from '../core/constants.js';
import { Phase, freeDriveZone, suddenDeathIn } from '../core/game.js';
import { FREE_WEAPON, WEAPON_BY_ID } from '../core/weapons.js';
import { LOOSE } from '../core/terrain.js';
import { buildPalette, hexToRgb } from './palette.js';
import { TerrainLayer, makeCanvas } from './terrainLayer.js';
import { Sky } from './sky.js';
import { Effects } from './effects.js';

export const FONT = '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
export const DISPLAY_FONT = '"Arial Black", "Segoe UI Black", Impact, "Helvetica Neue", sans-serif';
export const HUD_HEIGHT = 58;
/** The parts of the top bar that open the weapons & items menu, as [left, right] x ranges. */
export const HUD_ZONES = { health: [216, 298], weapon: [596, 804], items: [1150, 1276] };
const TAU = Math.PI * 2;

/** Which clickable part of the top bar is at (x, y), in game coordinates, or null. */
export function hudZoneAt(x, y) {
  if (y < 0 || y >= HUD_HEIGHT) return null;
  for (const [zone, [left, right]] of Object.entries(HUD_ZONES)) if (x >= left && x < right) return zone;
  return null;
}

/** The local player's aim for `tank` while it's their turn (their own drive included), or null. */
function localAimFor(view, s, tank) {
  const aim = view.aim;
  if (!aim || aim.playerId !== tank.id || s.active !== tank.id) return null;
  return s.phase === Phase.AIM || (s.phase === Phase.BUSY && !s.pendingTurnEnd) ? aim : null;
}

const shade = (hex, f) => {
  const [r, g, b] = hexToRgb(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
};

const formatMoney = (n) => `$${Math.floor(n).toLocaleString('en-US')}`;

// Colors of fire from white-hot (0) to smouldering (1+).
const HEAT = [
  [255, 255, 238],
  [255, 236, 140],
  [255, 170, 50],
  [236, 82, 22],
  [140, 30, 12],
  [60, 14, 8],
];

function hot(t, alpha) {
  const x = Math.max(0, Math.min(HEAT.length - 1.001, t * (HEAT.length - 1)));
  const i = Math.floor(x);
  const f = x - i;
  const a = HEAT[i];
  const b = HEAT[i + 1];
  const c = (k) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgba(${c(0)},${c(1)},${c(2)},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/** Pre-rendered radial glows, drawn scaled instead of building gradients every frame. */
function glowSprite(stops, size = 64) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

const GLOW = {
  fire: glowSprite([[0, 'rgba(255,190,90,0.55)'], [0.5, 'rgba(255,110,30,0.22)'], [1, 'rgba(255,60,0,0)']]),
  white: glowSprite([[0, 'rgba(255,255,235,0.9)'], [0.4, 'rgba(255,245,200,0.35)'], [1, 'rgba(255,240,200,0)']]),
  flame: glowSprite([[0, 'rgba(255,220,130,0.95)'], [0.35, 'rgba(255,120,25,0.6)'], [1, 'rgba(200,40,0,0)']]),
  hotFlame: glowSprite([[0, 'rgba(255,250,200,1)'], [0.35, 'rgba(255,150,40,0.7)'], [1, 'rgba(220,50,0,0)']]),
  shell: glowSprite([[0, 'rgba(255,235,180,0.95)'], [1, 'rgba(255,200,120,0)']]),
  napalmShell: glowSprite([[0, 'rgba(255,160,60,0.95)'], [1, 'rgba(255,90,20,0)']]),
  tracer: glowSprite([[0, 'rgba(140,255,180,0.95)'], [1, 'rgba(80,255,150,0)']]),
  dirt: glowSprite([[0, 'rgba(210,160,100,0.8)'], [1, 'rgba(180,120,70,0)']]),
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrainLayer = new TerrainLayer();
    this.sky = new Sky();
    this.effects = new Effects();
    this.trails = new Map(); // projectile id → { points, weapon, dead }
    this.tracers = []; // lasting tracer paths for this round
    this.roundKey = null;
    this.palette = null;
    this.scale = 1;
    this.viewport = { left: 0, top: 0, width: WIDTH, height: HEIGHT };
    this.fps = 60;
    this.lastFrame = 0;
    this.showDebug = false;
    this.tankFx = new Map(); // tank id → { hit: flash timer, smoke: timer }
    this.bubbles = null; // speech bubbles, set by main.js
    this.resize();
  }

  /** Fit the playfield in the window, letterboxed, at the display's pixel density. */
  resize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / WIDTH, vh / HEIGHT);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssWidth = Math.floor(WIDTH * scale);
    const cssHeight = Math.floor(HEIGHT * scale);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.scale = scale;
    const rect = this.canvas.getBoundingClientRect();
    this.viewport = { left: rect.left, top: rect.top, width: cssWidth, height: cssHeight };
  }

  /** Converts a pointer position (CSS pixels) to logical game coordinates. */
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ((clientX - rect.left) / rect.width) * WIDTH, y: ((clientY - rect.top) / rect.height) * HEIGHT };
  }

  hudZoneAt(x, y) {
    return hudZoneAt(x, y);
  }

  resetRound() {
    this.trails.clear();
    this.tracers = [];
    this.effects.clear();
    this.tankFx.clear();
    this.banner = null;
  }

  prepareRound(state) {
    const key = `${state.round}:${state.roundInfo?.colorSeed ?? 0}:${state.sky}:${state.ground}`;
    if (key === this.roundKey) return;
    this.roundKey = key;
    this.palette = buildPalette(state.ground, state.sky);
    this.sky.prepare(state.sky, state.roundInfo?.colorSeed ?? 7);
    this.resetRound();
  }

  // --- Events --------------------------------------------------------------------------------

  handleEvent(event, game) {
    const s = game.state;
    const fx = this.effects;
    switch (event.type) {
      case 'explosion':
        fx.explosion(event.x, event.y, event.radius, event);
        break;
      case 'carve': {
        const color = this.palette?.css[event.material] ?? '#7a5a3a';
        fx.debris(event.x, event.y, event.radius, color, Math.round(event.removed / 40));
        break;
      }
      case 'riot': {
        const color = this.palette?.css[event.material] ?? '#7a5a3a';
        fx.debris(event.x, event.y, event.radius, color, 60);
        fx.explosion(event.x, event.y, 12, {});
        fx.shake(4);
        break;
      }
      case 'fire': {
        const tank = s.tanks[event.tank];
        const dx = event.x - tank.x;
        const dy = event.y - (tank.y - TANK.pivotY);
        const len = Math.hypot(dx, dy) || 1;
        fx.muzzle(event.x, event.y, dx / len, dy / len);
        break;
      }
      case 'damage': {
        const tank = s.tanks[event.tank];
        fx.damageText(event.tank, tank.x, tank.y - 34, event.amount, '#ff6a5a', 18);
        this.fxFor(event.tank).hit = Math.max(this.fxFor(event.tank).hit, event.amount >= 5 ? 0.35 : 0.12);
        break;
      }
      case 'shieldDamage': {
        const tank = s.tanks[event.tank];
        fx.damageText(event.tank, tank.x, tank.y - 46, event.amount, '#7fd8ff', 15);
        this.fxFor(event.tank).shieldHit = 0.4;
        break;
      }
      case 'shieldBreak': {
        const tank = s.tanks[event.tank];
        fx.sparkle(tank.x, tank.y - 8, '140,220,255', 30);
        break;
      }
      case 'shieldUp':
      case 'battery': {
        const tank = s.tanks[event.tank];
        fx.sparkle(tank.x, tank.y - 10, event.type === 'battery' ? '140,255,160' : '140,220,255', 18);
        if (event.type === 'battery') fx.text(tank.x, tank.y - 34, '+25', '#8dff9a', 17);
        break;
      }
      case 'death': {
        const tank = s.tanks[event.tank];
        fx.text(tank.x, tank.y - 50, 'DESTROYED', '#ffd36a', 16);
        break;
      }
      case 'suddenDeath':
        this.banner = { title: 'SUDDEN DEATH', text: 'Shells fall from the sky after every turn', age: 0 };
        fx.shake(6);
        break;
      case 'round':
        this.resetRound();
        break;
      case 'dirt': {
        const color = this.palette?.css[LOOSE + 4] ?? '#8f6436';
        fx.debris(event.x, event.y, event.radius * 0.6, color, 40);
        fx.shake(event.radius / 16);
        break;
      }
      case 'split':
        fx.sparkle(event.x, event.y, '255,240,180', 20);
        break;
      case 'bounce':
        fx.sparkle(event.x, event.y, '160,255,170', 10);
        break;
      case 'napalm':
        fx.sparkle(event.x, event.y, '255,150,40', 30);
        fx.shake(3);
        break;
      case 'tracerEnd':
        break;
    }
  }

  fxFor(id) {
    let fx = this.tankFx.get(id);
    if (!fx) {
      fx = { hit: 0, shieldHit: 0, smoke: 0 };
      this.tankFx.set(id, fx);
    }
    return fx;
  }

  // --- Frame ---------------------------------------------------------------------------------

  /**
   * view: { session, time, dt, aim, aimGuide, hideHud, dim }
   * `aim` is the local player's unconfirmed aim (angle, power, weaponId) while it's their turn.
   */
  draw(view) {
    const { ctx } = this;
    const now = performance.now();
    if (this.lastFrame) this.fps += (1000 / Math.max(1, now - this.lastFrame) - this.fps) * 0.05;
    this.lastFrame = now;

    const session = view.session;
    const game = session?.game;
    const k = this.canvas.width / WIDTH;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = true;

    if (!game || !game.state.roundInfo) {
      this.drawIdleBackdrop(view.time, view.dt);
      return;
    }
    const s = game.state;
    this.prepareRound(s);
    this.terrainLayer.update(game.terrain, this.palette, this.roundKey);
    this.effects.update(view.dt, s.wind);
    this.updateTrails(s);

    const [sx, sy] = this.effects.shakeOffset();
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    this.sky.draw(ctx, view.time, view.dt, s.wind);
    this.effects.drawBack(ctx);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrainLayer.canvas, 0, 0, WIDTH, HEIGHT);
    ctx.imageSmoothingEnabled = true;

    this.view?.drawUnderTanks?.(ctx, game, view);
    this.drawTracers(ctx);
    this.drawNapalm(ctx, s, view.time);
    this.drawDriveZone(ctx, game, view);
    for (const tank of s.tanks) this.drawTank(ctx, tank, game, session, view);
    this.drawTrails(ctx);
    this.drawProjectiles(ctx, s, view.time);
    this.drawExplosions(ctx, s, view.time);
    this.effects.drawFront(ctx);
    this.drawLabels(ctx, s, session, view);
    this.effects.drawTexts(ctx, FONT);
    if (view.aimGuide) this.drawAimGuide(ctx, view.aimGuide);
    this.bubbles?.draw(ctx, s, view.time);
    this.drawOffscreenMarkers(ctx, s);

    ctx.setTransform(k, 0, 0, k, 0, 0);
    this.effects.drawFlash(ctx, WIDTH, HEIGHT);
    this.drawSuddenDeathGlow(ctx, s, view.time);
    this.drawBanner(ctx, view.dt);
    if (view.dim) {
      ctx.fillStyle = `rgba(6,10,20,${view.dim})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
    if (!view.hideHud) this.drawHud(ctx, session, view);
    if (this.showDebug) this.drawDebug(ctx, game);
  }

  drawIdleBackdrop(time, dt) {
    const { ctx } = this;
    this.sky.prepare('night', 99);
    this.sky.draw(ctx, time, dt, 2);
  }

  // --- World pieces --------------------------------------------------------------------------

  updateTrails(s) {
    const alive = new Set();
    for (const p of s.projectiles) {
      alive.add(p.id);
      let trail = this.trails.get(p.id);
      if (!trail) {
        trail = { points: [], weapon: p.weapon, fade: 1, dead: false };
        this.trails.set(p.id, trail);
      }
      const pts = trail.points;
      const lx = pts[pts.length - 2];
      const ly = pts[pts.length - 1];
      // Break the line across wrap-around jumps.
      if (pts.length && Math.abs(lx - p.x) > WIDTH / 2) pts.push(NaN, NaN);
      pts.push(p.x, p.y);
      if (p.weapon === 'tracer') trail.tracer = true;
      if (!trail.tracer && pts.length > 64) pts.splice(0, pts.length - 64);
    }
    for (const [id, trail] of this.trails) {
      if (alive.has(id)) continue;
      if (trail.tracer) {
        this.tracers.push(trail.points);
        this.trails.delete(id);
        continue;
      }
      trail.dead = true;
      trail.fade -= 0.06;
      if (trail.fade <= 0) this.trails.delete(id);
    }
  }

  drawTrails(ctx) {
    ctx.lineCap = 'round';
    for (const trail of this.trails.values()) {
      const pts = trail.points;
      const n = pts.length / 2;
      if (n < 2) continue;
      for (let i = 1; i < n; i++) {
        const x0 = pts[(i - 1) * 2];
        const y0 = pts[(i - 1) * 2 + 1];
        const x1 = pts[i * 2];
        const y1 = pts[i * 2 + 1];
        if (Number.isNaN(x0) || Number.isNaN(x1)) continue;
        const t = i / n;
        const alpha = t * 0.55 * trail.fade;
        ctx.strokeStyle = trail.tracer ? `rgba(120,255,170,${alpha + 0.2})` : `rgba(255,${Math.round(180 + 60 * t)},${Math.round(120 * t)},${alpha.toFixed(3)})`;
        ctx.lineWidth = trail.tracer ? 1.5 : 1 + t * 2;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }

  drawTracers(ctx) {
    if (!this.tracers.length) return;
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(120,255,170,0.65)';
    for (const pts of this.tracers) {
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i];
        const y = pts[i + 1];
        if (Number.isNaN(x)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawProjectiles(ctx, s, time) {
    for (const p of s.projectiles) {
      if (p.mode === 'roll') {
        this.drawRoller(ctx, p, time);
        continue;
      }
      if (p.mode === 'dig') {
        this.drawDigger(ctx, p);
        continue;
      }
      const weapon = WEAPON_BY_ID[p.weapon];
      const big = weapon?.radius >= 55 || p.kind === 'mirv';
      const r = p.child ? 2.4 : big ? 4.2 : 3;
      const g = r * 3.5;
      if (p.funky || p.kind === 'funky') {
        const hue = `hsla(${Math.round((time * 400 + p.id * 70) % 360)},100%,65%,`;
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, g);
        glow.addColorStop(0, `${hue}0.9)`);
        glow.addColorStop(1, `${hue}0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, g, 0, TAU);
        ctx.fill();
      } else {
        const sprite = p.kind === 'napalm' ? GLOW.napalmShell : p.kind === 'tracer' ? GLOW.tracer : p.kind === 'dirt' ? GLOW.dirt : GLOW.shell;
        ctx.drawImage(sprite, p.x - g, p.y - g, g * 2, g * 2);
      }
      ctx.fillStyle = p.kind === 'dirt' ? '#b98a55' : '#fff8e8';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.kind === 'dirt' ? r + 1.5 : r, 0, TAU);
      ctx.fill();
    }
  }

  drawRoller(ctx, p, time) {
    const heavy = p.weapon === 'heavyroller';
    const r = heavy ? 5 : 4;
    const x = p.x;
    const y = p.y - r + 1;
    ctx.fillStyle = heavy ? '#5a6275' : '#8a93a8';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#dfe6f3';
    ctx.lineWidth = 1.2;
    const spin = (x / r) * p.dir;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(spin) * r, y + Math.sin(spin) * r);
    ctx.lineTo(x - Math.cos(spin) * r, y - Math.sin(spin) * r);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,90,60,${0.5 + 0.5 * Math.sin(time * 14)})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.4, 0, TAU);
    ctx.fill();
  }

  drawDigger(ctx, p) {
    const len = 7;
    ctx.strokeStyle = '#d8c3a0';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x - p.dx * len, p.y - p.dy * len);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,220,150,0.8)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2, 0, TAU);
    ctx.fill();
  }

  drawExplosions(ctx, s, time = 0) {
    if (!s.explosions.length) return;
    const shapes = [];
    for (const e of s.explosions) {
      const life = e.grow + e.fade;
      let r;
      let fade;
      if (e.age <= e.grow) {
        const t = e.age / e.grow;
        r = e.radius * (0.22 + 0.78 * (1 - (1 - t) * (1 - t)));
        fade = 0;
      } else {
        fade = (e.age - e.grow) / e.fade;
        r = e.radius * (1 - 0.62 * fade * Math.sqrt(fade));
      }
      r *= 1 + 0.045 * Math.sin(time * 47 + e.x * 0.3);
      // Heat runs from white-hot to dull red over the blast's life, with a flicker.
      const heat = Math.min(1, Math.max(0, (e.age / life) * 1.05 + 0.07 * Math.sin(time * 31 + e.y)));
      shapes.push({ e, r: Math.max(1, r), fade, heat });
    }
    // An opaque fiery body first, so blasts read against bright skies too…
    for (const { e, r, fade, heat } of shapes) {
      const alpha = 1 - fade * 0.8;
      const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      grad.addColorStop(0, hot(heat, alpha));
      grad.addColorStop(0.5, hot(heat + 0.2, alpha * 0.95));
      grad.addColorStop(0.82, hot(heat + 0.42, alpha * 0.7));
      grad.addColorStop(1, hot(heat + 0.6, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, TAU);
      ctx.fill();
    }
    // …then light on top.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const { e, r, fade } of shapes) {
      ctx.globalAlpha = (1 - fade) * (e.flash ? 0.8 : 0.45);
      ctx.drawImage(GLOW.fire, e.x - r * 1.9, e.y - r * 1.9, r * 3.8, r * 3.8);
      if (fade < 0.35) {
        ctx.globalAlpha = (0.35 - fade) * 1.6;
        ctx.drawImage(GLOW.white, e.x - r * 0.7, e.y - r * 0.7, r * 1.4, r * 1.4);
      }
      if (e.flash && e.age < e.grow + 8) {
        ctx.globalAlpha = 0.6;
        ctx.drawImage(GLOW.white, e.x - r * 2.8, e.y - r * 2.8, r * 5.6, r * 5.6);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawNapalm(ctx, s, time) {
    if (!s.napalm.length) return;
    // A few embers drift up from the fire each frame.
    for (let i = 0; i < 2; i++) {
      const n = s.napalm[Math.floor(Math.random() * s.napalm.length)];
      if (n.flow) this.effects.ember(n.x, n.y - 4);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const n of s.napalm) {
      const life = Math.min(1, n.life / 60);
      const flicker = 0.72 + 0.28 * Math.sin(time * 19 + n.x * 0.7 + n.y * 1.3);
      const r = (6 + 4 * life) * flicker * (n.heat > 1 ? 1.2 : 1);
      ctx.globalAlpha = 0.85 * life;
      // Flames are taller than they are wide.
      ctx.drawImage(n.heat > 1 ? GLOW.hotFlame : GLOW.flame, n.x - r * 0.8, n.y - 2 - r * 2, r * 1.6, r * 2.4);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  isBuried(terrain, tank) {
    for (const [dx, dy] of [[0, -6], [0, -11], [-6, -5], [6, -5]]) if (terrain.isSolid(tank.x + dx, tank.y + dy)) return true;
    return false;
  }

  /** Where the barrel points for a tank: the local aim, a remote preview, or its last shot. */
  barrelAngle(tank, session, view) {
    const s = session.game.state;
    const local = localAimFor(view, s, tank);
    if (local) return local.angle;
    const preview = session.previews.get(tank.id);
    if (preview && s.active === tank.id) return preview.angle;
    return tank.angle;
  }

  drawTank(ctx, tank, game, session, view) {
    const x = tank.x;
    const y = tank.y;
    const fx = this.tankFx.get(tank.id);
    if (fx) {
      fx.hit = Math.max(0, fx.hit - view.dt);
      fx.shieldHit = Math.max(0, fx.shieldHit - view.dt);
    }
    if (tank.wreck || (!tank.alive && tank.dying === 0)) {
      this.drawWreck(ctx, tank, view);
      return;
    }
    const color = tank.color;
    const dark = shade(color, 0.55);
    const light = shade(color, 1.35);
    const angle = this.barrelAngle(tank, session, view);
    const shaking = !tank.alive && tank.dying > 0 ? (Math.random() - 0.5) * 3 : 0;

    ctx.save();
    ctx.translate(shaking, 0);
    if (tank.chute && tank.falling) this.drawParachute(ctx, x, y, color);

    // Barrel.
    const rad = (angle * Math.PI) / 180;
    const px = x;
    const py = y - TANK.pivotY;
    ctx.strokeStyle = '#2b2f36';
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(rad) * TANK.barrel, py - Math.sin(rad) * TANK.barrel);
    ctx.stroke();
    ctx.strokeStyle = '#8a929e';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(rad) * (TANK.barrel - 1), py - Math.sin(rad) * (TANK.barrel - 1));
    ctx.stroke();

    // Turret dome.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y - 9, 7, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(x - 2, y - 11, 2.5, 0, TAU);
    ctx.fill();

    // Hull.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 13, y - 5);
    ctx.lineTo(x - 10, y - 10);
    ctx.lineTo(x + 10, y - 10);
    ctx.lineTo(x + 13, y - 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = light;
    ctx.fillRect(x - 9, y - 10, 18, 1.6);

    // Tracks.
    ctx.fillStyle = '#23262c';
    ctx.beginPath();
    ctx.roundRect(x - 14, y - 6, 28, 6.5, 3.2);
    ctx.fill();
    ctx.fillStyle = dark;
    for (let i = -10; i <= 10; i += 5) {
      ctx.beginPath();
      ctx.arc(x + i, y - 2.8, 1.7, 0, TAU);
      ctx.fill();
    }

    if (fx?.hit > 0) {
      ctx.globalAlpha = fx.hit / 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 14, y - 16, 28, 16);
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (this.isBuried(game.terrain, tank)) {
      const bx = Math.max(0, x - 18);
      const by = Math.max(0, y - 30);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.terrainLayer.canvas, bx, by, 36, 31, bx, by, 36, 31);
      ctx.imageSmoothingEnabled = true;
    }

    if (tank.shield > 0) this.drawShield(ctx, tank, view.time, fx?.shieldHit ?? 0);
  }

  drawShield(ctx, tank, time, hit) {
    const max = tank.shieldType === 'heavyshield' ? 150 : 60;
    const strength = Math.max(0.25, tank.shield / max);
    const cx = tank.x;
    const cy = tank.y - 8;
    const r = TANK.shieldRadius + Math.sin(time * 3 + tank.id) * 0.8;
    const heavy = tank.shieldType === 'heavyshield';
    const base = heavy ? '190,140,255' : '110,210,255';
    const grad = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r);
    grad.addColorStop(0, `rgba(${base},0)`);
    grad.addColorStop(0.8, `rgba(${base},${(0.12 * strength).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${base},${(0.45 * strength + hit).toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `rgba(${base},${(0.5 * strength + hit).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${(0.35 * strength).toFixed(3)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 4, Math.PI * 1.1 + Math.sin(time) * 0.2, Math.PI * 1.45 + Math.sin(time) * 0.2);
    ctx.stroke();
  }

  drawParachute(ctx, x, y, color) {
    const top = y - 58;
    ctx.strokeStyle = 'rgba(240,240,240,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const dx of [-20, -8, 8, 20]) {
      ctx.moveTo(x + dx, top + 12);
      ctx.lineTo(x + dx * 0.4, y - 12);
    }
    ctx.stroke();
    ctx.fillStyle = '#f4f1e8';
    ctx.beginPath();
    ctx.ellipse(x, top + 12, 24, 16, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = color;
    for (const dx of [-16, 0, 16]) {
      ctx.beginPath();
      ctx.ellipse(x + dx * 0.9, top + 7, 4.5, 8, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawWreck(ctx, tank, view) {
    const x = tank.x;
    const y = tank.y;
    ctx.fillStyle = '#2a2624';
    ctx.beginPath();
    ctx.moveTo(x - 13, y);
    ctx.lineTo(x - 11, y - 7);
    ctx.lineTo(x - 3, y - 9);
    ctx.lineTo(x + 5, y - 6);
    ctx.lineTo(x + 12, y - 8);
    ctx.lineTo(x + 13, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#1a1817';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 1, y - 8);
    ctx.lineTo(x + 9, y - 13);
    ctx.lineTo(x + 14, y - 12);
    ctx.stroke();
    ctx.fillStyle = shade(tank.color, 0.35);
    ctx.fillRect(x - 8, y - 6, 10, 2);
    const fx = this.fxFor(tank.id);
    fx.smoke -= view.dt;
    if (fx.smoke <= 0) {
      fx.smoke = 0.18 + Math.random() * 0.25;
      this.effects.wreckSmoke(x, y - 8);
    }
  }

  drawLabels(ctx, s, session, view) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const tank of s.tanks) {
      if (!tank.alive) continue;
      const x = tank.x;
      const top = tank.y - (tank.shield > 0 ? 44 : 30);
      ctx.font = `600 11px ${FONT}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(tank.name, x, top - 6);
      ctx.fillStyle = '#f4f6fb';
      ctx.fillText(tank.name, x, top - 6);
      const w = 30;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - w / 2 - 1, top - 3, w + 2, 5);
      const hp = tank.health / 100;
      ctx.fillStyle = hp > 0.6 ? '#52e07a' : hp > 0.3 ? '#ffc94a' : '#ff5a4a';
      ctx.fillRect(x - w / 2, top - 2, w * hp, 3);
      if (s.active === tank.id && (s.phase === Phase.AIM || s.phase === Phase.BUSY)) {
        const bob = Math.sin(view.time * 6) * 3;
        const ay = top - 22 + bob;
        ctx.fillStyle = tank.color;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 7, ay);
        ctx.lineTo(x + 7, ay);
        ctx.lineTo(x, ay + 8);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        // An AI that hasn't started swinging its barrel yet is thinking.
        if (s.phase === Phase.AIM && tank.ai && !session.previews.has(tank.id)) this.drawThinking(ctx, x + 18, top - 30, view.time);
      }
    }
  }

  drawThinking(ctx, x, y, time) {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - 2, y - 10, 34, 18, 9);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x - 3, y + 11, 3, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x - 8, y + 17, 1.8, 0, TAU);
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      const up = Math.max(0, Math.sin(time * 7 - i * 0.9)) * 2.5;
      ctx.fillStyle = '#39414f';
      ctx.beginPath();
      ctx.arc(x + 7 + i * 8, y - 1 - up, 2.3, 0, TAU);
      ctx.fill();
    }
  }

  drawAimGuide(ctx, guide) {
    const { x, y, angle, power } = guide;
    const rad = (angle * Math.PI) / 180;
    const len = 40 + (power / MAX_POWER) * 160;
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(rad) * len, y - Math.sin(rad) * len);
    ctx.stroke();
    ctx.restore();
  }

  drawOffscreenMarkers(ctx, s) {
    for (const p of s.projectiles) {
      if (p.y >= HUD_HEIGHT - 4) continue;
      const x = Math.max(12, Math.min(WIDTH - 12, p.x));
      const top = HUD_HEIGHT + 6;
      // Shells falling in sudden death are marked in red.
      ctx.fillStyle = p.sky ? 'rgba(255,90,70,0.95)' : 'rgba(255,220,120,0.95)';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x - 7, top + 11);
      ctx.lineTo(x + 7, top + 11);
      ctx.closePath();
      ctx.fill();
      ctx.font = `600 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = p.sky ? 'rgba(255,170,150,0.95)' : 'rgba(255,230,160,0.95)';
      ctx.fillText(`${Math.round(HUD_HEIGHT - p.y)}`, x, top + 24);
    }
  }

  /** Posts at the two ends of the local player's free drive zone, while it's their turn. */
  drawDriveZone(ctx, game, view) {
    const s = game.state;
    const tank = view.aim ? s.tanks[view.aim.playerId] : null;
    if (!tank?.alive || view.aim.fired || !localAimFor(view, s, tank)) return;
    const [from, to] = freeDriveZone(tank);
    for (const [x, dir] of [[from, 1], [to, -1]]) {
      if (x < TANK.halfWidth || x > WIDTH - 1 - TANK.halfWidth) continue; // past the edge of the map
      const ground = this.surfaceNear(game.terrain, x, tank.y);
      const top = ground - 22;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, ground);
      ctx.lineTo(x, top);
      ctx.stroke();
      ctx.strokeStyle = tank.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      // A small pennant pointing back toward the tank.
      ctx.fillStyle = tank.color;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x + dir * 10, top + 4);
      ctx.lineTo(x, top + 8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

  /** The top of the ground in column x, searching up or down from `nearY`. */
  surfaceNear(terrain, x, nearY) {
    let y = Math.max(0, Math.min(HEIGHT - 1, Math.round(nearY)));
    if (terrain.isSolid(x, y)) {
      while (y > 0 && terrain.isSolid(x, y - 1)) y--;
      return y;
    }
    while (y < HEIGHT && !terrain.isSolid(x, y)) y++;
    return y;
  }

  /** A red glow over the sky while sudden death is on. */
  drawSuddenDeathGlow(ctx, s, time) {
    if (suddenDeathIn(s) !== 0 || (s.phase !== Phase.AIM && s.phase !== Phase.BUSY)) return;
    const strength = 0.16 + Math.sin(time * 2.2) * 0.05;
    const grad = ctx.createLinearGradient(0, 0, 0, 240);
    grad.addColorStop(0, `rgba(255,50,30,${strength.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,50,30,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, 240);
  }

  /** The big "SUDDEN DEATH" announcement: pops in, holds, fades. */
  drawBanner(ctx, dt) {
    const b = this.banner;
    if (!b) return;
    b.age += dt;
    const life = 3.4;
    if (b.age >= life) {
      this.banner = null;
      return;
    }
    const alpha = Math.max(0, Math.min(1, b.age / 0.2, (life - b.age) / 0.6));
    const scale = 1 + Math.max(0, 0.25 - b.age) * 1.6;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(WIDTH / 2, HEIGHT * 0.36);
    ctx.fillStyle = 'rgba(40,4,4,0.55)';
    ctx.fillRect(-WIDTH / 2, -62, WIDTH, 104);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `900 64px ${DISPLAY_FONT}`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(b.title, 0, 4);
    const grad = ctx.createLinearGradient(0, -50, 0, 6);
    grad.addColorStop(0, '#fff1a8');
    grad.addColorStop(0.5, '#ff9a3c');
    grad.addColorStop(1, '#e8331f');
    ctx.fillStyle = grad;
    ctx.fillText(b.title, 0, 4);
    ctx.font = `700 18px ${FONT}`;
    ctx.lineWidth = 4;
    ctx.strokeText(b.text, 0, 32);
    ctx.fillStyle = '#ffe2d0';
    ctx.fillText(b.text, 0, 32);
    ctx.restore();
  }

  // --- HUD -----------------------------------------------------------------------------------

  drawHud(ctx, session, view) {
    const s = session.game.state;
    const tank = s.tanks[s.active];
    ctx.fillStyle = 'rgba(8,12,22,0.72)';
    ctx.fillRect(0, 0, WIDTH, HUD_HEIGHT);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, HUD_HEIGHT - 1, WIDTH, 1);
    if (!tank) return;

    const local = localAimFor(view, s, tank);
    const preview = session.previews.get(tank.id);
    const angle = local?.angle ?? preview?.angle ?? tank.angle;
    const power = local?.power ?? preview?.power ?? tank.power;
    const weaponId = local?.weaponId ?? preview?.weaponId ?? tank.weapon;
    const weapon = WEAPON_BY_ID[weaponId] ?? WEAPON_BY_ID[FREE_WEAPON];

    // On your turn, the weapon, health and items open the weapons & items menu.
    const clickable = !!local && !local.fired;
    if (clickable) {
      const lit = new Set();
      if (view.hud?.hover) lit.add(view.hud.hover);
      if (view.hud?.open) lit.add('weapon');
      for (const zone of lit) {
        const [x0, x1] = HUD_ZONES[zone];
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.strokeStyle = 'rgba(255,211,106,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x0 + 0.5, 4.5, x1 - x0 - 1, HUD_HEIGHT - 9, 8);
        ctx.fill();
        ctx.stroke();
      }
    }

    const label = (text, x, menu = false) => {
      ctx.font = `700 10px ${FONT}`;
      ctx.fillStyle = 'rgba(190,205,230,0.7)';
      ctx.textAlign = 'left';
      ctx.fillText(text, x, 19);
      if (!menu || !clickable) return;
      // A little ▾ says "click me".
      const cx = x + ctx.measureText(text).width + 8;
      ctx.fillStyle = '#ffd36a';
      ctx.beginPath();
      ctx.moveTo(cx - 4, 12);
      ctx.lineTo(cx + 4, 12);
      ctx.lineTo(cx, 17);
      ctx.closePath();
      ctx.fill();
    };
    const value = (text, x, color = '#ffffff', size = 19) => {
      ctx.font = `700 ${size}px ${FONT}`;
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(text, x, 42);
    };
    ctx.textBaseline = 'alphabetic';

    // Player.
    ctx.fillStyle = tank.color;
    ctx.beginPath();
    ctx.roundRect(14, 12, 10, 34, 3);
    ctx.fill();
    ctx.font = `800 17px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    const who = tank.ai ? `${tank.name}` : tank.name;
    ctx.fillText(who, 32, 27, 150);
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = 'rgba(190,205,230,0.8)';
    const role = tank.ai ? `AI · ${tank.ai.charAt(0).toUpperCase()}${tank.ai.slice(1)}` : session.controls(tank.id) ? (session.online ? 'You' : 'Human') : 'Remote player';
    ctx.fillText(role, 32, 42);
    const left = session.turnTimeLeft();
    if (left !== null) {
      ctx.font = `800 15px ${FONT}`;
      ctx.fillStyle = left < 6 ? '#ff6a5a' : '#ffd36a';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.ceil(left)}s`, 212, 42);
    }

    // Health.
    label('HEALTH', 222);
    const hp = tank.health / 100;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(222, 30, 66, 10);
    ctx.fillStyle = hp > 0.6 ? '#52e07a' : hp > 0.3 ? '#ffc94a' : '#ff5a4a';
    ctx.fillRect(222, 30, 66 * hp, 10);
    ctx.font = `700 11px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(`${tank.health}${tank.shield > 0 ? `  +${tank.shield}` : ''}`, 222, 54);

    // Angle.
    label('ANGLE', 304);
    value(`${angle.toFixed(1)}°`, 304);

    // Power.
    label('POWER', 392);
    const barX = 392;
    const barW = 190;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(barX, 28, barW, 12);
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    grad.addColorStop(0, '#ffd36a');
    grad.addColorStop(1, '#ff6a3a');
    ctx.fillStyle = grad;
    ctx.fillRect(barX, 28, (barW * power) / MAX_POWER, 12);
    ctx.font = `700 13px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(power)}`, barX + barW, 19);

    // Weapon.
    label('WEAPON', 604, true);
    const ammo = weapon.id === FREE_WEAPON ? '∞' : `×${tank.stock[weapon.id] ?? 0}`;
    value(weapon.name, 604, '#ffffff', 17);
    ctx.font = `700 13px ${FONT}`;
    ctx.fillStyle = '#ffd36a';
    ctx.textAlign = 'left';
    const nameWidth = Math.min(160, ctx.measureText(weapon.name).width * (17 / 13));
    ctx.fillText(ammo, 604 + nameWidth + 10, 42);

    // Wind.
    label('WIND', 812);
    this.drawWind(ctx, 812, 36, s.wind, WIND_MAX[s.settings.wind] ?? 0);

    // Round.
    label('ROUND', 972);
    value(`${s.round} / ${s.settings.rounds}`, 972);

    // Money.
    label('CASH', 1064);
    value(formatMoney(tank.money), 1064, '#8dff9a', 18);

    // Items, in two short lines.
    label('ITEMS', 1158, true);
    const st = tank.stock;
    const shields = st.shield + st.heavyshield;
    const lines = [
      [shields && `Shield ${shields}`, st.battery && `Batt ${st.battery}`],
      [st.parachute && `Chute ${st.parachute}`, st.fuel && `Fuel ${st.fuel}`],
    ].map((bits) => bits.filter(Boolean).join(' · ')).filter(Boolean);
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = lines.length ? 'rgba(228,235,248,0.92)' : 'rgba(190,205,230,0.5)';
    if (!lines.length) lines.push('None');
    lines.forEach((text, i) => ctx.fillText(text, 1158, (lines.length === 1 ? 38 : 34) + i * 15, WIDTH - 1158 - 6));

    // Sudden death: a countdown for the last few rounds of turns, then a warning.
    const sd = suddenDeathIn(s);
    if (sd !== null && sd <= 3) {
      const text = sd === 0 ? 'SUDDEN DEATH' : `Sudden death in ${sd} ${sd === 1 ? 'turn' : 'turns'}`;
      ctx.font = `800 12px ${FONT}`;
      const w = ctx.measureText(text).width + 24;
      const y = HUD_HEIGHT + 6;
      ctx.fillStyle = sd === 0 ? 'rgba(196,34,24,0.88)' : 'rgba(110,64,10,0.82)';
      ctx.beginPath();
      ctx.roundRect(WIDTH / 2 - w / 2, y, w, 21, 10.5);
      ctx.fill();
      ctx.fillStyle = sd === 0 ? '#ffe8dc' : '#ffd36a';
      ctx.textAlign = 'center';
      ctx.fillText(text, WIDTH / 2, y + 15);
    }
  }

  drawWind(ctx, x, y, wind, max) {
    ctx.font = `700 19px ${FONT}`;
    ctx.textAlign = 'left';
    if (!wind) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(max ? 'Calm' : 'Off', x, y + 6);
      return;
    }
    const dir = Math.sign(wind);
    const len = 22 + (Math.abs(wind) / Math.max(1, max || 14)) * 40;
    const ax = dir > 0 ? x : x + len;
    ctx.strokeStyle = '#9fd8ff';
    ctx.fillStyle = '#9fd8ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ax, y);
    ctx.lineTo(ax + dir * (len - 8), y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax + dir * len, y);
    ctx.lineTo(ax + dir * (len - 10), y - 7);
    ctx.lineTo(ax + dir * (len - 10), y + 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${Math.abs(wind)}`, x + len + 10, y + 7);
  }

  drawDebug(ctx, game) {
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, HEIGHT - 58, 300, 50);
    ctx.fillStyle = '#9fffb0';
    ctx.fillText(`${this.fps.toFixed(0)} fps · ${this.effects.particles.length} particles · uploads ${this.terrainLayer.uploads}`, 16, HEIGHT - 40);
    ctx.fillText(`phase ${game.state.phase} · tick ${game.state.tick} · turn ${game.state.turnId}`, 16, HEIGHT - 22);
  }
}
