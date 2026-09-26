// Telling an admin the library needs attention, without them going to look (#101, @Squeaks72's proposal).
//
// Admin -> Health only speaks to somebody who has already decided to open it, and what it finds -- a source
// blocked for a week, chapters failing their retries, folders the scan cannot index -- is exactly what goes
// unnoticed because nothing announces it. So an admin's header carries a quiet marker while the last report
// is not clean, and a banner appears once when the SET of findings changes.
//
// The data is `GET /api/admin/health/summary`, which answers from a stored report and never runs the checks
// (bff lib/healthSummary.ts). Nothing here is for other accounts: the route is admin-only, its text names
// sources and folders, and there is nothing an ordinary reader could do about any of it.

export type HealthTone = 'warn' | 'problem';

export interface HealthSummary {
  at: string;
  worst: 'ok' | HealthTone;
  count: number;
  headline: string | null;
  /** Changes only when WHICH checks found something changes, not when a count inside one moves. */
  key: string;
  checks: Array<{ id: string; title: string; status: 'ok' | HealthTone; summary: string }>;
}

/** The marker's colour, or null for no marker at all: a clean report shows nothing. */
export function alertTone(s: HealthSummary | null | undefined): HealthTone | null {
  return s && s.count > 0 && s.worst !== 'ok' ? s.worst : null;
}

/**
 * What a dismissal remembers (v0.48.3): which checks were finding something, and how badly -- not a hash of the
 * set. A hash changes when a check goes QUIET too (fixed, or its last finding ignored), and brought back a banner
 * the admin had already dismissed, over nothing new: the complaint Ignore exists to answer.
 */
export function seenValue(s: HealthSummary): string {
  return JSON.stringify({ v: 2, checks: s.checks.filter((c) => c.status !== 'ok').map((c) => `${c.id}:${c.status}`) });
}
function seenChecks(seen: string | null): Map<string, string> | null {
  if (!seen || !seen.startsWith('{')) return null;
  try {
    const v = JSON.parse(seen);
    return Array.isArray(v?.checks) ? new Map(v.checks.map((x: string) => { const i = x.lastIndexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; })) : null;
  } catch { return null; }
}

/**
 * Whether the banner shows. Once per finding set: dismissed (or followed), it stays away until a check that was
 * NOT finding anything then is finding something now, or one gets worse (warn to problem) -- and never on the
 * admin console itself, where the Health tab is one click away and saying it twice is noise. A check that goes
 * quiet brings nothing back. A dismissal stored by an older version (the bare key) is compared as it always was.
 */
export function bannerWanted(s: HealthSummary | null | undefined, seen: string | null, path: string): boolean {
  if (!alertTone(s) || !s!.key) return false;
  if (path.startsWith('/admin')) return false;
  const was = seenChecks(seen);
  if (!was) return s!.key !== seen;
  return s!.checks.some((c) => c.status !== 'ok' && (!was.has(c.id) || (c.status === 'problem' && was.get(c.id) !== 'problem')));
}

/**
 * The dismissal to keep when the banner is NOT wanted: today's set, which is inside what was dismissed. Stored back
 * so a check that has gone quiet leaves it -- and is news again if it ever returns -- rather than staying
 * dismissed on this device for good. Null when nothing needs writing.
 */
export function prunedSeen(s: HealthSummary | null | undefined, seen: string | null): string | null {
  if (!s || !seenChecks(seen)) return null;
  const next = seenValue(s);
  return next === seen ? null : next;
}

const SEEN = 'uchiyomi.healthSeen';

/** Per device, like every dismissal in the app. Storage that throws reads as never dismissed. */
export function readSeen(): string | null {
  try { return localStorage.getItem(SEEN); } catch { return null; }
}
export function writeSeen(key: string): void {
  try { localStorage.setItem(SEEN, key); } catch { /* a private window: the banner comes back, which is harmless */ }
}
