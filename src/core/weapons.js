// The arsenal, as data. `kind` selects the behavior in game.js; the numbers are tuning. Prices
// are for a bundle of `bundle` units. Add a weapon by adding a row (and a kind, if it's new).

export const WEAPONS = [
  { id: 'baby', name: 'Baby Missile', kind: 'missile', price: 0, bundle: 0, radius: 20, damage: 34,
    blurb: 'Small, free and unlimited.' },
  { id: 'missile', name: 'Missile', kind: 'missile', price: 1800, bundle: 5, radius: 32, damage: 52,
    blurb: 'A solid all-rounder.' },
  { id: 'babynuke', name: 'Baby Nuke', kind: 'missile', price: 6500, bundle: 3, radius: 58, damage: 78,
    blurb: 'A big blast in a small package.' },
  { id: 'nuke', name: 'Nuke', kind: 'missile', price: 11000, bundle: 1, radius: 100, damage: 105, flash: true,
    blurb: 'Flattens a whole hillside.' },
  { id: 'mirv', name: 'MIRV', kind: 'mirv', price: 9500, bundle: 2, radius: 28, damage: 42, warheads: 5, spread: 55,
    blurb: 'Splits into 5 warheads at the top of its arc.' },
  { id: 'deathshead', name: "Death's Head", kind: 'mirv', price: 17000, bundle: 1, radius: 44, damage: 62,
    warheads: 9, spread: 48, blurb: 'Splits into 9 heavy warheads.' },
  { id: 'funky', name: 'Funky Bomb', kind: 'funky', price: 7500, bundle: 2, radius: 30, damage: 36, bomblets: 8,
    bombletRadius: 21, bombletDamage: 28, blurb: 'Bursts and sprays bomblets everywhere.' },
  { id: 'leapfrog', name: 'Leapfrog', kind: 'leapfrog', price: 5000, bundle: 3, radius: 25, damage: 38, hops: 3,
    blurb: 'Explodes, bounces, and explodes again. Three times.' },
  { id: 'napalm', name: 'Napalm', kind: 'napalm', price: 5500, bundle: 3, particles: 40, burn: 250, heat: 1,
    blurb: 'Burning jelly that runs downhill.' },
  { id: 'hotnapalm', name: 'Hot Napalm', kind: 'napalm', price: 9500, bundle: 2, particles: 70, burn: 340,
    heat: 1.5, blurb: 'More jelly, hotter, longer.' },
  { id: 'roller', name: 'Roller', kind: 'roller', price: 3200, bundle: 4, radius: 30, damage: 50,
    blurb: 'Rolls downhill and blows up when it stops or hits a tank.' },
  { id: 'heavyroller', name: 'Heavy Roller', kind: 'roller', price: 6500, bundle: 2, radius: 46, damage: 72,
    blurb: 'A roller with a much bigger bang.' },
  { id: 'digger', name: 'Digger', kind: 'digger', price: 2600, bundle: 4, radius: 22, damage: 36, tunnel: 110,
    burrowers: 1, blurb: 'Tunnels through dirt, then explodes underground.' },
  { id: 'sandhog', name: 'Sandhog', kind: 'digger', price: 5800, bundle: 2, radius: 30, damage: 44, tunnel: 150,
    burrowers: 3, blurb: 'Three burrowing warheads that undermine the ground.' },
  { id: 'dirtball', name: 'Dirt Ball', kind: 'dirt', price: 2000, bundle: 5, radius: 42,
    blurb: 'A ball of dirt. Build a wall or bury a rival.' },
  { id: 'tonofdirt', name: 'Ton of Dirt', kind: 'dirt', price: 4800, bundle: 2, radius: 82,
    blurb: 'A huge heap of dirt.' },
  { id: 'riot', name: 'Riot Charge', kind: 'riot', price: 2200, bundle: 4, radius: 48,
    blurb: 'Blasts away the dirt around your own tank.' },
  { id: 'tracer', name: 'Tracer', kind: 'tracer', price: 400, bundle: 10,
    blurb: 'Harmless. Leaves a lasting trail to help you aim.' },
];

export const ITEMS = [
  { id: 'parachute', name: 'Parachute', price: 1500, bundle: 2, blurb: 'Opens by itself when you fall too far.' },
  { id: 'shield', name: 'Shield', price: 3500, bundle: 1, strength: 60,
    blurb: 'Absorbs 60 damage. Raised at round start, or press S.' },
  { id: 'heavyshield', name: 'Heavy Shield', price: 8000, bundle: 1, strength: 150,
    blurb: 'Absorbs 150 damage. Raised at round start, or press S.' },
  { id: 'battery', name: 'Battery', price: 2500, bundle: 2, restore: 25,
    blurb: 'Restores 25 health (and max power). Press B.' },
  { id: 'fuel', name: 'Fuel', price: 1500, bundle: 150, blurb: 'Drive with A and D. Slopes cost more.' },
];

// Lookup tables without a prototype, so names like "constructor" or "__proto__" never match.
const table = (rows) => Object.assign(Object.create(null), Object.fromEntries(rows.map((row) => [row.id, row])));

export const WEAPON_BY_ID = table(WEAPONS);
export const ITEM_BY_ID = table(ITEMS);
export const WEAPON_IDS = WEAPONS.map((w) => w.id);
export const ITEM_IDS = ITEMS.map((item) => item.id);
/** Every inventory key, in the fixed order used for hashing and snapshots. */
export const STOCK_IDS = [...WEAPON_IDS, ...ITEM_IDS];
export const FREE_WEAPON = 'baby';
export const MAX_STOCK = 99;
export const MAX_FUEL = 999;

export const isWeapon = (id) => typeof id === 'string' && Object.hasOwn(WEAPON_BY_ID, id);
export const isItem = (id) => typeof id === 'string' && Object.hasOwn(ITEM_BY_ID, id);
export const productById = (id) => (isWeapon(id) ? WEAPON_BY_ID[id] : isItem(id) ? ITEM_BY_ID[id] : null);
export const stockLimit = (id) => (id === 'fuel' ? MAX_FUEL : MAX_STOCK);
