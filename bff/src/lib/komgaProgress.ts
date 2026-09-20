// Reading progress the way Mihon's Komga tracker speaks it: `GET`/`PUT /api/v2/series/:id/read-progress/tachiyomi`.
//
// The tracker (upstream mihon/app/src/main/java/eu/kanade/tachiyomi/data/track/komga/KomgaApi.kt @424bbc53)
// reads six numbers (L52-76): the four counts decide UNREAD / READING / COMPLETED (L70-74), `maxNumberSort`
// truncated to a Long is the chapter total (L69), and `lastReadContinuousNumberSort` becomes
// `last_chapter_read` (L75). On every bind and refresh it marks local chapters with `chapterNumber <=` that
// value as read, takes the max of remote and local, and PUTs it straight back as `lastBookNumberSortRead` --
// unconditionally, even when nothing changed (SyncChapterProgressWithTrack.kt L36-46).
//
// The quantity all of this compares is the override-aware chapter number, `COALESCE(book_overrides.number,
// lib_books.number)`: it is what lib/ownedCatalog's booksSrc hands the extension as `metadata.numberSort`, and
// it is what lib/trackers' seriesProgressFor tells AniList. A different number on any one of the three would
// mark the wrong chapters.
import { q } from './db';
import { ViewCtx, seriesVisible } from './visibility';
import { ghostsEnabled, ghostNumbers } from './komgaGhosts';

export interface ReadProgressV2 {
  booksCount: number;
  booksReadCount: number;
  booksUnreadCount: number;
  booksInProgressCount: number;
  lastReadContinuousNumberSort: number;
  maxNumberSort: number;
}

/**
 * Komga's `findProgressV2BySeries` (komga ReadProgressDtoDao.kt L33-65 @7f718087), over EVERY book of the
 * series including tombstones: a pruned chapter's row is exactly what this member's history refers to, and
 * dropping it would shrink the total and punch a hole in the run. Books are ordered by number then file --
 * the tuple the reader walks (ownedCatalog adjacentBook) -- and the answer is the number of the LAST book in
 * the LEADING run of completed ones (`takeWhile { completed }.lastOrNull()`, L162-166), else 0. A series read
 * 1, 2, 4 therefore reports 2, not 4: this is the number Mihon uses as "everything up to here is read", and
 * the tracker's own MAX-based figure would mark chapter 3 read on the phone.
 *
 * ⚠️ Number-0 rule. 0 is also the protocol's "nothing read" sentinel (Komga returns 0F for an empty run), and
 * in this library number 0 is common: numFromName gives 0 to "Oneshot.cbz" / "Extra.cbz" and to anything else
 * without a digit. A run that ends on such a book cannot be expressed and reports 0 as well; Mihon then
 * marks its local number-0 chapters read (`chapterNumber <= 0`), which is what they are. The PUT side has the
 * matching rule (markReadUpTo).
 *
 * ⚠️ GHOSTS (lib/komgaGhosts, opt-in). When the chapter list includes the chapters this server does not hold,
 * this must agree with it or the tracker is fed a total that contradicts the list it just read. So a ghost
 * counts in `booksCount`, in `booksUnreadCount` and in `maxNumberSort` -- that last one is the fix the whole
 * feature is for, since it is what Mihon reports as the series' chapter total.
 *
 * But a ghost must NOT break the continuous run, and this is the subtle half. A ghost has no lib_books row,
 * so markReadUpTo can never mark it: were it to break the run, one never-fetched chapter 5 would pin
 * `lastReadContinuousNumberSort` at 4 for a reader at chapter 1000, and the tracker would take the series
 * back to 4 on the next sync. Skipped instead, the run reads through it, the server reports 1000, and Mihon
 * marks every local chapter at or below 1000 read -- the ghost rows included, which is how a chapter that is
 * listed but absent still shows as read on the phone. A tombstone is a real row with a real read_progress
 * and is never skipped; it is already counted correctly and always was.
 *
 * Returns null when the viewer may not see the series (deleted, merged, other library, above the age cap): the
 * route turns that into 404 so "not yours" and "no such series" look identical from outside.
 */
export async function readProgressV2(ctx: ViewCtx, userId: string, seriesId: string): Promise<ReadProgressV2 | null> {
  // visible(), not browsable(): the 18+ hide is a surfacing filter, and refusing to report progress on a
  // series the reader deliberately bound would lose data rather than tidy a screen (lib/visibility).
  if (!(await seriesVisible(seriesId, ctx))) return null;
  const rows = await q<{ number: number; completed: boolean | null }>(
    `SELECT COALESCE(ov.number, b.number) AS number, rp.completed
       FROM lib_books b
       LEFT JOIN book_overrides ov ON ov.book_id = b.id
       LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $2
      WHERE b.series_id = $1
      ORDER BY COALESCE(ov.number, b.number) ASC, b.file ASC`,
    [seriesId, userId],
  );
  // Merged into the same ascending order the run is walked in, so a ghost sits where its number puts it
  // rather than after everything. `ghost` is what the run loop skips on.
  const ghosts = (await ghostsEnabled()) ? await ghostNumbers(seriesId) : [];
  const all: Array<{ number: number; completed: boolean | null; ghost: boolean }> = [
    ...rows.map((r) => ({ number: Number(r.number), completed: r.completed, ghost: false })),
    ...ghosts.map((number) => ({ number, completed: null, ghost: true })),
  ];
  if (ghosts.length) all.sort((a, b) => a.number - b.number);

  let read = 0;
  let inProgress = 0;
  let max = 0;
  for (const r of all) {
    if (r.completed === true) read++;
    else if (r.completed === false) inProgress++;
    if (r.number > max) max = r.number;
  }
  let last = 0;
  for (const r of all) {
    // A chapter nobody can read cannot be the thing that says how far this reader has got.
    if (r.ghost) continue;
    if (r.completed !== true) break;
    last = r.number;
  }
  return {
    booksCount: all.length,
    booksReadCount: read,
    booksUnreadCount: all.length - read - inProgress,
    booksInProgressCount: inProgress,
    lastReadContinuousNumberSort: last,
    maxNumberSort: max,
  };
}

/**
 * Komga's `PUT .../read-progress/tachiyomi` (komga SeriesController.kt L783-804): every book whose number is
 * <= `n` and that is not already completed becomes completed; nothing is ever un-marked (the protocol has no
 * unread; our unread path is a DELETE with no push, routes/personal.ts bulk read).
 *
 * ONE set-based statement, the shape of routes/personal.ts's bulk mark-read, rather than a writeProgress per
 * book: that would be N round trips and, because writeProgress pushes to the external trackers on every
 * completed write, N AniList calls per PUT -- and Mihon PUTs on every refresh. The `WHERE NOT completed` on
 * the conflict branch is what makes the refresh free: rows already complete are skipped entirely, so their
 * `updated_at` stays put (Continue-reading orders by it) and they are not RETURNED, so `changed` is the count
 * of rows this call actually moved. The ROUTE pushes to the trackers once, only when changed > 0.
 *
 * ⚠️ `$3::real`. lib_books.number and book_overrides.number are float4. Mihon echoes the numberSort it was
 * given back as a Double; binding it as numeric or float8 promotes the stored 12.1f to 12.100000381469727 on
 * one side only, and the boundary chapter is never marked. Comparing in real makes both sides the same float.
 *
 * ⚠️ `n <= 0` writes nothing. Mihon PUTs `max(remote, local)` on every bind, which is 0.0 for a freshly bound
 * series (SyncChapterProgressWithTrack.kt L41-46), and `number <= 0` would mark every "Oneshot.cbz" / "Extra.cbz"
 * read for that user on the first bind. Nothing is lost by skipping it: TrackChapter.kt L33 never reports a
 * chapter whose number is <= what is already read, so a real read of a number-0 chapter never arrives as 0.
 *
 * GREATEST on page so marking a chapter read never rewinds one someone is part-way through. No reading_events
 * row: a sync from a phone is not reading in the app and must not inflate streaks, the leaderboard or Wrapped
 * (the `silent` policy of lib/progress.ts).
 *
 * ⚠️ Does NOT check visibility. The route must answer 404 from `seriesVisible` before calling this, exactly
 * as it does for the GET; the write itself is keyed on series_id so it cannot reach another series' books.
 */
export async function markReadUpTo(userId: string, seriesId: string, n: number): Promise<{ changed: number }> {
  if (!Number.isFinite(n) || n <= 0) return { changed: 0 };
  const rows = await q<{ book_id: string }>(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
     SELECT $1, b.id, b.series_id, COALESCE(b.pages, 0), true
       FROM lib_books b
       LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.series_id = $2 AND COALESCE(ov.number, b.number) <= $3::real
     ON CONFLICT (user_id, book_id) DO UPDATE
       SET completed = true, page = GREATEST(read_progress.page, EXCLUDED.page), updated_at = now()
       WHERE NOT read_progress.completed
     RETURNING book_id`,
    [userId, seriesId, n],
  );
  return { changed: rows.length };
}
