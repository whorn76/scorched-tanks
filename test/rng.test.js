import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng, hash3 } from '../src/core/rng.js';

test('mulberry32 matches the reference sequence', () => {
  const rng = new Rng(1);
  assert.deepEqual([rng.nextU32(), rng.nextU32(), rng.nextU32()], [2693262067, 11749833, 2265367787]);
  assert.equal(new Rng(0xdeadbeef).nextU32(), 4043151706);
});

test('the same seed gives the same sequence, different seeds differ', () => {
  const a = new Rng(123);
  const b = new Rng(123);
  const c = new Rng(124);
  const seq = (r) => Array.from({ length: 20 }, () => r.nextU32());
  const sa = seq(a);
  assert.deepEqual(sa, seq(b));
  assert.notDeepEqual(sa, seq(c));
});

test('the state can be saved and resumed mid-sequence', () => {
  const a = new Rng(99);
  for (let i = 0; i < 10; i++) a.nextU32();
  const b = new Rng(a.state);
  assert.deepEqual(Array.from({ length: 5 }, () => a.float()), Array.from({ length: 5 }, () => b.float()));
});

test('helpers stay within their ranges', () => {
  const rng = new Rng(5);
  for (let i = 0; i < 5000; i++) {
    const f = rng.float();
    assert.ok(f >= 0 && f < 1);
    const n = rng.int(7);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 7);
    const k = rng.intRange(-3, 3);
    assert.ok(Number.isInteger(k) && k >= -3 && k <= 3);
    const r = rng.range(10, 20);
    assert.ok(r >= 10 && r < 20);
  }
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(rng.intRange(-3, 3));
  assert.equal(seen.size, 7, 'intRange reaches both ends');
});

test('shuffle is a deterministic permutation', () => {
  const a = new Rng(3).shuffle([1, 2, 3, 4, 5, 6]);
  const b = new Rng(3).shuffle([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5, 6]);
});

test('hash3 is stable and spreads nearby inputs', () => {
  assert.equal(hash3(1, 2, 3), hash3(1, 2, 3));
  const values = new Set();
  for (let x = 0; x < 64; x++) values.add(hash3(x, 0, 7) & 7);
  assert.equal(values.size, 8);
});
