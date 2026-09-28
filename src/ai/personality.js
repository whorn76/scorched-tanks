// AI personalities, as data. Error is added after a perfect search, so lower is deadlier.
// `wind`: 'ignore' aims as if it were calm, 'exact' reads the gauge, 'estimate' works it out
// from where its own shells actually landed.
export const PERSONALITIES = {
  rookie: {
    label: 'Rookie',
    angleError: 6,
    powerError: 0.12,
    wind: 'ignore',
    target: 'sloppy',
    weapons: 'random',
    think: [50, 95],
    spend: 0.55,
    wishlist: 'random',
  },
  gunner: {
    label: 'Gunner',
    angleError: 1.1,
    powerError: 0.022,
    wind: 'ignore',
    target: 'nearest',
    weapons: 'solid',
    think: [40, 75],
    spend: 0.7,
    wishlist: [['parachute', 2], ['missile', 10], ['riot', 2], ['babynuke', 3], ['leapfrog', 3], ['battery', 2], ['shield', 1]],
  },
  spotter: {
    label: 'Spotter',
    angleError: 3,
    powerError: 0.06,
    learn: 0.45, // error multiplier per shot at the same target
    wind: 'estimate',
    target: 'weakest',
    weapons: 'spotter',
    think: [40, 75],
    spend: 0.75,
    wishlist: [['tracer', 10], ['parachute', 2], ['riot', 2], ['missile', 10], ['shield', 1], ['mirv', 2], ['battery', 2], ['funky', 2], ['babynuke', 3]],
  },
  cyborg: {
    label: 'Cyborg',
    angleError: 0.35,
    powerError: 0.007,
    wind: 'exact',
    target: 'revenge',
    weapons: 'strongest',
    think: [30, 60],
    spend: 0.9,
    wishlist: [['heavyshield', 1], ['parachute', 2], ['riot', 2], ['battery', 4], ['nuke', 2], ['deathshead', 1], ['mirv', 2], ['babynuke', 3], ['hotnapalm', 2], ['heavyroller', 2], ['missile', 10], ['shield', 2]],
  },
};

/** Weapons the Cyborg prefers, strongest first. */
export const STRONGEST = ['nuke', 'deathshead', 'babynuke', 'mirv', 'hotnapalm', 'heavyroller', 'funky', 'napalm', 'missile', 'leapfrog', 'roller'];
export const SOLID = ['babynuke', 'missile', 'leapfrog'];
export const SPOTTER = ['mirv', 'funky', 'missile', 'babynuke'];
