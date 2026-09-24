// The series page's chapter list, a page at a time. Long series (One Piece: 1,193 chapters) rendered every
// row at once; now the list shows CHAPTER_PAGE rows and a pager, and opens on the page holding the chapter
// "Continue" would open -- on chapter 956 nobody wants to start at chapter 1.
//
// Paged over the merged rows (chapters, ghosts, run rows), not the books, so ghosts sit on the page between
// the chapters they fall between, exactly as in the unpaged list.

export const CHAPTER_PAGE = 100;

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
