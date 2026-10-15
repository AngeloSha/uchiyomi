// A reader's own say on where a double-page spread is.
//
// The detector (lib/spreadJoin.ts) is good, not perfect: it joins pairs that are not spreads and misses ones that are. A mark
// tells THIS account's reader what to do with the pair (page, page + 1) of one chapter: `join` shows them as one spread where
// the detector found none, `split` shows them as two pages where it joined them. No mark leaves the detector's answer.
// Marks are per account, so one reader's correction cannot break a chapter for another, and they sit beside
// lib_books.page_dims, never in it, so a re-measure leaves them alone.
import { q } from './db';

export type SpreadMark = 'join' | 'split';

/** The most marks one account keeps on one chapter: a chapter has a few spreads, so more is a script or a slip. */
export const MAX_MARKS_PER_BOOK = 60;

/** `{ [first page of the pair]: mark }` for this account and chapter. */
export async function marksFor(userId: string, bookId: string): Promise<Record<number, SpreadMark>> {
  const rows = await q<{ page: number; mark: SpreadMark }>(
    'SELECT page, mark FROM spread_marks WHERE user_id = $1 AND book_id = $2', [userId, bookId]);
  return Object.fromEntries(rows.map((r) => [r.page, r.mark]));
}

export type SetMarkResult = 'ok' | 'bad_page' | 'too_many';

/**
 * Set the mark on the pair (page, page + 1), or clear it with `null` (back to the detector's answer). `pages` is the
 * chapter's page count: `page` must be 1..pages-1. A join drops a join on either neighbouring pair, because a page is in one
 * spread only (5 joined to 6 and 6 to 7 would be three pages in one picture).
 */
export async function setMark(userId: string, bookId: string, page: number, mark: SpreadMark | null, pages: number): Promise<SetMarkResult> {
  if (!Number.isInteger(page) || page < 1 || page >= pages) return 'bad_page';
  if (mark === null) {
    await q('DELETE FROM spread_marks WHERE user_id = $1 AND book_id = $2 AND page = $3', [userId, bookId, page]);
    return 'ok';
  }
  const [{ n }] = await q<{ n: number }>(
    'SELECT count(*)::int AS n FROM spread_marks WHERE user_id = $1 AND book_id = $2 AND page <> $3', [userId, bookId, page]);
  if (n >= MAX_MARKS_PER_BOOK) return 'too_many';
  if (mark === 'join') {
    await q(`DELETE FROM spread_marks WHERE user_id = $1 AND book_id = $2 AND mark = 'join' AND page IN ($3, $4)`, [userId, bookId, page - 1, page + 1]);
  }
  await q(
    `INSERT INTO spread_marks (user_id, book_id, page, mark) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, book_id, page) DO UPDATE SET mark = EXCLUDED.mark, updated_at = now()`,
    [userId, bookId, page, mark]);
  return 'ok';
}
