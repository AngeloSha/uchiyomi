// What the reader concluded about a chapter it tried to open.
//
// This existed only as inline `if` statements, and they collapsed three distinct answers into two. On first
// load, `if (!alive || !first) { setReady(true); return; }` treated "could not load" as "nothing more to do",
// which cleared the loading overlay and left a bare black rectangle. Mid-series,
// `if (ch && ch.pages.length) ... else { setEnded(true); }` treated BOTH failure modes as the end of the
// series, so a damaged file or a dropped connection rendered as "You finished".
//
// The four cases have four different upstream causes and want four different things said to the reader:
//   * a corrupt CBZ, or a library that is not mounted right now, answers 200 with an EMPTY page list
//   * a book that was deleted, or that this account may not see, throws 404
//   * a chapter the server's read-chapter cleanup deleted also answers 200 with an empty page list, and
//     saying "the file may be damaged" about a file the admin deliberately removed sends someone to check
//     their mounts over a working install. `pruned` is what tells the two empties apart.
//   * anything else is a chapter that opens normally
export type ChapterOutcome = 'ok' | 'unreadable' | 'unavailable' | 'pruned';

export function chapterOutcome(ch: { pages: unknown[]; pruned?: boolean } | null | undefined): ChapterOutcome {
  if (!ch) return 'unavailable';          // threw: gone, hidden, or the network went
  // Checked before the length, not after: a pruned chapter is empty BY DEFINITION, so the order is the
  // whole distinction. There is nothing to retry and nothing wrong with the install.
  if (ch.pruned) return 'pruned';
  if (!ch.pages.length) return 'unreadable'; // resolved, but there is nothing in it to show
  return 'ok';
}
