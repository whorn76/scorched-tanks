// Menu screens built as DOM overlays: title, local setup, pause, help, round summary and final
// standings. Each function returns an element; main.js decides which one is showing.
import { AI_CHOICES, MAX_TANKS, MIN_TANKS, TANK_COLORS } from '../core/constants.js';
import { ITEMS, WEAPONS } from '../core/weapons.js';
import { h, money, select } from './dom.js';
import { GAMEPLAY_KEYS, PERSONAL_KEYS, settingsForm } from './settingsForm.js';

export const AI_LABELS = {
  rookie: 'AI · Rookie',
  gunner: 'AI · Gunner',
  spotter: 'AI · Spotter',
  cyborg: 'AI · Cyborg',
  random: 'AI · Random',
};

export function logo() {
  return h('div', { class: 'logo' }, h('span', { class: 'logo-top', text: 'SCORCHED' }), h('span', { class: 'logo-bottom', text: 'TANKS' }));
}

export function titleScreen({ onLocal, onHost, onJoin, onSettings, onHelp }) {
  return h(
    'div',
    { class: 'panel title-panel', id: 'title-screen' },
    logo(),
    h('p', { class: 'tagline', text: 'Turn-based artillery. Blow up the hills, and each other.' }),
    h('div', { class: 'menu' },
      h('button', { class: 'btn primary big', id: 'btn-local', onclick: onLocal, text: 'Local Game' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn big', id: 'btn-host', onclick: onHost, text: 'Host Online' }),
        h('button', { class: 'btn big', id: 'btn-join', onclick: onJoin, text: 'Join Online' })),
      h('div', { class: 'row' },
        h('button', { class: 'btn', id: 'btn-settings', onclick: onSettings, text: 'Settings' }),
        h('button', { class: 'btn', id: 'btn-help', onclick: onHelp, text: 'How to Play' }))),
    h('p', { class: 'fineprint', text: 'A tribute to Scorched Earth (1991). Press H any time for help.' }),
  );
}

/** Editable list of tanks for a local game. `lineup` is mutated in place; `onChange` saves it. */
export function lineupEditor(lineup, { onChange, allowAi = true, maxTanks = MAX_TANKS }) {
  const list = h('div', { class: 'lineup' });
  const typeOptions = [['human', 'Human'], ...(allowAi ? AI_CHOICES.map((id) => [id, AI_LABELS[id]]) : [])];
  const render = () => {
    list.replaceChildren(
      ...lineup.map((entry, i) =>
        h('div', { class: 'lineup-row' },
          h('button', {
            class: 'color-dot',
            title: 'Change color',
            style: { background: entry.color },
            onclick: () => {
              const used = new Set(lineup.map((e) => e.color));
              const start = TANK_COLORS.indexOf(entry.color);
              for (let k = 1; k <= TANK_COLORS.length; k++) {
                const next = TANK_COLORS[(start + k) % TANK_COLORS.length];
                if (!used.has(next)) {
                  entry.color = next;
                  break;
                }
              }
              onChange();
              render();
            },
          }),
          h('input', {
            class: 'name-input',
            value: entry.name,
            maxlength: 16,
            'aria-label': `Tank ${i + 1} name`,
            oninput: (e) => {
              entry.name = e.target.value.slice(0, 16);
              onChange();
            },
          }),
          select(typeOptions, entry.type, (value) => {
            entry.type = value;
            onChange();
          }, { 'aria-label': `Tank ${i + 1} type`, class: 'type-select' }),
          h('button', {
            class: 'btn icon',
            title: 'Remove',
            disabled: lineup.length <= MIN_TANKS,
            onclick: () => {
              lineup.splice(i, 1);
              onChange();
              render();
            },
            text: '✕',
          }),
        ),
      ),
      h('button', {
        class: 'btn add-tank',
        disabled: lineup.length >= maxTanks,
        onclick: () => {
          const used = new Set(lineup.map((e) => e.color));
          const color = TANK_COLORS.find((c) => !used.has(c)) ?? TANK_COLORS[0];
          lineup.push({ name: `Tank ${lineup.length + 1}`, color, type: allowAi ? 'gunner' : 'human' });
          onChange();
          render();
        },
        text: '+ Add tank',
      }),
    );
  };
  render();
  return list;
}

export function localSetupScreen({ lineup, allowAi, onChange, onStart, onBack, onSettings }) {
  return h(
    'div',
    { class: 'panel', id: 'local-setup' },
    h('h2', { text: 'Local Game' }),
    h('p', { class: 'hint', text: 'Two to six tanks. Humans take turns at this keyboard; AI tanks play themselves.' }),
    lineupEditor(lineup, { onChange, allowAi }),
    h('div', { class: 'row end' },
      onSettings ? h('button', { class: 'btn', onclick: onSettings, text: 'Settings' }) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: onBack, text: 'Back' }),
      h('button', { class: 'btn primary', id: 'btn-start-local', onclick: onStart, text: 'Start battle' })),
  );
}

export function pauseScreen({ online, onResume, onHelp, onSettings, onQuit, muted, onMute }) {
  return h(
    'div',
    { class: 'panel narrow', id: 'pause-menu' },
    h('h2', { text: online ? 'Menu' : 'Paused' }),
    online ? h('p', { class: 'hint', text: 'The game keeps running for everyone else.' }) : null,
    h('div', { class: 'menu' },
      h('button', { class: 'btn primary', onclick: onResume, text: 'Resume' }),
      h('button', { class: 'btn', onclick: onMute, text: muted ? 'Sound: off' : 'Sound: on' }),
      onSettings ? h('button', { class: 'btn', onclick: onSettings, text: 'Sound & talk' }) : null,
      h('button', { class: 'btn', onclick: onHelp, text: 'How to play' }),
      h('button', { class: 'btn danger', onclick: onQuit, text: online ? 'Leave game' : 'Quit to title' })),
  );
}

const KEYS = [
  ['← / →', 'Turn the barrel (hold to speed up, Shift for fine steps)'],
  ['↑ / ↓', 'Power up / down'],
  ['Space / Enter', 'Fire'],
  ['Tab / Shift+Tab, [ ]', 'Next / previous weapon'],
  ['A / D', 'Drive left / right (needs fuel)'],
  ['S', 'Raise a shield'],
  ['B', 'Use a battery'],
  ['Mouse / touch drag', 'Aim: direction sets angle, distance sets power'],
  ['T', 'Chat (online)'],
  ['M', 'Mute'],
  ['Esc', 'Menu / pause'],
  ['H or ?', 'This help'],
];

export function helpScreen({ onClose }) {
  const weaponRows = WEAPONS.map((w) => h('tr', {}, h('td', { text: w.name }), h('td', { text: w.price ? `${money(w.price)} / ${w.bundle}` : 'Free' }), h('td', { text: w.blurb })));
  const itemRows = ITEMS.map((it) => h('tr', {}, h('td', { text: it.name }), h('td', { text: `${money(it.price)} / ${it.bundle}` }), h('td', { text: it.blurb })));
  return h(
    'div',
    { class: 'panel wide', id: 'help-screen' },
    h('h2', { text: 'How to Play' }),
    h('p', { text: 'Take turns lobbing shells at the other tanks. Set your angle and power, mind the wind, and fire. Last tank standing wins the round. Hits and kills earn cash to spend in the shop between rounds.' }),
    h('div', { class: 'help-grid' },
      h('table', { class: 'keys' }, h('tbody', {}, KEYS.map(([k, v]) => h('tr', {}, h('th', { text: k }), h('td', { text: v }))))),
      h('div', { class: 'scroll' },
        h('table', { class: 'shop-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Weapon' }), h('th', { text: 'Price' }), h('th', { text: '' }))),
          h('tbody', {}, weaponRows),
          h('thead', {}, h('tr', {}, h('th', { text: 'Item' }), h('th', { text: 'Price' }), h('th', { text: '' }))),
          h('tbody', {}, itemRows)))),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: onClose, text: 'Got it' })),
  );
}

export function roundSummary(game) {
  const s = game.state;
  const r = s.results;
  if (!r) return h('div');
  const winner = s.tanks[r.winner];
  const title = r.timeUp
    ? winner
      ? `Time's up! ${winner.name} wins round ${r.round}`
      : `Time's up! Round ${r.round} is a draw`
    : winner
      ? `${winner.name} wins round ${r.round}!`
      : `Round ${r.round}: nobody survived!`;
  const rows = [...r.earnings]
    .sort((a, b) => b.total - a.total)
    .map((e) => {
      const tank = s.tanks[e.tank];
      return h('tr', {},
        h('td', {}, h('span', { class: 'chip', style: { background: tank.color } }), tank.name),
        h('td', { text: String(e.damage) }),
        h('td', { text: String(e.kills) }),
        h('td', { class: 'money', text: `+${money(e.total)}` }));
    });
  return h(
    'div',
    { class: 'panel banner', id: 'round-summary' },
    h('h2', { text: title }),
    h('table', { class: 'results' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Tank' }), h('th', { text: 'Damage' }), h('th', { text: 'Kills' }), h('th', { text: 'Earned' }))),
      h('tbody', {}, rows)),
    h('p', { class: 'hint', text: game.isLastRound() ? 'Final results coming up…' : 'Next: the shop.' }),
  );
}

export function standingsScreen(game, { onAgain, onMenu, canRestart = true }) {
  const ranked = game.standings();
  const rows = ranked.map((tank, i) =>
    h('tr', { class: i === 0 ? 'first' : '' },
      h('td', { text: String(i + 1) }),
      h('td', {}, h('span', { class: 'chip', style: { background: tank.color } }), tank.name),
      h('td', { text: String(tank.stats.wins) }),
      h('td', { text: String(tank.stats.kills) }),
      h('td', { text: String(tank.stats.damage) }),
      h('td', { class: 'money', text: money(tank.money) })));
  return h(
    'div',
    { class: 'panel', id: 'standings' },
    h('h2', { text: `${ranked[0].name} wins the war!` }),
    h('table', { class: 'results' },
      h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: 'Tank' }), h('th', { text: 'Rounds won' }), h('th', { text: 'Kills' }), h('th', { text: 'Damage' }), h('th', { text: 'Money' }))),
      h('tbody', {}, rows)),
    h('div', { class: 'row end' },
      canRestart && onAgain ? h('button', { class: 'btn primary', onclick: onAgain, text: 'Play again' }) : null,
      h('button', { class: 'btn', onclick: onMenu, text: 'Main menu' })),
  );
}

export function messageScreen({ title, text, onOk, okText = 'OK' }) {
  return h('div', { class: 'panel narrow', id: 'message' },
    h('h2', { text: title }),
    h('p', { text }),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: onOk, text: okText })));
}

/** Settings. `personalOnly` shows just sound and talk (inside a running game). */
export function settingsScreen(settings, { onChange, onClose, personalOnly = false }) {
  return h('div', { class: 'panel', id: 'settings-screen' },
    h('h2', { text: personalOnly ? 'Sound & display' : 'Settings' }),
    personalOnly ? null : h('h3', { text: 'Battle' }),
    personalOnly ? null : settingsForm(settings, { keys: GAMEPLAY_KEYS, onChange }),
    h('h3', { text: 'Personal' }),
    settingsForm(settings, { keys: PERSONAL_KEYS, onChange }),
    personalOnly ? null : h('p', { class: 'hint', text: 'Online, the host’s battle settings apply to everyone.' }),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', id: 'btn-settings-done', onclick: onClose, text: 'Done' })));
}
