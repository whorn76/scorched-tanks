// On-screen controls for touch screens: angle and power buttons (hold to repeat, speeding up),
// weapon picker, drive, items, a big Fire button and a menu button.
import { h } from './dom.js';

const REPEAT_DELAY = 0.28;

export class TouchControls {
  constructor(root, handlers) {
    this.root = root;
    this.handlers = handlers;
    this.held = null; // { action, dir, time }
    this.enabled = false;
    this.driving = 0;
    const hold = (action, dir, label, cls = '') => {
      const el = h('button', { class: `touch-btn ${cls}`, 'aria-label': `${action} ${dir > 0 ? 'up' : 'down'}`, text: label });
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        this.held = { action, dir, time: 0 };
        this.fire(action, dir, false);
      });
      const release = () => {
        if (this.held?.action === action && this.held.dir === dir) this.held = null;
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
      return el;
    };
    const tap = (label, fn, cls = '', aria = label) => {
      const el = h('button', { class: `touch-btn ${cls}`, 'aria-label': aria, text: label });
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fn();
      });
      return el;
    };
    const drive = (dir, label) => {
      const el = h('button', { class: 'touch-btn', 'aria-label': dir < 0 ? 'Drive left' : 'Drive right', text: label });
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        this.driving = dir;
      });
      const stop = () => {
        if (this.driving === dir) this.driving = 0;
      };
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointercancel', stop);
      el.addEventListener('lostpointercapture', stop);
      return el;
    };
    this.weaponLabel = h('span', { class: 'touch-weapon' });
    this.aimGroup = h('div', { class: 'touch-bar' },
      h('div', { class: 'touch-cluster left' },
        h('div', { class: 'touch-group' }, h('span', { class: 'touch-label', text: 'Angle' }), hold('angle', 1, '⟲'), hold('angle', -1, '⟳')),
        h('div', { class: 'touch-group' }, h('span', { class: 'touch-label', text: 'Power' }), hold('power', -1, '−'), hold('power', 1, '+')),
        h('div', { class: 'touch-group' }, h('span', { class: 'touch-label', text: 'Drive' }), drive(-1, '◀'), drive(1, '▶'))),
      h('div', { class: 'touch-cluster right' },
        h('div', { class: 'touch-group weapon' },
          tap('‹', () => handlers.weapon(-1), '', 'Previous weapon'),
          this.weaponLabel,
          tap('›', () => handlers.weapon(1), '', 'Next weapon')),
        h('div', { class: 'touch-row' },
          h('div', { class: 'touch-group' }, tap('Shield', () => handlers.shield(), 'small'), tap('Battery', () => handlers.battery(), 'small')),
          tap('FIRE', () => handlers.fire(), 'fire', 'Fire'))));
    this.menuButton = tap('☰', () => handlers.menu(), 'menu', 'Menu');
    root.replaceChildren(this.aimGroup, this.menuButton);
    this.touchCapable = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);
    window.addEventListener('touchstart', () => {
      this.touchCapable = true;
    }, { once: true, passive: true });
  }

  fire(action, dir, held) {
    this.handlers.aim(action, dir, held);
  }

  /** Shows the bar during games on touch devices; the aim buttons only on your turn. */
  sync({ inGame, myTurn, weaponName }) {
    const visible = this.touchCapable && inGame;
    this.root.hidden = !visible;
    this.aimGroup.hidden = !myTurn;
    if (!myTurn) {
      this.held = null;
      this.driving = 0;
    }
    if (weaponName && this.weaponLabel.textContent !== weaponName) this.weaponLabel.textContent = weaponName;
  }

  /** Repeats held buttons, faster the longer they're held. */
  update(dt) {
    if (!this.held) return;
    const held = this.held;
    held.time += dt;
    if (held.time < REPEAT_DELAY) return;
    const boost = 1 + 3 * Math.min(1, (held.time - REPEAT_DELAY) / 1.2);
    this.handlers.aimRate(held.action, held.dir * boost * dt);
  }
}
