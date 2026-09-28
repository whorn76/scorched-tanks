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
    angleError: 2.2,
    powerError: 0.045,
    wind: 'ignore',
    target: 'nearest',
    weapons: 'solid',
    think: [40, 75],
    spend: 0.7,
    wishlist: [['parachute', 2], ['shield', 1], ['missile', 10], ['fuel', 150], ['riot', 2], ['babynuke', 3], ['battery', 2], ['leapfrog', 3]],
  },
  spotter: {
    label: 'Spotter',
    angleError: 2.6,
    powerError: 0.05,
    learn: 0.4, // error multiplier per shot at the same target
    wind: 'estimate',
    target: 'weakest',
    weapons: 'spotter',
    think: [40, 75],
    spend: 0.75,
    wishlist: [['tracer', 10], ['parachute', 2], ['fuel', 150], ['riot', 2], ['missile', 10], ['shield', 1], ['mirv', 2], ['battery', 2], ['funky', 2], ['babynuke', 3]],
  },
  cyborg: {
    label: 'Cyborg',
    angleError: 1.0,
    powerError: 0.018,
    wind: 'exact',
    target: 'revenge',
    weapons: 'strongest',
    think: [30, 60],
    spend: 0.9,
    wishlist: [['parachute', 2], ['shield', 1], ['fuel', 150], ['riot', 2], ['battery', 2], ['babynuke', 3], ['mirv', 2], ['missile', 10], ['heavyshield', 1], ['nuke', 1], ['deathshead', 1], ['hotnapalm', 2], ['heavyroller', 2], ['battery', 4]],
  },
};

/** Weapons the Cyborg prefers, strongest first. */
export const STRONGEST = ['nuke', 'deathshead', 'babynuke', 'mirv', 'hotnapalm', 'heavyroller', 'funky', 'napalm', 'missile', 'leapfrog', 'roller'];
export const SOLID = ['babynuke', 'missile', 'leapfrog'];
export const SPOTTER = ['mirv', 'funky', 'missile', 'babynuke'];
