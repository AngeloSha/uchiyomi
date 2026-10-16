// Guards on the reader's chapter-level moves, so one stray touch or keypress cannot leave the chapter.
//
// A page turn is cheap to undo; leaving a chapter is not -- it drops the page you were on, and skipping
// forward past unread pages is silent. These are the rules for when a single press is enough.

/** How long an armed "next chapter" stays armed. Long enough to look up and press again, short enough to lapse. */
export const ARM_MS = 3000;

/** On this many of a chapter's last pages, "next chapter" needs no second press: you are done with it. */
export const NEAR_END_PAGES = 2;

/** Whether "next chapter" should ask for a second press, given how many flow pages of this chapter remain after the current one. */
export function skipNeedsConfirm(pagesAfterCurrent: number): boolean {
  return pagesAfterCurrent >= NEAR_END_PAGES;
}

/** Whether a press at `now` lands inside the window opened by an arming press at `armedAt` (null = never armed). */
export function stillArmed(armedAt: number | null, now: number): boolean {
  return armedAt != null && now - armedAt <= ARM_MS;
}

/** Number of flow items in the same chapter after `current`. */
export function pagesAfter(flow: ReadonlyArray<{ ci: number }>, current: number): number {
  const ci = flow[current]?.ci;
  if (ci == null) return 0;
  let n = 0;
  for (let i = current + 1; i < flow.length && flow[i].ci === ci; i++) n++;
  return n;
}

/** A run of chapter numbers a series is missing: GET /api/series/:id/gaps, the Health card's own rule (bff lib/seriesGaps.ts). */
export interface GapRun { lo: number; hi: number }

/**
 * The missing runs the reader skips going from the chapter numbered `from` to the one numbered `to` (#236): the series'
 * runs, cut to the numbers strictly between the two. The runs are the server's, never counted here from the reader's own
 * chapter list: a file holding 1 to 7, a run the cleanup deleted after everyone read it, a gap an admin ignored on Health
 * and a post its source deleted are not missing, and the list cannot tell any of them apart. Nothing when either number is
 * unknown or the order does not run forward (an edition's copy of the same number, a special placed out of order).
 */
export function gapsBetween(gaps: readonly GapRun[], from: number | undefined | null, to: number | undefined | null): GapRun[] {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const lo = Math.floor(from) + 1;
  const hi = Math.ceil(to) - 1;
  const out: GapRun[] = [];
  for (const g of gaps) {
    const a = Math.max(g.lo, lo);
    const b = Math.min(g.hi, hi);
    if (a <= b) out.push({ lo: a, hi: b });
  }
  return out;
}
