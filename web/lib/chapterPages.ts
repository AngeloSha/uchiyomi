// The series page's chapter list, a page at a time. Long series (One Piece: 1,193 chapters) rendered every
// row at once; now the list shows CHAPTER_PAGE rows and a pager, and opens on the page holding the chapter
// "Continue" would open -- on chapter 956 nobody wants to start at chapter 1.
//
// Paged over the merged rows (chapters, ghosts, run rows), not the books, so ghosts sit on the page between
// the chapters they fall between, exactly as in the unpaged list.

import type { Row } from './chapterRows';

export const CHAPTER_PAGE = 100;

/**
 * The page size the series page uses: CHAPTER_PAGE, or every row on one page when the reader asked for the whole list
 * at once (the account setting `showAllChapters`, lib/showAllChapters.ts). The whole list is a size, never Infinity:
 * `0 * Infinity` is NaN, and `rows.slice(NaN, NaN)` is an empty page.
 */
export const pageSizeFor = (all: boolean, total: number): number => (all ? Math.max(1, total) : CHAPTER_PAGE);

export function pageCount(total: number, size = CHAPTER_PAGE): number {
  return Math.max(1, Math.ceil(total / size));
}

/** The page holding the first row `isTarget` accepts; page 0 when none does. */
export function pageOf<T>(rows: readonly T[], isTarget: (r: T) => boolean, size = CHAPTER_PAGE): number {
  const i = rows.findIndex(isTarget);
  return i < 0 ? 0 : Math.floor(i / size);
}

export function clampPage(page: number, total: number, size = CHAPTER_PAGE): number {
  return Math.min(Math.max(0, page), pageCount(total, size) - 1);
}

export function pageSlice<T>(rows: readonly T[], page: number, size = CHAPTER_PAGE): T[] {
  const p = clampPage(page, rows.length, size);
  return rows.slice(p * size, p * size + size);
}

/**
 * The chapter numbers a row stands for, top to bottom as the list shows them; none for "show all". A file holding a
 * range stands for its start and its end (v0.55.2), so a page ending on `Batman 95-100` reads "…–100".
 */
export function rowNumbers(r: Row, asc: boolean): number[] {
  if (r.kind === 'book') {
    const { number, numberEnd } = r.book;
    if (numberEnd == null || !(numberEnd > number)) return [number];
    return asc ? [number, numberEnd] : [numberEnd, number];
  }
  if (r.kind === 'ghost') return [r.ghost.number];
  if (r.kind === 'run') return asc ? [r.from, r.to] : [r.to, r.from];
  return [];
}

// `real` columns arrive with float noise (20.100000381); two decimals is every numbering a source uses.
const fmtNumber = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * A page's name in the picker: the first and last chapter numbers it shows, in the list's own order, so
 * newest-first reads "1193–1094" -- what a reader hunting for a chapter scans for. Row positions were wrong
 * twice over: ghost, run and "show all" rows are rows but not chapters, and newest-first put "1–100" on the
 * page holding 1193–1094. A page with no numbered row falls back to its position.
 */
export function pageLabel(rows: readonly Row[], page: number, asc: boolean, size = CHAPTER_PAGE): string {
  const nums = pageSlice(rows, page, size).flatMap((r) => rowNumbers(r, asc));
  if (!nums.length) return String(page + 1);
  const [a, b] = [nums[0], nums[nums.length - 1]];
  return a === b ? fmtNumber(a) : `${fmtNumber(a)}–${fmtNumber(b)}`;
}

/**
 * The numbers a series' chapters run from and to, for the header ("149 chapters · Ch. 0–129"), when they do not simply
 * run 1 to the count: half chapters (12.5), a chapter 0, extras or a gap make the count and the last number differ, and
 * "86–129 of 149" read as twenty chapters missing that were never there (10-19). Null when they agree, or with fewer
 * than two chapters. A file holding a range counts to its end.
 */
export function numberingSpan(books: ReadonlyArray<{ number: number; numberEnd?: number | null }>, count: number): { a: string; b: string } | null {
  if (count < 2 || !books.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const b of books) {
    lo = Math.min(lo, b.number);
    hi = Math.max(hi, b.numberEnd != null && b.numberEnd > b.number ? b.numberEnd : b.number);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  if (lo === 1 && hi === count) return null;
  return { a: fmtNumber(lo), b: fmtNumber(hi) };
}

