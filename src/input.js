// Keyboard, mouse and touch input. Discrete keys become actions; the aim keys can be held and
// speed up the longer they're held (Shift for fine steps). Pointer drags aim directly.
const AIM_KEYS = {
  ArrowLeft: ['angle', 1],
  ArrowRight: ['angle', -1],
  ArrowUp: ['power', 1],
  ArrowDown: ['power', -1],
};

const ACTION_KEYS = {
  Space: 'fire',
  Enter: 'fire',
  NumpadEnter: 'fire',
  Tab: 'weapon',
  BracketLeft: 'prevWeapon',
  BracketRight: 'nextWeapon',
  KeyA: 'driveLeft',
  KeyD: 'driveRight',
  KeyS: 'shield',
  KeyB: 'battery',
  KeyI: 'arsenal',
  KeyM: 'mute',
  Escape: 'pause',
  KeyH: 'help',
  Slash: 'help',
  KeyT: 'chat',
  F3: 'debug',
};

const STEP = { angle: 1, power: 5 };
const FINE_STEP = { angle: 0.1, power: 1 };
const RATE = { angle: 22, power: 90 }; // per second when held
const FINE_RATE = { angle: 3, power: 15 };
const HOLD_DELAY = 0.22;

export class Input {
  constructor(target) {
    this.target = target;
    this.held = new Map(); // code → seconds held
    this.shift = false;
    this.handlers = {};
    this.enabled = true;
    this.driving = 0;
    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keyup(e));
    window.addEventListener('blur', () => {
      this.held.clear();
      this.driving = 0;
    });
  }

  on(name, handler) {
    this.handlers[name] = handler;
  }

  emit(name, arg) {
    this.handlers[name]?.(arg);
  }

  typing(e) {
    const el = e.target;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  keydown(e) {
    this.shift = e.shiftKey;
    if (this.typing(e)) {
      if (e.code === 'Escape') this.emit('escapeField', e);
      return;
    }
    if (AIM_KEYS[e.code]) {
      e.preventDefault();
      if (!this.enabled) return;
      if (!this.held.has(e.code)) {
        this.held.set(e.code, 0);
        const [kind, dir] = AIM_KEYS[e.code];
        this.emit('aim', { kind, delta: dir * (e.shiftKey ? FINE_STEP[kind] : STEP[kind]) });
      }
      return;
    }
    let action = ACTION_KEYS[e.code];
    if (e.key === '?') action = 'help';
    if (!action) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      action = e.shiftKey ? 'prevWeapon' : 'nextWeapon';
    }
    if (e.code === 'Space' || e.code === 'F3') e.preventDefault();
    if (action === 'driveLeft' || action === 'driveRight') {
      this.driving = action === 'driveLeft' ? -1 : 1;
      return;
    }
    if (e.repeat) return;
    if (!this.enabled && !['mute', 'pause', 'help', 'debug', 'chat'].includes(action)) return;
    this.emit(action, e);
  }

  keyup(e) {
    this.shift = e.shiftKey;
    this.held.delete(e.code);
    if ((e.code === 'KeyA' && this.driving < 0) || (e.code === 'KeyD' && this.driving > 0)) this.driving = 0;
  }

  /** Per-frame aim changes from held keys, accelerating the longer they're held. */
  update(dt) {
    if (!this.enabled) {
      this.held.clear();
      this.driving = 0;
      return;
    }
    for (const [code, time] of this.held) {
      const now = time + dt;
      this.held.set(code, now);
      if (now < HOLD_DELAY) continue;
      const [kind, dir] = AIM_KEYS[code];
      const boost = 1 + 3 * Math.min(1, (now - HOLD_DELAY) / 1.2);
      const rate = (this.shift ? FINE_RATE[kind] : RATE[kind] * boost) * dt;
      this.emit('aim', { kind, delta: dir * rate, held: true });
    }
  }

  releaseAll() {
    this.held.clear();
    this.driving = 0;
  }
}
