/**
 * Is the Cloudflare solver behind its latest release?
 *
 * The version is already in hand -- `solverPing()` reads it out of the solver's own greeting and the health
 * page printed it and threw the rest away. All that was missing was something to compare it to.
 *
 * The fetching, caching and comparison rules now live in ./githubRelease, because the update check needs
 * exactly the same behaviour against a different repo. This file is what is solver-specific about it: which
 * repo, and the names the rest of the code already imports.
 */
import { latestRelease, resetReleaseCache } from './githubRelease';

export { parseVersion, isBehind } from './githubRelease';

/**
 * Where each solver Health can name publishes its releases (v0.55.3, flaresolverr.ts SolverKind). trawl's are its own:
 * held against FlareSolverr's 3.x, its 1.7.0 read as years behind. A solver of another kind is compared with nothing.
 */
const SOLVER_REPOS = { flaresolverr: 'FlareSolverr/FlareSolverr', trawl: 'germondai/trawl' } as const;

/** The newest published release of that solver (FlareSolverr's by default), or null if we could not find out. Never throws. */
export function latestSolverVersion(now = Date.now(), kind: keyof typeof SOLVER_REPOS = 'flaresolverr'): Promise<string | null> {
  return latestRelease(SOLVER_REPOS[kind], now);
}

/** Test seam: drop the memoised answer. */
export function resetSolverVersionCache(): void {
  resetReleaseCache();
}
