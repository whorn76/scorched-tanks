// Things tanks say. All original lines. Which line (and whether a tank speaks at all) is picked
// from a hash of the turn and tank, so everyone in an online game sees the same bubble.
import { hash3 } from './core/rng.js';

export const QUIPS = {
  fire: [
    'Special delivery!',
    'Duck and cover!',
    "This one's got your name on it.",
    'Incoming!',
    "Physics, don't fail me now.",
    'I did the math. Probably.',
    'Wind? What wind?',
    'Fore!',
    'Catch!',
    'Return to sender!',
    'Knock knock.',
    'Here comes the boom.',
    'Parabolas are my passion.',
    'Brace yourself, neighbor.',
    'Sorry about your lawn.',
    'Compliments of the chef.',
    'One crater, coming right up.',
    "Hold still. This won't hurt. Much.",
    "I've been practicing!",
    'Gravity is my co-pilot.',
    'Air mail!',
    "Let's redecorate.",
    'Nothing personal. Mostly.',
    'Calculated. Roughly.',
    'Time to rearrange the scenery.',
    'Bombs away!',
    "You'll feel this one in your treads.",
    'Hope you bought a shield.',
    "I call this one 'The Surprise'.",
    'Launching a friendship torpedo.',
    'Homework is due: physics!',
    'Dirt, meet sky.',
    'Taxes are due. Paying in shells.',
    'Measure twice, fire once.',
    'Is this thing loaded? Oh, it is.',
    'Please hold for a very loud message.',
  ],
  hit: [
    'Ow! My turret!',
    'Hey, I just waxed this!',
    'Is that all you have?',
    'That tickled. Mostly.',
    'Rude!',
    'You scratched my paint!',
    'Okay, now it is personal.',
    'You missed my good side.',
    'Ouch. Noted.',
    'I felt that one.',
    'Right in the treads!',
    'Note to self: buy armor.',
    'My insurance is going up.',
  ],
  death: [
    'I regret nothing!',
    'Tell my treads I loved them.',
    'Was it something I said?',
    'Not the paint job!',
    'I should have bought a shield.',
    'Is that... smoke?',
    'Well, that escalated.',
    "I'll be back next round!",
    'Avenge meeee!',
    'Oof.',
    "My warranty doesn't cover this.",
    'Rust in peace.',
    'At least I had nice treads.',
    'Worth it!',
    'Tell mom I went out with a bang.',
    'Ctrl+Z! Ctrl+Z!',
    'Whose idea was this war?',
    'I was one round from retirement.',
    'Scrapyard, here I come.',
    'So much for dodging.',
    'Tanks for nothing.',
    'Recalculating... never mind.',
    'Next time, a bigger shell.',
    'Blame the wind!',
    'Goodbye, cruel battlefield.',
  ],
  kill: [
    'Scratch one tank.',
    'Nailed it!',
    'And stay down!',
    'Another one for the scrapyard.',
    'Too easy.',
    'Did everyone see that?',
    'Bullseye!',
    "That's how it's done.",
    'Cleanup on aisle five.',
    'Chalk one up for me.',
  ],
};

const KIND_SEED = { fire: 1, hit: 2, death: 3, kill: 4 };
const CHANCE = { fire: 0.35, hit: 0.35, death: 0.9, kill: 0.4 };

/** The line a tank says for an event, or null if it keeps quiet this time. */
export function quipFor(kind, turnId, tankId, salt = 0) {
  const list = QUIPS[kind];
  if (!list) return null;
  const h = hash3(turnId * 16 + KIND_SEED[kind], tankId + 1, 0x51ab + salt);
  if ((h & 0xffff) / 0x10000 >= CHANCE[kind]) return null;
  return list[(h >>> 16) % list.length];
}
