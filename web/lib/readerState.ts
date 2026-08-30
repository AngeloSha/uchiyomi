// What the reader concluded about a chapter it tried to open.
//
// This existed only as inline `if` statements, and they collapsed three distinct answers into two. On first
// load, `if (!alive || !first) { setReady(true); return; }` treated "could not load" as "nothing more to do",
// which cleared the loading overlay and left a bare black rectangle. Mid-series,
// `if (ch && ch.pages.length) ... else { setEnded(true); }` treated BOTH failure modes as the end of the
// series, so a damaged file or a dropped connection rendered as "You finished".
//
// The three cases have three different upstream causes and want three different things said to the reader:
//   * a corrupt CBZ, or a library that is not mounted right now, answers 200 with an EMPTY page list
//   * a book that was deleted, or that this account may not see, throws 404
//   * anything else is a chapter that opens normally
export type ChapterOutcome = 'ok' | 'unreadable' | 'unavailable';

export function chapterOutcome(ch: { pages: unknown[] } | null | undefined): ChapterOutcome {
  if (!ch) return 'unavailable';          // threw: gone, hidden, or the network went
  if (!ch.pages.length) return 'unreadable'; // resolved, but there is nothing in it to show
  return 'ok';
}
