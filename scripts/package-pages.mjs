// Assembles the static site that .github/workflows/pages.yml publishes to GitHub Pages:
//
//   index.html, relay.json, version.json   at the top
//   v/<version>/src, vendor, styles.css    the game itself
//
// GitHub Pages lets browsers reuse each file for 10 minutes without checking for a new one, so
// after an update a reload could still run old files, or a mix of old and new ones. With the
// game in a folder named after the version, every deploy has new addresses: a page always
// loads one complete version, and a reload always gets the current one. version.json lets a
// running copy notice that a newer one is out (see src/version.js).
//
//   node scripts/package-pages.mjs <out-dir> <version>
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Throws unless `out` is a safe place to (re)build the site: never the project or above it. */
export function checkOutDir(out) {
  const target = resolve(out);
  if (target === root || root.startsWith(target + sep)) throw new Error(`refusing to replace ${target}`);
  return target;
}

export function packagePages(out, version) {
  if (!/^\w[\w.-]*$/.test(String(version))) throw new Error(`bad version "${version}"`);
  const target = checkOutDir(out);
  const dir = `v/${version}`;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, dir), { recursive: true });
  for (const name of ['src', 'vendor', 'styles.css']) cpSync(join(root, name), join(target, dir, name), { recursive: true });
  cpSync(join(root, 'relay.json'), join(target, 'relay.json'));
  const page = readFileSync(join(root, 'index.html'), 'utf8')
    .replace('href="styles.css"', `href="${dir}/styles.css"`)
    .replace('src="src/main.js"', `src="${dir}/src/main.js"`);
  if (!page.includes(`href="${dir}/styles.css"`) || !page.includes(`src="${dir}/src/main.js"`)) {
    throw new Error('index.html no longer links styles.css and src/main.js the way this script expects');
  }
  writeFileSync(join(target, 'index.html'), page);
  writeFileSync(join(target, 'version.json'), `${JSON.stringify({ version })}\n`);
  return { dir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, version] = process.argv.slice(2);
  if (!out || !version) {
    console.error('Usage: node scripts/package-pages.mjs <out-dir> <version>');
    process.exit(1);
  }
  const { dir } = packagePages(out, version);
  console.log(`Packaged the site in ${out}, with the game under ${dir}/`);
}
