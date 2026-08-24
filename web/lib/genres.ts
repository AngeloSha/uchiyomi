/**
 * Genre strings that are not genres.
 *
 * `lib_series.genres` is whatever the scrapers wrote, and `seriesDto` has no tags column to put anything
 * else in (`booksMetadata.tags` is hardcoded `[]`), so formats and site meta-tags end up in the same array
 * as Horror and Romance. On the library this was written against, "Manhwa" carries 159 of 213 series: under
 * a count ranking it is the second-largest tile on the page, above every actual mood. Manhwa is not a mood.
 *
 * So these are separated out and shown as a quiet chip row instead of competing for the wall. They still
 * WORK -- clicking one filters by it exactly as before -- they just stop pretending to be a genre. Nothing
 * is hidden and nothing is deleted; format-ness decides, not size, which is why Manhwa at 159 is a chip and
 * Sports at 2 is a tile.
 *
 * Matched against the case-folded `key` the API returns, so spelling variants collapse on their own.
 */
export const FORMAT_KEYS: ReadonlySet<string> = new Set([
  'manhwa', 'manhua', 'manga', 'webtoon', 'webtoons', 'web comic', 'webcomic', 'long strip',
  'full color', 'full colour', 'one shot', 'one-shot', 'oneshot', 'doujinshi', 'adaptation',
  'animated', 'english', 'mangatoon', 'popular', 'all', 'completed', 'ongoing', 'anthology',
]);

/** One row of `GET /api/genres/overview`. `series` is null in Komga mode, which cannot count. */
export interface GenreFacet {
  key: string;
  label: string;
  series: number | null;
  covers: string[];
}
