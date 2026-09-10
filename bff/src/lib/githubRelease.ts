/**
 * "What is the newest published release of X?", asked of GitHub, safely.
 *
 * This was written for the Cloudflare solver and is now also used to tell an operator that a newer Uchiyomi
 * exists. Both are the same job with a different repo, so the rules live here once.
 *
 * ⚠️ THE ANSWER MUST NEVER MATTER. No network, a rate-limited reply, a tag in a shape nobody predicted:
 * every one of those means "no opinion" -- never an error, never a status of its own, never a reason for a
 * health check to fail. Knowing a newer version exists is a nice thing to know; a version check that can
 * take the health page down with it is not.
 *
 * ⚠️ AND IT MUST NEVER SAY ANYTHING ABOUT THIS INSTALL. It is a GET of a public releases endpoint. GitHub
 * learns an IP and a user-agent, which is unavoidable for any update check, and nothing else -- no version,
 * no id, no library. That is precisely what makes it safe to leave on by default, and it is why the opt-in
 * install count in installPing.ts is a SEPARATE switch pointing somewhere else. If this call ever went to a
 * server we run, "I have update checks on but the count off" would stop being true, so it must not.
 *
 * Cached per repo for a day, because unauthenticated GitHub allows 60 requests an hour per IP, shared with
 * everything else on the host.
 */

const TTL_MS = 24 * 60 * 60_000;
/** Long enough to be worth having, short enough that a hanging GitHub cannot hold a health check open. */
const TIMEOUT_MS = 4000;

const cache = new Map<string, { at: number; version: string | null }>();

/** `v3.5.0` / `3.5.0` -> [3,5,0]. Null for anything that is not three plain numbers. */
export function parseVersion(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Is `running` strictly older than `latest`?
 *
 * ⚠️ Returns false whenever either side cannot be parsed, which is the safe direction: an unrecognised
 * version string must read as "nothing to say", not as "you are out of date". A build newer than the last
 * published release -- a release candidate, or a fork -- is also not behind.
 * Reintroduce by comparing the strings directly: '3.10.0' sorts before '3.5.0' and a current install is
 * reported as stale.
 */
export function isBehind(running: string | null | undefined, latest: string | null | undefined): boolean {
  const a = parseVersion(running);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/**
 * The newest published release tag of `repo` (`owner/name`), or null if we could not find out.
 * Never throws.
 */
export async function latestRelease(repo: string, now = Date.now()): Promise<string | null> {
  const hit = cache.get(repo);
  if (hit && now - hit.at < TTL_MS) return hit.version;
  let version: string | null = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'uchiyomi' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A rate-limited or unavailable GitHub is a normal Tuesday, not a fault to report.
    if (r.ok) {
      const j = (await r.json()) as { tag_name?: unknown };
      if (typeof j?.tag_name === 'string' && parseVersion(j.tag_name)) version = j.tag_name;
    }
  } catch {
    /* offline, blocked, timed out -- all mean "no opinion" */
  }
  // Cached either way, INCLUDING a null. Otherwise an unreachable GitHub is retried on every single health
  // page load, which is the rate-limit problem this cache exists to avoid, only worse.
  cache.set(repo, { at: now, version });
  return version;
}

/** Test seam: drop the memoised answers. */
export function resetReleaseCache(): void {
  cache.clear();
}
