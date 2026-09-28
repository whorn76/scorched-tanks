import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SHOTS, aimAndFire, launch, openPage, waitForMyTurn, waitForPhase } from './helpers.mjs';

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

test('the title screen shows an AI demo battle and the help overlay', async () => {
  const page = await openPage(browser, { name: 'title' });
  await page.waitForSelector('#title-screen');
  await page.waitForFunction(() => window.__scorched.app.demo?.game?.state.round === 1, null, { timeout: 10000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SHOTS, 'title.png') });
  await page.keyboard.press('KeyH');
  await page.waitForSelector('#help-screen');
  const rows = await page.locator('#help-screen .shop-table tr').count();
  assert.ok(rows > 20, 'weapons and items are listed');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'help.png') });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a local game against the AI plays several turns without errors', async () => {
  const page = await openPage(browser, {
    name: 'local',
    storage: {
      settings: { startCash: 0, rounds: 3, wind: 'low' },
      lineup: [
        { name: 'Tester', color: '#e8453c', type: 'human' },
        { name: 'Gail', color: '#3d8bff', type: 'gunner' },
      ],
    },
  });
  await page.click('#btn-local');
  await page.click('#btn-start-local');
  await waitForPhase(page, ['aim', 'busy']);
  let myShots = 0;
  const seenTurns = new Set();
  for (let i = 0; i < 12 && myShots < 4; i++) {
    const mine = await waitForMyTurn(page);
    const phase = await page.evaluate(() => window.__scorched.phase);
    if (phase === 'roundOver' || phase === 'shop') {
      // Between rounds: wait for the next round, shopping if asked.
      await page.waitForFunction(() => ['aim', 'busy', 'shop', 'gameOver'].includes(window.__scorched.phase) && window.__scorched.phase !== 'roundOver', null, { timeout: 15000 });
      if ((await page.evaluate(() => window.__scorched.phase)) === 'shop') {
        await page.click('#btn-shop-done');
        await page.waitForFunction(() => window.__scorched.phase !== 'shop', null, { timeout: 15000 });
      }
      continue;
    }
    if (phase === 'gameOver') break;
    if (!mine) continue;
    const turn = await page.evaluate(() => window.__scorched.turnId);
    seenTurns.add(turn);
    const facingRight = await page.evaluate(() => {
      const s = window.__scorched.session.game.state;
      const me = s.tanks[s.active];
      const foe = s.tanks.find((t) => t !== me && t.alive);
      return foe.x > me.x;
    });
    await aimAndFire(page, { angleKey: facingRight ? 'ArrowRight' : 'ArrowLeft', angleMs: 150 + myShots * 60, powerMs: 250 + myShots * 80 });
    const fired = await page
      .waitForFunction((t) => window.__scorched.turnId > t || window.__scorched.phase !== 'aim', turn, { timeout: 10000 })
      .then(() => true)
      .catch(async () => {
        const state = await page.evaluate(() => ({ phase: window.__scorched.phase, turn: window.__scorched.turnId, aim: window.__scorched.app.aim, modal: window.__scorched.app.modal, focus: document.activeElement?.outerHTML?.slice(0, 80) }));
        await page.screenshot({ path: join(SHOTS, 'local-stuck.png') });
        console.log('shot did not register', JSON.stringify(state));
        return false;
      });
    if (!fired) continue;
    myShots++;
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(SHOTS, `local-turn-${myShots}.png`) });
  }
  assert.ok(myShots >= 4, `fired ${myShots} shots`);
  const state = await page.evaluate(() => ({ turn: window.__scorched.turnId, hash: window.__scorched.hash, phase: window.__scorched.phase }));
  assert.ok(state.turn >= 7, `turn ${state.turn}`);
  assert.match(state.hash, /^[0-9a-f]{16}$/);
  assert.deepEqual(page.errors, [], 'no console errors');
  await page.context().close();
});

test('the phone layout shows touch controls that work', async () => {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('scorched-tanks', JSON.stringify({ settings: { startCash: 0 }, lineup: [{ name: 'Thumb', color: '#e8453c', type: 'human' }, { name: 'Bot', color: '#3d8bff', type: 'rookie' }] }));
      sessionStorage.setItem('seeded', '1');
    }
  });
  await page.goto(process.env.E2E_BASE_URL || 'http://127.0.0.1:8080/');
  await page.tap('#btn-local');
  await page.tap('#btn-start-local');
  await page.waitForFunction(() => window.__scorched.session?.myTurn() >= 0 && window.__scorched.app.aim, null, { timeout: 60000 });
  assert.equal(await page.locator('#touch').isVisible(), true);
  const before = await page.evaluate(() => window.__scorched.app.aim.power);
  await page.locator('.touch-btn[aria-label="power up"]').tap();
  await page.locator('.touch-btn[aria-label="power up"]').tap();
  const after = await page.evaluate(() => window.__scorched.app.aim.power);
  assert.ok(after > before, 'power went up');
  await page.screenshot({ path: join(SHOTS, 'phone.png') });
  await page.locator('.touch-btn.fire').tap();
  await page.waitForFunction(() => window.__scorched.phase === 'busy', null, { timeout: 5000 });
  assert.deepEqual(errors, []);
  await context.close();
});
