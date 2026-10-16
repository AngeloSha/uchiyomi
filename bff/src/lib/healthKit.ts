// What every Health check shares: the page size, the cut, the verdict and the summary's tails (v0.72.0).
//
// Kept apart from lib/health.ts so a check can live in a file of its own (lib/healthDisk.ts, lib/healthTrackers.ts,
// lib/healthFiles.ts) without importing the whole report -- the split @Squeaks72 proposed in #253, when health.ts had
// grown to 2,193 lines. health.ts imports these too, so there is one copy of each rule.
import { joined, say, type Part } from './said';
import type { HealthCheck, HealthItem, HealthStatus } from './health';

export const MAX_ITEMS = 50; // keep the payload sane; the summary always reports the true total
export const DAY_MS = 24 * 60 * 60 * 1000;
/** The most chapters one Delete (or Fetch again) key acts on, and the most an admin can sensibly read in a confirmation. */
export const MAX_BOOK_IDS = 20;

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
export const verdict = (items: HealthItem[], bad: HealthStatus = 'warn'): HealthStatus =>
  items.some((i) => !i.info) ? bad : 'ok';

/** A summary's "; 2 ignored": the findings an admin chose to stop being told about (lib/healthIgnore.ts). */
export const ignoredPart = (n: number): Part | null => (n ? say('ignored', { n }) : null);
/** A note's " 3 more not shown.": the rows past the slice. */
export const hiddenPart = (n: number): Part | null => (n > 0 ? joined('sentence', say('hidden', { n })) : null);

/**
 * Every row a check found, before the cut to MAX_ITEMS (v0.72.0): what Health's By series view groups (lib/health.ts
 * groupBySeries, #254), so a series whose finding is a card's fifty-first is still there -- and its count, Select all and
 * Remove act on every series, not on the fifty each card shows. A symbol, so it never goes on the wire: JSON.stringify
 * leaves symbol keys out, and the card's payload stays the page it always was. Reintroduce the cut list by dropping
 * `withAll` from a check: "By series has every series, past the fifty a card shows" in healthBySeries.int.test.ts finds
 * series missing.
 */
export const ALL_ROWS: unique symbol = Symbol('every row of a Health check, before the cut');

/** The check, carrying its full list for the By series view. */
export function withAll<C extends HealthCheck>(check: C, all: readonly HealthItem[]): C {
  check[ALL_ROWS] = all;
  return check;
}

/** A check's full list: what `withAll` kept, else the rows it sends (a check that never cuts). */
export const allRows = (c: HealthCheck): readonly HealthItem[] => c[ALL_ROWS] ?? c.items;
