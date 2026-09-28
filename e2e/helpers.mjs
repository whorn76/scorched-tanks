// Shared helpers for the browser tests.
import { chromium } from 'playwright';
import { join } from 'node:path';

export const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080/';
/** The same game on a static host under a subpath, like GitHub Pages (no relay there). */
export const STATIC_URL = process.env.E2E_STATIC_URL || BASE_URL;
/** The relay that BASE_URL's server runs. */
export const RELAY_WS_URL = `${BASE_URL.replace(/^http/, 'ws')}ws`;
export const SHOTS = join('test-results', 'e2e');

export async function launch() {
  return chromium.launch();
}

/** A page that records console errors and uncaught exceptions. */
export async function openPage(browser, { name = 'page', viewport = { width: 1280, height: 720 }, storage = null, url = BASE_URL, clipboard = false } = {}) {
  const context = await browser.newContext({ viewport });
  if (clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const page = await context.newPage();
  page.errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') page.errors.push(`${name} console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => page.errors.push(`${name} page error: ${err.message}`));
  if (storage) {
    await context.addInitScript((value) => {
      if (!sessionStorage.getItem('e2e-seeded')) {
        localStorage.setItem('scorched-tanks', value);
        sessionStorage.setItem('e2e-seeded', '1');
      }
    }, JSON.stringify(storage));
  }
  await page.goto(url);
  await page.waitForFunction(() => !!window.__scorched);
  return page;
}

export const debug = (page, expr) => page.evaluate(expr);

export async function waitForPhase(page, phases, timeout = 30000) {
  const list = Array.isArray(phases) ? phases : [phases];
  await page.waitForFunction((l) => l.includes(window.__scorched.phase), list, { timeout });
}

/** Waits until it's this page's turn (or the round/game ends). Returns true if it's our turn. */
export async function waitForMyTurn(page, timeout = 60000) {
  await page.waitForFunction(
    () => (window.__scorched.session?.myTurn() >= 0 && window.__scorched.app.aim && !window.__scorched.app.aim.fired) || ['roundOver', 'shop', 'gameOver'].includes(window.__scorched.phase),
    null,
    { timeout },
  );
  return page.evaluate(() => window.__scorched.session.myTurn() >= 0);
}

/** Aims with the keyboard like a person would, then fires. */
export async function aimAndFire(page, { angleKey = 'ArrowLeft', angleMs = 250, powerKey = 'ArrowUp', powerMs = 300 } = {}) {
  await page.keyboard.down(angleKey);
  await page.waitForTimeout(angleMs);
  await page.keyboard.up(angleKey);
  await page.keyboard.down(powerKey);
  await page.waitForTimeout(powerMs);
  await page.keyboard.up(powerKey);
  await page.keyboard.press('Space');
}
