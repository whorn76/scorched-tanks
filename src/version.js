// Which published version of the game is running, and whether a newer one is out. On GitHub
// Pages the game's files live under v/<version>/ (see scripts/package-pages.mjs), and
// version.json at the top of the site names the current version. Anywhere else (npm start,
// other static hosts) this is 'dev' and there's nothing to check.

/** The version in a module URL like …/v/<version>/src/version.js, or 'dev'. */
export function buildFromUrl(url) {
  return /\/v\/(\w[\w.-]*)\/src\/version\.js(?:[?#]|$)/.exec(String(url))?.[1] ?? 'dev';
}

export const BUILD = buildFromUrl(import.meta.url);

/** Resolves true when the site has published a different version than the one running here. */
export async function updateAvailable({ build = BUILD, pageUrl = globalThis.location?.href, fetchFn = globalThis.fetch } = {}) {
  if (build === 'dev' || !pageUrl || typeof fetchFn !== 'function') return false;
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined;
    const res = await fetchFn(new URL('version.json', pageUrl).href, { cache: 'no-store', signal });
    if (!res.ok) return false;
    const info = await res.json();
    return typeof info?.version === 'string' && info.version !== build;
  } catch {
    return false;
  }
}
