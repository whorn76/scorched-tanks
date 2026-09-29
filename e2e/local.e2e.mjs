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

test('the top bar opens a weapons & items menu, and every tank can drive two tank lengths a turn', async () => {
  const page = await openPage(browser, {
    name: 'menu',
    storage: {
      settings: { startCash: 0, rounds: 2, wind: 'off', terrain: 'flat' },
      lineup: [
        { name: 'Tester', color: '#e8453c', type: 'human' },
        { name: 'Gail', color: '#3d8bff', type: 'gunner' },
      ],
    },
  });
  await page.click('#btn-local');
  await page.click('#btn-start-local');
  assert.ok(await waitForMyTurn(page));
  await page.waitForFunction(() => window.__scorched.session.game.isIdle());
  const me = await page.evaluate(() => {
    const t = window.__scorched.session.state.tanks[window.__scorched.app.aim.playerId];
    Object.assign(t.stock, { missile: 5, shield: 1, battery: 1 });
    t.health = 60;
    return { id: t.id, x: t.x };
  });
  const tank = () => page.evaluate((id) => {
    const t = window.__scorched.session.state.tanks[id];
    return { x: t.x, driveFrom: t.driveFrom, fuel: t.stock.fuel, shield: t.shield, health: t.health };
  }, me.id);
  const aim = () => page.evaluate(() => ({ angle: window.__scorched.app.aim.angle, power: window.__scorched.app.aim.power, weapon: window.__scorched.app.aim.weaponId }));
  // Aim a little first, so we can check that nothing below resets it.
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(300);
  await page.keyboard.up('ArrowUp');
  const aimed = await aim();

  // Click the weapon in the top bar and pick a missile.
  const box = await page.locator('#game').boundingBox();
  const k = box.width / 1280;
  await page.mouse.click(box.x + 680 * k, box.y + 30 * k);
  await page.waitForSelector('#arsenal-menu');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, 'menu.png') });
  await page.click('[data-weapon="missile"]');
  assert.equal((await aim()).weapon, 'missile');
  assert.equal(await page.locator('#arsenal-menu').count(), 0, 'picking a weapon closes the menu');

  // I opens it too: raise the shield and use the battery.
  await page.keyboard.press('KeyI');
  await page.click('[data-use="shield"]');
  await page.click('[data-use="battery"]');
  assert.deepEqual((({ shield, health }) => ({ shield, health }))(await tank()), { shield: 60, health: 85 });

  // Hold ▶: no fuel needed for the first two tank lengths, then the button gives out.
  const right = await page.locator('[data-drive="1"]').boundingBox();
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => document.querySelector('[data-drive="1"]')?.disabled, null, { timeout: 15000 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__scorched.session.game.isIdle());
  const drove = await tank();
  assert.equal(drove.fuel, 0);
  assert.ok(drove.x > me.x + 30 && drove.x <= me.x + 56, `drove from ${me.x} to ${drove.x}`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, 'menu-drive.png') });

  // Esc closes the menu, and the aim and weapon are just as they were.
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#arsenal-menu').count(), 0);
  assert.deepEqual(await aim(), { ...aimed, weapon: 'missile' });
  // Pausing doesn't reset them either.
  await page.keyboard.press('Escape');
  await page.click('#pause-menu .btn.primary');
  assert.deepEqual(await aim(), { ...aimed, weapon: 'missile' });

  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__scorched.phase === 'busy' || !window.__scorched.app.aim, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__scorched.session.state.lastShot.weaponId), 'missile');
  assert.deepEqual(page.errors, [], 'no console errors');
  await page.context().close();
});

test('sudden death rains shells from the sky', async () => {
  const page = await openPage(browser, {
    name: 'sudden',
    storage: {
      settings: { startCash: 0, rounds: 1, wind: 'low', suddenDeath: 8 },
      lineup: [
        { name: 'Tester', color: '#e8453c', type: 'human' },
        { name: 'Bot', color: '#3d8bff', type: 'rookie' },
      ],
    },
  });
  await page.click('#btn-local');
  await page.click('#btn-start-local');
  await waitForPhase(page, ['aim', 'busy']);
  // Skip ahead to the last round of turns before sudden death.
  await page.evaluate(() => {
    window.__scorched.session.state.rotation = 8;
  });
  let banner = false;
  let falling = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !(banner && falling)) {
    const st = await page.evaluate(() => {
      const app = window.__scorched.app;
      const s = window.__scorched.session.state;
      // Our own shots are harmless tracers straight up.
      if (app.aim && !app.aim.fired && window.__scorched.session.game.isIdle()) {
        s.tanks[app.aim.playerId].stock.tracer = 9;
        Object.assign(app.aim, { weaponId: 'tracer', angle: 90, power: 150 });
      }
      return { mine: !!app.aim && !app.aim.fired, banner: !!window.__scorched.renderer.banner, falling: s.projectiles.some((p) => p.sky && p.y > 80), phase: window.__scorched.phase };
    });
    if (st.phase === 'roundOver' || st.phase === 'gameOver') break;
    banner ||= st.banner;
    if (st.falling && !falling) {
      falling = true;
      await page.screenshot({ path: join(SHOTS, 'sudden-death.png') });
    }
    if (st.mine) await page.keyboard.press('Space');
    await page.waitForTimeout(100);
  }
  assert.ok(banner, 'sudden death was announced');
  assert.ok(falling, 'and shells fell from the sky');
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
  // Tapping the weapon's name opens the weapons & items menu.
  await page.locator('button.touch-weapon').tap();
  await page.waitForSelector('#arsenal-menu');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, 'phone-menu.png') });
  await page.locator('#arsenal-menu .arsenal-close').tap();
  assert.equal(await page.locator('#arsenal-menu').count(), 0);
  await page.locator('.touch-btn.fire').tap();
  await page.waitForFunction(() => window.__scorched.phase === 'busy', null, { timeout: 5000 });
  assert.deepEqual(errors, []);
  await context.close();
});
