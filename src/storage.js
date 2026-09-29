// Settings, the local lineup and online preferences, kept in localStorage.
import { DEFAULT_SETTINGS, sanitizeSettings } from './core/constants.js';

const KEY = 'scorched-tanks';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

function write(changes) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), ...changes }));
  } catch {
    // Storage can be unavailable (private modes); the game still works without it.
  }
}

export const loadSettings = () => sanitizeSettings({ ...DEFAULT_SETTINGS, ...read().settings });
export const saveSettings = (settings) => write({ settings: sanitizeSettings(settings) });

export const loadMuted = () => read().muted === true;
export const saveMuted = (muted) => write({ muted });

export function loadLineup() {
  const lineup = read().lineup;
  return Array.isArray(lineup) ? lineup.slice(0, 6) : null;
}
export const saveLineup = (lineup) => write({ lineup });

export function loadOnline() {
  const online = read().online ?? {};
  return {
    name: typeof online.name === 'string' ? online.name.slice(0, 16) : '',
    transport: online.transport === 'relay' ? 'relay' : 'peer',
    transportChosen: online.transport === 'relay' || online.transport === 'peer', // picked before on this site
    relayUrl: typeof online.relayUrl === 'string' ? online.relayUrl.slice(0, 300) : '',
    turnUrl: typeof online.turnUrl === 'string' ? online.turnUrl.slice(0, 300) : '',
    turnUser: typeof online.turnUser === 'string' ? online.turnUser.slice(0, 200) : '',
    turnPass: typeof online.turnPass === 'string' ? online.turnPass.slice(0, 200) : '',
  };
}
export const saveOnline = ({ transportChosen, ...online }) => write({ online });
