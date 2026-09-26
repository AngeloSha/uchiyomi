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
 * Whether the banner shows. Once per finding set: dismissed (or followed) for `key`, it stays away until
 * `key` changes -- a new kind of problem, or one getting worse -- and never on the admin console itself,
 * where the Health tab is one click away and saying it twice is noise.
 */
export function bannerWanted(s: HealthSummary | null | undefined, seen: string | null, path: string): boolean {
  if (!alertTone(s) || !s!.key) return false;
  if (path.startsWith('/admin')) return false;
  return s!.key !== seen;
}

const SEEN = 'uchiyomi.healthSeen';

/** Per device, like every dismissal in the app. Storage that throws reads as never dismissed. */
export function readSeen(): string | null {
  try { return localStorage.getItem(SEEN); } catch { return null; }
}
export function writeSeen(key: string): void {
  try { localStorage.setItem(SEEN, key); } catch { /* a private window: the banner comes back, which is harmless */ }
}
