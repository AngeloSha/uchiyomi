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

const SOLVER_REPO = 'FlareSolverr/FlareSolverr';

/** The newest published FlareSolverr release, or null if we could not find out. Never throws. */
export function latestSolverVersion(now = Date.now()): Promise<string | null> {
  return latestRelease(SOLVER_REPO, now);
}

/** Test seam: drop the memoised answer. */
export function resetSolverVersionCache(): void {
  resetReleaseCache();
}
