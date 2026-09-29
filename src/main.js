// Wires the game together: sessions, the fixed-timestep loop, input, rendering and the menus.
import { DEFAULT_SETTINGS, DT, MAX_POWER, TANK, TANK_COLORS, WIDTH } from './core/constants.js';
import { Phase, driveProblem } from './core/game.js';
import { FREE_WEAPON, WEAPONS, WEAPON_BY_ID } from './core/weapons.js';
import { hashGame } from './core/hash.js';
import { LocalSession } from './session/session.js';
import { HostSession, resolveAiLevel } from './session/host.js';
import { GuestSession } from './session/guest.js';
import { normalizeRoomCode } from './net/protocol.js';
import { detectSameOriginRelay, hostRelay, joinRelay, normalizeRelayUrl, relayUrlProblem } from './net/relayTransport.js';
import { hostPeer, joinPeer, turnProblem } from './net/peerTransport.js';
import { BUILD, updateAvailable } from './version.js';
import { HUD_HEIGHT, HUD_ZONES, Renderer } from './render/renderer.js';
import { Bubbles } from './render/bubbles.js';
import { Sound } from './audio.js';
import { quipFor } from './quips.js';
import { Input } from './input.js';
import { h } from './ui/dom.js';
import * as screens from './ui/screens.js';
import { Lobby, hostScreen, joinScreen, waitingScreen } from './ui/online.js';
import { ChatBox } from './ui/chat.js';
import { Shop } from './ui/shop.js';
import { TouchControls } from './ui/touch.js';
import { Arsenal } from './ui/arsenal.js';
import { loadLineup, loadMuted, loadOnline, loadSettings, saveLineup, saveMuted, saveOnline, saveSettings } from './storage.js';

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');
const toasts = document.getElementById('toasts');

// index.html reloads the page once if the game's files can't be loaded (an old cached copy of
// the page after an update). They loaded, so allow that again.
try {
  sessionStorage.removeItem('scorched-tanks-reload');
} catch {
  // Storage can be unavailable (private modes); there's nothing to clear then.
}

const renderer = new Renderer(canvas);
const bubbles = new Bubbles();
renderer.bubbles = bubbles;
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
  hudShown: false, // the top bar is on screen (during a battle)
  hudHover: null, // the part of the top bar under the mouse
  driveWarned: new Set(), // drive problems already explained this turn
  settings: loadSettings(),
  lineup: loadLineup() ?? defaultLineup(),
  online: loadOnline(),
  muted: loadMuted(),
  overlayKey: null,
  lobby: null,
  joinCode: '',
  message: null,
  busy: false,
  demo: null,
  demoEndedAt: 0,
  sameOriginRelay: '', // this site's relay address, if it runs one
  relayChecked: false,
};

const sound = new Sound({ volume: app.settings.volume, muted: app.muted });
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => sound.unlock(), { capture: true });
for (const root of [uiRoot, document.getElementById('arsenal')]) {
  root.addEventListener('click', (e) => {
    if (e.target.closest?.('button')) sound.play({ type: 'click' });
  });
}

// --- Overlays --------------------------------------------------------------------------------

function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}`, text });
  toasts.append(el);
  // Long messages stay up long enough to read.
  setTimeout(() => el.remove(), Math.min(12000, Math.max(3600, String(text).length * 55)));
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
    const { title, text, okText, onOk } = app.message;
    return [`message:${title}:${text}`, () => screens.messageScreen({ title, text, okText, onOk: onOk ?? (() => (app.message = null)) })];
  }
  switch (app.screen) {
    case 'title':
      return ['title', () => screens.titleScreen({
        version: BUILD,
        onLocal: () => go('setup'),
        onHost: () => go('host'),
        onJoin: () => go('join'),
        onSettings: () => openSettings('title'),
        onHelp: () => go('help'),
      })];
    case 'setup':
      return ['setup', () => screens.localSetupScreen({
        lineup: app.lineup,
        allowAi: true,
        onChange: () => saveLineup(app.lineup),
        onStart: startLocalGame,
        onBack: () => go('title'),
        onSettings: () => openSettings('setup'),
      })];
    case 'settings':
      return ['settings', () => screens.settingsScreen(app.settings, { onChange: settingsChanged, onClose: () => go(app.settingsBack ?? 'title') })];
    case 'help':
      return ['help', () => screens.helpScreen({ onClose: () => go('title') })];
    case 'host':
      return [`host:${!!app.relayChecked}`, () => hostScreen(app.online, { sameOrigin: app.sameOriginRelay, onCreate: createRoom, onBack: () => go('title') })];
    case 'join':
      return [`join:${app.joinCode}:${!!app.relayChecked}`, () => joinScreen(app.online, { sameOrigin: app.sameOriginRelay, code: app.joinCode, onJoin: joinRoom, onBack: () => go('title') })];
    default:
      return [null, null];
  }
}

function onlineOverlay(session) {
  if (session.status === 'ended') {
    // A guest whose copy of the game is older than the host's can fix it by reloading.
    const reload = !!session.updateNeeded;
    return ['ended', () => screens.messageScreen({
      title: session.versionMismatch ? 'Different versions' : session.isAuthority ? 'Game closed' : 'Disconnected',
      text: session.endReason || 'The game has ended.',
      onOk: reload ? () => reloadWithInvite(session.invite) : quitToTitle,
      okText: reload ? 'Reload' : 'Back to menu',
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
  if (app.modal === 'settings') {
    return ['game-settings', () => screens.settingsScreen(app.settings, { personalOnly: true, onChange: settingsChanged, onClose: () => (app.modal = 'pause') }), true];
  }
  if (app.modal === 'pause') {
    const armed = !!app.aim && !app.aim.fired;
    return [`pause:${app.muted}:${armed}`, () => screens.pauseScreen({
      online: session.online,
      muted: app.muted,
      onResume: closeModal,
      onMute: toggleMute,
      onSettings: () => (app.modal = 'settings'),
      onHelp: () => (app.modal = 'help'),
      onQuit: quitToTitle,
      onArsenal: armed
        ? () => {
            closeModal();
            openArsenal();
          }
        : null,
    }), true];
  }
  switch (game.phase) {
    case Phase.SHOP: {
      const shopper = session.localShoppers()[0];
      if (shopper === undefined) {
        app.shop = null;
        return ['shop-wait', () => waitingScreen('Waiting…', 'The other players are still shopping.', null), true];
      }
      const key = `shop:${game.state.round}:${shopper}`;
      if (app.shop?.key !== key) {
        app.shop = new Shop(session, {
          getTankId: () => session.localShoppers()[0] ?? -1,
          onDone: (id) => session.submit({ type: 'ready', playerId: id }),
        });
        app.shop.key = key;
      }
      return [key, () => app.shop.el, true];
    }
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
  if (key?.startsWith('shop:')) app.shop?.update();
  const online = !!app.session?.online && app.session.status !== 'ended';
  chat.show(online, online && app.session.status === 'lobby');
}

function go(screen) {
  app.screen = screen;
}

function openSettings(back) {
  app.settingsBack = back;
  go('settings');
}

function settingsChanged(settings) {
  app.settings = settings;
  saveSettings(settings);
  sound.setVolume(settings.volume);
  if (!settings.talk) bubbles.clear();
}

function closeModal() {
  app.modal = null;
  app.paused = false;
  input.enabled = !!app.aim && !chat.isOpen; // right away, not on the next frame
}

function toggleMute() {
  app.muted = !app.muted;
  saveMuted(app.muted);
  sound.setMuted(app.muted);
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
  closeArsenal();
  app.session = session;
  app.paused = false;
  app.modal = null;
  app.aim = null;
  app.lobby = null;
  app.overlayKey = '(reset)';
  document.activeElement?.blur?.();
  renderer.resetRound();
  bubbles.clear();
  input.releaseAll();
  chat.clear();
}

function quitToTitle() {
  app.session?.close();
  closeArsenal();
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
  const ice = { turnUrl: opts.turnUrl, turnUser: opts.turnUser, turnPass: opts.turnPass };
  const problem = turnProblem(ice);
  if (problem) throw new Error(problem);
  return ice;
}

/** The relay to use: the one typed in, or this site's own when it runs one. Throws if unusable. */
async function relayAddress(opts) {
  await app.relayProbe;
  const url = normalizeRelayUrl(opts.relayUrl || app.sameOriginRelay);
  if (opts.relayUrl && !url) throw new Error('That relay address does not look right. Paste the https:// address of the relay server.');
  const problem = relayUrlProblem(url);
  if (problem) throw new Error(problem);
  return url;
}

function setStatus(ui, text, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', error);
}

/** Reloads the page to pick up a new version, coming back to the join screen for `invite`. */
function reloadWithInvite(invite) {
  const params = new URLSearchParams();
  if (invite?.code) params.set('join', invite.code);
  if (invite?.relay) params.set('relay', invite.relay);
  const hash = params.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${hash ? `#${hash}` : ''}`);
  location.reload();
}

/**
 * Asks to reload first if a newer version has been published since this page loaded, so
 * nobody hosts or joins with an old copy. Returns true if it did.
 */
async function offeredUpdate(invite = null) {
  if (!(await updateAvailable())) return false;
  app.message = {
    title: 'Update available',
    text: 'A newer version of Scorched Tanks is out. Reload to get it, so you and your friends run the same version.',
    okText: 'Reload',
    onOk: () => reloadWithInvite(invite),
  };
  return true;
}

async function createRoom(opts, ui) {
  if (app.busy) return;
  app.busy = true;
  ui.button.disabled = true;
  opts.name = (opts.name || '').trim().slice(0, 16) || 'Host';
  saveOnline(opts);
  try {
    if (await offeredUpdate()) return;
    let transport;
    if (opts.transport === 'relay') {
      const url = await relayAddress(opts);
      setStatus(ui, 'Opening a room on the relay…');
      transport = await hostRelay(url);
    } else {
      const ice = iceOptions(opts);
      setStatus(ui, 'Contacting the PeerJS signaling server…');
      transport = await hostPeer({ ice, onStatus: (t) => setStatus(ui, t) });
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
    const invite = { code, relay: opts.transport === 'relay' ? normalizeRelayUrl(opts.relayUrl || app.sameOriginRelay) : '' };
    if (await offeredUpdate(invite)) return;
    let conn;
    if (opts.transport === 'relay') {
      const url = await relayAddress(opts);
      setStatus(ui, 'Connecting to the relay…');
      conn = await joinRelay(url, code);
    } else {
      conn = await joinPeer(code, { ice: iceOptions(opts), onStatus: (t) => setStatus(ui, t) });
    }
    const session = new GuestSession({ conn, name: opts.name });
    session.invite = invite;
    startSession(session);
  } catch (error) {
    setStatus(ui, error.message || String(error), true);
  } finally {
    app.busy = false;
    ui.button.disabled = false;
  }
}

chat.onSend((text) => app.session?.sendChat?.(text));

// Offer this site as the relay only if it really runs one (not on GitHub Pages, for example).
// When it does, the relay is also the better default: it works on any network, while direct
// connections between different internet connections often can't get through.
app.relayProbe = detectSameOriginRelay().then((url) => {
  app.sameOriginRelay = url;
  if (url && !app.online.transportChosen && !app.joinCode) app.online.transport = 'relay';
  app.relayChecked = true;
});

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

/**
 * The tank the person at this screen is playing right now, or -1. That's while the game waits
 * for their move, and also while their own drive is still rolling (so their aim survives
 * driving), but not once they've fired.
 */
function localTurnTank(session) {
  const s = session.state;
  if (!s) return -1;
  const driving = s.phase === Phase.BUSY && !s.pendingTurnEnd;
  if (s.phase !== Phase.AIM && !driving) return -1;
  const tank = s.tanks[s.active];
  return tank && tank.alive && !tank.ai && session.controls(tank.id) ? tank.id : -1;
}

function syncAim() {
  const session = app.session;
  // The aim is kept while paused too, so pausing never resets the barrel or the weapon.
  const id = session?.game ? localTurnTank(session) : -1;
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
      power: tank.power,
      weaponId: weapons.includes(tank.weapon) ? tank.weapon : FREE_WEAPON,
      fired: false,
    };
    app.aimDirty = true;
  }
  if (!availableWeapons(tank).includes(app.aim.weaponId)) app.aim.weaponId = FREE_WEAPON;
}

function changeAim(kind, delta) {
  const aim = app.aim;
  if (!aim || aim.fired) return;
  if (kind === 'angle') aim.angle = Math.round(Math.min(180, Math.max(0, aim.angle + delta)) * 10) / 10;
  else aim.power = Math.min(MAX_POWER, Math.max(0, aim.power + delta));
  app.aimDirty = true;
}

function sendAimPreview(now) {
  const aim = app.aim;
  // Wait until the world is at rest: the host ignores previews while a drive is rolling.
  if (!aim || aim.fired || !app.aimDirty || now - app.aimSentAt < 80 || !app.session.game.isIdle()) return;
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

/** Picks a weapon from the weapons & items menu. */
function selectWeapon(weaponId) {
  const aim = app.aim;
  if (!aim || aim.fired) return;
  const tank = app.session.state.tanks[aim.playerId];
  if (!availableWeapons(tank).includes(weaponId)) return;
  aim.weaponId = weaponId;
  app.aimDirty = true;
  closeArsenal();
}

/**
 * Uses an item. The S key asks for 'shield' and gets the strongest one you have; the menu
 * names the exact item ('shield', 'heavyshield' or 'battery').
 */
function useItem(kind, { exact = false } = {}) {
  const aim = app.aim;
  if (!aim || aim.fired || !app.session.game.isIdle()) return;
  const tank = app.session.state.tanks[aim.playerId];
  let item = kind;
  if (kind === 'shield' && !exact) item = tank.stock.heavyshield > 0 ? 'heavyshield' : 'shield';
  if (!(tank.stock[item] > 0)) {
    toast(kind === 'battery' ? 'No batteries. Buy them in the shop.' : 'No shields. Buy them in the shop.');
    return;
  }
  const result = app.session.submit({ type: 'use', turnId: aim.turnId, playerId: aim.playerId, item });
  if (result && !result.ok) toast(`Can't use that: ${result.error}.`, 'error');
}

/** Explains once per turn why a drive can't go on (the free distance is used up, a cliff…). */
function warnDrive(reason) {
  if (app.driveWarned.has(reason)) return;
  app.driveWarned.add(reason);
  const text = {
    range: 'That’s as far as you can drive this turn: two tank lengths either way. Fuel from the shop takes you further.',
    fuel: 'Out of fuel.',
    steep: 'Too steep to drive up.',
    edge: 'That’s the edge of the map.',
  }[reason];
  if (text) toast(text);
}

function drive(now) {
  const aim = app.aim;
  const dir = input.driving || touch.driving || arsenal.driving;
  if (!aim || aim.fired || !dir || !app.session.game.isIdle()) return;
  const tank = app.session.state.tanks[aim.playerId];
  if (driveProblem(tank, dir)) {
    warnDrive('range');
    return;
  }
  if (app.session.online && now - (app.lastMoveAt ?? 0) < 120) return; // one request in flight
  app.lastMoveAt = now;
  app.session.submit({ type: 'move', turnId: aim.turnId, playerId: aim.playerId, dir });
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
  aim.power = Math.round(Math.min(MAX_POWER, Math.max(0, Math.hypot(dx, dy) * 5)));
  app.aimDirty = true;
  app.drag = { x: px, y: py };
}

// --- Weapons & items menu --------------------------------------------------------------------

const arsenal = new Arsenal(document.getElementById('arsenal'), {
  select: selectWeapon,
  use: (id) => useItem(id, { exact: true }),
  close: () => closeArsenal(),
});

/** Opens the weapons & items menu under the weapon in the top bar, if it's your turn. */
function openArsenal() {
  const aim = app.aim;
  if (!aim || aim.fired) {
    if (app.session?.game && app.hudShown) toast('You can change weapons and use items on your turn.');
    return;
  }
  arsenal.show(app.session.state.tanks[aim.playerId], aim);
  placeArsenal();
}

function closeArsenal() {
  arsenal.hide();
}

function toggleArsenal() {
  if (arsenal.isOpen) closeArsenal();
  else openArsenal();
}

/** Anchors the menu just under the top bar's weapon (the bar scales with the window). */
function placeArsenal() {
  if (!arsenal.isOpen) return;
  const rect = canvas.getBoundingClientRect();
  const k = rect.width / WIDTH;
  arsenal.place(rect.left + HUD_ZONES.weapon[0] * k, rect.top + HUD_HEIGHT * k + 6);
}

// Clicking or tapping anywhere outside the menu closes it (the battlefield handles its own).
document.addEventListener('pointerdown', (event) => {
  if (!arsenal.isOpen) return;
  const target = event.target;
  if (arsenal.root.contains(target) || target === canvas || target.closest?.('[data-arsenal-toggle]')) return;
  closeArsenal();
}, { capture: true });

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  // With the menu open, a click on the battlefield (or on the top bar again) just closes it.
  if (arsenal.isOpen) {
    event.preventDefault();
    closeArsenal();
    return;
  }
  // The top bar works like a menu: its weapon, health and items open the weapons & items menu.
  const p = renderer.toWorld(event.clientX, event.clientY);
  if (app.hudShown && p.y < HUD_HEIGHT) {
    event.preventDefault();
    if (renderer.hudZoneAt(p.x, p.y)) openArsenal();
    return;
  }
  if (!app.aim || app.paused) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  dragAim(event);
});
canvas.addEventListener('pointermove', (event) => {
  if (app.drag && canvas.hasPointerCapture(event.pointerId)) {
    dragAim(event);
    return;
  }
  const p = renderer.toWorld(event.clientX, event.clientY);
  const zone = event.pointerType === 'mouse' && app.hudShown && app.aim && p.y < HUD_HEIGHT ? renderer.hudZoneAt(p.x, p.y) : null;
  if (zone !== app.hudHover) {
    app.hudHover = zone;
    canvas.style.cursor = zone ? 'pointer' : '';
  }
});
canvas.addEventListener('pointerleave', () => {
  app.hudHover = null;
  canvas.style.cursor = '';
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
input.on('arsenal', () => toggleArsenal());
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
  if (arsenal.isOpen) closeArsenal();
  else togglePause();
});

function togglePause() {
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
}

const touch = new TouchControls(document.getElementById('touch'), {
  aim: (kind, dir) => changeAim(kind, kind === 'angle' ? dir : dir * 5),
  aimRate: (kind, amount) => changeAim(kind, amount * (kind === 'angle' ? 22 : 90)),
  weapon: (dir) => cycleWeapon(dir),
  fire: () => fire(),
  shield: () => useItem('shield'),
  battery: () => useItem('battery'),
  arsenal: () => toggleArsenal(),
  menu: () => togglePause(),
});

window.addEventListener('resize', () => {
  renderer.resize();
  placeArsenal();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.session && !app.session.online && !app.modal) {
    app.modal = 'pause';
    app.paused = true;
  }
});

// --- Loop ------------------------------------------------------------------------------------

/** Tanks talk when they fire, get hit, die or score a kill (if talking tanks is on). */
function talk(event, game) {
  if (!app.settings.talk) return;
  const s = game.state;
  switch (event.type) {
    case 'fire':
      bubbles.say(event.tank, quipFor('fire', s.turnId, event.tank));
      break;
    case 'damage':
      if (event.amount >= 20 && s.tanks[event.tank]?.alive) bubbles.say(event.tank, quipFor('hit', s.turnId, event.tank, event.amount));
      break;
    case 'death':
      bubbles.say(event.tank, quipFor('death', s.turnId, event.tank));
      if (event.killer >= 0 && event.killer !== event.tank) bubbles.say(event.killer, quipFor('kill', s.turnId, event.killer), 1.4);
      break;
    case 'suddenDeath': {
      const speaker = s.tanks[s.active]?.alive ? s.active : s.tanks.findIndex((t) => t.alive);
      if (speaker >= 0) bubbles.say(speaker, quipFor('sky', s.turnId, speaker));
      break;
    }
    case 'round':
      bubbles.clear();
      break;
  }
}

function handleEvents(session, { quiet = false } = {}) {
  for (const event of session.drainEvents()) {
    if (session.game) {
      renderer.handleEvent(event, session.game);
      talk(event, session.game);
    }
    if (!quiet) sound.play(event);
    switch (event.type) {
      case 'turn':
        app.driveWarned.clear();
        if (!quiet && session.controls(event.tank) && !session.game?.state.tanks[event.tank]?.ai) sound.play({ type: 'yourTurn' });
        break;
      case 'blocked':
        if (!quiet && app.aim?.playerId === event.tank) warnDrive(event.reason);
        break;
      case 'suddenDeath':
        if (!quiet) toast('Sudden death! Shells now fall from the sky after every turn.', 'error');
        break;
      case 'chat':
        chat.add(event);
        break;
      case 'net':
        toast(event.text, event.level === 'error' ? 'error' : '');
        // The host turned down our last move: let the player try again.
        if (app.aim && session.online && !session.isAuthority) app.aim.fired = false;
        break;
      case 'timeout':
        if (session.controls(event.tank)) toast('Time is up! Firing.');
        break;
    }
  }
}

/** An AI-vs-AI battle that plays behind the title menu. */
function makeDemo() {
  const crew = [
    ['Unit 7', 'cyborg'],
    ['Hawkeye', 'spotter'],
    ['Sarge', 'gunner'],
    ['Private Pip', 'rookie'],
  ];
  const players = crew.map(([name, ai], i) => ({ name, color: TANK_COLORS[(i + app.demoCount) % TANK_COLORS.length], ai }));
  app.demoCount = (app.demoCount ?? 0) + 1;
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, startCash: 0, turnTimer: 0, wind: 'medium', talk: app.settings.talk };
  const demo = new LocalSession({ settings, players });
  demo.start();
  demo.commit(demo.planNextRound());
  return demo;
}

function stepDemo(dt, now) {
  if (!app.demo) {
    app.demoCount = app.demoCount ?? 0;
    app.demo = makeDemo();
    app.demoAcc = 0;
    renderer.resetRound();
    bubbles.clear();
  }
  const demo = app.demo;
  app.demoAcc += dt;
  let steps = 0;
  while (app.demoAcc >= DT && steps < 4) {
    demo.update();
    app.demoAcc -= DT;
    steps++;
  }
  if (steps === 4) app.demoAcc = 0;
  handleEvents(demo, { quiet: true });
  const over = demo.game.phase === Phase.ROUND_OVER || demo.game.phase === Phase.GAME_OVER;
  if (over && !app.demoEndedAt) app.demoEndedAt = now;
  if (over && now - app.demoEndedAt > 3500) {
    app.demo = null;
    app.demoEndedAt = 0;
  }
}

let last = performance.now();
let accumulator = 0;

/** Advances the running session by the real time that has passed (at most `maxSteps` ticks). */
function stepSession(session, dt, maxSteps) {
  accumulator += dt;
  let steps = 0;
  while (accumulator >= DT && steps < maxSteps) {
    session.update();
    accumulator -= DT;
    steps++;
  }
  if (steps === maxSteps) accumulator = 0;
}

// Browsers stop animation frames in background tabs. Online, everyone else is waiting on us
// (especially on the host), so keep the simulation going on a timer while hidden.
setInterval(() => {
  const session = app.session;
  if (!document.hidden || !session?.online) return;
  const now = performance.now();
  const dt = Math.min(2, (now - last) / 1000);
  last = now;
  stepSession(session, dt, 240);
  handleEvents(session);
}, 250);

function frame(now) {
  try {
    runFrame(now);
  } catch (error) {
    // Never let one bad frame stop the loop for good.
    if (!app.frameError) console.error('frame failed', error);
    app.frameError = error;
  }
  requestAnimationFrame(frame);
}

function runFrame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const session = app.session;
  const playing = !!session && (!session.online || session.status === 'playing') && !!session.game;
  if (session) {
    if (!app.paused || session.online) stepSession(session, dt, 8);
    handleEvents(session);
    if (session.game) {
      syncAim();
      // The menu belongs to the turn it was opened on.
      if (arsenal.isOpen && (!app.aim || app.aim.fired || app.modal || app.aim.playerId !== arsenal.tankId)) closeArsenal();
      input.enabled = !!app.aim && !app.modal && !chat.isOpen;
      input.update(dt);
      touch.update(dt);
      drive(now);
      sendAimPreview(now);
      if (arsenal.isOpen) arsenal.update({ tank: session.state.tanks[app.aim.playerId], aim: app.aim, idle: session.game.isIdle() });
    }
  }
  if (arsenal.isOpen && !session?.game) closeArsenal();
  if (playing) {
    if (app.demo) {
      app.demo = null;
      renderer.resetRound();
      bubbles.clear();
    }
  } else {
    stepDemo(dt, now);
  }
  syncOverlay();
  const weapon = app.aim ? WEAPON_BY_ID[app.aim.weaponId] : null;
  touch.sync({ inGame: playing, myTurn: !!app.aim && !app.modal, weaponName: weapon?.name });
  const shown = playing ? session : app.demo;
  const battle = playing && (session.game.phase === Phase.AIM || session.game.phase === Phase.BUSY);
  app.hudShown = battle;
  if (!battle || !app.aim) app.hudHover = null;
  bubbles.update(dt);
  sound.update(playing ? session.game : null);
  const guide = app.drag && app.aim ? { x: app.drag.x, y: app.drag.y, angle: app.aim.angle, power: app.aim.power } : null;
  renderer.draw({
    session: shown,
    time: now / 1000,
    dt,
    aim: playing ? app.aim : null,
    aimGuide: playing ? guide : null,
    hideHud: !battle,
    hud: { hover: app.hudHover, open: arsenal.isOpen },
    dim: playing ? (app.modal ? 0.35 : 0) : 0.28,
  });
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
