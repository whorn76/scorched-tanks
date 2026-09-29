// The published site: versioned deploys (scripts/package-pages.mjs) and the update check that
// goes with them (src/version.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFromUrl, updateAvailable } from '../src/version.js';
import { checkOutDir, packagePages, root } from '../scripts/package-pages.mjs';

test('the running version comes from the folder the game was loaded from', () => {
  assert.equal(buildFromUrl('https://me.github.io/scorched-tanks/v/0123456789ab/src/version.js'), '0123456789ab');
  assert.equal(buildFromUrl('http://127.0.0.1:9000/scorched-tanks/v/e2e/src/version.js?x=1'), 'e2e');
  assert.equal(buildFromUrl('http://localhost:8080/src/version.js'), 'dev', 'npm start and other hosts are "dev"');
  assert.equal(buildFromUrl('https://x.trycloudflare.com/src/version.js'), 'dev');
  assert.equal(buildFromUrl('https://evil.example/v/../src/version.js'), 'dev');
  assert.equal(buildFromUrl(undefined), 'dev');
});

test('a running copy notices when a newer version has been published', async () => {
  const calls = [];
  const site = (body, ok = true) => async (url, options) => {
    calls.push({ url, options });
    return { ok, json: async () => body };
  };
  const pageUrl = 'https://me.github.io/scorched-tanks/#join=ACEFG';
  assert.equal(await updateAvailable({ build: 'abc', pageUrl, fetchFn: site({ version: 'abc' }) }), false);
  assert.equal(calls[0].url, 'https://me.github.io/scorched-tanks/version.json', 'asked next to the page');
  assert.equal(calls[0].options.cache, 'no-store', 'never answered from the browser cache');
  assert.equal(await updateAvailable({ build: 'abc', pageUrl, fetchFn: site({ version: 'def' }) }), true);
  assert.equal(await updateAvailable({ build: 'abc', pageUrl, fetchFn: site({ version: 'def' }, false) }), false, 'no answer, no nagging');
  assert.equal(await updateAvailable({ build: 'abc', pageUrl, fetchFn: site({ version: 7 }) }), false);
  assert.equal(await updateAvailable({ build: 'abc', pageUrl, fetchFn: async () => { throw new Error('offline'); } }), false);
  const before = calls.length;
  assert.equal(await updateAvailable({ build: 'dev', pageUrl, fetchFn: site({ version: 'def' }) }), false);
  assert.equal(calls.length, before, 'dev copies never check');
});

test('the Pages package puts the game under v/<version>/ and points index.html at it', () => {
  const out = mkdtempSync(join(tmpdir(), 'scorched-site-'));
  try {
    const { dir } = packagePages(out, 'abc123');
    assert.equal(dir, 'v/abc123');
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(page, /href="v\/abc123\/styles\.css"/);
    assert.match(page, /src="v\/abc123\/src\/main\.js"/);
    assert.doesNotMatch(page, /(?:href|src)="(?:src|styles)/, 'nothing still points at the old places');
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'version.json'), 'utf8')), { version: 'abc123' });
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'relay.json'), 'utf8')), JSON.parse(readFileSync(join(root, 'relay.json'), 'utf8')));
    for (const file of ['src/main.js', 'src/version.js', 'src/core/game.js', 'vendor/peerjs/peerjs.min.js', 'vendor/peerjs/LICENSE', 'styles.css']) {
      assert.ok(existsSync(join(out, dir, file)), `${file} is published`);
    }
    for (const file of ['server', 'test', 'e2e', 'scripts', 'node_modules', 'package.json', 'src', 'styles.css']) {
      assert.ok(!existsSync(join(out, file)), `${file} is not published at the top`);
    }
    // Packaging again replaces the previous version rather than piling up.
    packagePages(out, 'def456');
    assert.ok(!existsSync(join(out, 'v/abc123')));
    assert.ok(existsSync(join(out, 'v/def456/src/main.js')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('packaging refuses unsafe versions and output folders', () => {
  assert.throws(() => packagePages(join(tmpdir(), 'scorched-never'), '../x'), /bad version/);
  assert.throws(() => packagePages(join(tmpdir(), 'scorched-never'), '..'), /bad version/);
  assert.throws(() => packagePages(join(tmpdir(), 'scorched-never'), ''), /bad version/);
  assert.throws(() => checkOutDir(root), /refusing/);
  assert.throws(() => checkOutDir(dirname(root)), /refusing/);
  assert.equal(checkOutDir(join(root, '_site')), join(root, '_site'));
});
