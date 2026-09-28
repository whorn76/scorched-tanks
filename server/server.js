// Serves the game as static files and, when the `ws` package is installed, runs the online relay
// on /ws. `npm start` runs this. Browsers only load ES modules over http(s), so opening
// index.html straight from disk won't work.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// Only the game itself is served; tooling, tests and the server code stay private.
const PUBLIC = [/^\/index\.html$/, /^\/styles\.css$/, /^\/src\//, /^\/vendor\//, /^\/favicon\.ico$/];

/**
 * Serves the public game files. `hasRelay()` says whether the relay is running here; the game
 * asks /relay.json so it only offers this site as a relay when there really is one.
 */
export function createStaticHandler({ hasRelay = () => false } = {}) {
  return async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (pathname === '/relay.json') {
      // Always answered (never a 404), so browsers don't log an error when there's no relay.
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ relay: hasRelay() }));
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    // Check the allow-list against the normalized path, so encoded "..", backslashes or NULs
    // can't reach anything outside it.
    const normalized = posix.normalize(pathname);
    const unsafe = /[\\\0]/.test(pathname) || normalized !== pathname || normalized.split('/').includes('..');
    const file = resolve(root, `.${normalized}`);
    if (unsafe || !file.startsWith(root + sep) || !PUBLIC.some((re) => re.test(normalized))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  };
}

export async function startServer({ port = Number(process.env.PORT) || 8080, host = process.env.HOST || '0.0.0.0', quiet = false } = {}) {
  let relay = null;
  const server = createServer(createStaticHandler({ hasRelay: () => relay !== null }));
  try {
    const { attachRelay } = await import('./relay.js');
    relay = await attachRelay(server);
  } catch (error) {
    if (!quiet) console.warn(`Relay disabled (${error.message}). Run "npm install" to enable online play through this server.`);
  }
  await new Promise((resolveListen) => server.listen(port, host, resolveListen));
  const address = server.address();
  if (!quiet) {
    const shown = host === '0.0.0.0' || host === '127.0.0.1' ? 'localhost' : host;
    console.log(`Scorched Tanks running at http://${shown}:${address.port}${relay ? ' (relay on /ws)' : ''}`);
  }
  return {
    server,
    relay,
    port: address.port,
    close: () =>
      new Promise((done) => {
        relay?.close();
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
