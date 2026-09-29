// A stand-in for GitHub Pages in the browser tests: packages the site exactly the way
// .github/workflows/pages.yml does (scripts/package-pages.mjs) and serves it under a
// /scorched-tanks/ subpath, with no relay.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { packagePages } from '../scripts/package-pages.mjs';

export const STATIC_VERSION = 'e2e';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export async function startStaticHost(prefix = '/scorched-tanks/') {
  const site = mkdtempSync(join(tmpdir(), 'scorched-pages-'));
  packagePages(site, STATIC_VERSION);
  const server = createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    let rel = path.startsWith(prefix) ? path.slice(prefix.length) : null;
    if (rel === '' || rel?.endsWith('/')) rel += 'index.html';
    const file = rel === null ? null : normalize(join(site, rel));
    if (!file || !file.startsWith(site + sep)) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}${prefix}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          rmSync(site, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
