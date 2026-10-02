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
