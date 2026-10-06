// "Show all chapters at once": the series page's chapter list on one page, with every ghost row and every
// older-chapters run unfolded -- no pager, no "Show all {n}" row. Stored on the account (`app_settings.data`,
// PUT /api/settings), like Reduce effects, so it follows the reader to every device they sign in on. Off by
// default: a 1,000-chapter series a hundred rows at a time is the deliberate look.

/** Whether the account asked for the whole chapter list at once. Anything but `true` reads as off. */
export function showAllChaptersOn(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.showAllChapters === true;
}

/**
 * The runs mergeRows unfolds (its `expandedRuns`). With the whole list asked for every run is open except those the
 * reader folded on this page (`folded`); otherwise just the ones they opened (`opened`). A test-shaped `has`, which
 * is all mergeRows reads, so "every run" needs no list of the runs first.
 */
export function openRuns(all: boolean, opened: ReadonlySet<number>, folded: ReadonlySet<number>): { has(n: number): boolean } {
  return all ? { has: (n: number) => !folded.has(n) } : opened;
}
