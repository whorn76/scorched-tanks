// A guest in an online game. It sends intents to the host and applies the host's commands in
// order, each one only when its own simulation is at rest, so every client passes through the
// same states. It checks the host's hash after every shot and asks for a snapshot if it ever
// drifts.
import { Session } from './session.js';
import { hashGame } from '../core/hash.js';
import { loadSnapshot } from '../core/snapshot.js';
import { MAX_SNAPSHOT_PARTS, PROTOCOL_VERSION, parseHostMessage, versionMismatchReason } from '../net/protocol.js';

export class GuestSession extends Session {
  constructor({ conn, name = 'Guest' }) {
    super();
    this.online = true;
    this.conn = conn;
    this.name = name;
    this.status = 'connecting'; // connecting → lobby → playing → ended
    this.lobby = null;
    this.slot = -1;
    this.you = -1;
    this.queue = [];
    this.seq = 0;
    this.loading = false;
    this.awaitingSnapshot = false;
    this.snapshotParts = null;
    this.endReason = '';
    this.lastHash = null;
    this.stats = { syncChecks: 0, mismatches: 0, resyncs: 0, commands: 0 };
    this.pingId = 0;
    this.pings = new Map();
    this.latency = null;
    conn.onMessage((raw) => this.onMessage(raw));
    conn.onClose((reason) => this.onClosed(reason));
    conn.send({ t: 'hello', v: PROTOCOL_VERSION, name });
  }

  onClosed(reason) {
    if (this.status === 'ended') return;
    const was = this.status;
    this.status = 'ended';
    this.endReason = this.endReason || (was === 'connecting' ? 'Could not join the room.' : 'The connection to the host was lost.');
    this.pushEvent({ type: 'ended', reason: this.endReason, detail: reason });
  }

  onMessage(raw) {
    const msg = parseHostMessage(raw);
    if (!msg) return;
    switch (msg.t) {
      case 'welcome':
        this.status = 'lobby';
        this.slot = msg.slot;
        this.pushEvent({ type: 'welcome' });
        break;
      case 'reject':
        if (msg.hostVersion !== undefined && msg.hostVersion !== PROTOCOL_VERSION) {
          // Our own words, so it names the side that's out of date even if the host is old.
          this.versionMismatch = true;
          this.updateNeeded = msg.hostVersion > PROTOCOL_VERSION;
          this.endReason = versionMismatchReason(msg.hostVersion, PROTOCOL_VERSION);
        } else {
          this.endReason = msg.reason;
        }
        this.pushEvent({ type: 'rejected', reason: this.endReason });
        this.status = 'ended';
        this.pushEvent({ type: 'ended', reason: this.endReason });
        this.conn.close();
        break;
      case 'lobby':
        this.lobby = msg;
        this.pushEvent({ type: 'lobby' });
        break;
      case 'start':
        this.beginGame(msg);
        break;
      case 'cmd':
      case 'sync':
        this.queue.push(msg);
        break;
      case 'snapshot':
        this.receiveSnapshotPart(msg);
        break;
      case 'aim':
        if (!this.controls(msg.playerId)) this.setPreview(msg.playerId, msg.angle, msg.power, msg.weaponId);
        break;
      case 'chat':
        this.pushEvent({ type: 'chat', name: msg.name, color: msg.color, text: msg.text, system: msg.system });
        break;
      case 'ready':
        this.ready.add(msg.playerId);
        this.pushEvent({ type: 'ready', tank: msg.playerId });
        break;
      case 'error':
        this.pushEvent({ type: 'net', level: 'warn', text: msg.reason });
        break;
      case 'end':
        this.endReason = msg.reason || 'The host ended the game.';
        break;
      case 'pong': {
        const sent = this.pings.get(msg.id);
        if (sent !== undefined) this.latency = Date.now() - sent;
        this.pings.delete(msg.id);
        break;
      }
    }
  }

  async beginGame(msg) {
    this.loading = true;
    this.status = 'playing';
    try {
      const game = await loadSnapshot(msg.snapshot);
      game.drainEvents();
      this.game = game;
      this.seq = msg.seq;
      this.you = msg.you;
      this.localPlayers = new Set([msg.you]);
      this.loading = false;
      this.pushEvent({ type: 'started' });
    } catch (error) {
      this.loading = false;
      this.endReason = `Could not load the game from the host (${error.message}).`;
      this.conn.close();
    }
  }

  // --- Applying the host's commands ----------------------------------------------------------

  update() {
    this.ticks++;
    if (!this.game || this.loading) return;
    // A snapshot we asked for never arrived in full (a lost message): ask again.
    if (this.awaitingSnapshot && this.ticks - this.resyncAt > 60 * 10) {
      this.awaitingSnapshot = false;
      this.snapshotParts = null;
      this.requestResync('snapshot timed out');
    }
    this.processQueue();
    // Catch up faster when commands are piling up (e.g. after a background tab).
    const behind = this.queue.filter((m) => m.t === 'cmd').length;
    const steps = behind > 1 ? 4 : behind === 1 ? 2 : 1;
    for (let i = 0; i < steps; i++) {
      this.game.tick();
      this.collectGameEvents();
      if (this.game.isIdle()) this.processQueue();
    }
  }

  processQueue() {
    while (this.queue.length && this.game.isIdle() && !this.awaitingSnapshot && !this.loading) {
      const msg = this.queue[0];
      if (msg.t === 'cmd') {
        if (msg.seq <= this.seq) {
          this.queue.shift();
          continue;
        }
        if (msg.seq !== this.seq + 1) {
          this.requestResync('missing commands');
          return;
        }
        this.queue.shift();
        let result;
        try {
          result = this.game.apply(msg.cmd);
        } catch (error) {
          result = { ok: false, error: error.message };
        }
        this.seq = msg.seq;
        this.stats.commands++;
        this.collectGameEvents();
        if (!result.ok) {
          this.requestResync(`the host's ${msg.cmd.type} did not apply here (${result.error})`);
          return;
        }
      } else {
        if (msg.seq > this.seq) {
          // The channel is ordered, so the commands before this check were lost on the way.
          if (!this.queue.some((m) => m.t === 'cmd' && m.seq === this.seq + 1)) this.requestResync('missing commands');
          return;
        }
        this.queue.shift();
        if (msg.seq === this.seq) this.checkHash(msg.hash);
      }
    }
  }

  checkHash(hash) {
    this.stats.syncChecks++;
    this.lastHash = hashGame(this.game);
    if (this.lastHash !== hash) {
      this.stats.mismatches++;
      this.requestResync('state hash mismatch');
    }
  }

  requestResync(reason) {
    if (this.awaitingSnapshot) return;
    this.awaitingSnapshot = true;
    this.resyncAt = this.ticks;
    this.stats.resyncs++;
    this.conn.send({ t: 'resync' });
    this.pushEvent({ type: 'net', level: 'warn', text: 'Out of sync with the host. Repairing…', detail: reason });
  }

  receiveSnapshotPart(msg) {
    if (!this.snapshotParts || this.snapshotParts.id !== msg.id) {
      this.snapshotParts = { id: msg.id, total: msg.total, parts: new Array(msg.total), got: 0, seq: null };
    }
    const sp = this.snapshotParts;
    if (msg.total !== sp.total || msg.total > MAX_SNAPSHOT_PARTS || sp.parts[msg.part] !== undefined) return;
    sp.parts[msg.part] = msg.data;
    sp.got++;
    if (msg.part === 0) sp.seq = msg.seq;
    if (sp.got === sp.total && sp.seq !== null) this.applySnapshot(sp);
  }

  async applySnapshot(sp) {
    this.snapshotParts = null;
    this.loading = true;
    try {
      const game = await loadSnapshot(JSON.parse(sp.parts.join('')));
      game.drainEvents();
      this.game = game;
      this.seq = sp.seq;
      this.queue = this.queue.filter((m) => m.seq > sp.seq);
      this.awaitingSnapshot = false;
      this.pushEvent({ type: 'resynced' });
    } catch (error) {
      this.awaitingSnapshot = false;
      this.pushEvent({ type: 'net', level: 'error', text: `Could not repair the game (${error.message}).` });
    } finally {
      this.loading = false;
    }
  }

  // --- Sending intents -----------------------------------------------------------------------

  submit(intent) {
    if (this.status !== 'playing' || !intent) return { ok: false, error: 'not playing' };
    switch (intent.type) {
      case 'aim':
      case 'fire':
        this.conn.send({ t: intent.type, turnId: intent.turnId, angle: intent.angle, power: intent.power, weaponId: intent.weaponId });
        if (intent.type === 'aim') this.setPreview(intent.playerId, intent.angle, intent.power, intent.weaponId);
        break;
      case 'move':
        this.conn.send({ t: 'move', turnId: intent.turnId, dir: intent.dir });
        break;
      case 'use':
        this.conn.send({ t: 'use', turnId: intent.turnId, item: intent.item });
        break;
      case 'buy':
      case 'sell':
        this.conn.send({ t: intent.type, item: intent.item });
        break;
      case 'ready':
        this.conn.send({ t: 'ready' });
        this.ready.add(this.you);
        break;
      default:
        return { ok: false, error: 'unknown intent' };
    }
    return { ok: true, pending: true };
  }

  sendChat(text) {
    this.conn.send({ t: 'chat', text });
  }

  ping() {
    const id = ++this.pingId;
    this.pings.set(id, Date.now());
    this.conn.send({ t: 'ping', id });
  }

  /** Local players still shopping: just us, until we click Ready. */
  localShoppers() {
    if (!this.game || this.game.phase !== 'shop' || this.ready.has(this.you)) return [];
    const tank = this.game.state.tanks[this.you];
    return tank && !tank.ai ? [this.you] : [];
  }

  close() {
    if (this.status !== 'ended') {
      this.status = 'ended';
      this.endReason = 'You left the game.';
    }
    this.conn.close();
    super.close();
  }
}
