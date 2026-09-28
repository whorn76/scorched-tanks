// Wires the game together: sessions, the fixed-timestep loop, input, rendering and the menus.
import { DT, MAX_POWER, TANK, TANK_COLORS, WIDTH } from './core/constants.js';
import { Phase, maxPower } from './core/game.js';
import { FREE_WEAPON, WEAPONS } from './core/weapons.js';
import { hashGame } from './core/hash.js';
import { LocalSession } from './session/session.js';
import { Renderer } from './render/renderer.js';
import { Input } from './input.js';
import { h } from './ui/dom.js';
import * as screens from './ui/screens.js';
import { loadLineup, loadMuted, loadSettings, saveLineup, saveMuted } from './storage.js';

const AI_READY = false;

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');
const toasts = document.getElementById('toasts');
const renderer = new Renderer(canvas);
const input = new Input(canvas);

function defaultLineup() {
  return [
    { name: 'Player 1', color: TANK_COLORS[0], type: 'human' },
    { name: 'Player 2', color: TANK_COLORS[1], type: 'human' },
  ];
}

const app = {
  screen: 'title', // menu screen when no game is running
  session: null,
  paused: false,
  modal: null, // 'pause' | 'help' over a running game
  aim: null, // the local player's unconfirmed aim
  aimSentAt: 0,
  aimDirty: false,
  drag: null,
  settings: loadSettings(),
  lineup: (loadLineup() ?? defaultLineup()).map((e) => ({ ...e, type: AI_READY || e.type === 'human' ? e.type : 'human' })),
  muted: loadMuted(),
  overlayKey: null,
  overlayPhase: null,
};

// --- Overlays --------------------------------------------------------------------------------

function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}`, text });
  toasts.append(el);
  setTimeout(() => el.remove(), 3200);
  while (toasts.children.length > 4) toasts.firstChild.remove();
}

function setOverlay(key, build, { dim = false } = {}) {
  if (key === app.overlayKey) return;
  app.overlayKey = key;
  uiRoot.classList.toggle('dim', dim);
  uiRoot.replaceChildren(...(build ? [build()] : []));
  const focus = uiRoot.querySelector('.btn.primary, input, .btn');
  if (focus && key && !key.startsWith('round')) focus.focus({ preventScroll: true });
}

function menuOverlay() {
  switch (app.screen) {
    case 'title':
      return ['title', () => screens.titleScreen({
        onLocal: () => go('setup'),
        onHost: () => toast('Online play arrives in the next update.'),
        onJoin: () => toast('Online play arrives in the next update.'),
        onSettings: () => toast('Settings arrive in a later update.'),
        onHelp: () => go('help'),
      })];
    case 'setup':
      return ['setup', () => screens.localSetupScreen({
        lineup: app.lineup,
        allowAi: AI_READY,
        onChange: () => saveLineup(app.lineup),
        onStart: startLocalGame,
        onBack: () => go('title'),
      })];
    case 'help':
      return ['help', () => screens.helpScreen({ onClose: () => go('title') })];
    default:
      return [null, null];
  }
}

function gameOverlay() {
  const session = app.session;
  const game = session.game;
  if (app.modal === 'help') return ['game-help', () => screens.helpScreen({ onClose: () => (app.modal = null) }), true];
  if (app.modal === 'pause') {
    return [`pause:${app.muted}`, () => screens.pauseScreen({
      online: session.online,
      muted: app.muted,
      onResume: closeModal,
      onMute: toggleMute,
      onHelp: () => (app.modal = 'help'),
      onQuit: quitToTitle,
    }), true];
  }
  switch (game.phase) {
    case Phase.ROUND_OVER:
      return [`round:${game.state.round}`, () => screens.roundSummary(game), false];
    case Phase.GAME_OVER:
      return ['standings', () => screens.standingsScreen(game, { onAgain: session.online ? null : startLocalGame, onMenu: quitToTitle }), true];
    default:
      return [null, null, false];
  }
}

function syncOverlay() {
  const [key, build, dim] = app.session ? gameOverlay() : menuOverlay();
  setOverlay(key, build, { dim });
}

function go(screen) {
  app.screen = screen;
}

function closeModal() {
  app.modal = null;
  app.paused = false;
}

function toggleMute() {
  app.muted = !app.muted;
  saveMuted(app.muted);
  toast(app.muted ? 'Sound off' : 'Sound on');
}

// --- Games -----------------------------------------------------------------------------------

function startLocalGame() {
  const players = app.lineup.map((entry, i) => ({
    name: entry.name.trim() || `Tank ${i + 1}`,
    color: entry.color,
    ai: entry.type === 'human' ? null : entry.type,
  }));
  const session = new LocalSession({ settings: app.settings, players });
  session.start();
  startSession(session);
}

function startSession(session) {
  app.session = session;
  app.paused = false;
  app.modal = null;
  app.aim = null;
  app.overlayKey = '(reset)';
  document.activeElement?.blur?.();
  renderer.resetRound();
  input.releaseAll();
}

function quitToTitle() {
  app.session?.close();
  app.session = null;
  app.modal = null;
  app.paused = false;
  app.aim = null;
  app.screen = 'title';
  app.overlayKey = '(reset)';
}

// --- Aiming ----------------------------------------------------------------------------------

function availableWeapons(tank) {
  return WEAPONS.filter((w) => w.id === FREE_WEAPON || tank.stock[w.id] > 0).map((w) => w.id);
}

function syncAim() {
  const session = app.session;
  const id = session && !app.paused ? session.myTurn() : -1;
  if (id < 0) {
    app.aim = null;
    return;
  }
  const s = session.state;
  const tank = s.tanks[id];
  if (!app.aim || app.aim.playerId !== id || app.aim.turnId !== s.turnId) {
    const weapons = availableWeapons(tank);
    app.aim = {
      playerId: id,
      turnId: s.turnId,
      angle: tank.angle,
      power: Math.min(tank.power, maxPower(tank)),
      weaponId: weapons.includes(tank.weapon) ? tank.weapon : FREE_WEAPON,
    };
    app.aimDirty = true;
  }
  app.aim.power = Math.min(app.aim.power, maxPower(tank));
  if (!availableWeapons(tank).includes(app.aim.weaponId)) app.aim.weaponId = FREE_WEAPON;
}

function changeAim(kind, delta) {
  const aim = app.aim;
  if (!aim) return;
  const tank = app.session.state.tanks[aim.playerId];
  if (kind === 'angle') aim.angle = Math.round(Math.min(180, Math.max(0, aim.angle + delta)) * 10) / 10;
  else aim.power = Math.min(maxPower(tank), Math.max(0, aim.power + delta));
  app.aimDirty = true;
}

function sendAimPreview(now) {
  const aim = app.aim;
  if (!aim || !app.aimDirty || now - app.aimSentAt < 80) return;
  app.aimDirty = false;
  app.aimSentAt = now;
  app.session.submit({ type: 'aim', playerId: aim.playerId, turnId: aim.turnId, angle: aim.angle, power: Math.round(aim.power), weaponId: aim.weaponId });
}

function fire() {
  const aim = app.aim;
  if (!aim || !app.session.game.isIdle()) return;
  const result = app.session.submit({ type: 'fire', turnId: aim.turnId, playerId: aim.playerId, angle: aim.angle, power: Math.round(aim.power), weaponId: aim.weaponId });
  if (result && !result.ok && result.error) toast(`Can't fire: ${result.error}`, 'error');
}

function cycleWeapon(dir) {
  const aim = app.aim;
  if (!aim) return;
  const tank = app.session.state.tanks[aim.playerId];
  const list = availableWeapons(tank);
  const i = list.indexOf(aim.weaponId);
  aim.weaponId = list[(i + dir + list.length) % list.length];
  app.aimDirty = true;
}

function useItem(kind) {
  const aim = app.aim;
  if (!aim || !app.session.game.isIdle()) return;
  const tank = app.session.state.tanks[aim.playerId];
  let item = kind;
  if (kind === 'shield') item = tank.stock.heavyshield > 0 ? 'heavyshield' : 'shield';
  if (!(tank.stock[item] > 0)) {
    toast(kind === 'shield' ? 'No shields. Buy them in the shop.' : 'No batteries. Buy them in the shop.');
    return;
  }
  const result = app.session.submit({ type: 'use', turnId: aim.turnId, playerId: aim.playerId, item });
  if (result && !result.ok) toast(result.error, 'error');
}

function drive() {
  const aim = app.aim;
  if (!aim || !input.driving || !app.session.game.isIdle()) return;
  const tank = app.session.state.tanks[aim.playerId];
  if (!(tank.stock.fuel > 0)) {
    if (!app.noFuelWarned) toast('No fuel. Buy some in the shop to drive.');
    app.noFuelWarned = true;
    return;
  }
  app.session.submit({ type: 'move', turnId: aim.turnId, playerId: aim.playerId, dir: input.driving });
}

function dragAim(event) {
  const aim = app.aim;
  if (!aim) return;
  const tank = app.session.state.tanks[aim.playerId];
  const p = renderer.toWorld(event.clientX, event.clientY);
  const px = tank.x;
  const py = tank.y - TANK.pivotY;
  const dx = p.x - px;
  const dy = py - p.y;
  let angle = (Math.atan2(Math.max(0, dy), dx) * 180) / Math.PI;
  if (dy < 0) angle = dx >= 0 ? 0 : 180;
  aim.angle = Math.round(Math.min(180, Math.max(0, angle)) * 10) / 10;
  aim.power = Math.round(Math.min(maxPower(tank), Math.max(0, Math.hypot(dx, dy) * 5)));
  app.aimDirty = true;
  app.drag = { x: px, y: py };
}

canvas.addEventListener('pointerdown', (event) => {
  if (!app.aim || app.paused) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  dragAim(event);
});
canvas.addEventListener('pointermove', (event) => {
  if (app.drag && canvas.hasPointerCapture(event.pointerId)) dragAim(event);
});
const endDrag = () => {
  app.drag = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

input.on('aim', ({ kind, delta }) => changeAim(kind, delta));
input.on('fire', () => fire());
input.on('nextWeapon', () => cycleWeapon(1));
input.on('prevWeapon', () => cycleWeapon(-1));
input.on('shield', () => useItem('shield'));
input.on('battery', () => useItem('battery'));
input.on('mute', () => toggleMute());
input.on('debug', () => (renderer.showDebug = !renderer.showDebug));
input.on('help', () => {
  if (!app.session) go(app.screen === 'help' ? 'title' : 'help');
  else app.modal = app.modal === 'help' ? null : 'help';
});
input.on('pause', () => {
  if (!app.session) {
    if (app.screen !== 'title') go('title');
    return;
  }
  if (app.modal) closeModal();
  else {
    app.modal = 'pause';
    app.paused = !app.session.online;
  }
});

window.addEventListener('resize', () => renderer.resize());
document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.session && !app.session.online && !app.modal) {
    app.modal = 'pause';
    app.paused = true;
  }
});

// --- Loop ------------------------------------------------------------------------------------

function handleEvents(session) {
  for (const event of session.drainEvents()) {
    renderer.handleEvent(event, session.game);
    if (event.type === 'turn') app.noFuelWarned = false;
    if (event.type === 'shop') {
      // Until the shop screen exists, humans skip straight to the next round.
      for (const id of session.localShoppers()) session.submit({ type: 'ready', playerId: id });
    }
  }
}

let last = performance.now();
let accumulator = 0;

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const session = app.session;
  if (session) {
    if (!app.paused) {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= DT && steps < 8) {
        session.update();
        accumulator -= DT;
        steps++;
      }
      if (steps === 8) accumulator = 0;
    }
    handleEvents(session);
    syncAim();
    input.enabled = !!app.aim && !app.modal;
    input.update(dt);
    drive();
    sendAimPreview(now);
  }
  syncOverlay();
  const guide = app.drag && app.aim ? { x: app.drag.x, y: app.drag.y, angle: app.aim.angle, power: app.aim.power } : null;
  renderer.draw({
    session,
    time: now / 1000,
    dt,
    aim: app.aim,
    aimGuide: guide,
    hideHud: !session,
    dim: session && app.modal ? 0.35 : 0,
  });
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// A small hook for automated browser tests and tinkering in DevTools.
window.__scorched = {
  app,
  renderer,
  get session() {
    return app.session;
  },
  get phase() {
    return app.session?.game.phase ?? `menu:${app.screen}`;
  },
  get hash() {
    return app.session ? hashGame(app.session.game) : null;
  },
  get turnId() {
    return app.session?.game.state.turnId ?? 0;
  },
  get round() {
    return app.session?.game.state.round ?? 0;
  },
  MAX_POWER,
  WIDTH,
};
