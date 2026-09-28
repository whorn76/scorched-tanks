// Speech bubbles over tanks: one per tank, drawn on the canvas, fading out after a few seconds.
import { FONT } from './renderer.js';

const DURATION = 2.8;

export class Bubbles {
  constructor() {
    this.list = new Map(); // tank id → { text, age, delay }
  }

  say(tankId, text, delay = 0) {
    if (!text) return;
    this.list.set(tankId, { text, age: -delay });
  }

  clear() {
    this.list.clear();
  }

  update(dt) {
    for (const [id, b] of this.list) {
      b.age += dt;
      if (b.age > DURATION) this.list.delete(id);
    }
  }

  draw(ctx, state) {
    if (!this.list.size) return;
    ctx.font = `600 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [id, b] of this.list) {
      if (b.age < 0) continue;
      const tank = state.tanks[id];
      if (!tank) continue;
      const fadeIn = Math.min(1, b.age / 0.15);
      const fadeOut = Math.min(1, (DURATION - b.age) / 0.4);
      const alpha = Math.max(0, Math.min(fadeIn, fadeOut));
      const w = Math.min(260, ctx.measureText(b.text).width + 20);
      const h = 26;
      const lift = tank.shield > 0 ? 62 : 50;
      let x = tank.x;
      const y = Math.max(h / 2 + 64, tank.y - lift - (1 - fadeIn) * 6);
      x = Math.max(w / 2 + 4, Math.min(1280 - w / 2 - 4, x));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = 'rgba(20,24,32,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 10);
      ctx.moveTo(tank.x - 6, y + h / 2 - 0.5);
      ctx.lineTo(tank.x, y + h / 2 + 8);
      ctx.lineTo(tank.x + 6, y + h / 2 - 0.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(tank.x - 5, y + h / 2 - 2, 10, 3);
      ctx.fillStyle = '#1b2230';
      ctx.fillText(b.text, x, y + 1, 240);
    }
    ctx.globalAlpha = 1;
  }
}
