// AI personalities, as data. Error is added after a perfect search, so lower is deadlier:
// `angleError` is in degrees and `powerError` a fraction of the power, both drawn evenly
// from ±that much. With `learn` below 1 the AI walks its shots in: the error shrinks by that
// factor for every shot at the same target, down to `floor`, so even the Cyborg keeps
// missing now and then. Measured against a target that doesn't move, with baby missiles
// (bigger weapons forgive more), the share of shots that do damage is roughly:
// Rookie 15%, Gunner 40% in calm air but ~10% in wind, Spotter 20% rising to ~40%,
// Cyborg 35% rising to ~45%.
// `wind`: 'ignore' aims as if it were calm, 'exact' reads the gauge, 'estimate' works it out
// from where its own shells actually landed.
export const PERSONALITIES = {
  rookie: {
    label: 'Rookie',
    angleError: 7,
    powerError: 0.15,
    wind: 'ignore',
    target: 'sloppy',
    weapons: 'random',
    think: [50, 95],
    spend: 0.55,
    wishlist: 'random',
  },
  gunner: {
    label: 'Gunner',
    angleError: 4.2,
    powerError: 0.095,
    learn: 0.9,
    floor: 0.7,
    wind: 'ignore',
    target: 'nearest',
    weapons: 'solid',
    think: [40, 75],
    spend: 0.7,
    wishlist: [['parachute', 2], ['shield', 1], ['missile', 10], ['fuel', 150], ['riot', 2], ['babynuke', 3], ['battery', 2], ['leapfrog', 3]],
  },
  spotter: {
    label: 'Spotter',
    angleError: 4.5,
    powerError: 0.1,
    learn: 0.72,
    floor: 0.6,
    wind: 'estimate',
    target: 'weakest',
    weapons: 'spotter',
    think: [40, 75],
    spend: 0.75,
    wishlist: [['tracer', 10], ['parachute', 2], ['fuel', 150], ['riot', 2], ['missile', 10], ['shield', 1], ['mirv', 2], ['battery', 2], ['funky', 2], ['babynuke', 3]],
  },
  cyborg: {
    label: 'Cyborg',
    angleError: 4.0,
    powerError: 0.09,
    learn: 0.82,
    floor: 0.6,
    wind: 'exact',
    target: 'revenge',
    weapons: 'strongest',
    think: [30, 60],
    spend: 0.9,
    wishlist: [['parachute', 2], ['shield', 1], ['fuel', 150], ['riot', 2], ['battery', 2], ['babynuke', 3], ['mirv', 2], ['missile', 10], ['heavyshield', 1], ['nuke', 1], ['deathshead', 1], ['hotnapalm', 2], ['heavyroller', 2], ['battery', 4]],
  },
};

/** How much of its aim error an AI still has after `shots` shots at the same target. */
export function aimErrorScale(personality, shots) {
  return Math.max(personality.floor ?? 1, (personality.learn ?? 1) ** shots);
}

/** Weapons the Cyborg prefers, strongest first. */
export const STRONGEST = ['nuke', 'deathshead', 'babynuke', 'mirv', 'hotnapalm', 'heavyroller', 'funky', 'napalm', 'missile', 'leapfrog', 'roller'];
export const SOLID = ['babynuke', 'missile', 'leapfrog'];
export const SPOTTER = ['mirv', 'funky', 'missile', 'babynuke'];
