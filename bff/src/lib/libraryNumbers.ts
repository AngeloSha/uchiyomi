// The chapter numbers a series HOLDS -- one definition, for everything that reasons about what is missing.
//
// Four places asked this question and three of them got it wrong in a different way. The Health page's gap
// check and its impossible-number check both read `lib_books.number` raw: an admin who renumbered a chapter
// through the series page still saw the old number reported as an outlier, and a chapter they deliberately
// deleted still counted as a hole the page told them to fill. The fill dialog's scan read every row
// including tombstones, so "find missing chapters" offered nothing for a series whose gap was a deleted
// chapter -- while the Health page next door insisted the gap was there.
//
// Two rules, and both of them are somebody else's rule quoted rather than restated:
//
//   - `book_overrides.number` wins over `lib_books.number`. The raw number is DERIVED from the filename by
//     numFromName (see the book_overrides note in lib/migrate.ts), and the override is the manual escape
//     hatch for when that parse is wrong. A renumber that the rest of the product honours but this query
//     does not is a finding that cannot be cleared.
//   - `heldBooks()` (lib/chapterCleanup.ts) decides what a tombstone means. A cleanup or Delete-files
//     tombstone is HELD -- the bytes went on purpose and the sweep must not fetch them back every night,
//     so it is not a gap either. A 'missing' tombstone the verify task wrote is NOT held: that file went
//     without anyone deciding so, and fetching it again is the whole point.
//
// And one that is not about a book at all (v0.49.0, #116): a series numbered by posting order keeps the number of
// a post its source DELETED as a hole (series_post_numbers.gone_at), so nothing after it moves. Nothing can fill
// that hole -- the post is gone, and no other site's numbers line up with posting order -- so it counts as held:
// a gap on the Health page and a search for the repair would be a finding nobody could ever clear.
//
// And one more of that kind (v0.55.2, #147): a notice chapter the admin hides (lib/noticeChapters.ts) that only the
// sources list. The sweep does not fetch it on purpose, so it is never held -- and a chapter that exists only in short
// parts (1.1 ... 1.9, each a few pages) left a whole-number hole at 1 that every sweep "would fetch" and none ever did.
// Counted as held, it is what it would be with the switch off, when the sweep fetches it: a chapter of the series.
//
// The SELECT is exported as well as the helper because the repair reads it per series inside a loop that
// already holds the row, and because a caller joining it into a larger query must get the same rules rather
// than a hand-written copy of them.
import { q } from './db';
import { heldBooks } from './chapterCleanup';
import { listedHidden, noticesActive } from './noticeChapters';

/**
 * The held numbers of ONE series, as SQL. `$1` is the series id; the alias is the books table's, so a
 * caller can slot it beside its own joins. `::float8` because `lib_books.number` is `real` and the pg
 * driver hands a `real` back as a JS number only through a float8 cast -- a half-chapter 12.5 read as
 * `12.5` here and as `12.5000019` after a round trip through `real` is the kind of difference that makes
 * gapsOf disagree with itself.
 * Reintroduce the books alone (drop the UNION): "a post the source deleted is a hole, not a gap" in
 * health.int.test.ts reads the hole as a gap. The third part, the hidden notices only the sources list, exists only
 * while something hides (lib/noticeChapters.ts `active`); reintroduce by dropping it: "a chapter that exists only in
 * short parts" in noticeChapters.int.test.ts finds a gap at 1, and Fill now leaves it for a sweep that never comes.
 */
export const HAVE_SQL = (alias = 'b'): string =>
  `SELECT COALESCE(o.number, ${alias}.number)::float8 AS number
     FROM lib_books ${alias} LEFT JOIN book_overrides o ON o.book_id = ${alias}.id
    WHERE ${alias}.series_id = $1 AND ${heldBooks(alias)}
   UNION ALL
   SELECT hole.number::float8 AS number
     FROM series_post_numbers hole JOIN lib_series hs ON hs.id = hole.series_id
    WHERE hole.series_id = $1 AND hole.gone_at IS NOT NULL AND hs.numbering = 'posting_order'
      AND hole.source_id = COALESCE(hs.numbering_source, hs.source_id)${noticesActive() ? `
   UNION ALL
   SELECT ln.number::float8 AS number
     FROM series_listing ln JOIN lib_series lns ON lns.id = ln.series_id
    WHERE ln.series_id = $1 AND ${listedHidden('lns', 'ln')}
      AND NOT EXISTS (SELECT 1 FROM lib_books lb LEFT JOIN book_overrides lo ON lo.book_id = lb.id
                       WHERE lb.series_id = ln.series_id AND COALESCE(lo.number, lb.number) = ln.number AND ${heldBooks('lb')})` : ''}`;

/** The held numbers of one series, finite and unsorted -- what gapsOf, assess and the outlier check take. */
export async function haveNumbers(seriesId: string): Promise<number[]> {
  const rows = await q<{ number: number }>(HAVE_SQL(), [seriesId]);
  return rows.map((r) => Number(r.number)).filter((n) => Number.isFinite(n));
}
