// Draws the game world and the HUD on a canvas. The playfield is a fixed 1280×720 logical space,
// letterboxed to fit the window and rendered at the display's full pixel density. The terrain
// comes from an offscreen canvas that only re-uploads dirty rectangles; everything else is
// vector drawing each frame. Game events (explosions, deaths…) spawn purely visual effects.
import { HEIGHT, MAX_POWER, TANK, WIDTH, WIND_MAX } from '../core/constants.js';
import { Phase, maxPower } from '../core/game.js';
import { FREE_WEAPON, WEAPON_BY_ID } from '../core/weapons.js';
import { LOOSE } from '../core/terrain.js';
import { buildPalette, hexToRgb } from './palette.js';
import { TerrainLayer } from './terrainLayer.js';
import { Sky } from './sky.js';
import { Effects } from './effects.js';

export const FONT = '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
export const DISPLAY_FONT = '"Arial Black", "Segoe UI Black", Impact, "Helvetica Neue", sans-serif';
export const HUD_HEIGHT = 58;
const TAU = Math.PI * 2;

const shade = (hex, f) => {
  const [r, g, b] = hexToRgb(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
};

const formatMoney = (n) => `$${Math.floor(n).toLocaleString('en-US')}`;

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

  resetRound() {
    this.trails.clear();
    this.tracers = [];
    this.effects.clear();
    this.tankFx.clear();
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
        fx.text(tank.x, tank.y - 34, `-${event.amount}`, '#ff6a5a', 18);
        this.fxFor(event.tank).hit = 0.35;
        break;
      }
      case 'shieldDamage': {
        const tank = s.tanks[event.tank];
        fx.text(tank.x, tank.y - 46, `-${event.amount}`, '#7fd8ff', 15);
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
    for (const tank of s.tanks) this.drawTank(ctx, tank, game, session, view);
    this.drawTrails(ctx);
    this.drawProjectiles(ctx, s, view.time);
    this.drawExplosions(ctx, s);
    this.effects.drawFront(ctx);
    this.drawLabels(ctx, s, session, view);
    this.effects.drawTexts(ctx, FONT);
    if (view.aimGuide) this.drawAimGuide(ctx, view.aimGuide);
    this.bubbles?.draw(ctx, s, view.time);
    this.drawOffscreenMarkers(ctx, s);

    ctx.setTransform(k, 0, 0, k, 0, 0);
    this.effects.drawFlash(ctx, WIDTH, HEIGHT);
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
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.5);
      const hue = p.funky || p.kind === 'funky'
        ? `hsla(${Math.round((time * 400 + p.id * 70) % 360)},100%,65%,`
        : p.kind === 'napalm' ? 'rgba(255,140,40,' : p.kind === 'tracer' ? 'rgba(120,255,170,' : p.kind === 'dirt' ? 'rgba(200,150,90,' : 'rgba(255,230,170,';
      glow.addColorStop(0, `${hue}0.9)`);
      glow.addColorStop(1, `${hue}0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3.5, 0, TAU);
      ctx.fill();
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

  drawExplosions(ctx, s) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of s.explosions) {
      let t;
      let r;
      if (e.age <= e.grow) {
        t = e.age / e.grow;
        r = e.radius * (0.25 + 0.75 * Math.sqrt(t));
      } else {
        t = 1 + (e.age - e.grow) / e.fade;
        const k = (e.age - e.grow) / e.fade;
        r = e.radius * (1 - k * k * 0.85);
      }
      const heat = Math.min(1, t / 2); // 0 = white hot, 1 = dull red
      const core = `rgba(255,${Math.round(255 - heat * 120)},${Math.round(220 - heat * 200)},${(1 - heat * 0.6).toFixed(3)})`;
      const mid = `rgba(255,${Math.round(170 - heat * 110)},${Math.round(40 - heat * 30)},${(0.85 - heat * 0.5).toFixed(3)})`;
      const edge = `rgba(${Math.round(230 - heat * 90)},${Math.round(60 - heat * 40)},20,0)`;
      const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, Math.max(1, r));
      grad.addColorStop(0, core);
      grad.addColorStop(0.55, mid);
      grad.addColorStop(1, edge);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(1, r), 0, TAU);
      ctx.fill();
      if (e.flash && e.age < e.grow + 4) {
        const glow = ctx.createRadialGradient(e.x, e.y, r * 0.5, e.x, e.y, r * 2.4);
        glow.addColorStop(0, 'rgba(255,255,230,0.5)');
        glow.addColorStop(1, 'rgba(255,255,230,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(e.x, e.y, r * 2.4, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawNapalm(ctx, s, time) {
    if (!s.napalm.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const n of s.napalm) {
      const life = Math.min(1, n.life / 60);
      const flicker = 0.75 + 0.25 * Math.sin(time * 18 + n.x * 0.7 + n.y);
      const r = (5 + 4 * life) * flicker * (n.heat > 1 ? 1.25 : 1);
      const glow = ctx.createRadialGradient(n.x, n.y - 2, 0, n.x, n.y - 2, r * 2.2);
      glow.addColorStop(0, `rgba(255,${n.heat > 1 ? 240 : 210},120,${(0.8 * life).toFixed(3)})`);
      glow.addColorStop(0.4, `rgba(255,110,20,${(0.55 * life).toFixed(3)})`);
      glow.addColorStop(1, 'rgba(200,40,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(n.x - r * 2.2, n.y - 2 - r * 2.2, r * 4.4, r * 4.4);
    }
    ctx.restore();
  }

  isBuried(terrain, tank) {
    for (const [dx, dy] of [[0, -6], [0, -11], [-6, -5], [6, -5]]) if (terrain.isSolid(tank.x + dx, tank.y + dy)) return true;
    return false;
  }

  /** Where the barrel points for a tank: the local aim, a remote preview, or its last shot. */
  barrelAngle(tank, session, view) {
    const s = session.game.state;
    if (view.aim && s.active === tank.id && s.phase === Phase.AIM && view.aim.playerId === tank.id) return view.aim.angle;
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
      ctx.fillStyle = 'rgba(255,220,120,0.95)';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x - 7, top + 11);
      ctx.lineTo(x + 7, top + 11);
      ctx.closePath();
      ctx.fill();
      ctx.font = `600 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,230,160,0.95)';
      ctx.fillText(`${Math.round(HUD_HEIGHT - p.y)}`, x, top + 24);
    }
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

    const local = view.aim && view.aim.playerId === tank.id && s.phase === Phase.AIM ? view.aim : null;
    const preview = session.previews.get(tank.id);
    const angle = local?.angle ?? preview?.angle ?? tank.angle;
    const power = local?.power ?? preview?.power ?? tank.power;
    const weaponId = local?.weaponId ?? preview?.weaponId ?? tank.weapon;
    const weapon = WEAPON_BY_ID[weaponId] ?? WEAPON_BY_ID[FREE_WEAPON];

    const label = (text, x) => {
      ctx.font = `700 10px ${FONT}`;
      ctx.fillStyle = 'rgba(190,205,230,0.7)';
      ctx.textAlign = 'left';
      ctx.fillText(text, x, 19);
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
    const role = tank.ai ? `AI · ${tank.ai}` : session.controls(tank.id) ? (session.online ? 'You' : 'Human') : 'Remote player';
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

    // Power with the health cap marked.
    label('POWER', 392);
    const barX = 392;
    const barW = 190;
    const cap = maxPower(tank) / MAX_POWER;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(barX, 28, barW, 12);
    ctx.fillStyle = 'rgba(255,90,70,0.22)';
    ctx.fillRect(barX + barW * cap, 28, barW * (1 - cap), 12);
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    grad.addColorStop(0, '#ffd36a');
    grad.addColorStop(1, '#ff6a3a');
    ctx.fillStyle = grad;
    ctx.fillRect(barX, 28, (barW * power) / MAX_POWER, 12);
    ctx.fillStyle = '#ff5a4a';
    ctx.fillRect(barX + barW * cap - 1, 25, 2, 18);
    ctx.font = `700 13px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(power)}`, barX + barW, 19);

    // Weapon.
    label('WEAPON', 604);
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

    // Fuel and items, small.
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(190,205,230,0.8)';
    const bits = [];
    if (tank.stock.fuel > 0) bits.push(`Fuel ${tank.stock.fuel}`);
    if (tank.stock.parachute > 0) bits.push(`Chutes ${tank.stock.parachute}`);
    if (tank.stock.shield + tank.stock.heavyshield > 0) bits.push(`Shields ${tank.stock.shield + tank.stock.heavyshield}`);
    if (tank.stock.battery > 0) bits.push(`Batt ${tank.stock.battery}`);
    ctx.fillText(bits.join(' · '), WIDTH - 12, 19);
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
