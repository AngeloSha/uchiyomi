// Which Uchiyomi is running, where an admin looks for it (v0.55.4, #150).
//
// Kedryn: "I can't find anymore what version I'm running. I'm pretty sure it was in a menu on the left somewhere." It
// was only Health's Version card, a tab and a scroll away. Now it is the foot of the admin menu, and on a phone (no
// menu down the side) one of the header's facts. The number comes from /api/admin/stats (bff lib/appVersion.ts) -- or,
// in Uchiyomi Desktop, from the app itself -- and whether a newer one is out from Health's `update` check: the answer
// the admin header has already asked for, so this asks GitHub nothing, and an admin who switched update checks off is
// told nothing about it rather than "up to date".
import type { Said } from './said';

/** Where releases are published: the repository the server's update check asks (bff lib/health.ts APP_REPO). */
export const RELEASES_URL = 'https://github.com/AngeloSha/uchiyomi/releases';

export type UpdateState = { kind: 'behind'; latest: string } | { kind: 'current' } | null;

/**
 * What Health's `update` check says about the running version: a newer release is out (`behind`, with its tag), it is
 * the newest (`current`), or null -- no answer yet, update checks off, GitHub not answering just now, or a version that
 * could not be read. Read from the check's codes (bff lib/said.ts `version.*`), the server's own words for each case:
 * "Running v0.55.4 — up to date" is `version.current`, and only that is a reason to print "up to date".
 */
export function updateState(checks: ReadonlyArray<{ id: string; summarySaid?: Said[] }> | undefined): UpdateState {
  const said = checks?.find((c) => c.id === 'update')?.summarySaid?.[0];
  if (said?.code === 'version.behind') {
    const latest = said.params?.latest;
    return typeof latest === 'string' && latest.trim() ? { kind: 'behind', latest: latest.trim() } : null;
  }
  return said?.code === 'version.current' ? { kind: 'current' } : null;
}

/**
 * The release page of the tag the update check named (`v0.55.5`), or the list of releases for anything that does not
 * look like one: the tag is GitHub's answer, passed through the server, and never becomes a path of its own choosing.
 */
export function releaseHref(tag: string): string {
  return /^v?\d+\.\d+\.\d+[0-9A-Za-z.-]*$/.test(tag) ? `${RELEASES_URL}/tag/${encodeURIComponent(tag)}` : RELEASES_URL;
}

/** `0.55.4` → `v0.55.4`, as Health's card prints it; one that already starts with a v is left alone. */
export const shownVersion = (v: string): string => (/^v/i.test(v.trim()) ? v.trim() : `v${v.trim()}`);
