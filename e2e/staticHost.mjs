// A stand-in for GitHub Pages in the browser tests: serves only the files that
// .github/workflows/pages.yml publishes, under a /scorched-tanks/ subpath, with no relay.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PUBLISHED = [/^index\.html$/, /^styles\.css$/, /^relay\.json$/, /^src\//, /^vendor\//];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export async function startStaticHost(root, prefix = '/scorched-tanks/') {
  const server = createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    const rel = path.startsWith(prefix) ? path.slice(prefix.length) || 'index.html' : null;
    if (!rel || rel.includes('..') || rel.includes('\\') || !PUBLISHED.some((re) => re.test(rel))) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream' });
      res.end(await readFile(join(root, rel)));
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}${prefix}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
