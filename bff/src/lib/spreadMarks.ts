// A reader's own say on where a double-page spread is (v0.89.0, #262 by @Squeaks72, rebuilt on v0.77.0's joining).
//
// The detector (lib/spreadJoin.ts, measured in the background by lib/spreadMeasure.ts) joins the two halves of a spread a
// source served as two pages. It is good, not perfect: it joins pairs that are not spreads and misses ones that are. A
// mark is one account's word on the pair (page, page + 1) of one chapter: `join` shows the two as one spread where the
// detector found none, `split` shows a pair it joined as two pages. No mark leaves the detector's answer standing.
//
// Per account, never shared: one reader's correction changes nothing for anyone else, so no account can break a chapter
// for another (the repeated-page flag is the household's; this is not). Kept beside the detector's answer, never in
// `lib_books.spreads`, so a re-measure or a new detector version leaves it alone. Each mark keeps the page count it was
// made on: a chapter whose file changed (a fixed copy with a page more) has other pages at those numbers, so a mark made
// on the old file is not applied to the new one -- the way the detector's answer is not, after a page-count mismatch.
// The marks ride on the page list (GET /api/books/:id/pages) and in the offline download's manifest, as `mark` on the
// first page of the pair, so the reader and a downloaded copy see them without asking for them.
import { q, tx } from './db';

export type SpreadMark = 'join' | 'split';

/** `{ first page of the pair -> mark }`, the account's marks on the chapter that were made on a file of `count` pages. */
export async function marksFor(userId: string, bookId: string, count: number): Promise<Map<number, SpreadMark>> {
  const rows = await q<{ page: number; mark: SpreadMark }>(
    'SELECT page, mark FROM spread_marks WHERE user_id = $1 AND book_id = $2 AND pages = $3 ORDER BY page', [userId, bookId, count]);
  return new Map(rows.map((r) => [Number(r.page), r.mark]));
}

/** The marks as the routes say them: `{ "4": "join", "9": "split" }`. */
export const marksJson = (m: Map<number, SpreadMark>): Record<string, SpreadMark> =>
  Object.fromEntries([...m].map(([page, mark]) => [String(page), mark]));

/**
 * Set the account's mark on the pair (page, page + 1) of a chapter of `count` pages, or clear it with `null`: the
 * detector's answer stands again. The caller has checked that the account may read the chapter and that `page` starts
 * a pair (1 to count - 1).
 *
 * A page is in one spread only: a join takes the account's join off either neighbouring pair (5 joined to 6 and 6 to 7
 * would be three pages in one picture). A neighbour's split stays: it says nothing about this pair. Marks made on an
 * earlier file of the chapter (another page count) are dropped with any change, as they no longer point at these pages.
 * Reintroduce by keying the row on the chapter alone: "a mark is the account's own" in spreadMarks.int.test.ts shows the
 * admin's merge to the member.
 *
 * One transaction, one account's chapter at a time (an advisory lock on the pair): two marks sent at once -- two tabs, two
 * devices, a second tap before the first answers -- could otherwise both pass the neighbour's delete and leave a page in
 * two joins. Reintroduce by dropping the lock: "two joins sent at once leave one" in spreadMarks.int.test.ts finds both.
 */
export async function setMark(userId: string, bookId: string, page: number, mark: SpreadMark | null, count: number): Promise<Map<number, SpreadMark>> {
  return tx(async (qq) => {
    await qq('SELECT pg_advisory_xact_lock(hashtext($1))', [`spread_marks:${userId}:${bookId}`]);
    await qq('DELETE FROM spread_marks WHERE user_id = $1 AND book_id = $2 AND pages <> $3', [userId, bookId, count]);
    if (mark === null) {
      await qq('DELETE FROM spread_marks WHERE user_id = $1 AND book_id = $2 AND page = $3', [userId, bookId, page]);
    } else {
      if (mark === 'join') {
        await qq(`DELETE FROM spread_marks WHERE user_id = $1 AND book_id = $2 AND mark = 'join' AND page IN ($3, $4)`, [userId, bookId, page - 1, page + 1]);
      }
      await qq(
        `INSERT INTO spread_marks (user_id, book_id, page, mark, pages) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, book_id, page) DO UPDATE SET mark = EXCLUDED.mark, pages = EXCLUDED.pages, updated_at = now()`,
        [userId, bookId, page, mark, count]);
    }
    const rows = await qq<{ page: number; mark: SpreadMark }>(
      'SELECT page, mark FROM spread_marks WHERE user_id = $1 AND book_id = $2 AND pages = $3 ORDER BY page', [userId, bookId, count]);
    return new Map(rows.map((r) => [Number(r.page), r.mark]));
  });
}
