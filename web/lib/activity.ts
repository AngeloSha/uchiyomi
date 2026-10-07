// A group's activity as a picture rather than a sentence, with no React in it.
//
// "ships weekly · last release 5d ago" is right but it is nine words per group, and the sources sheet lists
// every group. Twelve squares -- one per week, filled when the group released -- say the same thing in a
// glance, and a coloured dot beside them says whether the group is still going. The sentence survives as the
// strip's `title`/`aria-label` (cadence.ts still builds it), so nothing is lost for a screen reader or a hover.
//
// ⚠️ Two cases where the picture would lie, both handled here rather than in the component:
//   * a group nothing dated in the last twelve weeks is twelve empty squares, which on a finished series is
//     every group -- a wall of blank strips with amber warning dots. `weeksOf` returns null then, and the
//     caller shows "last release {ago}" instead;
//   * "quiet" is a warning on an ongoing series and a plain fact on a completed one. `activityStatus` takes
//     the series' status so a finished title's groups are grey, not amber.

import type { Cadence, GroupStat } from './types';
import { keys, t as tr } from './i18n';

export type ActivityStatus = 'active' | 'quiet' | 'done' | 'unknown';

/** Whether `status` (the series' metadata status, free text from sources) says the series is over. */
export function seriesFinished(status: string | null | undefined): boolean {
  return /\b(completed?|finished|ended?|cancell?ed|dropped)\b/i.test(status ?? '');
}

// The four statuses the Library filters by (components/LibraryFilters.tsx STATUS_LABELS), declared again here
// because statusText reaches them through a variable.
const STATUS_WORDS = keys('Ongoing', 'Completed', 'Hiatus', 'Cancelled');

/**
 * A series' status in the reader's words: the four the Library filters by and their synonyms, read the way the
 * server reads them for Komga (bff lib/komgaDto.ts komgaStatus), through their keys; any other words a source
 * wrote, as it wrote them. The series page and the home hero printed `status.toLowerCase()`, which read "ongoing"
 * in every language.
 */
export function statusText(status: string): string {
  const s = status.trim().toUpperCase().replace(/[\s_-]+/g, ' ');
  if (s === 'ONGOING' || s === 'PUBLISHING' || s === 'RELEASING') return tr(STATUS_WORDS[0]);
  if (s === 'COMPLETED' || s === 'COMPLETE' || s === 'FINISHED' || s === 'PUBLISHING FINISHED' || s === 'ENDED') return tr(STATUS_WORDS[1]);
  if (s === 'ON HIATUS' || s === 'HIATUS' || s === 'PAUSED') return tr(STATUS_WORDS[2]);
  if (s === 'CANCELLED' || s === 'CANCELED' || s === 'DROPPED' || s === 'ABANDONED') return tr(STATUS_WORDS[3]);
  return status.toLowerCase();
}

/**
 * The dot beside the strip. `unknown` when the group has no dated release at all; `quiet` when the server
 * says so on a series still running; `done` for the same silence on a finished series; else `active`.
 */
export function activityStatus(
  g: { cadence: Cadence; lastReleaseAt: string | null },
  seriesStatus?: string | null,
): ActivityStatus {
  if (!g.lastReleaseAt) return 'unknown';
  if (g.cadence.quiet) return seriesFinished(seriesStatus) ? 'done' : 'quiet';
  return 'active';
}

/**
 * The twelve flags to draw, or null when there is nothing to draw: the server did not send them (older than
 * v0.34.0), they are not twelve, or none is set.
 */
export function weeksOf(g: Pick<GroupStat, 'weeks'>): boolean[] | null {
  const w = g.weeks;
  if (!Array.isArray(w) || w.length !== 12) return null;
  return w.some(Boolean) ? w.map(Boolean) : null;
}
