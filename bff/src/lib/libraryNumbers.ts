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
//     the row's name rule (lib/naming.ts numberByRule; the book_overrides note in lib/migrate.ts), and the
//     override is the manual escape hatch for when that parse is wrong. A renumber that the rest of the product honours but this query
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
// And one about a file (v0.55.2, #150): a file holding a range of chapters, `Batman 01-07`, holds every whole number
// from its start to its end (lib/chapterRanges.ts), so a hand-collected 01-07 never reads as six missing chapters.
//
// And the numbers an admin hid by hand (#240, lib/noticeChapters.ts numberHidden): a hidden chapter is no chapter of the
// series, so it is neither held nor missing. A file at a hidden number is left out of what the series holds -- it would
// otherwise be the outliers card's 9001 again, a chapter nobody can see -- and a hidden WHOLE number between the series'
// plausible numbers counts as held, so the hole it would be is no gap: the source's stray 13 between 12 and 14 is not
// a chapter for Health to report, the repair to search for or Fill to fetch. Only between them: a hidden 15 above a
// series that ends at 10 holds nothing, or 11 to 14 would become a gap the hide made up. And never a part: hiding 12.5
// does not say chapter 12 is here.
//
// The SELECT is exported as well as the helper because the repair reads it per series inside a loop that
// already holds the row, and because a caller joining it into a larger query must get the same rules rather
// than a hand-written copy of them.
import { q, one } from './db';
import { heldBooks } from './chapterCleanup';
import { bookHiddenNumber, hiddenNumbersActive, listedNoticeHidden, noticesActive } from './noticeChapters';
import { rangeEnd } from './chapterRanges';

/**
 * The held numbers of ONE series, as SQL. `$1` is the series id; the alias is the books table's, so a
 * caller can slot it beside its own joins. `::float8` because `lib_books.number` is `real` and the pg
 * driver hands a `real` back as a JS number only through a float8 cast -- a half-chapter 12.5 read as
 * `12.5` here and as `12.5000019` after a round trip through `real` is the kind of difference that makes
 * gapsOf disagree with itself.
 * Reintroduce the books alone (drop the UNION): "a post the source deleted is a hole, not a gap" in
 * health.int.test.ts reads the hole as a gap.
 * The second branch is each range's whole numbers after its start, which the first already gives: `01-07` is 1, then
 * 2 to 7. Reintroduce by dropping it: "a file holding chapters 1 to 7 is no gap" in chapterRanges.int.test.ts finds
 * a gap of six.
 * The last part, the hidden notices only the sources list, exists only while something hides (lib/noticeChapters.ts
 * `active`); reintroduce by dropping it: "a chapter that exists only in short parts" in noticeChapters.int.test.ts
 * finds a gap at 1, and Fill now leaves it for a sweep that never comes.
 * A file at a number hidden by hand is left out of the first part while any series hides one (#240); reintroduce by
 * dropping the clause: "a hidden chapter is neither held nor missing" in hiddenChapters.int.test.ts finds the hidden
 * 9001 on the outliers card. The hidden numbers that do count as held are haveNumbers' (below), not this SELECT's:
 * they depend on the rest being plausible, which is a rule over the whole set.
 */
export const HAVE_SQL = (alias = 'b'): string =>
  `SELECT COALESCE(o.number, ${alias}.number)::float8 AS number
     FROM lib_books ${alias} LEFT JOIN book_overrides o ON o.book_id = ${alias}.id${hiddenNumbersActive() ? `
     JOIN lib_series hb_s ON hb_s.id = ${alias}.series_id` : ''}
    WHERE ${alias}.series_id = $1 AND ${heldBooks(alias)}${hiddenNumbersActive() ? ` AND NOT ${bookHiddenNumber('hb_s', alias, 'o')}` : ''}
   UNION ALL
   SELECT generate_series(floor(${alias}.number)::numeric + 1, floor(${rangeEnd(alias, 'o')})::numeric)::float8 AS number
     FROM lib_books ${alias} LEFT JOIN book_overrides o ON o.book_id = ${alias}.id
    WHERE ${alias}.series_id = $1 AND ${heldBooks(alias)} AND ${rangeEnd(alias, 'o')} IS NOT NULL
   UNION ALL
   SELECT hole.number::float8 AS number
     FROM series_post_numbers hole JOIN lib_series hs ON hs.id = hole.series_id
    WHERE hole.series_id = $1 AND hole.gone_at IS NOT NULL AND hs.numbering = 'posting_order'
      AND hole.source_id = COALESCE(hs.numbering_source, hs.source_id)${noticesActive() ? `
   UNION ALL
   SELECT ln.number::float8 AS number
     FROM series_listing ln JOIN lib_series lns ON lns.id = ln.series_id
    WHERE ln.series_id = $1 AND ${listedNoticeHidden('lns', 'ln')}
      AND NOT EXISTS (SELECT 1 FROM lib_books lb LEFT JOIN book_overrides lo ON lo.book_id = lb.id
                       WHERE lb.series_id = ln.series_id AND COALESCE(lo.number, lb.number) = ln.number AND ${heldBooks('lb')})` : ''}`;

/**
 * The held numbers of one series, finite and unsorted -- what gapsOf, assess and the outlier check take. With the
 * hidden whole numbers that lie between its plausible numbers (#240, the header): no gap, never a wider series.
 * Reintroduce by returning HAVE_SQL alone: "a hidden number between two chapters is no gap" in
 * hiddenChapters.int.test.ts finds 13 on the gaps card; by taking every hidden number, it finds 11-14 there for the
 * hidden 15.
 */
export async function haveNumbers(seriesId: string): Promise<number[]> {
  const rows = await q<{ number: number }>(HAVE_SQL(), [seriesId]);
  const held = rows.map((r) => Number(r.number)).filter((n) => Number.isFinite(n));
  if (!hiddenNumbersActive() || held.length < 2) return held;
  const row = await one<{ hidden: number[] | null }>('SELECT hidden_numbers AS hidden FROM lib_series WHERE id = $1', [seriesId]);
  const hidden = (row?.hidden ?? []).map(Number).filter((n) => Number.isFinite(n) && n === Math.floor(n));
  if (!hidden.length) return held;
  const range = plausibleNumbers(held);
  const lo = Math.min(...range);
  const hi = Math.max(...range);
  const have = new Set(held);
  return [...held, ...hidden.filter((n) => n > lo && n < hi && !have.has(n))];
}

/** percentile_cont(0.5), in JS: the interpolated median, so this check and the SQL it replaced agree. */
export function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
}

/**
 * The impossible-number rule over a series' held numbers: the limit a chapter number may not pass -- four times the
 * median, or the median plus 500, whichever is more -- when one does, else null. Exported (v0.55.0) for the repair's
 * gap step under Fix everything, which leaves such a series to the files phase: one chapter numbered 9001 is a
 * 9000-chapter "gap".
 */
export function impossibleLimit(numbers: readonly number[]): number | null {
  // Positive numbers only, as the SQL this replaced did: a chapter 0 is a legitimate prologue and
  // including it would drag the median down towards nothing.
  const nums = numbers.filter((n) => n > 0).sort((a, b) => a - b);
  if (!nums.length) return null;
  const med = median(nums);
  const limit = Math.max(med * 4, med + 500);
  return nums[nums.length - 1] > limit ? limit : null;
}

/**
 * The numbers a series' holes are counted between: all of them but the ones the outliers card names (impossibleLimit).
 * One chapter numbered 9001 among 1 to 4 is a chapter numbered impossibly, not 8,996 missing chapters: counted as a gap
 * it filled the gaps card with a hole nothing can fetch -- which Fix everything left alone, so a bookmarked 9001 kept
 * "the next run continues" and Run again on the end for good -- and sent the nightly searching other sites for
 * thousands of chapters. Health's gaps check and the repair's gap step both count this way (v0.55.0 integration).
 */
export function plausibleNumbers(numbers: readonly number[]): number[] {
  const limit = impossibleLimit(numbers);
  return limit === null ? [...numbers] : numbers.filter((n) => n <= limit);
}


/**
 * The whole numbers each series' sources list (series_listing, every status), for the gap rule's "does a site offer
 * it" (lib/fill.ts splitListed). One grouped read for Health's report, `seriesIds` for one series; a series no source
 * has answered for is absent, and its holes count as before. A read that fails is an empty map: every hole counts.
 */
export async function listedWholeNumbers(seriesIds?: readonly string[]): Promise<Map<string, Set<number>>> {
  const rows = await q<{ series_id: string; nums: number[] }>(
    `SELECT series_id, array_agg(DISTINCT floor(number)::int) AS nums FROM series_listing
      WHERE number IS NOT NULL ${seriesIds ? 'AND series_id = ANY($1)' : ''} GROUP BY series_id`,
    seriesIds ? [seriesIds as string[]] : [],
  ).catch(() => []);
  return new Map(rows.map((r) => [r.series_id, new Set((r.nums ?? []).map(Number))]));
}
