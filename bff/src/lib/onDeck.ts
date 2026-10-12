// Which chapter Home offers for each series someone has been reading: Keep reading's pick, and since v0.61.0 Pick back
// up's, the same pick over an older window.
//
// One row per series: the chapter you are part-way through, or -- if you finished it -- the next one you have not read.
// It used to be only `completed = false`, so finishing a chapter dropped the series out of Continue Reading entirely and
// nothing put the next one in front of you. You had to remember what you were reading and go find it, which is precisely
// the job this rail exists to do.
//
// Moved here from routes/catalog.ts (v0.61.0) so Home's two rails and the OPDS Keep reading shelf (routes/opds.ts) pick
// by one rule.
import { q } from './db';
import { Params, browsable, type ViewCtx } from './visibility';
import { noticeBook } from './noticeChapters';

/**
 * `recent`, Keep reading: series touched in the last RECENT_DAYS days, ordered by when you last read. `stale`, Pick back
 * up (v0.61.0): series whose every row is older than that but newer than STALE_DAYS, in which you finished at least one
 * chapter -- something you got into and put down, not a first chapter you bounced off. The two windows cannot share a
 * series: one asks for a row newer than the boundary, the other for none.
 */
export type DeckWindow = 'recent' | 'stale';

export const RECENT_DAYS = 90;
/** Beyond two years a series is not one you put down for a while; it is one you left. */
export const STALE_DAYS = 730;

export interface DeckPick {
  bookId: string;
  seriesId: string;
  /** When you last read in the series: Pick back up says how long ago. */
  lastRead: string;
}

/**
 * The picks, newest-read first, at most `limit`. A series with nothing left to offer -- every chapter finished, or the
 * only unfinished ones gone -- has no pick and drops out, correctly.
 *
 * The 18+ filter is applied HERE rather than after the fact, for the same reason the LIMIT is: callers resolve each pick
 * by id (komga.book(), OPDS's chapter rows), which is a by-id read and deliberately does not filter, so a series hidden
 * from browsing would otherwise stay on the rail. Params rather than hand-written $1/$2 because `browsable()` pushes its
 * own for a restricted viewer.
 */
export async function onDeckPicks(uid: string, ctx: ViewCtx, o: { window: DeckWindow; limit: number }): Promise<DeckPick[]> {
  const p = new Params();
  const uidP = p.add(uid);
  // Keep reading filters the rows to the window before grouping, as it always has; Pick back up has to see every row of
  // a series to know that none is recent, so it groups first and asks of the group. Reintroduce by dropping either edge
  // or the finished-chapter count: "Pick back up and Keep reading split at 90 days and never share a series" in
  // homeRails.int.test.ts finds a series this week's, one of three years ago, or one only peeked at.
  const rows = o.window === 'recent' ? `AND rp.updated_at > now() - interval '${RECENT_DAYS} days'` : '';
  const group = o.window === 'stale'
    ? `HAVING max(rp.updated_at) <= now() - interval '${RECENT_DAYS} days'
          AND max(rp.updated_at) > now() - interval '${STALE_DAYS} days'
          AND count(*) FILTER (WHERE rp.completed AND NOT ${noticeBook('rp.book_id')}) > 0`
    : '';
  const picks = await q<{ book_id: string; series_id: string; last_read: Date }>(
    `WITH touched AS (
       SELECT series_id, max(updated_at) AS last_read
         FROM read_progress rp
        WHERE rp.user_id = ${uidP} ${rows}
          AND EXISTS (SELECT 1 FROM lib_series s WHERE s.id = rp.series_id AND ${browsable('s', ctx, p)})
        GROUP BY series_id
        ${group}
     ),
     pick AS (
       SELECT r.series_id, r.last_read,
              COALESCE(
                -- the chapter you are part-way through wins
                (SELECT p.book_id FROM read_progress p
                   WHERE p.user_id = ${uidP} AND p.series_id = r.series_id AND p.completed = false
                     -- not a notice chapter the admin hides (lib/noticeChapters.ts): it is no chapter to resume
                     AND NOT ${noticeBook('p.book_id')}
                     -- nor one whose pages were deleted (v0.60.1, found in Squeaks72's fork): it used to win here
                     -- and then be dropped by the resolved-book filter below, taking the whole series off the rail
                     -- instead of falling through to the next chapter. NOT EXISTS of a KNOWN tombstone, not EXISTS
                     -- of a live row: a Komga-backed install has no lib_books row for the book at all.
                     AND NOT EXISTS (SELECT 1 FROM lib_books pb WHERE pb.id = p.book_id AND pb.pruned_at IS NOT NULL)
                   ORDER BY p.updated_at DESC LIMIT 1),
                -- otherwise the lowest-numbered chapter you have not finished
                (SELECT b.id FROM lib_books b
                   LEFT JOIN book_overrides bo ON bo.book_id = b.id
                   WHERE b.series_id = r.series_id
                     -- never offer a chapter whose pages were deleted (a tombstone, lib/chapterCleanup.ts)
                     AND b.pruned_at IS NULL
                     AND NOT ${noticeBook('b.id')}
                     AND NOT EXISTS (
                       SELECT 1 FROM read_progress p2
                        WHERE p2.user_id = ${uidP} AND p2.book_id = b.id AND p2.completed
                     )
                   ORDER BY COALESCE(bo.number, b.number) ASC, b.file ASC LIMIT 1)
              ) AS book_id
         FROM touched r
     )
     SELECT book_id, series_id, last_read FROM pick
      WHERE book_id IS NOT NULL      -- a series you have finished entirely drops out, correctly
      ORDER BY last_read DESC
      LIMIT ${p.add(o.limit)}`,
    p.values as any[],
  );
  return picks.map((r) => ({ bookId: r.book_id, seriesId: r.series_id, lastRead: new Date(r.last_read).toISOString() }));
}
