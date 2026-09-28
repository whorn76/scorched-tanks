import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIR, LOOSE, SCORCHED, Terrain } from '../src/core/terrain.js';
import { HEIGHT, WIDTH } from '../src/core/constants.js';

function flatTerrain(height = 500) {
  const t = new Terrain();
  t.fillFromHeights(new Int16Array(WIDTH).fill(height), 42);
  t.clearDirty();
  t.fullDirty = false;
  return t;
}

const columnSolids = (t, x) => {
  let n = 0;
  for (let y = 0; y < HEIGHT; y++) if (t.data[y * WIDTH + x] !== AIR) n++;
  return n;
};

test('generated ground is solid below the surface and air above', () => {
  const heights = new Int16Array(WIDTH);
  for (let x = 0; x < WIDTH; x++) heights[x] = 300 + (x % 100);
  const t = new Terrain();
  t.fillFromHeights(heights, 1);
  for (const x of [0, 50, 640, 1279]) {
    assert.equal(t.isSolid(x, heights[x] - 1), false);
    assert.equal(t.isSolid(x, heights[x]), true);
    assert.equal(t.isSolid(x, HEIGHT - 1), true);
    assert.equal(t.surfaceY(x), heights[x]);
  }
  assert.equal(t.isSolid(-1, 600), false, 'outside the sides is air');
  assert.equal(t.isSolid(10, HEIGHT + 5), true, 'below the bottom is bedrock');
});

test('the same heights and seed always build the same pixels', () => {
  const heights = new Int16Array(WIDTH).fill(420);
  const a = new Terrain();
  const b = new Terrain();
  a.fillFromHeights(heights, 777);
  b.fillFromHeights(heights, 777);
  assert.deepEqual(a.data, b.data);
  b.fillFromHeights(heights, 778);
  assert.notDeepEqual(a.data, b.data);
});

test('carving removes a disc and blackens its rim', () => {
  const t = flatTerrain(400);
  const { removed } = t.carve(640, 500, 20);
  assert.ok(Math.abs(removed - Math.PI * 400) < 60, `removed ${removed}`);
  assert.equal(t.isSolid(640, 500), false);
  assert.equal(t.isSolid(655, 500), false);
  const rim = t.get(640 + 22, 500);
  assert.ok(rim >= SCORCHED && rim < LOOSE, 'rim is scorched');
  const outside = t.get(640 + 30, 500);
  assert.ok(outside > 0 && outside < SCORCHED, 'beyond the rim is untouched');
  assert.ok(t.settling, 'carving wakes up the columns around it');
});

test('unsupported dirt slides down and keeps its colors', () => {
  const t = flatTerrain(500);
  // A floating slab: carve a tunnel under the surface.
  for (let x = 600; x < 700; x++) for (let y = 520; y < 560; y++) t.data[y * WIDTH + x] = AIR;
  const before = [];
  for (let y = 500; y < 520; y++) before.push(t.data[y * WIDTH + 650]);
  const solidsBefore = columnSolids(t, 650);
  t.activate(600, 699);

  t.settleStep();
  t.settleStep();
  t.settleStep();
  assert.ok(t.settling, 'still falling after a few ticks');
  const topNow = t.surfaceY(650);
  assert.ok(topNow > 500 && topNow < 540, `slab is visibly partway down (${topNow})`);

  const steps = t.settleAll();
  assert.ok(steps > 3 && steps < 60, `settled in ${steps} steps`);
  assert.equal(t.settling, false);
  assert.equal(columnSolids(t, 650), solidsBefore, 'no dirt lost or created');
  assert.equal(t.surfaceY(650), 540, 'slab now rests on the tunnel floor');
  const after = [];
  for (let y = 540; y < 560; y++) after.push(t.data[y * WIDTH + 650]);
  assert.deepEqual(after, before, 'colors fall with the dirt, in order');
  for (let y = 540; y < HEIGHT; y++) assert.ok(t.isSolid(650, y), 'no gaps left');
});

test('settling a column with nothing floating finishes at once', () => {
  const t = flatTerrain(500);
  t.activate(0, WIDTH - 1);
  assert.equal(t.settleStep(), false);
});

test('dirt fills only air and then settles', () => {
  const t = flatTerrain(500);
  const added = t.addDirt(640, 440, 30, 9);
  assert.ok(added > 1500, `added ${added}`);
  assert.ok(t.get(640, 440) >= LOOSE);
  t.settleAll();
  assert.equal(t.surfaceY(640), 500 - 61, 'the ball collapsed into a pile on the ground');
});

test('riot carving leaves the ground under the tank', () => {
  const t = flatTerrain(500);
  t.addDirt(640, 480, 30, 3);
  t.settleAll();
  t.carveAbove(640, 488, 40, 500);
  for (let y = 460; y < 500; y++) assert.equal(t.isSolid(640, y), false);
  assert.equal(t.isSolid(640, 500), true);
});

test('dirty rectangles cover every change and then reset', () => {
  const t = flatTerrain(500);
  t.carve(300, 500, 10);
  t.carve(900, 500, 10);
  const rects = [];
  t.consumeDirty((x, y, w, hgt) => rects.push({ x, y, w, h: hgt }));
  assert.ok(rects.length >= 2);
  const covers = (px, py) => rects.some((r) => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
  assert.ok(covers(300, 500) && covers(900, 500) && covers(305, 495));
  assert.ok(!covers(600, 500), 'untouched columns are skipped');
  const again = [];
  t.consumeDirty((x) => again.push(x));
  assert.equal(again.length, 0);
});
