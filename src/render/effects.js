// Purely visual effects: debris, sparks, smoke, shockwave rings, floating damage numbers, screen
// shake and flashes. Nothing here affects the simulation, so it may use Math.random freely.
const MAX_PARTICLES = 1600;

const rand = (min, max) => min + Math.random() * (max - min);

export class Effects {
  constructor() {
    this.particles = [];
    this.rings = [];
    this.texts = [];
    this.shakeAmount = 0;
    this.flash = 0;
    this.flashColor = '255,255,255';
    this.enabled = true;
  }

  clear() {
    this.particles.length = 0;
    this.rings.length = 0;
    this.texts.length = 0;
    this.shakeAmount = 0;
    this.flash = 0;
  }

  add(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  shake(amount) {
    this.shakeAmount = Math.min(22, Math.max(this.shakeAmount, amount));
  }

  flashScreen(strength, color = '255,255,255') {
    this.flash = Math.max(this.flash, strength);
    this.flashColor = color;
  }

  /** The start of a blast: shockwave, sparks, smoke and shake scaled to its size. */
  explosion(x, y, radius, { flash = false, kind = 'blast' } = {}) {
    this.rings.push({ x, y, r: radius * 0.3, max: radius * 1.9, life: 0, duration: 0.35 + radius / 260, width: Math.max(2, radius / 9) });
    if (radius > 40) this.rings.push({ x, y, r: radius * 0.2, max: radius * 2.6, life: -0.08, duration: 0.6 + radius / 200, width: 2 });
    const sparks = Math.min(70, 10 + radius);
    for (let i = 0; i < sparks; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = rand(80, 200 + radius * 5);
      this.add({
        type: 'spark',
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 60,
        life: 0,
        maxLife: rand(0.25, 0.6 + radius / 200),
        size: rand(1.5, 3),
        gravity: 360,
        drag: 1.8,
        color: kind === 'death' ? '255,210,120' : Math.random() < 0.5 ? '255,236,160' : '255,150,60',
      });
    }
    const puffs = Math.min(18, 3 + Math.round(radius / 7));
    for (let i = 0; i < puffs; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * radius * 0.7;
      this.add({
        type: 'smoke',
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        vx: rand(-15, 15),
        vy: rand(-40, -12),
        life: -rand(0.05, 0.3),
        maxLife: rand(1.1, 2.1),
        size: rand(radius * 0.18, radius * 0.34) + 4,
        grow: rand(7, 16),
        gravity: 0,
        drag: 0.6,
        shade: Math.round(rand(55, 95)),
      });
    }
    this.shake(radius / 7);
    if (flash) {
      this.flashScreen(0.95);
      // A mushroom of smoke: a rising column topped by a wide cap.
      for (let i = 0; i < 24; i++) {
        const up = i / 24;
        this.add({
          type: 'smoke',
          x: x + rand(-radius, radius) * 0.12,
          y: y - up * radius * 0.5,
          vx: rand(-5, 5),
          vy: -rand(45, 70) * (0.6 + up),
          life: -0.15 - up * 0.35,
          maxLife: rand(2.6, 3.6),
          size: rand(radius * 0.16, radius * 0.26),
          grow: rand(5, 10),
          gravity: 0,
          drag: 0.45,
          shade: Math.round(rand(80, 120)),
        });
      }
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        this.add({
          type: 'smoke',
          x: x + Math.cos(a) * radius * 0.3,
          y: y - radius * 0.9 + Math.sin(a) * radius * 0.12,
          vx: Math.cos(a) * rand(25, 45),
          vy: -rand(55, 75),
          life: -0.55,
          maxLife: rand(2.8, 3.8),
          size: rand(radius * 0.22, radius * 0.32),
          grow: rand(8, 14),
          gravity: 0,
          drag: 0.6,
          shade: Math.round(rand(95, 135)),
        });
      }
    }
  }

  /** Clumps of dirt thrown out of a crater, in the ground's own color. */
  debris(x, y, radius, color, count) {
    const n = Math.min(90, count);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * rand(0.05, 0.95);
      const speed = rand(60, 160 + radius * 4);
      this.add({
        type: 'debris',
        x: x + rand(-radius, radius) * 0.5,
        y: y + rand(-radius, radius) * 0.3,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 0,
        maxLife: rand(0.8, 1.6),
        size: rand(1.5, 3.5),
        gravity: 520,
        drag: 0.4,
        color,
      });
    }
  }

  muzzle(x, y, ux, uy) {
    for (let i = 0; i < 10; i++) {
      const speed = rand(60, 220);
      this.add({
        type: 'spark',
        x,
        y,
        vx: ux * speed + rand(-40, 40),
        vy: uy * speed + rand(-40, 40),
        life: 0,
        maxLife: rand(0.12, 0.3),
        size: rand(1.5, 2.5),
        gravity: 0,
        drag: 4,
        color: '255,230,150',
      });
    }
    for (let i = 0; i < 5; i++) {
      this.add({
        type: 'smoke',
        x: x + ux * 4,
        y: y + uy * 4,
        vx: ux * rand(10, 40),
        vy: uy * rand(10, 40) - 10,
        life: 0,
        maxLife: rand(0.5, 0.9),
        size: rand(3, 6),
        grow: 10,
        gravity: 0,
        drag: 1,
        shade: 180,
      });
    }
  }

  /** Smoke curling up from a wreck. */
  wreckSmoke(x, y) {
    this.add({
      type: 'smoke',
      x: x + rand(-6, 6),
      y,
      vx: rand(-6, 6),
      vy: rand(-30, -18),
      life: 0,
      maxLife: rand(1.4, 2.4),
      size: rand(3, 6),
      grow: 9,
      gravity: 0,
      drag: 0.2,
      shade: Math.round(rand(40, 70)),
    });
  }

  sparkle(x, y, color, count = 12) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = rand(30, 120);
      this.add({
        type: 'spark',
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 0,
        maxLife: rand(0.3, 0.7),
        size: rand(1.5, 2.5),
        gravity: 60,
        drag: 2,
        color,
      });
    }
  }

  text(x, y, text, color = '#ffffff', size = 18, extra = null) {
    const t = { x, y, text, color, size, life: 0, maxLife: 1.3, ...extra };
    this.texts.push(t);
    return t;
  }

  /** Adds damage to a tank's recent floating number instead of stacking a new one. */
  damageText(tankId, x, y, amount, color, size) {
    const recent = this.texts.find((t) => t.tank === tankId && t.color === color && t.life < 0.7);
    if (recent) {
      recent.total += amount;
      recent.text = `-${recent.total}`;
      recent.life = Math.min(recent.life, 0.25);
      return recent;
    }
    return this.text(x, y, `-${amount}`, color, size, { tank: tankId, total: amount });
  }

  /** Embers drifting up from burning napalm. */
  ember(x, y) {
    this.add({
      type: 'spark',
      x: x + rand(-3, 3),
      y,
      vx: rand(-12, 12),
      vy: rand(-70, -35),
      life: 0,
      maxLife: rand(0.4, 0.9),
      size: rand(1.2, 2.2),
      gravity: -20,
      drag: 1.2,
      color: Math.random() < 0.5 ? '255,200,90' : '255,120,40',
    });
  }

  update(dt, wind = 0) {
    const ps = this.particles;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.maxLife) continue;
      if (p.life >= 0) {
        const drag = Math.max(0, 1 - p.drag * dt);
        p.vx = p.vx * drag + (p.type === 'smoke' ? wind * 3 * dt : 0);
        p.vy = p.vy * drag + p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.grow) p.size += p.grow * dt;
      }
      ps[w++] = p;
    }
    ps.length = w;
    for (const ring of this.rings) ring.life += dt;
    this.rings = this.rings.filter((ring) => ring.life < ring.duration);
    for (const t of this.texts) {
      t.life += dt;
      t.y -= 28 * dt;
    }
    this.texts = this.texts.filter((t) => t.life < t.maxLife);
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 30);
    this.flash = Math.max(0, this.flash - dt * 1.6);
  }

  shakeOffset() {
    if (this.shakeAmount <= 0.05) return [0, 0];
    return [rand(-1, 1) * this.shakeAmount, rand(-1, 1) * this.shakeAmount];
  }

  drawBack(ctx) {
    for (const p of this.particles) {
      if (p.type !== 'smoke' || p.life < 0) continue;
      const t = p.life / p.maxLife;
      const alpha = (1 - t) * 0.34;
      ctx.fillStyle = `rgba(${p.shade},${p.shade},${p.shade},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawFront(ctx) {
    for (const p of this.particles) {
      if (p.type !== 'debris' || p.life < 0) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    for (const ring of this.rings) {
      if (ring.life < 0) continue;
      const t = ring.life / ring.duration;
      const r = ring.r + (ring.max - ring.r) * (1 - (1 - t) * (1 - t));
      ctx.strokeStyle = `rgba(255,220,170,${((1 - t) * 0.42).toFixed(3)})`;
      ctx.lineWidth = ring.width * 0.8 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of this.particles) {
      if (p.type !== 'spark' || p.life < 0) continue;
      const t = p.life / p.maxLife;
      ctx.fillStyle = `rgba(${p.color},${(1 - t).toFixed(3)})`;
      const s = p.size * (1 - t * 0.5);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  drawTexts(ctx, font) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of this.texts) {
      const k = t.life / t.maxLife;
      ctx.globalAlpha = k > 0.6 ? (1 - k) / 0.4 : 1;
      ctx.font = `bold ${t.size}px ${font}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  drawFlash(ctx, width, height) {
    if (this.flash <= 0) return;
    ctx.fillStyle = `rgba(${this.flashColor},${Math.min(1, this.flash).toFixed(3)})`;
    ctx.fillRect(0, 0, width, height);
  }
}
