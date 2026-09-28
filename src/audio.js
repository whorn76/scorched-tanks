// Sound effects synthesized with the Web Audio API, so there are no audio files to load.
// Browsers only allow audio after a user gesture, so unlock() is called from input handlers.
// Game events trigger one-shot effects; update() drives the looping ones (the falling shell's
// whistle, napalm crackle and the rumble of settling dirt).

const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);

export class Sound {
  constructor({ volume = 70, muted = false } = {}) {
    this.volume = volume;
    this.muted = muted;
    this.ctx = null;
    this.recent = new Map(); // effect name → last play time, to avoid stacking identical sounds
  }

  unlock() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.ratio.value = 6;
      this.master.connect(this.compressor).connect(this.ctx.destination);
      this.noiseBuffer = this.createNoiseBuffer(2);
      this.applyVolume();
      this.startLoops();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setVolume(volume) {
    this.volume = volume;
    this.applyVolume();
  }

  setMuted(muted) {
    this.muted = muted;
    this.applyVolume();
  }

  applyVolume() {
    if (!this.master) return;
    const v = this.muted ? 0 : (this.volume / 100) ** 1.5 * 0.9;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  // --- Building blocks -----------------------------------------------------------------------

  tone({ type = 'sine', from, to = from, duration, volume, delay = 0, attack = 0.005, curve = 'exp' }) {
    const ctx = this.ctx;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) {
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);
      else osc.frequency.linearRampToValueAtTime(to, start + duration);
    }
    osc.connect(this.envelope(start, duration, volume, attack));
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  noise({ duration, volume, from, to = from, q = 1, filter = 'bandpass', delay = 0, attack = 0.005 }) {
    const ctx = this.ctx;
    const start = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const biquad = ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.Q.value = q;
    biquad.frequency.setValueAtTime(from, start);
    if (to !== from) biquad.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
    source.connect(biquad).connect(this.envelope(start, duration, volume, attack));
    source.start(start, Math.random() * 1.5);
    source.stop(start + duration + 0.05);
  }

  envelope(start, duration, volume, attack) {
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    gain.connect(this.master);
    return gain;
  }

  createNoiseBuffer(seconds) {
    const length = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** True if `name` played less than `gap` seconds ago (and marks it as playing now if not). */
  throttled(name, gap) {
    const now = this.ctx.currentTime;
    const last = this.recent.get(name) ?? -1;
    if (now - last < gap) return true;
    this.recent.set(name, now);
    return false;
  }

  // --- Loops: whistle, napalm, dirt ----------------------------------------------------------

  startLoops() {
    const ctx = this.ctx;
    this.whistle = ctx.createOscillator();
    this.whistle.type = 'sine';
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain).connect(this.master);
    this.whistle.start();

    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noiseBuffer;
    rumble.loop = true;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 260;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumble.connect(low).connect(this.rumbleGain).connect(this.master);
    rumble.start();
  }

  /** Call every frame with the running game (or null). */
  update(game) {
    if (!this.ready) return;
    const state = game?.state ?? null;
    const t = this.ctx.currentTime;
    // The falling-bomb whistle follows the fastest-falling shell in the air.
    let fall = null;
    if (state) {
      for (const p of state.projectiles) {
        if (p.mode !== 'fly' || p.kind === 'tracer') continue;
        if (!fall || p.vy > fall.vy) fall = p;
      }
    }
    if (fall && fall.vy > 40) {
      const freq = Math.max(260, 1500 - fall.vy * 1.7);
      this.whistle.frequency.setTargetAtTime(freq, t, 0.05);
      this.whistleGain.gain.setTargetAtTime(Math.min(0.05, fall.vy / 6000), t, 0.08);
    } else {
      this.whistleGain.gain.setTargetAtTime(0, t, 0.06);
    }
    // Dirt sliding down.
    const settling = game ? Math.min(1, game.terrain.activeCount / 180) : 0;
    this.rumbleGain.gain.setTargetAtTime(settling * 0.16, t, 0.12);
    // Napalm crackle: random pops while it burns.
    const flames = state?.napalm.length ?? 0;
    if (flames && Math.random() < 0.18 + Math.min(0.5, flames / 120)) {
      this.noise({ duration: 0.03 + Math.random() * 0.04, volume: 0.05 + Math.random() * 0.07, from: 1800 + Math.random() * 3000, filter: 'highpass', q: 0.7 });
    }
  }

  // --- One-shot effects ----------------------------------------------------------------------

  explosion(radius, flash) {
    if (this.throttled(`boom${radius > 45 ? 'big' : 'small'}`, 0.06)) return;
    const size = Math.min(1, radius / 100);
    const duration = 0.35 + size * 1.4;
    this.noise({ duration, volume: 0.35 + size * 0.5, from: 2600 - size * 1200, to: 90, filter: 'lowpass', q: 0.6 });
    this.tone({ type: 'sine', from: 110 - size * 50, to: 28, duration: duration * 0.9, volume: 0.35 + size * 0.45 });
    if (radius > 40) this.noise({ duration: duration * 1.4, volume: 0.12 + size * 0.2, from: 400, to: 60, filter: 'lowpass', delay: 0.08 });
    if (flash) {
      this.tone({ type: 'sawtooth', from: 60, to: 22, duration: 2.6, volume: 0.25, attack: 0.02 });
      this.noise({ duration: 2.8, volume: 0.3, from: 900, to: 50, filter: 'lowpass', delay: 0.05 });
    }
  }

  play(event) {
    if (!this.ready || this.muted) return;
    switch (event.type) {
      case 'fire': {
        const heavy = ['nuke', 'deathshead', 'babynuke', 'mirv'].includes(event.weapon);
        this.tone({ type: 'sine', from: heavy ? 150 : 190, to: 45, duration: 0.22, volume: 0.45 });
        this.noise({ duration: 0.16, volume: 0.3, from: 1600, to: 300, q: 0.8 });
        break;
      }
      case 'explosion':
        this.explosion(event.radius, event.flash);
        break;
      case 'riot':
        this.noise({ duration: 0.5, volume: 0.35, from: 900, to: 120, filter: 'lowpass' });
        break;
      case 'dirt':
        this.noise({ duration: 0.5, volume: 0.3, from: 500, to: 90, filter: 'lowpass' });
        this.tone({ type: 'sine', from: 90, to: 50, duration: 0.3, volume: 0.25 });
        break;
      case 'split':
        for (let i = 0; i < 4; i++) this.tone({ type: 'triangle', from: 1400 + i * 260, to: 900, duration: 0.12, volume: 0.07, delay: i * 0.03 });
        break;
      case 'bounce':
        this.tone({ type: 'sine', from: 260, to: 620, duration: 0.14, volume: 0.18 });
        break;
      case 'roll':
        this.noise({ duration: 0.4, volume: 0.12, from: 300, to: 180, filter: 'lowpass' });
        break;
      case 'dig':
        this.noise({ duration: 0.6, volume: 0.2, from: 700, to: 200, q: 2 });
        break;
      case 'napalm':
        this.noise({ duration: 0.6, volume: 0.3, from: 1200, to: 300, filter: 'lowpass' });
        break;
      case 'shieldHit':
      case 'shieldDamage':
        if (this.throttled('shield', 0.12)) break;
        this.tone({ type: 'sine', from: 1800, to: 1300, duration: 0.25, volume: 0.1 });
        this.tone({ type: 'sine', from: 2700, to: 2100, duration: 0.18, volume: 0.06 });
        break;
      case 'shieldBreak':
        this.noise({ duration: 0.35, volume: 0.2, from: 5000, to: 1500, filter: 'highpass' });
        break;
      case 'shieldUp':
      case 'battery':
        [0, 4, 7, 12].forEach((n, i) => this.tone({ type: 'triangle', from: NOTE(72 + n), duration: 0.12, volume: 0.08, delay: i * 0.05 }));
        break;
      case 'parachute':
        this.noise({ duration: 0.12, volume: 0.25, from: 2000, to: 600 });
        this.tone({ type: 'sine', from: 300, to: 500, duration: 0.15, volume: 0.1 });
        break;
      case 'land':
        if (event.distance > 6) this.noise({ duration: 0.2, volume: Math.min(0.35, event.distance / 150), from: 400, to: 80, filter: 'lowpass' });
        break;
      case 'death':
        this.tone({ type: 'triangle', from: 520, to: 70, duration: 0.8, volume: 0.2 });
        break;
      case 'drive':
        if (this.throttled('drive', 0.09)) break;
        this.tone({ type: 'square', from: 70 + Math.random() * 15, duration: 0.07, volume: 0.05 });
        break;
      case 'blocked':
        this.tone({ type: 'sine', from: 120, to: 60, duration: 0.12, volume: 0.15 });
        break;
      case 'turn':
        this.tone({ type: 'sine', from: NOTE(84), duration: 0.09, volume: 0.05 });
        break;
      case 'yourTurn':
        this.tone({ type: 'triangle', from: NOTE(76), duration: 0.1, volume: 0.09 });
        this.tone({ type: 'triangle', from: NOTE(83), duration: 0.16, volume: 0.09, delay: 0.09 });
        break;
      case 'timeout':
        [0, 0.15].forEach((d) => this.tone({ type: 'square', from: 880, duration: 0.09, volume: 0.07, delay: d }));
        break;
      case 'round':
        this.fanfare();
        break;
      case 'roundOver':
        this.fanfare(true);
        break;
      case 'buy':
        this.tone({ type: 'square', from: NOTE(79), duration: 0.05, volume: 0.06 });
        this.tone({ type: 'square', from: NOTE(84), duration: 0.08, volume: 0.06, delay: 0.05 });
        break;
      case 'sell':
        this.tone({ type: 'square', from: NOTE(84), duration: 0.05, volume: 0.06 });
        this.tone({ type: 'square', from: NOTE(77), duration: 0.08, volume: 0.06, delay: 0.05 });
        break;
      case 'click':
        this.tone({ type: 'square', from: 1300, duration: 0.03, volume: 0.04 });
        break;
      case 'chat':
        this.tone({ type: 'sine', from: NOTE(88), to: NOTE(91), duration: 0.08, volume: 0.05, curve: 'lin' });
        break;
    }
  }

  fanfare(ending = false) {
    const notes = ending ? [67, 72, 76, 79, 84] : [60, 64, 67, 72];
    notes.forEach((n, i) => {
      this.tone({ type: 'square', from: NOTE(n), duration: 0.16, volume: 0.06, delay: i * 0.11 });
      this.tone({ type: 'triangle', from: NOTE(n - 12), duration: 0.2, volume: 0.08, delay: i * 0.11 });
    });
    const end = notes.length * 0.11;
    for (const n of ending ? [72, 76, 79] : [64, 67, 72]) this.tone({ type: 'triangle', from: NOTE(n), duration: 0.6, volume: 0.07, delay: end });
  }
}
