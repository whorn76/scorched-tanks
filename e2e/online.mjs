// Online play between two browser contexts. Used by relay.e2e.mjs and peer.e2e.mjs.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BASE_URL, SHOTS, aimAndFire, openPage } from './helpers.mjs';

const settings = { startCash: 0, rounds: 2, wind: 'medium', turnTimer: 0 };

export async function playOnline(browser, { transport, label, turns = 4 }) {
  const host = await openPage(browser, { name: `${label}-host`, storage: { settings, online: { name: 'Alice', transport } } });
  await host.click('#btn-host');
  await host.fill('#host-name', 'Alice');
  await host.check(`input[name=transport][value=${transport}]`);
  await host.click('#btn-create-room');
  await host.waitForFunction(() => window.__scorched.phase === 'online:lobby', null, { timeout: 30000 });
  const code = await host.evaluate(() => window.__scorched.code);
  assert.match(code, /^[ACEFGHKMNPRTWXY34679]{5}$/);

  // The guest opens the invite link, which goes straight to the join screen with the code filled in.
  const invite = `${BASE_URL}#join=${code}${transport === 'relay' ? `&relay=${encodeURIComponent(`${BASE_URL.replace(/^http/, 'ws')}ws`)}` : ''}`;
  const guest = await openPage(browser, { name: `${label}-guest`, url: invite, storage: { online: { name: 'Bob' } } });
  await guest.waitForSelector('#join-screen');
  assert.equal(await guest.inputValue('#join-code'), code);
  await guest.fill('#join-name', 'Bob');
  await guest.click('#btn-join-room');
  await guest.waitForFunction(() => window.__scorched.phase === 'online:lobby', null, { timeout: 30000 });
  await host.waitForFunction(() => window.__scorched.session.lobbyPlayers.length === 2);

  // Chat is plain text: markup shows up literally.
  await guest.fill('.chat-input', 'hi <b>there</b>');
  await guest.press('.chat-input', 'Enter');
  await host.waitForFunction(() => [...document.querySelectorAll('.chat-line')].some((l) => l.textContent.includes('hi <b>there</b>')));
  assert.equal(await host.locator('.chat-line b').count(), 0, 'no HTML injected');
  await host.waitForTimeout(400);
  await host.screenshot({ path: join(SHOTS, `${label}-lobby.png`) });

  await host.click('#btn-start-online');
  for (const page of [host, guest]) await page.waitForFunction(() => ['aim', 'busy'].includes(window.__scorched.phase), null, { timeout: 30000 });

  let played = 0;
  for (let i = 0; i < turns * 3 && played < turns; i++) {
    // Whoever's turn it is fires; the other one watches.
    let shooter = null;
    for (const page of [host, guest]) {
      if (await page.evaluate(() => window.__scorched.session.myTurn() >= 0 && !!window.__scorched.app.aim && !window.__scorched.app.aim.fired)) shooter = page;
    }
    if (!shooter) {
      await host.waitForTimeout(300);
      continue;
    }
    const turn = await shooter.evaluate(() => window.__scorched.turnId);
    const right = await shooter.evaluate(() => {
      const s = window.__scorched.session.game.state;
      const me = s.tanks[s.active];
      return s.tanks.find((t) => t !== me && t.alive).x > me.x;
    });
    await aimAndFire(shooter, { angleKey: right ? 'ArrowRight' : 'ArrowLeft', angleMs: 150 + played * 50, powerMs: 250 + played * 60 });
    played++;
    // Wait for both sides to finish the shot, then compare state hashes.
    await host.waitForFunction((t) => window.__scorched.turnId > t || !['aim', 'busy'].includes(window.__scorched.phase), turn, { timeout: 30000 });
    await host.waitForFunction(() => window.__scorched.phase !== 'busy', null, { timeout: 30000 });
    const seq = await host.evaluate(() => window.__scorched.seq);
    await guest.waitForFunction((s) => window.__scorched.seq >= s && window.__scorched.phase !== 'busy', seq, { timeout: 30000 });
    const [h1, h2] = await Promise.all([host.evaluate(() => window.__scorched.hash), guest.evaluate(() => window.__scorched.hash)]);
    assert.equal(h2, h1, `hashes match after shot ${played}`);
    await guest.screenshot({ path: join(SHOTS, `${label}-guest-shot-${played}.png`) });
  }
  assert.ok(played >= turns, `played ${played} shots`);
  const stats = await guest.evaluate(() => window.__scorched.session.stats);
  assert.equal(stats.mismatches, 0);
  assert.ok(stats.syncChecks >= played);
  assert.deepEqual([...host.errors, ...guest.errors], [], 'no console errors');

  // When the host leaves, the guest is told and can go back to the menu.
  await host.keyboard.press('Escape');
  await host.click('#pause-menu .btn.danger');
  await guest.waitForSelector('#message', { timeout: 30000 });
  assert.match(await guest.textContent('#message'), /host/i);
  await guest.waitForTimeout(400);
  await guest.screenshot({ path: join(SHOTS, `${label}-host-left.png`) });
  await host.context().close();
  await guest.context().close();
}
