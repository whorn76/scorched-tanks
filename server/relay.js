// The WebSocket relay for online play: a fallback for networks where direct WebRTC connections
// fail. One host and up to five guests share a room identified by a short code. The relay
// forwards messages without looking inside them, and it enforces limits on room size, message
// size and message rate. Rooms disappear as soon as their host leaves.
import { WebSocketServer } from 'ws';
import { randomInt } from 'node:crypto';

export const RELAY_VERSION = 1;
const ALPHABET = 'ACEFGHKMNPRTWXY34679';
const CODE_LENGTH = 5;

export const LIMITS = {
  maxGuests: 5,
  maxRooms: 500,
  maxPayload: 64 * 1024, // bytes per message
  rate: 60, // messages per second, sustained
  burst: 150,
  helloTimeoutMs: 15000, // a socket must host or join this quickly
  heartbeatMs: 30000,
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

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};

/**
 * Attaches the relay to an HTTP server on the /ws path. Returns { close, rooms, stats }.
 */
export async function attachRelay(server, options = {}) {
  const limits = { ...LIMITS, ...options };
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayload });
  const rooms = new Map(); // code → { host, guests: Map(peerId → ws), nextPeer }
  const stats = { connections: 0, messages: 0, dropped: 0 };

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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    stats.connections++;
    const client = { role: null, code: null, peer: null, bucket: new Bucket(limits.rate, limits.burst) };
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const helloTimer = setTimeout(() => {
      if (!client.role) ws.close(4000, 'no hello');
    }, limits.helloTimeoutMs);

    ws.on('message', (raw, isBinary) => {
      stats.messages++;
      if (!client.bucket.take()) {
        stats.dropped++;
        if (client.bucket.tokens < -limits.burst) ws.close(4008, 'rate limit');
        client.bucket.tokens -= 0.5; // repeat offenders drain further and get closed
        return;
      }
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      handle(ws, client, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      leave(ws, client);
    });
    ws.on('error', () => {});
  });

  function handle(ws, client, msg) {
    switch (msg.type) {
      case 'host': {
        if (client.role) return;
        if (msg.v !== RELAY_VERSION) return send(ws, { type: 'error', reason: 'version' });
        if (rooms.size >= limits.maxRooms) return send(ws, { type: 'error', reason: 'busy' });
        const code = makeCode(rooms);
        if (!code) return send(ws, { type: 'error', reason: 'busy' });
        rooms.set(code, { host: ws, guests: new Map(), nextPeer: 1 });
        client.role = 'host';
        client.code = code;
        return send(ws, { type: 'hosted', code });
      }
      case 'join': {
        if (client.role) return;
        if (msg.v !== RELAY_VERSION) return send(ws, { type: 'error', reason: 'version' });
        const code = typeof msg.code === 'string' ? msg.code.toUpperCase() : '';
        const room = rooms.get(code);
        if (!room) return send(ws, { type: 'error', reason: 'no-room' });
        if (room.guests.size >= limits.maxGuests) return send(ws, { type: 'error', reason: 'full' });
        const peer = `p${room.nextPeer++}`;
        room.guests.set(peer, ws);
        client.role = 'guest';
        client.code = code;
        client.peer = peer;
        send(ws, { type: 'joined', code });
        return send(room.host, { type: 'peer-join', peer });
      }
      case 'to': {
        if (client.role !== 'host') return;
        const target = rooms.get(client.code)?.guests.get(msg.peer);
        if (target) send(target, { type: 'data', data: msg.data });
        return;
      }
      case 'data': {
        if (client.role !== 'guest') return;
        const room = rooms.get(client.code);
        if (room) send(room.host, { type: 'from', peer: client.peer, data: msg.data });
        return;
      }
      case 'kick': {
        if (client.role !== 'host') return;
        const target = rooms.get(client.code)?.guests.get(msg.peer);
        target?.close(4003, 'removed by host');
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
