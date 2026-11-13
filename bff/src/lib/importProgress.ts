// Reading progress an import brings over (#433): the chapters a Mihon / Suwayomi backup has marked read, and every
// chapter at or below how far a tracker says the person got, marked read HERE -- for the account whose file or list it
// was (the batch's owner, routes/admin.ts markImportedRead), and for nobody else.
//
// Each number is resolved the way a person's own tick is (lib/listingProgress.ts markNumbers): a number the series
// holds is read_progress on its row, a number the sources list and this server does not hold is a listing_progress mark
// with source 'import', and a number that is neither is skipped. The listing is the authorisation, so an import marks
// nothing past what exists. A tracker's number is a bound, not a list: read to 57 on AniList marks every held or listed
// chapter at or below 57.
//
// What must never happen, each pinned by a named test in importProgress.int.test.ts:
//   1. A chapter is never marked unread, and one already read here is left exactly as it is: its updated_at says when
//      it was finished HERE, and Continue Reading and the cleanup's which-copy rule read it.
//   2. An imported read never makes a file due for the read-chapter cleanup (lib/chapterCleanup.ts dueSql), the job
//      that deletes the files of chapters read here. Stamped LEAST(now(), mtime - 1 ms) it is a read of a copy before
//      the one on disk, as a mark is when its chapter lands (reconcileListingProgress). Stamped now(), a 0-day cleanup
//      would delete within the hour every file an import of an established library had just marked, and the tombstone
//      would keep each from being fetched again. A file with no mtime (0, its stat failed) takes now(), as there.
//   3. No reading_events row and no tracker push. Reading done elsewhere is not reading done here: streaks, Wrapped and
//      the boards must not grow from a backup. And there is nothing to tell a tracker: its number is where this came
//      from, and the floor the import seeds beside it (lib/trackers.ts seedTrackerFloor) already equals it, so nothing
//      loops either. The next chapter finished here pushes the real run, as every chapter does.
//   4. Never on a series whose numbers are not another app's: numbered by posting order (#116) or by its chapter
//      titles (#379), or with a renumber pending or under way. Chapter 57 on Mihon is not post 57 here.
//   5. Never a file holding a range (lib/chapterRanges.ts) on the strength of its first chapter: Batman 01-07 is read
//      only once the tracker's number reaches 7. Absence is never a read (listingProgress.ts, rule 1).
import { tx } from './db';
import { lastNumber, rangeEnd } from './chapterRanges';
import { HELD } from './listingProgress';

/** Rule 4: the series is numbered by its source, and no renumber is pending or under way. Over `lib_series s`. */
const SAME_NUMBERS = `COALESCE(s.numbering, 'source') = 'source' AND s.numbering_pending IS NULL AND s.renumber_plan IS NULL`;

/** The account's Incognito switch, carried onto every row as markNumbers carries it (lib/incognito.ts). */
const INCOGNITO = `EXISTS (SELECT 1 FROM app_settings WHERE user_id = $1 AND data->'incognito' = 'true'::jsonb)`;

/**
 * How far an import row's trackers say the person got: the highest progress among its links. A provider named twice
 * with two different entries says nothing -- the row is not linked to either (routes/admin.ts linkImportedSeries) -- so
 * neither number counts. 0 when no link says anything.
 */
export function readUpTo(links: ReadonlyArray<{ provider: string; externalId: string; progress: number }>): number {
  const torn = new Set(links.filter((l) => links.some((o) => o.provider === l.provider && o.externalId !== l.externalId)).map((l) => l.provider));
  return Math.max(0, ...links.filter((l) => !torn.has(l.provider)).map((l) => Math.floor(Number(l.progress)) || 0));
}

/**
 * Mark `readNumbers`, and every chapter at or below `upTo`, read for `userId` on `seriesId` (the header says how).
 * `upTo` is a tracker's progress and 0 means none: it marks nothing, not chapter 0. Returns how many chapters this call
 * newly marked: rows it moved to completed plus marks it wrote.
 *
 * ONE set-based statement per kind, in one transaction, as markNumbers does it -- never writeProgress per chapter, which
 * writes a reading_events row and pushes to the trackers on every completed write (lib/progress.ts): rule 3, and 500
 * AniList calls for one title. Reintroduce writeProgress: "an import marks what it read" finds the chapter left open
 * stamped now (and the cleanup test finds files due); a writer that stamped right would still meet its checks for an
 * event and for a push.
 *
 * `WHERE NOT read_progress.completed` is rule 1: a finished row is not touched, and is not counted. An unfinished one
 * (somebody partway through this copy) becomes read, stamped LEAST(its own time, the import's): its own is after the
 * file landed, and kept it would make the chapter due at once, under the person reading it. Reintroduce by dropping the
 * WHERE: "an import marks what it read" counts chapter 4, read here already, as marked again, and moves its time.
 *
 * ⚠️ Does NOT check visibility or scope: the import found the series in the batch's own scope (routes/admin.ts).
 */
export async function importReadProgress(userId: string, seriesId: string, readNumbers: readonly number[], upTo: number): Promise<number> {
  const bound = Number.isFinite(upTo) && upTo > 0 ? Math.floor(upTo) : 0;
  if (!readNumbers.length && !bound) return 0;
  return tx(async (qq) => {
    // Rule 5 is the pair of tests on the range: a number of the read set marks only a file holding that one chapter, and
    // the bound marks a range only once its LAST chapter is under it. Reintroduce by dropping the rangeEnd test: "a range
    // is read only to its end" finds Batman 01-07 read on chapter 1 alone.
    const books = await qq(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at, is_private, incognito)
       SELECT $1, b.id, b.series_id, COALESCE(b.pages, 0), true,
              CASE WHEN b.mtime > 0 THEN LEAST(now(), to_timestamp(b.mtime / 1000.0) - interval '1 millisecond') ELSE now() END,
              s.is_private, ${INCOGNITO}
         FROM lib_books b
         JOIN lib_series s ON s.id = b.series_id
         LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE b.series_id = $2 AND ${SAME_NUMBERS}
          AND ((COALESCE(ov.number, b.number) = ANY($3::real[]) AND ${rangeEnd('b', 'ov')} IS NULL)
               OR ($4::real > 0 AND COALESCE(ov.number, b.number) >= 0 AND ${lastNumber('b', 'ov')} <= $4::real))
       ON CONFLICT (user_id, book_id) DO UPDATE
         SET completed = true, page = GREATEST(read_progress.page, EXCLUDED.page),
             updated_at = LEAST(read_progress.updated_at, EXCLUDED.updated_at),
             is_private = read_progress.is_private OR EXCLUDED.is_private,
             incognito = read_progress.incognito AND EXCLUDED.incognito
         WHERE NOT read_progress.completed
       RETURNING 1`,
      [userId, seriesId, readNumbers, bound],
    );
    // ON CONFLICT DO NOTHING: a number this reader marked already keeps its mark and its time, whoever made it.
    const marks = await qq(
      `INSERT INTO listing_progress (user_id, series_id, number, source, is_private, incognito)
       SELECT $1, l.series_id, l.number, 'import', s.is_private, ${INCOGNITO}
         FROM series_listing l
         JOIN lib_series s ON s.id = l.series_id
        WHERE l.series_id = $2 AND ${SAME_NUMBERS}
          AND (l.number = ANY($3::real[]) OR ($4::real > 0 AND l.number >= 0 AND l.number <= $4::real))
          AND NOT ${HELD('l.series_id', 'l.number')}
       ON CONFLICT (user_id, series_id, number) DO NOTHING
       RETURNING 1`,
      [userId, seriesId, readNumbers, bound],
    );
    return books.length + marks.length;
  });
}
