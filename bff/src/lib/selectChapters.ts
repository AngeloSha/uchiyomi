// Which chapters an add takes when it does not take them all.
//
// Adapters return chapters ascending, so "first N" has always meant the OLDEST N: pick 25 of a 200-chapter
// series and you get 1..25, which is the right thing for a title you are starting and the wrong thing for one
// you are catching up on. 'newest' is the tail slice instead. Either way the selection stays ascending, so
// the download loop meets the chapters in reading order and a partial run still leaves a coherent prefix.
//
// 'none' is the add that fetches nothing: the series is created, followed and floored above what the
// source lists today, and chapters arrive only as they are released (or when a person fetches older ones
// from the series page). It ignores the count on purpose -- "nothing" with a count is still nothing.

export type ChapterFrom = 'oldest' | 'newest' | 'none';

/** No count, a zero count, or a count larger than the list all mean "every chapter" -- unless `from` is 'none'. */
export function selectChapters<T>(chapters: T[], count?: number, from: ChapterFrom = 'oldest'): T[] {
  // Before the count rules, or "nothing" would read as "everything" whenever the count is absent or oversize.
  // Reintroduce by moving this below the count line: "none selects nothing whatever the count" reads ten.
  if (from === 'none') return [];
  if (!count || count <= 0 || count >= chapters.length) return chapters;
  return from === 'newest' ? chapters.slice(chapters.length - count) : chapters.slice(0, count);
}
