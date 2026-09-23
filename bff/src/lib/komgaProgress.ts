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
import { continuousRun, marksByOrigin, mergeRun, realRows } from './listingProgress';

/** What one Mihon PUT moved. Only `changed` and `ghostMarksAhead` are news for a tracker (markReadUpTo). */
export interface MarkUpToResult {
  /** read_progress rows this call moved to completed: real reading progress, and the route's push condition. */
  changed: number;
  /** listing_progress rows this call wrote for listed chapters this server does not hold (#69). */
  ghostMarks: number;
  /** Of those, the ones above every chapter this reader has finished here -- the phone knowing more than we did. */
  ghostMarksAhead: number;
}

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
 * ⚠️ GHOSTS (lib/komgaGhosts, opt-in). A ghost is a chapter the sources listed that this server does not
 * hold, so it has no lib_books row at all. It always raises `maxNumberSort` -- the field KomgaApi.kt L69
 * truncates to the series' chapter total, which is the number a pruned or never-fetched library was reporting
 * as 1. Since v0.43.0 (#69) a reader can also MARK a ghost read (lib/listingProgress), and a mark moves the
 * two things below, for that reader only. With the switch off none of this runs and every answer is
 * byte-identical to v0.42.0: marks are a web-page fact until an admin opts the phone surface in.
 *
 * ⚠️ THE COUNTS ARE ENGAGED-ONLY. Mihon picks the tracker status with
 * `when (booksCount) { booksUnreadCount -> UNREAD; booksReadCount -> COMPLETED; else -> READING }`
 * (KomgaApi.kt L70-74). Counting every ghost for everyone would make `booksReadCount == booksCount`
 * unreachable for a reader who has never touched a ghost, and the long runner this feature exists for would
 * go from COMPLETED to permanently READING the day the switch was flipped. So the counts stay over the REAL
 * rows (tombstones included) -- unless this reader has marked at least one of the series' CURRENT ghosts, in
 * which case they are a reader who tracks the ghosts, and the counts include every ghost: a marked one as
 * read, an unmarked one as unread. COMPLETED stays reachable for them by marking the rest. ⚠️ "Current": a mark
 * can outlive its listing row (the sweep rewrites the listing whole), and an orphan mark must not switch a
 * finished series to ghost-inclusive counts it has no row left to clear. Reintroduce by `marks.size > 0`: "a
 * stale mark does not make the reader engaged" in komgaGhosts.int.test.ts reads READING.
 * ⚠️ AND "MARKED" MEANS A MARK THE READER MADE -- `marks.own`, source <> 'komga' -- never one the phone echoed
 * back. markReadUpTo below marks every listed ghost at or below the number a PUT carries, and Mihon PUTs on
 * every bind and refresh (the route's own note), so reading `marks.all` here took a series the reader had
 * FINISHED out of COMPLETED and into READING with nobody having marked anything, and un-marking from the web
 * lasted until the next refresh re-created the mark. Reintroduce by `ghosts.some((n) => marks.all.has(n))`:
 * "a phone refresh alone never takes a finished series out of Completed" in komgaGhosts.int.test.ts reads
 * READING.
 *
 * ⚠️ THE RUN IS continuousRun's MAX OF TWO WALKS (lib/listingProgress says why). The v0.42.0 walk skips
 * ghosts, so one never-fetched chapter 5 cannot pin a reader at chapter 1000 back to 4; the strict walk lets a
 * contiguous run of MARKED ghosts carry it further, and an unmarked one breaks it. A tombstone is a real row
 * with a real read_progress and is never skipped; it is already counted correctly and always was.
 *
 * Returns null when the viewer may not see the series (deleted, merged, other library, above the age cap): the
 * route turns that into 404 so "not yours" and "no such series" look identical from outside.
 */
export async function readProgressV2(ctx: ViewCtx, userId: string, seriesId: string): Promise<ReadProgressV2 | null> {
  return (await readProgressDetail(ctx, userId, seriesId))?.progress ?? null;
}

/**
 * readProgressV2 plus whether the counts are ghost-inclusive for this reader, for the v1 series DTO.
 *
 * ⚠️ That DTO takes `booksCount` from lib_series.books_count (the real rows) and the three read counts from
 * here. With engaged counts the two would disagree -- a follow-only series with every listed chapter marked
 * read would answer booksCount 0 beside booksReadCount 10, which Mihon's `when (booksCount)` reads as UNREAD --
 * so the route takes the total from here too, and only when `engaged`, so every other answer is unchanged.
 * The six-field v2 JSON stays exactly the six fields.
 */
export async function readProgressDetail(ctx: ViewCtx, userId: string, seriesId: string): Promise<{ progress: ReadProgressV2; engaged: boolean } | null> {
  // visible(), not browsable(): the 18+ hide is a surfacing filter, and refusing to report progress on a
  // series the reader deliberately bound would lose data rather than tidy a screen (lib/visibility).
  if (!(await seriesVisible(seriesId, ctx))) return null;
  const rows = await realRows(userId, seriesId);
  // Merged into the same ascending order the run is walked in, so a ghost sits where its number puts it
  // rather than after everything. The marks are read only under the switch, with the ghosts they apply to.
  const ghostsOn = await ghostsEnabled();
  const ghosts = ghostsOn ? await ghostNumbers(seriesId) : [];
  const marks = ghosts.length ? await marksByOrigin(userId, seriesId) : { all: new Set<number>(), own: new Set<number>() };
  const all = mergeRun(rows, ghosts, marks.all);
  // `own`, never `all`: a mark the PHONE wrote is this server's own answer echoed back, not an act (see above).
  const engaged = ghosts.some((n) => marks.own.has(n));

  let read = 0;
  let inProgress = 0;
  let max = 0;
  for (const r of all) {
    // A ghost counts for an engaged reader only, on exactly the condition `booksCount` below uses -- counting
    // a phone-echoed ghost as read here while the total stayed over the real rows sent booksUnreadCount to -1.
    // Reintroduce by dropping this branch: "a phone refresh alone never takes a finished series out of
    // Completed" fails at 'still finished after the sync' -- the echoed ghost is read while the total stays
    // at the 19 real rows, so the reader has 20 read of 19 and booksUnreadCount -1.
    if (r.ghost && !engaged) {
      if (r.number > max) max = r.number;
      continue;
    }
    // A ghost is `completed: true` only when marked, and never false, so it counts as read or not at all.
    if (r.completed === true) read++;
    else if (r.completed === false) inProgress++;
    if (r.number > max) max = r.number;
  }
  // `rows.length` unless engaged, never `all.length` for everyone: see THE COUNTS ARE ENGAGED-ONLY above.
  const booksCount = rows.length + (engaged ? ghosts.length : 0);
  return {
    engaged,
    progress: {
      booksCount,
      booksReadCount: read,
      booksUnreadCount: booksCount - read - inProgress,
      booksInProgressCount: inProgress,
      lastReadContinuousNumberSort: continuousRun(all),
      maxNumberSort: max,
    },
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
 * ⚠️ GHOST MARKS, UNDER THE SWITCH ONLY (#69). With komga_ghost_chapters on, the phone lists the ghosts and
 * Mihon marks every local chapter at or below `n` read -- the ghost rows included -- so the listed numbers
 * at or below `n` that this server does not hold become marks too (lib/listingProgress, source 'komga'), and
 * the phone and the series page agree. `ON CONFLICT DO NOTHING` keeps an earlier mark's time and keeps a
 * refresh free. With the switch off the phone never saw a ghost and nothing is written for one. Reintroduce by
 * dropping the `ghostsEnabled()` gate: "markReadUpTo writes ghost marks only with the switch on" in
 * komgaGhosts.int.test.ts finds marks written with it off.
 * ⚠️ Consequence worth knowing: Mihon PUTs back whatever run it was told. A skip-walk answer of 1000 over an
 * unmarked ghost at 5 comes back as PUT 1000 and marks 5 -- which the phone already shows as read, so this is
 * the two agreeing, not a new claim.
 *
 * ⚠️ THREE NUMBERS, BECAUSE ONLY ONE OF THEM IS NEWS. `changed` counts REAL rows this call moved, and nothing
 * else: the route pushes to AniList/MAL/Kitsu on it, and folding the echoed ghost marks in made the first
 * refresh after the switch was flipped fire one remote mutation per bound series saying exactly what the
 * tracker already held (a bulk "Mark unread" re-armed it, since the next refresh re-creates the marks).
 * `ghostMarksAhead` is the honest other half: a ghost mark ABOVE every chapter this reader has actually
 * finished here is the phone telling us something new -- a follow-only series ticked to 500 on the phone, say
 * -- and the run it feeds is what the tracker is owed, so the route pushes for that too. An echo is never
 * ahead: it can only mark numbers at or below the run this server itself reported, which is at or below the
 * reader's highest completed real chapter. Reintroduce by adding the ghost marks into `changed`: the assertion
 * "a bind that only echoes the run back tells no tracker anything" in komgaGhosts.int.test.ts reads changed 1.
 *
 * ⚠️ Does NOT check visibility. The route must answer 404 from `seriesVisible` before calling this, exactly
 * as it does for the GET; the write itself is keyed on series_id so it cannot reach another series' books.
 */
export async function markReadUpTo(userId: string, seriesId: string, n: number): Promise<MarkUpToResult> {
  if (!Number.isFinite(n) || n <= 0) return { changed: 0, ghostMarks: 0, ghostMarksAhead: 0 };
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
  // The override-aware anti-join, as ghostNumbers draws the ghosts: a renumbered chapter is a real row here.
  // `done` is this reader's highest COMPLETED real chapter, computed after the upsert above so the rows this
  // very call moved count: a mark above it is progress no push has ever carried, a mark below it is an echo.
  const ghostRows = (await ghostsEnabled())
    ? await q<{ marks: number; ahead: number }>(
        `WITH ins AS (
           INSERT INTO listing_progress (user_id, series_id, number, source)
           SELECT $1, l.series_id, l.number, 'komga'
             FROM series_listing l
            WHERE l.series_id = $2 AND l.number <= $3::real
              AND NOT EXISTS (
                SELECT 1 FROM lib_books b
                  LEFT JOIN book_overrides ov ON ov.book_id = b.id
                 WHERE b.series_id = l.series_id AND COALESCE(ov.number, b.number) = l.number)
           ON CONFLICT (user_id, series_id, number) DO NOTHING
           RETURNING number
         ), done AS (
           SELECT COALESCE(MAX(COALESCE(ov.number, b.number)), 0) AS n
             FROM lib_books b
             LEFT JOIN book_overrides ov ON ov.book_id = b.id
             JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $1 AND rp.completed
            WHERE b.series_id = $2
         )
         SELECT count(*)::int AS marks, count(*) FILTER (WHERE ins.number > done.n)::int AS ahead
           FROM ins, done`,
        [userId, seriesId, n],
      )
    : [];
  return { changed: rows.length, ghostMarks: ghostRows[0]?.marks ?? 0, ghostMarksAhead: ghostRows[0]?.ahead ?? 0 };
}
