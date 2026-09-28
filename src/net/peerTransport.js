// Online play over WebRTC data channels, using PeerJS and its free public signaling server
// (0.peerjs.com) to find each other. After the handshake, game traffic goes directly between
// browsers. PeerJS is loaded on demand from vendor/, so local games never download it.
import { Connection, HostTransportBase } from './transport.js';
import { PEER_PREFIX, makeRoomCode } from './protocol.js';

const PEERJS_SRC = new URL('../../vendor/peerjs/peerjs.min.js', import.meta.url).href;

export const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

// PeerJS's own default config also lists free TURN servers (eu-0/us-0.turn.peerjs.com), but
// those hosts no longer exist, so there is no free relay to fall back on: players on strict
// networks need the WebSocket relay or their own TURN server (the Advanced fields).

/** TURN URLs from the Advanced field (comma or space separated), keeping only turn: and turns:. */
export function parseTurnUrls(text = '') {
  return String(text)
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^turns?:/i.test(u));
}

/** Why the Advanced TURN settings can't be used, or '' if they're fine (or empty). */
export function turnProblem({ turnUrl = '', turnUser = '', turnPass = '' } = {}) {
  if (!String(turnUrl).trim()) return '';
  if (!parseTurnUrls(turnUrl).length) return 'TURN addresses start with turn: or turns:.';
  if (!turnUser || !turnPass) return 'A TURN server needs a username and a password.';
  return '';
}

/** Google STUN, plus the player's own TURN server if they set one. */
export function iceServers({ turnUrl = '', turnUser = '', turnPass = '' } = {}) {
  const servers = [...STUN_SERVERS];
  const urls = parseTurnUrls(turnUrl);
  if (urls.length && turnUser && turnPass) servers.push({ urls, username: turnUser, credential: turnPass });
  return servers;
}

let loading = null;

/** Loads vendor/peerjs/peerjs.min.js once and resolves with the global Peer class. */
export function loadPeerJs() {
  if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PEERJS_SRC;
      script.async = true;
      script.onload = () => (globalThis.Peer ? resolve(globalThis.Peer) : reject(new Error('PeerJS failed to load.')));
      script.onerror = () => {
        loading = null;
        reject(new Error('PeerJS failed to load.'));
      };
      document.head.append(script);
    });
  }
  return loading;
}

function peerError(err) {
  switch (err?.type) {
    case 'peer-unavailable':
      return 'No room with that code (or the host has left).';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the PeerJS signaling server. Try the relay server option.';
    case 'browser-incompatible':
      return 'This browser does not support WebRTC. Try the relay server option.';
    case 'unavailable-id':
      return 'That room code is taken.';
    default:
      return err?.message || 'Connection failed.';
  }
}

class PeerConnection extends Connection {
  constructor(conn, owner = null) {
    super(conn.peer);
    this.conn = conn;
    this.owner = owner; // the guest's own Peer, destroyed when the connection closes
    conn.on('data', (data) => this.deliver(data));
    conn.on('close', () => this.fireClose('closed'));
    conn.on('error', () => this.fireClose('error'));
    // Some browsers only report a dead peer through the ICE state. "disconnected" can be a
    // blip, so it only counts once it has lasted a while.
    conn.peerConnection?.addEventListener?.('iceconnectionstatechange', () => {
      const state = conn.peerConnection.iceConnectionState;
      clearTimeout(this.iceTimer);
      if (state === 'failed' || state === 'closed') this.fireClose(state);
      else if (state === 'disconnected') this.iceTimer = setTimeout(() => this.fireClose('disconnected'), 10000);
    });
  }

  send(msg) {
    if (this.closed || !this.conn.open) return;
    try {
      this.conn.send(msg);
    } catch {
      this.fireClose('send failed');
    }
  }

  close() {
    if (this.closed) return;
    this.fireClose('closed');
    try {
      this.conn.close();
    } catch {
      // already gone
    }
  }

  fireClose(reason) {
    if (this.closed) return;
    clearTimeout(this.iceTimer);
    super.fireClose(reason);
    if (this.owner) setTimeout(() => this.owner.destroy(), 100);
  }
}

function waitForOpen(peer, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ type: 'timeout', message: 'Timed out contacting the PeerJS server.' }), timeoutMs);
    const finish = (result) => {
      clearTimeout(timer);
      peer.off?.('open', onOpen);
      peer.off?.('error', onError);
      resolve(result);
    };
    const onOpen = () => finish('open');
    const onError = (err) => finish(err);
    peer.on('open', onOpen);
    peer.on('error', onError);
  });
}

/** Creates a room: registers `scorchedtanks-CODE` on the signaling server, retrying on clashes. */
export async function hostPeer({ ice = {}, timeoutMs = 15000, onStatus = () => {} } = {}) {
  const Peer = await loadPeerJs();
  const config = { iceServers: iceServers(ice) };
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = makeRoomCode();
    onStatus(`Registering room ${code}…`);
    const peer = new Peer(PEER_PREFIX + code, { config, debug: 1 });
    const result = await waitForOpen(peer, timeoutMs);
    if (result !== 'open') {
      peer.destroy();
      if (result?.type === 'unavailable-id') continue;
      throw new Error(peerError(result));
    }
    const transport = new HostTransportBase('peer', code);
    peer.on('connection', (conn) => {
      const accept = () => transport.accept(new PeerConnection(conn));
      if (conn.open) accept();
      else conn.on('open', accept);
    });
    // Losing the signaling server only stops new guests from joining; try to get it back.
    peer.on('disconnected', () => {
      if (!transport.closed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => {
      if (err?.type === 'unavailable-id' || err?.type === 'invalid-id') transport.fireClose(peerError(err));
    });
    transport.close = () => {
      transport.fireClose('closed');
      peer.destroy();
    };
    return transport;
  }
  throw new Error('Could not get a free room code. Try again.');
}

/** Joins a room by code. Resolves with the connection to the host. */
export async function joinPeer(code, { ice = {}, timeoutMs = 20000, onStatus = () => {} } = {}) {
  const Peer = await loadPeerJs();
  const peer = new Peer({ config: { iceServers: iceServers(ice) }, debug: 1 });
  onStatus('Contacting the signaling server…');
  const opened = await waitForOpen(peer, timeoutMs);
  if (opened !== 'open') {
    peer.destroy();
    throw new Error(peerError(opened));
  }
  onStatus('Connecting to the host…');
  const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ type: 'timeout', message: 'Could not connect to the host. Both networks may be blocking connections: try your own TURN server (Advanced) or the relay server.' }), timeoutMs);
    conn.on('open', () => {
      clearTimeout(timer);
      resolve('open');
    });
    peer.on('error', (err) => {
      clearTimeout(timer);
      resolve(err);
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
  if (result !== 'open') {
    peer.destroy();
    throw new Error(peerError(result));
  }
  return new PeerConnection(conn, peer);
}
