// The host of an online game. It owns the truth: it runs the lobby, validates every message from
// its guests, resolves their intents into commands, applies them and broadcasts them in order
// (numbered by `seq`). After each shot settles it broadcasts a state hash; a guest whose hash
// differs asks for a snapshot. AI tanks, including guests who dropped out, run here.
import { AuthoritySession } from './session.js';
import { AI_LEVELS, MAX_TANKS, TANK_COLORS, sanitizeSettings } from '../core/constants.js';
import { Phase } from '../core/game.js';
import { hashGame } from '../core/hash.js';
import { makeSnapshot } from '../core/snapshot.js';
import { int16ToBase64 } from '../core/bytes.js';
import {
  MAX_HUMANS,
  MAX_SNAPSHOT_PARTS,
  PROTOCOL_VERSION,
  RateLimiter,
  SNAPSHOT_CHUNK,
  cleanText,
  parseGuestMessage,
} from '../net/protocol.js';

const AIM_BROADCAST_TICKS = 5; // ≈ 12 aim previews per second
const HELLO_TIMEOUT_MS = 10000;

const AI_NAMES = {
  rookie: ['Rookie Rick', 'Private Pip', 'Cadet Kay', 'Greenhorn Gus'],
  gunner: ['Gunner Gail', 'Sarge', 'Boomer', 'Captain Crater'],
  spotter: ['Spotter Sam', 'Hawkeye', 'Rangefinder', 'Lookout Lou'],
  cyborg: ['Cyborg X', 'Unit 7', 'Deep Thud', 'Tin Terror'],
  random: ['Wildcard', 'Mystery Tank', 'Dice Roller', 'Loose Cannon'],
};

export function resolveAiLevel(level, random = Math.random) {
  if (AI_LEVELS.includes(level)) return level;
  return AI_LEVELS[Math.floor(random() * AI_LEVELS.length)];
}

/** Commands as they travel: typed arrays become base64. */
export function wireCommand(cmd) {
  if (cmd.type === 'newRound') return { ...cmd, heights: int16ToBase64(cmd.heights) };
  return cmd;
}

export class HostSession extends AuthoritySession {
  constructor({ transport, name = 'Host', settings = {}, seed, aiFast = false }) {
    super({ seed, aiFast });
    this.online = true;
    this.transport = transport;
    this.code = transport.code;
    this.status = 'lobby'; // lobby → starting → playing → ended
    this.settings = sanitizeSettings(settings);
    this.peers = new Map();
    this.lobbyPlayers = [{ slot: 0, name: cleanText(name, 16) || 'Host', color: TANK_COLORS[0], kind: 'host', ai: null, peer: null }];
    this.nextSlot = 1;
    this.snapshotWaiters = new Set();
    this.snapshotBusy = false;
    this.snapshotId = 1;
    this.pendingControl = [];
    this.pendingAim = new Map();
    this.lastAimTick = new Map();
    this.syncsSent = 0;
    transport.onConnection((conn) => this.onConnection(conn));
    transport.onClose((reason) => {
      if (this.status !== 'ended') this.pushEvent({ type: 'net', level: 'warn', text: `Room connection lost (${reason}). Guests already here stay connected.` });
    });
  }

  // --- Lobby ---------------------------------------------------------------------------------

  lobbyView() {
    return this.lobbyPlayers.map(({ slot, name, color, kind, ai }) => ({ slot, name, color, kind, ai }));
  }

  humans() {
    return this.lobbyPlayers.filter((p) => p.kind !== 'ai').length;
  }

  canStart() {
    return this.status === 'lobby' && this.lobbyPlayers.length >= 2;
  }

  freeColor() {
    const used = new Set(this.lobbyPlayers.map((p) => p.color));
    return TANK_COLORS.find((c) => !used.has(c)) ?? TANK_COLORS[this.lobbyPlayers.length % TANK_COLORS.length];
  }

  uniqueName(name) {
    const taken = new Set(this.lobbyPlayers.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 20; i++) {
      const candidate = `${name.slice(0, 13)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  addAi(level = 'gunner') {
    if (this.status !== 'lobby' || this.lobbyPlayers.length >= MAX_TANKS) return false;
    const key = AI_NAMES[level] ? level : 'gunner';
    const names = AI_NAMES[key];
    const name = this.uniqueName(names[this.lobbyPlayers.filter((p) => p.kind === 'ai').length % names.length]);
    this.lobbyPlayers.push({ slot: this.nextSlot++, name, color: this.freeColor(), kind: 'ai', ai: key, peer: null });
    this.broadcastLobby();
    return true;
  }

  removeSlot(slot) {
    const player = this.lobbyPlayers.find((p) => p.slot === slot);
    if (!player || player.kind === 'host' || this.status !== 'lobby') return;
    if (player.kind === 'ai') {
      this.lobbyPlayers = this.lobbyPlayers.filter((p) => p !== player);
      this.broadcastLobby();
    } else if (player.peer) {
      this.rejectPeer(player.peer, 'The host removed you from the room.');
    }
  }

  setSettings(settings) {
    if (this.status !== 'lobby') return;
    this.settings = sanitizeSettings({ ...this.settings, ...settings });
    this.broadcastLobby();
  }

  broadcastLobby() {
    const msg = { t: 'lobby', players: this.lobbyView(), settings: this.settings, code: this.code };
    for (const peer of this.peers.values()) if (peer.state === 'lobby') peer.conn.send(msg);
    this.pushEvent({ type: 'lobby' });
  }

  /** Creates the game from the lobby and sends every guest its starting snapshot. */
  async startGame() {
    if (!this.canStart()) return { ok: false, error: 'Need at least two tanks.' };
    this.status = 'starting';
    const players = this.lobbyPlayers.map((p) => ({ name: p.name, color: p.color, ai: p.kind === 'ai' ? resolveAiLevel(p.ai) : null }));
    this.setupGame(this.settings, players);
    this.lobbyPlayers.forEach((p, i) => {
      p.playerId = i;
      if (p.peer) p.peer.playerId = i;
    });
    this.localPlayers = new Set([0]);
    const seq = this.seq;
    const snapshot = await makeSnapshot(this.game);
    for (const peer of this.peers.values()) {
      if (peer.state !== 'lobby') continue;
      peer.state = 'playing';
      peer.conn.send({ t: 'start', seq, you: peer.playerId, snapshot });
    }
    this.status = 'playing';
    this.started = true;
    this.pushEvent({ type: 'started' });
    return { ok: true };
  }

  // --- Connections ---------------------------------------------------------------------------

  onConnection(conn) {
    const peer = { conn, state: 'hello', slot: -1, playerId: -1, name: 'Guest', limiter: new RateLimiter(30, 60), strikes: 0 };
    this.peers.set(conn.id, peer);
    conn.onMessage((raw) => this.onPeerMessage(peer, raw));
    conn.onClose(() => this.onPeerClose(peer));
    peer.helloTimer = setTimeout(() => {
      if (peer.state === 'hello') this.rejectPeer(peer, 'No handshake received.');
    }, HELLO_TIMEOUT_MS);
    peer.helloTimer.unref?.();
  }

  rejectPeer(peer, reason) {
    if (peer.state === 'closed') return;
    clearTimeout(peer.helloTimer);
    peer.conn.send({ t: 'reject', reason });
    const wasState = peer.state;
    peer.state = 'rejected';
    const timer = setTimeout(() => peer.conn.close(), 150);
    timer.unref?.();
    if (wasState === 'lobby') this.dropFromLobby(peer);
  }

  onPeerMessage(peer, raw) {
    if (peer.state === 'closed' || peer.state === 'rejected') return;
    if (!peer.limiter.allow()) {
      if (peer.limiter.dropped > 300) this.rejectPeer(peer, 'Too many messages.');
      return;
    }
    const msg = parseGuestMessage(raw);
    if (!msg) {
      peer.strikes++;
      if (peer.strikes > 50) this.rejectPeer(peer, 'Too many invalid messages.');
      return;
    }
    if (peer.state === 'hello') {
      this.handshake(peer, msg);
      return;
    }
    switch (msg.t) {
      case 'hello':
        return;
      case 'chat':
        this.chat(peer.name, this.colorOf(peer), msg.text);
        return;
      case 'ping':
        peer.conn.send({ t: 'pong', id: msg.id });
        return;
      case 'resync':
        if (peer.state === 'playing') this.snapshotWaiters.add(peer);
        return;
      default:
        if (peer.state === 'playing' && this.status === 'playing') this.guestIntent(peer, msg);
    }
  }

  handshake(peer, msg) {
    clearTimeout(peer.helloTimer);
    if (msg.t !== 'hello') return this.rejectPeer(peer, 'Unexpected message before the handshake.');
    if (msg.v !== PROTOCOL_VERSION) {
      return this.rejectPeer(peer, `Version mismatch: the host runs protocol v${PROTOCOL_VERSION} and you have v${msg.v}. Reload the page to update.`);
    }
    if (this.status !== 'lobby') return this.rejectPeer(peer, 'That game has already started.');
    if (this.humans() >= MAX_HUMANS || this.lobbyPlayers.length >= MAX_TANKS) return this.rejectPeer(peer, 'That room is full.');
    peer.state = 'lobby';
    peer.name = this.uniqueName(msg.name);
    peer.slot = this.nextSlot++;
    this.lobbyPlayers.push({ slot: peer.slot, name: peer.name, color: this.freeColor(), kind: 'guest', ai: null, peer });
    peer.conn.send({ t: 'welcome', v: PROTOCOL_VERSION, slot: peer.slot });
    this.broadcastLobby();
    this.systemChat(`${peer.name} joined.`);
  }

  colorOf(peer) {
    return this.lobbyPlayers.find((p) => p.peer === peer)?.color ?? '#cccccc';
  }

  dropFromLobby(peer) {
    const before = this.lobbyPlayers.length;
    this.lobbyPlayers = this.lobbyPlayers.filter((p) => p.peer !== peer);
    if (this.lobbyPlayers.length !== before) {
      this.broadcastLobby();
      this.systemChat(`${peer.name} left.`);
    }
  }

  onPeerClose(peer) {
    clearTimeout(peer.helloTimer);
    const state = peer.state;
    peer.state = 'closed';
    this.peers.delete(peer.conn.id);
    this.snapshotWaiters.delete(peer);
    if (state === 'lobby') this.dropFromLobby(peer);
    if ((state === 'playing' || state === 'rejected') && this.game && peer.playerId >= 0 && this.status === 'playing') {
      const tank = this.game.state.tanks[peer.playerId];
      if (tank && !tank.ai) {
        this.pendingControl.push({ type: 'control', playerId: peer.playerId, ai: 'gunner' });
        this.systemChat(`${peer.name} disconnected. An AI takes over their tank.`);
      }
    }
  }

  guestIntent(peer, msg) {
    const playerId = peer.playerId;
    let result;
    switch (msg.t) {
      case 'aim': {
        const s = this.game.state;
        if (s.phase !== Phase.AIM || s.active !== playerId || msg.turnId !== s.turnId) return;
        result = this.handleIntent({ type: 'aim', playerId, turnId: msg.turnId, angle: msg.angle, power: msg.power, weaponId: msg.weaponId });
        break;
      }
      case 'fire':
        result = this.handleIntent({ type: 'fire', playerId, turnId: msg.turnId, angle: msg.angle, power: msg.power, weaponId: msg.weaponId });
        break;
      case 'move':
        result = this.handleIntent({ type: 'move', playerId, turnId: msg.turnId, dir: msg.dir });
        if (!result.ok && result.error === 'busy') return; // they'll send another while the key is held
        break;
      case 'use':
        result = this.handleIntent({ type: 'use', playerId, turnId: msg.turnId, item: msg.item });
        break;
      case 'buy':
      case 'sell':
        result = this.handleIntent({ type: msg.t, playerId, item: msg.item });
        break;
      case 'ready':
        result = this.markReady(playerId);
        break;
      default:
        return;
    }
    if (result && !result.ok) peer.conn.send({ t: 'error', reason: result.error });
  }

  // --- Broadcasting --------------------------------------------------------------------------

  broadcast(msg, except = null) {
    for (const peer of this.peers.values()) {
      if (peer.state === 'playing' && peer !== except) peer.conn.send(msg);
    }
  }

  onCommit(cmd) {
    this.broadcast({ t: 'cmd', seq: this.seq, cmd: wireCommand(cmd) });
    if (this.game.isIdle()) this.sendSync();
  }

  onSettled() {
    this.sendSync();
  }

  sendSync() {
    this.syncsSent++;
    this.broadcast({ t: 'sync', seq: this.seq, hash: hashGame(this.game) });
  }

  onPreview(playerId) {
    this.pendingAim.set(playerId, this.previews.get(playerId));
  }

  markReady(playerId) {
    const result = super.markReady(playerId);
    if (result.ok) this.broadcast({ t: 'ready', playerId, ready: true });
    return result;
  }

  chat(name, color, text) {
    const msg = { t: 'chat', name, color, text: cleanText(text, 200) };
    if (!msg.text) return;
    for (const peer of this.peers.values()) if (peer.state === 'lobby' || peer.state === 'playing') peer.conn.send(msg);
    this.pushEvent({ type: 'chat', name, color, text: msg.text });
  }

  sendChat(text) {
    this.chat(this.lobbyPlayers[0].name, this.lobbyPlayers[0].color, text);
  }

  systemChat(text) {
    const msg = { t: 'chat', name: '', color: '#cccccc', text, system: true };
    for (const peer of this.peers.values()) if (peer.state === 'lobby' || peer.state === 'playing') peer.conn.send(msg);
    this.pushEvent({ type: 'chat', system: true, text });
  }

  // --- Loop ----------------------------------------------------------------------------------

  update() {
    super.update();
    if (!this.game || this.status !== 'playing') return;
    // Aim previews, throttled.
    for (const [playerId, aim] of this.pendingAim) {
      const last = this.lastAimTick.get(playerId) ?? -Infinity;
      if (this.ticks - last < AIM_BROADCAST_TICKS) continue;
      this.lastAimTick.set(playerId, this.ticks);
      this.pendingAim.delete(playerId);
      const owner = [...this.peers.values()].find((p) => p.playerId === playerId);
      this.broadcast({ t: 'aim', playerId, angle: aim.angle, power: aim.power, weaponId: aim.weaponId }, owner);
    }
    if (!this.game.isIdle()) return;
    while (this.pendingControl.length && this.game.isIdle()) {
      const cmd = this.pendingControl.shift();
      this.commit(cmd);
      if (this.game.phase === Phase.SHOP) this.ready.delete(cmd.playerId);
    }
    if (this.snapshotWaiters.size && !this.snapshotBusy) this.sendSnapshots();
  }

  async sendSnapshots() {
    this.snapshotBusy = true;
    const waiters = [...this.snapshotWaiters];
    this.snapshotWaiters.clear();
    const seq = this.seq;
    try {
      const snapshot = await makeSnapshot(this.game); // captured synchronously, compressed async
      const text = JSON.stringify(snapshot);
      const total = Math.ceil(text.length / SNAPSHOT_CHUNK);
      if (total > MAX_SNAPSHOT_PARTS) throw new Error('snapshot too large');
      const id = this.snapshotId++;
      for (const peer of waiters) {
        if (peer.state !== 'playing') continue;
        for (let part = 0; part < total; part++) {
          const data = text.slice(part * SNAPSHOT_CHUNK, (part + 1) * SNAPSHOT_CHUNK);
          peer.conn.send({ t: 'snapshot', id, part, total, seq: part === 0 ? seq : undefined, data });
        }
      }
    } catch (error) {
      this.pushEvent({ type: 'net', level: 'error', text: `Could not send a snapshot: ${error.message}` });
    } finally {
      this.snapshotBusy = false;
    }
  }

  close() {
    if (this.status === 'ended') return;
    this.status = 'ended';
    for (const peer of this.peers.values()) {
      peer.conn.send({ t: 'end', reason: 'The host left the game.' });
      const conn = peer.conn;
      const timer = setTimeout(() => conn.close(), 150);
      timer.unref?.();
    }
    const timer = setTimeout(() => this.transport.close(), 200);
    timer.unref?.();
    super.close();
  }
}
