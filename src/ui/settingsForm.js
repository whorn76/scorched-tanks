// A form for game settings. Gameplay settings are shared by everyone in an online game (the host
// decides); talking tanks and volume are personal and only shown when `personal` is true.
import { SETTING_OPTIONS } from '../core/constants.js';
import { h, money, select } from './dom.js';

const LABELS = {
  rounds: 'Rounds',
  startCash: 'Starting cash',
  wind: 'Wind',
  windChange: 'Wind changes each turn',
  gravity: 'Gravity',
  walls: 'Walls',
  terrain: 'Terrain',
  sky: 'Sky',
  turnTimer: 'Turn timer',
  suddenDeath: 'Sudden death',
  talk: 'Talking tanks',
  volume: 'Sound volume',
};

const cap = (s) => {
  const text = String(s ?? '');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const VALUE_LABELS = {
  startCash: (v) => money(v),
  turnTimer: (v) => (v ? `${v} s` : 'Off'),
  walls: (v) => ({ open: 'Open (shells fly off)', wrap: 'Wrap-around', rubber: 'Rubber (bounce)', concrete: 'Concrete (explode)', random: 'Random each round' })[v],
  terrain: (v) => ({ hills: 'Rolling hills', mountains: 'Mountains', canyons: 'Canyons', flat: 'Mostly flat', random: 'Random' })[v],
  sky: (v) => (v === 'random' ? 'Random each round' : cap(v)),
  rounds: (v) => String(v),
  suddenDeath: (v) => (v ? `After ${v} turns each` : 'Off'),
};

export const GAMEPLAY_KEYS = ['rounds', 'startCash', 'wind', 'windChange', 'gravity', 'walls', 'terrain', 'sky', 'turnTimer', 'suddenDeath'];
export const PERSONAL_KEYS = ['talk', 'volume'];

export function describeSetting(key, value) {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return (VALUE_LABELS[key] ?? ((v) => cap(String(v))))(value);
}

/**
 * settingsForm(settings, { keys, onChange, readOnly }) — `settings` is updated in place and
 * onChange(settings) is called after every edit.
 */
export function settingsForm(settings, { keys = GAMEPLAY_KEYS, onChange = () => {}, readOnly = false } = {}) {
  const grid = h('div', { class: 'settings-grid' });
  for (const key of keys) {
    const id = `setting-${key}`;
    let control;
    if (readOnly) {
      control = h('span', { class: 'setting-value', id, text: describeSetting(key, settings[key]) });
    } else if (key === 'volume') {
      const out = h('span', { class: 'range-value', text: `${settings.volume}` });
      control = h('span', { class: 'range' },
        h('input', {
          type: 'range',
          id,
          min: 0,
          max: 100,
          step: 5,
          value: settings.volume,
          oninput: (e) => {
            settings.volume = Number(e.target.value);
            out.textContent = `${settings.volume}`;
            onChange(settings, key);
          },
        }),
        out);
    } else if (typeof settings[key] === 'boolean') {
      control = h('input', {
        type: 'checkbox',
        id,
        checked: settings[key],
        onchange: (e) => {
          settings[key] = e.target.checked;
          onChange(settings, key);
        },
      });
    } else {
      const options = SETTING_OPTIONS[key].map((v) => [v, describeSetting(key, v)]);
      control = select(options, settings[key], (value) => {
        settings[key] = typeof SETTING_OPTIONS[key][0] === 'number' ? Number(value) : value;
        onChange(settings, key);
      }, { id });
    }
    grid.append(h('label', { for: id, text: LABELS[key] }), control);
  }
  return grid;
}
