// The WebSocket relay for online play: a fallback for networks where direct WebRTC connections
// fail. One host and up to five guests share a room identified by a short code. The relay
// forwards messages without looking inside them, and it enforces limits on room size, message
// size, message rate, connections per address and idle time. Rooms disappear as soon as their
// host leaves.
import { WebSocketServer } from 'ws';
import { randomInt } from 'node:crypto';

export const RELAY_VERSION = 1;
const ALPHABET = 'ACEFGHKMNPRTWXY34679';
const CODE_LENGTH = 5;

export const LIMITS = {
  maxGuests: 5,
  maxRooms: 500,
  maxPayload: 64 * 1024, // bytes per message
  rate: 60, // messages per second, sustained (a host gets this much again per guest)
  burst: 150,
  helloTimeoutMs: 15000, // a socket must host or join this quickly
  heartbeatMs: 30000,
  maxConnectionsPerAddress: 24,
  maxRoomsPerAddress: 4,
  idleRoomMs: 30 * 60 * 1000, // a room with no traffic for this long is closed
  maxBuffered: 1024 * 1024, // a socket that stops reading gets closed
};

function makeCode(rooms) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

class Bucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Behind a tunnel or proxy every socket comes from the proxy, so prefer its client header. */
function addressOf(req) {
  const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

/**
 * Attaches the relay to an HTTP server on the /ws path. Returns { close, rooms, stats }.
 */
export async function attachRelay(server, options = {}) {
  const limits = { ...LIMITS, ...options };
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayload });
  const rooms = new Map(); // code → { host, guests: Map(peerId → ws), nextPeer, address, lastActive }
  const perAddress = new Map(); // address → open connections
  const stats = { connections: 0, messages: 0, dropped: 0, errors: 0 };

  const send = (ws, obj) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > limits.maxBuffered) {
      ws.terminate(); // not reading its messages; don't buffer for it forever
      return;
    }
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      stats.errors++;
      return;
    }
    ws.send(text);
  };

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      // fall through
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const address = addressOf(req);
    if ((perAddress.get(address) ?? 0) >= limits.maxConnectionsPerAddress) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, address));
  });

  wss.on('connection', (ws, req, address) => {
    stats.connections++;
    perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
    const client = { role: null, code: null, peer: null, address, bucket: new Bucket(limits.rate, limits.burst), strikes: 0 };
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const helloTimer = setTimeout(() => {
      if (!client.role) ws.close(4000, 'no hello');
    }, limits.helloTimeoutMs);

    ws.on('message', (raw, isBinary) => {
      stats.messages++;
      try {
        if (!client.bucket.take()) {
          stats.dropped++;
          // Tell the sender once in a while instead of dropping silently, and cut off floods.
          if (++client.strikes % 50 === 1) send(ws, { type: 'error', reason: 'rate' });
          if (client.strikes > 300) ws.close(4008, 'rate limit');
          return;
        }
        if (isBinary) return;
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object') return;
        handle(ws, client, msg);
      } catch {
        stats.errors++; // malformed or pathological input: ignore it, never crash the server
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      const left = (perAddress.get(address) ?? 1) - 1;
      if (left > 0) perAddress.set(address, left);
      else perAddress.delete(address);
      leave(ws, client);
    });
    ws.on('error', () => {});
  });

  function roomsOf(address) {
    let n = 0;
    for (const room of rooms.values()) if (room.address === address) n++;
    return n;
  }

  function handle(ws, client, msg) {
    const room = client.code ? rooms.get(client.code) : null;
    if (room) room.lastActive = Date.now();
    switch (msg.type) {
      case 'host': {
        if (client.role) return;
        if (msg.v !== RELAY_VERSION) return send(ws, { type: 'error', reason: 'version' });
        if (rooms.size >= limits.maxRooms || roomsOf(client.address) >= limits.maxRoomsPerAddress) {
          return send(ws, { type: 'error', reason: 'busy' });
        }
        const code = makeCode(rooms);
        if (!code) return send(ws, { type: 'error', reason: 'busy' });
        rooms.set(code, { host: ws, hostClient: client, guests: new Map(), nextPeer: 1, address: client.address, lastActive: Date.now() });
        client.role = 'host';
        client.code = code;
        return send(ws, { type: 'hosted', code });
      }
      case 'join': {
        if (client.role) return;
        if (msg.v !== RELAY_VERSION) return send(ws, { type: 'error', reason: 'version' });
        const code = typeof msg.code === 'string' ? msg.code.toUpperCase() : '';
        const target = rooms.get(code);
        if (!target) return send(ws, { type: 'error', reason: 'no-room' });
        if (target.guests.size >= limits.maxGuests) return send(ws, { type: 'error', reason: 'full' });
        const peer = `p${target.nextPeer++}`;
        target.guests.set(peer, ws);
        target.lastActive = Date.now();
        client.role = 'guest';
        client.code = code;
        client.peer = peer;
        // The host relays to every guest, so its budget grows with the room.
        const hostBucket = target.hostClient.bucket;
        hostBucket.rate = limits.rate * (1 + target.guests.size);
        hostBucket.burst = limits.burst * (1 + target.guests.size);
        send(ws, { type: 'joined', code });
        return send(target.host, { type: 'peer-join', peer });
      }
      case 'to': {
        if (client.role !== 'host' || typeof msg.peer !== 'string') return;
        const target = room?.guests.get(msg.peer);
        if (target) send(target, { type: 'data', data: msg.data });
        return;
      }
      case 'data': {
        if (client.role !== 'guest') return;
        if (room) send(room.host, { type: 'from', peer: client.peer, data: msg.data });
        return;
      }
      case 'kick': {
        if (client.role !== 'host' || typeof msg.peer !== 'string') return;
        room?.guests.get(msg.peer)?.close(4003, 'removed by host');
        return;
      }
      case 'ping':
        return send(ws, { type: 'pong' });
      default:
    }
  }

  function leave(ws, client) {
    const room = client.code ? rooms.get(client.code) : null;
    if (!room) return;
    if (client.role === 'host' && room.host === ws) {
      rooms.delete(client.code);
      for (const guest of room.guests.values()) guest.close(4001, 'host-left');
    } else if (client.role === 'guest' && room.guests.get(client.peer) === ws) {
      room.guests.delete(client.peer);
      send(room.host, { type: 'peer-leave', peer: client.peer });
    }
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.lastActive > limits.idleRoomMs) {
        rooms.delete(code);
        room.host.close(4002, 'idle');
        for (const guest of room.guests.values()) guest.close(4002, 'idle');
      }
    }
  }, limits.heartbeatMs);
  heartbeat.unref?.();

  return {
    rooms,
    stats,
    wss,
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
