// A chapter file that holds several chapters (v0.55.2, discussion #150): `Batman 01-07 (1987).cbz`, read by name rule
// 2 (lib/naming.ts chapterFromName), is lib_books.number 1 with lib_books.number_end 7 -- one file, one row, chapters
// 1 to 7. number_end is NULL for one chapter, as every row was before.
//
// What each reader of a book's number does with a range, decided once, here:
//   - the START (lib_books.number) is the book's place: the chapter list's order and next/previous, the Komga API's
//     numberSort, the cover, and every match against ONE chapter landing or listed -- a range is never a chapter's
//     landing, so the stamps (dates, groups, borrowed and healed names) and a renumber's plan leave it alone;
//   - every number from the start to the END is HELD: the gaps (lib/libraryNumbers.ts HAVE_SQL), the sweep's and the
//     add's have-sets, the ghost rows, the slow archive's work list, the failure ledger's "it landed";
//   - the END is how far a reader got who finished the book: what the trackers are told, the run Mihon reads, the
//     edition chips' "read to", Mark caught up.
// An admin's number (book_overrides.number, Edit number & title) replaces the file's reading, the range with it: the
// book is that one chapter. And a stored end is a range only while it is above the number and at most MAX_RANGE past
// it, as the parser writes it: a v0.55.1 scan after a rollback rewrites `number` by the first number in the name and
// never meets number_end, so until v0.55.2's next scan writes both again the pair can say anything.
//
// ⚠️ The ONE definition. Every query that needs the rule interpolates a fragment from here, as lib/visibility.ts's
// are. No fragment binds a parameter. Pure: no database (chapterRanges.test.ts imports it).
import { MAX_RANGE } from './naming';

/** Is book `b` a range, as its file reads? Never NULL, so `NOT isRange(b)` keeps every single chapter. */
export const isRange = (b: string): string =>
  `COALESCE(${b}.number_end > ${b}.number AND ${b}.number_end <= ${b}.number + ${MAX_RANGE}, false)`;

/** The end of the file's own range, NULL for one chapter: for the readers that compare the RAW number. */
export const rawRangeEnd = (b: string): string => `(CASE WHEN ${isRange(b)} THEN ${b}.number_end END)`;

/**
 * The end of book `b`'s range as a reader sees it (`ov` is its LEFT JOINed book_overrides row): NULL for one chapter,
 * and for a range an admin has numbered by hand.
 */
export const rangeEnd = (b: string, ov: string): string =>
  `(CASE WHEN ${ov}.number IS NULL AND ${isRange(b)} THEN ${b}.number_end END)`;

/** The last chapter book `b` holds, override-aware: its range's end, else its number. */
export const lastNumber = (b: string, ov: string): string => `COALESCE(${rangeEnd(b, ov)}, ${ov}.number, ${b}.number)`;

/** Does book `b` hold chapter `num` (an SQL expression)? Its own number, override-aware, or one inside its range. */
export const holds = (b: string, ov: string, num: string): string =>
  `(COALESCE(${ov}.number, ${b}.number) = ${num} OR ${num} BETWEEN ${b}.number AND ${rangeEnd(b, ov)})`;

/** holds, by the RAW number: for the readers that compare it (lib/updater.ts says which and why). */
export const holdsRaw = (b: string, num: string): string =>
  `(${b}.number = ${num} OR ${num} BETWEEN ${b}.number AND ${rawRangeEnd(b)})`;

/** A held book as the JS readers take it: its number, and the end of its range when it is one. */
export interface HeldBook {
  number: number | string;
  end?: number | string | null;
}

/**
 * The numbers some books hold, as a test: `n` is held when a book is numbered `n` or `n` lies inside a book's range.
 * The JS twin of `holds`, for have-sets read into memory (the sweep, the add, the fetch route).
 */
export function heldBy(rows: Iterable<HeldBook>): { has(n: number): boolean } {
  const exact = new Set<number>();
  const ranges: Array<[number, number]> = [];
  for (const r of rows) {
    const n = Number(r.number);
    exact.add(n);
    const e = r.end == null ? NaN : Number(r.end);
    if (e > n && e - n <= MAX_RANGE) ranges.push([n, e]);
  }
  return { has: (n: number) => exact.has(n) || ranges.some(([a, z]) => n >= a && n <= z) };
}

/** A book's number as it is read out: `12`, or `1–7` for a range. */
export const numberText = (number: number, end: number | null | undefined): string =>
  end != null && Number(end) > Number(number) ? `${number}–${end}` : String(number);
