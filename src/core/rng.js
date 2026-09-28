// Seeded integer PRNG (mulberry32) and integer hashing. Only Math.imul, shifts and xors, so the
// sequence is identical in every JavaScript engine. The state is a single uint32, which makes it
// trivial to snapshot, hash and send over the network.

export class Rng {
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  /** Next uint32. */
  nextU32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Float in [0, 1). */
  float() {
    return this.nextU32() / 4294967296;
  }

  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.float() * n);
  }

  /** Float in [min, max). */
  range(min, max) {
    return min + (max - min) * this.float();
  }

  /** Integer in [min, max]. */
  intRange(min, max) {
    return min + this.int(max - min + 1);
  }

  chance(p) {
    return this.float() < p;
  }

  pick(items) {
    return items[this.int(items.length)];
  }

  shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

/** Mixes up to three integers into a well-distributed uint32 (used for terrain texture noise). */
export function hash3(a, b, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
