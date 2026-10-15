// What every Health check shares: the page size, the cut, the verdict and the summary's tails. Kept apart from
// health.ts so a check can live in its own file without importing the whole report.
import { joined, say, type Part } from './said';

export const MAX_ITEMS = 50; // keep the payload sane; the summary always reports the true total
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ⚠️ FINDINGS FIRST, always, before the slice. A check's status is decided by the items WITHOUT `info`
 * (the page's one invariant, pinned in health.int.test.ts), so a check holding sixty greyed rows and three
 * real ones could cut the real ones off and report a warning with nothing in it -- which reads as a page
 * bug rather than as a finding. Sorting by severity first costs nothing and makes the slice safe whatever
 * order the check itself built its rows in.
 */
export function truncate<T extends { info?: boolean }>(rows: T[]): { items: T[]; hidden: number } {
  const ordered = [...rows].sort((a, b) => Number(!!a.info) - Number(!!b.info));
  return { items: ordered.slice(0, MAX_ITEMS), hidden: Math.max(0, rows.length - MAX_ITEMS) };
}

/** A check's verdict, from the items that are findings: the invariant, written once. */
export const verdict = <S extends string>(items: Array<{ info?: boolean }>, bad: S | 'warn' = 'warn'): S | 'warn' | 'ok' =>
  items.some((i) => !i.info) ? bad : 'ok';

/** A summary's "; 2 ignored": the findings an admin chose to stop being told about (lib/healthIgnore.ts). */
export const ignoredPart = (n: number): Part | null => (n ? say('ignored', { n }) : null);
/** A note's " 3 more not shown.": the rows past the slice. */
export const hiddenPart = (n: number): Part | null => (n > 0 ? joined('sentence', say('hidden', { n })) : null);
