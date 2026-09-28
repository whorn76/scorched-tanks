// Transports carry protocol messages between the host and its guests. They all expose the same
// small interface, so the sessions don't care whether they run over WebRTC, a WebSocket relay or
// an in-process loopback:
//
//   Connection     { id, send(msg), onMessage(fn), onClose(fn), close() }
//   HostTransport  { code, kind, inviteParams, onConnection(fn), onClose(fn), close() }
//
// Messages are plain JSON-serializable objects.

/** Base class for connections: handles listener registration and a single close. */
export class Connection {
  constructor(id) {
    this.id = id;
    this.messageHandlers = [];
    this.closeHandlers = [];
    this.closed = false;
  }

  onMessage(fn) {
    this.messageHandlers.push(fn);
  }

  onClose(fn) {
    this.closeHandlers.push(fn);
  }

  deliver(msg) {
    if (this.closed) return;
    for (const fn of this.messageHandlers) {
      try {
        fn(msg);
      } catch (error) {
        console.error('message handler failed', error);
      }
    }
  }

  fireClose(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeHandlers) fn(reason);
  }

  send() {
    throw new Error('not implemented');
  }

  close() {
    this.fireClose('closed');
  }
}

export class HostTransportBase {
  constructor(kind, code) {
    this.kind = kind;
    this.code = code;
    this.inviteParams = {};
    this.connectionHandlers = [];
    this.closeHandlers = [];
    this.closed = false;
  }

  onConnection(fn) {
    this.connectionHandlers.push(fn);
  }

  onClose(fn) {
    this.closeHandlers.push(fn);
  }

  accept(conn) {
    for (const fn of this.connectionHandlers) fn(conn);
  }

  fireClose(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeHandlers) fn(reason);
  }
}

// --- Loopback ----------------------------------------------------------------------------------

class LoopbackConnection extends Connection {
  constructor(hub, id) {
    super(id);
    this.hub = hub;
    this.peer = null;
  }

  send(msg) {
    if (this.closed || !this.peer) return;
    // Serialize like a real network would, so no objects are shared between the two ends.
    const text = JSON.stringify(msg);
    const peer = this.peer;
    this.hub.enqueue(() => peer.deliver(JSON.parse(text)));
  }

  close() {
    if (this.closed) return;
    const peer = this.peer;
    this.fireClose('closed');
    this.hub.enqueue(() => peer?.fireClose('peer closed'));
  }
}

/**
 * An in-process "network" for tests. With `manual: true` nothing is delivered until flush() is
 * called, which makes multi-client tests fully deterministic.
 */
export class LoopbackHub {
  constructor({ manual = false } = {}) {
    this.manual = manual;
    this.queue = [];
    this.hosts = new Map();
    this.nextId = 1;
    this.scheduled = false;
  }

  enqueue(fn) {
    this.queue.push(fn);
    if (!this.manual && !this.scheduled) {
      this.scheduled = true;
      setTimeout(() => {
        this.scheduled = false;
        this.flush();
      }, 0);
    }
  }

  /** Delivers everything queued so far (and anything it triggers). Returns the count. */
  flush(limit = 100000) {
    let n = 0;
    while (this.queue.length && n < limit) {
      this.queue.shift()();
      n++;
    }
    return n;
  }

  host(code = `LOOP${this.hosts.size + 1}`) {
    const transport = new HostTransportBase('loopback', code);
    transport.close = () => {
      this.hosts.delete(code);
      transport.fireClose('closed');
    };
    this.hosts.set(code, transport);
    return transport;
  }

  /** Connects to a hosted room. Resolves with the guest end of the connection. */
  async connect(code) {
    const host = this.hosts.get(code);
    if (!host) throw new Error('Room not found');
    const id = `loop-${this.nextId++}`;
    const guestEnd = new LoopbackConnection(this, id);
    const hostEnd = new LoopbackConnection(this, id);
    guestEnd.peer = hostEnd;
    hostEnd.peer = guestEnd;
    host.accept(hostEnd);
    return guestEnd;
  }

  /** Synchronous variant for manual-mode tests. */
  connectNow(code) {
    const host = this.hosts.get(code);
    if (!host) throw new Error('Room not found');
    const id = `loop-${this.nextId++}`;
    const guestEnd = new LoopbackConnection(this, id);
    const hostEnd = new LoopbackConnection(this, id);
    guestEnd.peer = hostEnd;
    hostEnd.peer = guestEnd;
    host.accept(hostEnd);
    return guestEnd;
  }
}
