// Online play through a WebSocket relay (server/relay.js). The relay only forwards messages
// between the host and the guests in a room; the game logic is identical to peer-to-peer play.
// Works in browsers and in Node (which has a global WebSocket since v22).
import { Connection, HostTransportBase } from './transport.js';

export const RELAY_VERSION = 1;

/** The relay URL to use when the page itself is served by the relay server. */
export function sameOriginRelayUrl(loc = globalThis.location) {
  if (!loc || !/^https?:$/.test(loc.protocol)) return '';
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

/**
 * Resolves with this site's relay address when the page is served by the relay server
 * (`npm start`, for example behind cloudflared), or '' when it isn't (GitHub Pages and other
 * static hosts), so the relay option never points at a server that doesn't exist. Static hosts
 * serve the checked-in relay.json ({"relay": false}); the relay server answers it live.
 */
export async function detectSameOriginRelay(loc = globalThis.location, fetchFn = globalThis.fetch) {
  if (!loc || !/^https?:$/.test(loc.protocol) || typeof fetchFn !== 'function') return '';
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined;
    const res = await fetchFn(new URL('relay.json', loc.href).href, { cache: 'no-store', signal });
    if (!res.ok) return '';
    const info = await res.json();
    if (!info || info.relay !== true) return '';
    const ws = new URL('ws', loc.href);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.search = '';
    ws.hash = '';
    return ws.href;
  } catch {
    return '';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why a relay address can't work from this page, or '' if it can. */
export function relayUrlProblem(url, loc = globalThis.location) {
  if (!url) return 'Enter the address of a relay server. This site does not run one itself: start one with "npm start" (for example behind cloudflared) and paste its https address.';
  if (loc?.protocol === 'https:' && url.startsWith('ws://') && !LOCAL_HOSTS.has(new URL(url).hostname)) {
    return 'This page was loaded over https, so browsers only allow secure relay addresses. Use the https:// (or wss://) address of the relay.';
  }
  return '';
}

/** Accepts http(s) or ws(s) URLs and returns a ws(s) URL ending in /ws, or '' if unusable. */
export function normalizeRelayUrl(text) {
  let value = String(text ?? '').trim();
  if (!value) return '';
  if (!/^[a-z]+:\/\//i.test(value)) value = `wss://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  url.hash = '';
  return url.toString();
}

function openSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      reject(new Error(`Bad relay URL: ${error.message}`));
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Could not reach the relay server.'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Could not reach the relay server.'));
    });
  });
}

/** Waits for the first relay message that `match` accepts. */
function nextMessage(ws, match, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The relay server did not answer.'));
    }, timeoutMs);
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg?.type === 'error') {
        cleanup();
        reject(new Error(relayError(msg.reason)));
      } else if (match(msg)) {
        cleanup();
        resolve(msg);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('The relay server closed the connection.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
  });
}

function relayError(reason) {
  switch (reason) {
    case 'no-room':
      return 'No room with that code. Check the code and the relay address.';
    case 'full':
      return 'That room is full.';
    case 'version':
      return 'The relay server runs a different version.';
    case 'busy':
      return 'The relay server is busy. Try again in a moment.';
    default:
      return `Relay error: ${reason ?? 'unknown'}`;
  }
}

const sendJson = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};

class RelayPeer extends Connection {
  constructor(ws, peerId) {
    super(peerId);
    this.ws = ws;
  }

  send(msg) {
    if (!this.closed) sendJson(this.ws, { type: 'to', peer: this.id, data: msg });
  }

  close() {
    if (this.closed) return;
    sendJson(this.ws, { type: 'kick', peer: this.id });
    this.fireClose('closed');
  }
}

/** Opens a room on the relay. Resolves with a HostTransport. */
export async function hostRelay(url, { timeoutMs = 10000 } = {}) {
  const ws = await openSocket(url, timeoutMs);
  sendJson(ws, { type: 'host', v: RELAY_VERSION });
  const hosted = await nextMessage(ws, (m) => m.type === 'hosted', timeoutMs);
  const transport = new HostTransportBase('relay', hosted.code);
  transport.inviteParams = { relay: url };
  const peers = new Map();
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'peer-join' && typeof msg.peer === 'string') {
      const peer = new RelayPeer(ws, msg.peer);
      peers.set(msg.peer, peer);
      transport.accept(peer);
    } else if (msg.type === 'from') {
      peers.get(msg.peer)?.deliver(msg.data);
    } else if (msg.type === 'peer-leave') {
      peers.get(msg.peer)?.fireClose('left');
      peers.delete(msg.peer);
    }
  });
  ws.addEventListener('close', () => {
    for (const peer of peers.values()) peer.fireClose('relay closed');
    peers.clear();
    transport.fireClose('relay closed');
  });
  const ping = setInterval(() => sendJson(ws, { type: 'ping' }), 25000);
  transport.close = () => {
    clearInterval(ping);
    ws.close(1000, 'host closed');
  };
  ws.addEventListener('close', () => clearInterval(ping));
  return transport;
}

class RelayGuest extends Connection {
  constructor(ws) {
    super('host');
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'data') this.deliver(msg.data);
    });
    ws.addEventListener('close', (event) => this.fireClose(event.reason || 'relay closed'));
    this.ping = setInterval(() => sendJson(ws, { type: 'ping' }), 25000);
  }

  send(msg) {
    if (!this.closed) sendJson(this.ws, { type: 'data', data: msg });
  }

  close() {
    clearInterval(this.ping);
    if (this.ws.readyState <= 1) this.ws.close(1000, 'guest left');
    this.fireClose('closed');
  }

  fireClose(reason) {
    clearInterval(this.ping);
    super.fireClose(reason);
  }
}

/** Joins a room on the relay. Resolves with the connection to the host. */
export async function joinRelay(url, code, { timeoutMs = 10000 } = {}) {
  const ws = await openSocket(url, timeoutMs);
  sendJson(ws, { type: 'join', code, v: RELAY_VERSION });
  await nextMessage(ws, (m) => m.type === 'joined', timeoutMs);
  return new RelayGuest(ws);
}
