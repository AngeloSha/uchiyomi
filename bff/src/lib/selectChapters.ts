// Which chapters an add takes when it does not take them all.
//
// Adapters return chapters ascending, so "first N" has always meant the OLDEST N: pick 25 of a 200-chapter
// series and you get 1..25, which is the right thing for a title you are starting and the wrong thing for one
// you are catching up on. 'newest' is the tail slice instead. Either way the selection stays ascending, so
// the download loop meets the chapters in reading order and a partial run still leaves a coherent prefix.

export type ChapterFrom = 'oldest' | 'newest';

/** No count, a zero count, or a count larger than the list all mean "every chapter". */
export function selectChapters<T>(chapters: T[], count?: number, from: ChapterFrom = 'oldest'): T[] {
  if (!count || count <= 0 || count >= chapters.length) return chapters;
  return from === 'newest' ? chapters.slice(chapters.length - count) : chapters.slice(0, count);
}
