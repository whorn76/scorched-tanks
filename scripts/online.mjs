// npm run online: host games from this PC for friends on other internet connections.
//
// Starts the game server with its relay, opens a free Cloudflare "quick tunnel" to it and
// prints a public https link. Everyone who opens that link plays through the relay on this
// PC, which works on any network, even ones that block direct connections between players.
// No Cloudflare account is needed, and the link is new every time. The first run downloads
// Cloudflare's cloudflared program into .cache/ (unless it's already installed).
//
//   npm run online              opens the link in your browser too
//   npm run online -- --no-open just prints it
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(root, '.cache', 'cloudflared');
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

/** Name of the cloudflared release file for this computer. */
function assetName() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';
  if (process.platform === 'win32') return `cloudflared-windows-${arch}.exe`;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch}.tgz`;
  return `cloudflared-linux-${arch}`;
}

/** An installed cloudflared, a previously downloaded one, or a fresh download. */
async function findCloudflared() {
  if (spawnSync(EXE, ['--version'], { stdio: 'ignore' }).status === 0) return EXE;
  const cached = join(CACHE, EXE);
  if (existsSync(cached)) return cached;
  const name = assetName();
  console.log(`Downloading Cloudflare's cloudflared (${name}). This only happens once…`);
  const res = await fetch(RELEASES + name);
  if (!res.ok) throw new Error(`Could not download cloudflared (HTTP ${res.status}).`);
  const data = Buffer.from(await res.arrayBuffer());
  mkdirSync(CACHE, { recursive: true });
  if (name.endsWith('.tgz')) {
    const archive = join(CACHE, name);
    writeFileSync(archive, data);
    const untar = spawnSync('tar', ['-xzf', archive, '-C', CACHE]);
    rmSync(archive, { force: true });
    if (untar.status !== 0) throw new Error('Could not unpack cloudflared.');
  } else {
    writeFileSync(`${cached}.part`, data);
    renameSync(`${cached}.part`, cached);
  }
  if (process.platform !== 'win32') chmodSync(cached, 0o755);
  return cached;
}

/** Starts a quick tunnel to the local port and resolves with its public URL. */
function openTunnel(exe, port) {
  return new Promise((resolveTunnel, reject) => {
    const child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let settled = false;
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolveTunnel({ child, url });
      }
    };
    const timer = setTimeout(() => finish(new Error(`cloudflared didn't open a tunnel within a minute.\n${log.slice(-1500)}`)), 60000);
    const onOutput = (chunk) => {
      log += chunk;
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (match) finish(null, match[0]);
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error(`cloudflared stopped (exit code ${code}).\n${log.slice(-1500)}`)));
  });
}

/** Waits until the game answers through the tunnel (a new link can take a few seconds). */
async function waitUntilReachable(url) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const server = await startServer({ port: Number(process.env.PORT) || 0, host: '127.0.0.1', quiet: true });
if (!server.relay) {
  console.error('The relay needs the "ws" package. Run "npm install" first.');
  await server.close();
  process.exit(1);
}
let tunnel;
try {
  tunnel = await openTunnel(await findCloudflared(), server.port);
} catch (error) {
  console.error(`Couldn't open a public link: ${error.message}`);
  await server.close();
  process.exit(1);
}
console.log('Opening the public link…');
if (!(await waitUntilReachable(tunnel.url))) console.warn('The link is slow to answer; it may take another minute to work.');
const link = `${tunnel.url}/`;
console.log(`
  Scorched Tanks is online at:

    ${link}

  Open it, click Host Online and send your friends the invite link (or this link and the
  room code). Games go through this PC, so leave this window open while you play.
  Press Ctrl+C to stop.
`);
if (!process.argv.includes('--no-open')) openBrowser(link);

let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  tunnel.child.kill();
  await server.close();
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
tunnel.child.on('exit', () => {
  if (!stopping) console.error('The Cloudflare tunnel closed, so the public link no longer works.');
  stop(1);
});
