// Wires the game together: sessions, the fixed-timestep loop, input, rendering and the menus.
import { DT, MAX_POWER, TANK, TANK_COLORS, WIDTH } from './core/constants.js';
import { Phase, maxPower } from './core/game.js';
import { FREE_WEAPON, WEAPONS } from './core/weapons.js';
import { hashGame } from './core/hash.js';
import { LocalSession } from './session/session.js';
import { HostSession, resolveAiLevel } from './session/host.js';
import { GuestSession } from './session/guest.js';
import { normalizeRoomCode } from './net/protocol.js';
import { hostRelay, joinRelay, normalizeRelayUrl, sameOriginRelayUrl } from './net/relayTransport.js';
import { hostPeer, joinPeer } from './net/peerTransport.js';
import { Renderer } from './render/renderer.js';
import { Input } from './input.js';
import { h } from './ui/dom.js';
import * as screens from './ui/screens.js';
import { Lobby, hostScreen, joinScreen, waitingScreen } from './ui/online.js';
import { ChatBox } from './ui/chat.js';
import { loadLineup, loadMuted, loadOnline, loadSettings, saveLineup, saveMuted, saveOnline } from './storage.js';

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');
const toasts = document.getElementById('toasts');
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const chat = new ChatBox(document.getElementById('chat'));

function defaultLineup() {
  return [
    { name: 'Player 1', color: TANK_COLORS[0], type: 'human' },
    { name: 'Cyborg', color: TANK_COLORS[1], type: 'cyborg' },
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
  lineup: loadLineup() ?? defaultLineup(),
  online: loadOnline(),
  muted: loadMuted(),
  overlayKey: null,
  lobby: null,
  joinCode: '',
  message: null,
  busy: false,
};

// --- Overlays --------------------------------------------------------------------------------

function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}`, text });
  toasts.append(el);
  setTimeout(() => el.remove(), 3600);
  while (toasts.children.length > 4) toasts.firstChild.remove();
}

function setOverlay(key, build, { dim = false } = {}) {
  if (key === app.overlayKey) return;
  app.overlayKey = key;
  uiRoot.classList.toggle('dim', dim);
  uiRoot.replaceChildren(...(build ? [build()] : []));
  const focus = uiRoot.querySelector('.code-input, .btn.primary, input, .btn');
  if (focus && key && !key.startsWith('round') && !key.startsWith('lobby')) focus.focus({ preventScroll: true });
}

function menuOverlay() {
  if (app.message) {
    const { title, text } = app.message;
    return [`message:${title}:${text}`, () => screens.messageScreen({ title, text, onOk: () => (app.message = null) })];
  }
  switch (app.screen) {
    case 'title':
      return ['title', () => screens.titleScreen({
        onLocal: () => go('setup'),
        onHost: () => go('host'),
        onJoin: () => go('join'),
        onSettings: () => toast('The settings screen arrives in the next update.'),
        onHelp: () => go('help'),
      })];
    case 'setup':
      return ['setup', () => screens.localSetupScreen({
        lineup: app.lineup,
        allowAi: true,
        onChange: () => saveLineup(app.lineup),
        onStart: startLocalGame,
        onBack: () => go('title'),
      })];
    case 'help':
      return ['help', () => screens.helpScreen({ onClose: () => go('title') })];
    case 'host':
      return ['host', () => hostScreen(app.online, { sameOrigin: sameOriginRelayUrl(), onCreate: createRoom, onBack: () => go('title') })];
    case 'join':
      return [`join:${app.joinCode}`, () => joinScreen(app.online, { sameOrigin: sameOriginRelayUrl(), code: app.joinCode, onJoin: joinRoom, onBack: () => go('title') })];
    default:
      return [null, null];
  }
}

function onlineOverlay(session) {
  if (session.status === 'ended') {
    return ['ended', () => screens.messageScreen({
      title: session.isAuthority ? 'Game closed' : 'Disconnected',
      text: session.endReason || 'The game has ended.',
      onOk: quitToTitle,
      okText: 'Back to menu',
    }), true];
  }
  if (session.status === 'connecting') return ['joining', () => waitingScreen('Joining…', 'Saying hello to the host.', quitToTitle), true];
  if (session.status === 'lobby') {
    if (!app.lobby) {
      const isHost = session.isAuthority;
      app.lobby = new Lobby(session, {
        isHost,
        inviteLink: isHost ? inviteLink(session) : null,
        onStart: async () => {
          const result = await session.startGame();
          if (!result.ok) toast(result.error, 'error');
        },
        onLeave: quitToTitle,
        onCopy: copyInvite,
      });
    }
    return ['lobby', () => app.lobby.el, false];
  }
  if (session.status === 'starting' || !session.game) return ['starting', () => waitingScreen('Starting…', 'Setting up the battlefield.', null), true];
  return null;
}

function gameOverlay() {
  const session = app.session;
  if (session.online) {
    const online = onlineOverlay(session);
    if (online) return online;
  }
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
  if (key === 'lobby') app.lobby?.update();
  const online = !!app.session?.online && app.session.status !== 'ended';
  chat.show(online, online && app.session.status === 'lobby');
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
    ai: entry.type === 'human' ? null : resolveAiLevel(entry.type),
  }));
  const session = new LocalSession({ settings: app.settings, players });
  session.start();
  startSession(session);
}

function startSession(session) {
  if (app.session && app.session !== session) app.session.close();
  app.session = session;
  app.paused = false;
  app.modal = null;
  app.aim = null;
  app.lobby = null;
  app.overlayKey = '(reset)';
  document.activeElement?.blur?.();
  renderer.resetRound();
  input.releaseAll();
  chat.clear();
}

function quitToTitle() {
  app.session?.close();
  app.session = null;
  app.modal = null;
  app.paused = false;
  app.aim = null;
  app.lobby = null;
  app.screen = 'title';
  app.overlayKey = '(reset)';
  chat.show(false);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// --- Online ----------------------------------------------------------------------------------

function inviteLink(session) {
  const url = new URL(location.href);
  const params = new URLSearchParams({ join: session.code });
  if (session.transport.kind === 'relay') params.set('relay', session.transport.inviteParams.relay);
  return `${url.origin}${url.pathname}${url.search}#${params.toString()}`;
}

async function copyInvite(link) {
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied.');
  } catch {
    toast(link);
  }
}

function iceOptions(opts) {
  return { turnUrl: opts.turnUrl, turnUser: opts.turnUser, turnPass: opts.turnPass };
}

function setStatus(ui, text, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', error);
}

async function createRoom(opts, ui) {
  if (app.busy) return;
  app.busy = true;
  ui.button.disabled = true;
  opts.name = (opts.name || '').trim().slice(0, 16) || 'Host';
  saveOnline(opts);
  try {
    let transport;
    if (opts.transport === 'relay') {
      const url = normalizeRelayUrl(opts.relayUrl || sameOriginRelayUrl());
      if (!url) throw new Error('Enter the relay server address.');
      setStatus(ui, 'Opening a room on the relay…');
      transport = await hostRelay(url);
    } else {
      setStatus(ui, 'Contacting the PeerJS signaling server…');
      transport = await hostPeer({ ice: iceOptions(opts), onStatus: (t) => setStatus(ui, t) });
    }
    startSession(new HostSession({ transport, name: opts.name, settings: app.settings }));
  } catch (error) {
    setStatus(ui, error.message || String(error), true);
  } finally {
    app.busy = false;
    ui.button.disabled = false;
  }
}

async function joinRoom(codeText, opts, ui) {
  if (app.busy) return;
  const code = normalizeRoomCode(codeText);
  if (!code) {
    setStatus(ui, 'Room codes are 5 letters and digits.', true);
    return;
  }
  app.busy = true;
  ui.button.disabled = true;
  opts.name = (opts.name || '').trim().slice(0, 16) || 'Guest';
  saveOnline(opts);
  try {
    let conn;
    if (opts.transport === 'relay') {
      const url = normalizeRelayUrl(opts.relayUrl || sameOriginRelayUrl());
      if (!url) throw new Error('Enter the relay server address.');
      setStatus(ui, 'Connecting to the relay…');
      conn = await joinRelay(url, code);
    } else {
      conn = await joinPeer(code, { ice: iceOptions(opts), onStatus: (t) => setStatus(ui, t) });
    }
    startSession(new GuestSession({ conn, name: opts.name }));
  } catch (error) {
    setStatus(ui, error.message || String(error), true);
  } finally {
    app.busy = false;
    ui.button.disabled = false;
  }
}

chat.onSend((text) => app.session?.sendChat?.(text));

/** Opening an invite link (…#join=CODE, optionally &relay=URL) goes straight to the join screen. */
function readInvite() {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = normalizeRoomCode(params.get('join'));
  if (!code) return;
  app.joinCode = code;
  const relay = normalizeRelayUrl(params.get('relay') ?? '');
  app.online.transport = relay ? 'relay' : 'peer';
  if (relay) app.online.relayUrl = relay;
  app.screen = 'join';
}

readInvite();
window.addEventListener('hashchange', () => {
  if (!app.session) {
    readInvite();
    app.overlayKey = '(reset)';
  }
});

// --- Aiming ----------------------------------------------------------------------------------

function availableWeapons(tank) {
  return WEAPONS.filter((w) => w.id === FREE_WEAPON || tank.stock[w.id] > 0).map((w) => w.id);
}

function syncAim() {
  const session = app.session;
  const id = session?.game && !app.paused ? session.myTurn() : -1;
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
      fired: false,
    };
    app.aimDirty = true;
  }
  app.aim.power = Math.min(app.aim.power, maxPower(tank));
  if (!availableWeapons(tank).includes(app.aim.weaponId)) app.aim.weaponId = FREE_WEAPON;
}

function changeAim(kind, delta) {
  const aim = app.aim;
  if (!aim || aim.fired) return;
  const tank = app.session.state.tanks[aim.playerId];
  if (kind === 'angle') aim.angle = Math.round(Math.min(180, Math.max(0, aim.angle + delta)) * 10) / 10;
  else aim.power = Math.min(maxPower(tank), Math.max(0, aim.power + delta));
  app.aimDirty = true;
}

function sendAimPreview(now) {
  const aim = app.aim;
  if (!aim || aim.fired || !app.aimDirty || now - app.aimSentAt < 80) return;
  app.aimDirty = false;
  app.aimSentAt = now;
  app.session.submit({ type: 'aim', playerId: aim.playerId, turnId: aim.turnId, angle: aim.angle, power: Math.round(aim.power), weaponId: aim.weaponId });
}

function fire() {
  const aim = app.aim;
  if (!aim || aim.fired || !app.session.game.isIdle()) return;
  const result = app.session.submit({ type: 'fire', turnId: aim.turnId, playerId: aim.playerId, angle: aim.angle, power: Math.round(aim.power), weaponId: aim.weaponId });
  if (result && !result.ok && result.error) toast(`Can't fire: ${result.error}`, 'error');
  else if (result?.pending) aim.fired = true; // online: wait for the host to confirm
}

function cycleWeapon(dir) {
  const aim = app.aim;
  if (!aim || aim.fired) return;
  const tank = app.session.state.tanks[aim.playerId];
  const list = availableWeapons(tank);
  const i = list.indexOf(aim.weaponId);
  aim.weaponId = list[(i + dir + list.length) % list.length];
  app.aimDirty = true;
}

function useItem(kind) {
  const aim = app.aim;
  if (!aim || aim.fired || !app.session.game.isIdle()) return;
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

function drive(now) {
  const aim = app.aim;
  if (!aim || aim.fired || !input.driving || !app.session.game.isIdle()) return;
  const tank = app.session.state.tanks[aim.playerId];
  if (!(tank.stock.fuel > 0)) {
    if (!app.noFuelWarned) toast('No fuel. Buy some in the shop to drive.');
    app.noFuelWarned = true;
    return;
  }
  if (app.session.online && now - (app.lastMoveAt ?? 0) < 120) return; // one request in flight
  app.lastMoveAt = now;
  app.session.submit({ type: 'move', turnId: aim.turnId, playerId: aim.playerId, dir: input.driving });
}

function dragAim(event) {
  const aim = app.aim;
  if (!aim || aim.fired) return;
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
input.on('chat', () => {
  if (app.session?.online) chat.open();
});
input.on('help', () => {
  if (!app.session) go(app.screen === 'help' ? 'title' : 'help');
  else app.modal = app.modal === 'help' ? null : 'help';
});
input.on('pause', () => {
  if (!app.session) {
    if (app.message) app.message = null;
    else if (app.screen !== 'title') go('title');
    return;
  }
  if (app.session.online && app.session.status !== 'playing') return;
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
    if (session.game) renderer.handleEvent(event, session.game);
    switch (event.type) {
      case 'turn':
        app.noFuelWarned = false;
        break;
      case 'shop':
        // Until the shop screen exists, humans skip straight to the next round.
        for (const id of session.localShoppers()) session.submit({ type: 'ready', playerId: id });
        break;
      case 'chat':
        chat.add(event);
        break;
      case 'net':
        toast(event.text, event.level === 'error' ? 'error' : '');
        break;
      case 'timeout':
        if (session.controls(event.tank)) toast('Time is up! Firing.');
        break;
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
    if (!app.paused || session.online) {
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
    if (session.game) {
      syncAim();
      input.enabled = !!app.aim && !app.modal && !chat.isOpen;
      input.update(dt);
      drive(now);
      sendAimPreview(now);
    }
  }
  syncOverlay();
  const guide = app.drag && app.aim ? { x: app.drag.x, y: app.drag.y, angle: app.aim.angle, power: app.aim.power } : null;
  const inLobby = session?.online && session.status !== 'playing';
  renderer.draw({
    session: inLobby ? null : session,
    time: now / 1000,
    dt,
    aim: app.aim,
    aimGuide: guide,
    hideHud: !session || inLobby,
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
    const s = app.session;
    if (!s) return `menu:${app.screen}`;
    if (s.online && s.status !== 'playing') return `online:${s.status}`;
    return s.game?.phase ?? 'loading';
  },
  get hash() {
    return app.session?.game ? hashGame(app.session.game) : null;
  },
  get turnId() {
    return app.session?.game?.state.turnId ?? 0;
  },
  get round() {
    return app.session?.game?.state.round ?? 0;
  },
  get seq() {
    return app.session?.seq ?? 0;
  },
  get code() {
    return app.session?.code ?? app.session?.lobby?.code ?? null;
  },
  MAX_POWER,
  WIDTH,
};
