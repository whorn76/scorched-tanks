// Screens for online play: hosting, joining, and the lobby where players gather before a game.
import { AI_LEVELS, MAX_TANKS } from '../core/constants.js';
import { MAX_HUMANS } from '../net/protocol.js';
import { h, select } from './dom.js';
import { GAMEPLAY_KEYS, settingsForm } from './settingsForm.js';
import { AI_LABELS } from './screens.js';

function connectionFields(opts, { sameOrigin }) {
  const relayInput = h('input', {
    class: 'wide-input',
    id: 'relay-url',
    value: opts.relayUrl || sameOrigin,
    placeholder: sameOrigin || 'wss://your-relay.example.com/ws',
    oninput: (e) => (opts.relayUrl = e.target.value.trim()),
  });
  const relayRow = h('div', { class: 'field indent', hidden: opts.transport !== 'relay' }, h('label', { for: 'relay-url', text: 'Relay server address' }), relayInput);
  const radio = (value, label, hint) =>
    h('label', { class: 'radio' },
      h('input', {
        type: 'radio',
        name: 'transport',
        value,
        checked: opts.transport === value,
        onchange: () => {
          opts.transport = value;
          relayRow.hidden = value !== 'relay';
        },
      }),
      h('span', {}, h('strong', { text: label }), h('small', { text: hint })));
  const turnField = (key, label, type = 'text', placeholder = '') =>
    h('div', { class: 'field' },
      h('label', { for: `turn-${key}`, text: label }),
      h('input', { id: `turn-${key}`, type, value: opts[key], placeholder, autocomplete: 'off', oninput: (e) => (opts[key] = e.target.value.trim()) }));
  return [
    h('div', { class: 'field' },
      h('span', { class: 'field-label', text: 'Connection' }),
      radio('peer', 'Direct (peer-to-peer)', 'WebRTC through the free PeerJS service. Best for most people.'),
      radio('relay', 'Relay server', 'Every message goes through a server running "npm start". Use when direct connections fail.')),
    relayRow,
    h('details', { class: 'advanced' },
      h('summary', { text: 'Advanced: TURN server' }),
      h('p', { class: 'hint', text: 'Some networks (strict NATs, corporate firewalls) block direct WebRTC connections. A TURN server relays the traffic. Both players should enter the same one.' }),
      turnField('turnUrl', 'TURN URL(s)', 'text', 'turn:turn.example.com:3478'),
      turnField('turnUser', 'Username'),
      turnField('turnPass', 'Password', 'password')),
  ];
}

export function hostScreen(opts, { sameOrigin, onCreate, onBack }) {
  const status = h('p', { class: 'status', id: 'net-status' });
  const button = h('button', { class: 'btn primary', id: 'btn-create-room', text: 'Create room' });
  button.addEventListener('click', () => onCreate(opts, { status, button }));
  return h('div', { class: 'panel', id: 'host-screen' },
    h('h2', { text: 'Host Online' }),
    h('p', { class: 'hint', text: `Create a room and share its code. Up to ${MAX_HUMANS} people can play, plus AI tanks.` }),
    h('div', { class: 'field' },
      h('label', { for: 'host-name', text: 'Your name' }),
      h('input', { id: 'host-name', value: opts.name, maxlength: 16, oninput: (e) => (opts.name = e.target.value) })),
    ...connectionFields(opts, { sameOrigin }),
    status,
    h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: onBack, text: 'Back' }), button));
}

export function joinScreen(opts, { sameOrigin, code = '', onJoin, onBack }) {
  const status = h('p', { class: 'status', id: 'net-status' });
  const codeInput = h('input', {
    id: 'join-code',
    class: 'code-input',
    value: code,
    maxlength: 7,
    placeholder: 'CODE',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    oninput: (e) => (e.target.value = e.target.value.toUpperCase()),
  });
  const button = h('button', { class: 'btn primary', id: 'btn-join-room', text: 'Join' });
  button.addEventListener('click', () => onJoin(codeInput.value, opts, { status, button }));
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') button.click();
  });
  return h('div', { class: 'panel', id: 'join-screen' },
    h('h2', { text: 'Join Online' }),
    h('div', { class: 'field' }, h('label', { for: 'join-code', text: 'Room code' }), codeInput),
    h('div', { class: 'field' },
      h('label', { for: 'join-name', text: 'Your name' }),
      h('input', { id: 'join-name', value: opts.name, maxlength: 16, oninput: (e) => (opts.name = e.target.value) })),
    ...connectionFields(opts, { sameOrigin }),
    status,
    h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: onBack, text: 'Back' }), button));
}

export function waitingScreen(title, text, onCancel) {
  return h('div', { class: 'panel narrow', id: 'waiting' },
    h('h2', { text: title }),
    h('p', { class: 'hint', text }),
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    onCancel ? h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: onCancel, text: 'Cancel' })) : null);
}

const KIND_LABEL = { host: 'Host', guest: 'Player', ai: 'AI' };

/** The lobby. Built once; update() refreshes the parts that change without losing focus. */
export class Lobby {
  constructor(session, { isHost, inviteLink, onStart, onLeave, onCopy }) {
    this.session = session;
    this.isHost = isHost;
    this.players = h('ul', { class: 'lobby-players', id: 'lobby-players' });
    this.settingsBox = h('div', { class: 'lobby-settings' });
    this.startButton = isHost ? h('button', { class: 'btn primary', id: 'btn-start-online', onclick: onStart, text: 'Start game' }) : null;
    this.note = h('p', { class: 'hint lobby-note' });
    this.aiLevel = 'gunner';
    const code = isHost ? session.code : session.lobby?.code ?? '';
    this.codeEl = h('div', { class: 'room-code', id: 'room-code', text: code });
    this.addAiRow = isHost
      ? h('div', { class: 'row' },
          select(AI_LEVELS.map((l) => [l, AI_LABELS[l]]).concat([['random', AI_LABELS.random]]), this.aiLevel, (v) => (this.aiLevel = v), { 'aria-label': 'AI level', id: 'ai-level' }),
          h('button', { class: 'btn', id: 'btn-add-ai', onclick: () => session.addAi(this.aiLevel), text: '+ Add AI tank' }))
      : null;
    this.el = h('div', { class: 'panel wide lobby', id: 'lobby' },
      h('div', { class: 'lobby-head' },
        h('div', {}, h('h2', { text: isHost ? 'Your room' : 'Lobby' }), h('p', { class: 'hint', text: isHost ? 'Share the code or the invite link with friends.' : 'Waiting for the host to start the game.' })),
        h('div', { class: 'code-box' },
          h('span', { class: 'field-label', text: 'Room code' }),
          this.codeEl,
          inviteLink ? h('button', { class: 'btn small', id: 'btn-copy-invite', onclick: () => onCopy(inviteLink), text: 'Copy invite link' }) : null)),
      h('div', { class: 'lobby-grid' },
        h('div', {}, h('h3', { text: 'Tanks' }), this.players, this.addAiRow),
        h('div', {}, h('h3', { text: 'Settings' }), this.settingsBox)),
      this.note,
      h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: onLeave, text: 'Leave' }), this.startButton));
    this.lastPlayers = '';
    this.lastSettings = '';
    this.update();
  }

  playerList() {
    if (this.isHost) return this.session.lobbyView();
    return this.session.lobby?.players ?? [];
  }

  update() {
    const players = this.playerList();
    const key = JSON.stringify(players);
    if (key !== this.lastPlayers) {
      this.lastPlayers = key;
      const mySlot = this.isHost ? 0 : this.session.slot;
      this.players.replaceChildren(...players.map((p) =>
        h('li', { class: 'lobby-player' },
          h('span', { class: 'chip', style: { background: p.color } }),
          h('span', { class: 'lobby-name', text: p.name }),
          p.slot === mySlot ? h('span', { class: 'badge you', text: 'You' }) : null,
          h('span', { class: `badge ${p.kind}`, text: p.kind === 'ai' ? AI_LABELS[p.ai] ?? 'AI' : KIND_LABEL[p.kind] }),
          this.isHost && p.kind !== 'host' ? h('button', { class: 'btn icon small', title: p.kind === 'ai' ? 'Remove' : 'Remove player', onclick: () => this.session.removeSlot(p.slot), text: '✕' }) : null)));
      const humans = players.filter((p) => p.kind !== 'ai').length;
      if (this.addAiRow) this.addAiRow.querySelector('button').disabled = players.length >= MAX_TANKS;
      this.note.textContent = `${players.length} of ${MAX_TANKS} tanks · ${humans} of ${MAX_HUMANS} people.` + (this.isHost && players.length < 2 ? ' Add an AI tank or wait for a friend to join.' : '');
      if (this.startButton) this.startButton.disabled = players.length < 2;
    }
    const settings = this.isHost ? this.session.settings : this.session.lobby?.settings ?? {};
    const skey = JSON.stringify(settings);
    if (skey !== this.lastSettings) {
      this.lastSettings = skey;
      const copy = { ...settings };
      this.settingsBox.replaceChildren(settingsForm(copy, {
        keys: GAMEPLAY_KEYS,
        readOnly: !this.isHost,
        onChange: (s) => {
          this.lastSettings = JSON.stringify({ ...this.session.settings, ...s });
          this.session.setSettings(s);
        },
      }));
    }
    if (!this.isHost && this.session.lobby?.code) this.codeEl.textContent = this.session.lobby.code;
  }
}
