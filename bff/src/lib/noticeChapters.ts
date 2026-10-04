// Notice chapters: the chapters a source numbers N.x to tell readers something.
//
// Many sites post an announcement -- a hiatus, a season break, a recruitment call -- as a short chapter numbered
// after the latest real one with a fraction: "Ch. 44.5 - Notice!". The admin may hide them per series type
// (Settings, server_settings.hide_notice_types) and per series (lib_series.hide_notices, NULL = the type's switch).
// A hidden chapter is gone from everything a person or a client reads -- the chapter list, next/previous, the
// counts and badges, Home, Updates, history, OPDS, the Komga-compatible API Mihon reads and what the trackers are
// told -- and the sweep does not download one the source already says is that short (lib/updater.ts). Nothing is
// deleted: switching it off shows every one again at once, and the next sweep fetches those never downloaded.
//
// ⚠️ A NOTICE IS SHORT, NOT MERELY FRACTIONAL (the owner's rule, v0.55.2). A chapter numbered with a fraction is a
// notice only when its page count is KNOWN and is NOTICE_MAX_PAGES or fewer: a saved chapter's own counted pages,
// else what the sources list for its number. On the owner's library, of 1,759 chapters numbered N.x about 170 had 3
// pages or fewer -- the notices -- and about 1,500 had 6 or more: real chapters posted in parts. Any fraction would
// have hidden 779 chapters in 94 series with Manhwa switched on (118 of Omniscient Reader's). Not known is shown:
// a chapter nobody has counted yet is a chapter until it is counted (the repair counts them nightly, the reader and
// OPDS when they open one).
//
// Off by default (an empty list and NULL everywhere), and while nothing hides, nothing costs anything: every fragment
// below is then a constant (`active`), so every query is the one the previous release ran.
//
// ⚠️ The ONE definition. Every query that needs the rule interpolates a fragment from here, so "which chapters
// are notices" and "which series hide them" cannot drift apart between the chapter list and the counts. No
// fragment binds a parameter: they are interpolated into queries whose parameter lists are written by hand, as
// browsable() in lib/visibility.ts is. Everything they read comes from the database itself. Two kinds of row are
// judged: a saved chapter (lib_books, `bookIsNotice`) by its own counted pages, else the listing's for its number --
// and never a file holding a range of chapters (lib/chapterRanges.ts); and a number only the sources list
// (series_listing, `listedIsNotice`) by what the listing says.
//
// Pure: no database (seriesTypeSignals.test.ts imports it). The reads that need one are lib/noticeSettings.ts.
import { SERIES_TYPES, isSeriesType, type SeriesType } from './seriesTypeSignals';
import { rangeEnd } from './chapterRanges';

/** The most pages a notice has. One more and it is a chapter -- a part of one, a short extra -- and stays. */
export const NOTICE_MAX_PAGES = 3;

/**
 * Does anything hide notices at all -- a type switched on, or a series switched on for itself? While nothing does, every
 * fragment below is a constant and a query is exactly the one the previous release ran: same plan, same cost. (Not
 * cheap otherwise: the planner prices the per-series count and the per-row EXISTS whether or not they run, which crossed
 * jit_above_cost on the Library grid.) Kept by lib/noticeSettings.ts refreshNoticesActive, at boot and after a switch.
 */
let active = false;
export const setNoticesActive = (on: boolean): void => { active = on; };
/** The flag itself, for code that works on lists in memory and would otherwise ask the database for nothing. */
export const noticesActive = (): boolean => active;

/** Is this number a fraction? NULL is not. `real` holds 100 exactly, so floor() compares cleanly. */
export const isFractional = (num: string): string => `(${num} IS NOT NULL AND ${num} <> floor(${num}))`;

/** Is a page count (an SQL expression, NULL when nobody knows) short enough for a notice? Not known is not. */
const isShort = (pages: string): string => `COALESCE(${pages} <= ${NOTICE_MAX_PAGES}, false)`;

/**
 * The most pages any copy of a listed number says it has (`copies`: a series_listing.copies expression), NULL when
 * none says. The most, so one group's two-page teaser does not make a notice of another group's real chapter. A copy
 * saying 0 knows nothing (an adapter that does not count), and anything not a JSON array is no copies at all.
 */
export const listedPages = (copies: string): string =>
  `NULLIF((SELECT max(CASE WHEN jsonb_typeof(c_nt->'pages') = 'number' THEN GREATEST((c_nt->>'pages')::numeric, 0) END)
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${copies}) = 'array' THEN ${copies} ELSE '[]'::jsonb END) c_nt), 0)`;

/**
 * Is the lib_books row `b` a notice -- whether or not its series hides them? `ov` is its LEFT JOINed book_overrides
 * row: the book goes by its EFFECTIVE number, the admin's renumber when there is one, as booksSrc reads it. Its own
 * counted pages, else what the listing says of its number (a chapter is counted when somebody opens it, or by the
 * nightly repair). The cheap tests first: a whole number never reaches the listing.
 *
 * Never a file holding a range of chapters (v0.55.2, #150, lib/chapterRanges.ts): `Chapter 12.5-13.cbz` is a part and
 * a chapter in one file, however few its pages, and hiding it would hide chapter 13 with it. An admin's number makes
 * such a file one chapter (rangeEnd reads the override), and that chapter is judged like any other. Reintroduce by
 * dropping the range test: "a range is never a notice" in noticeRanges.int.test.ts finds the two-page 12.5-13 gone.
 */
export const bookIsNotice = (b: string, ov: string): string => {
  const num = `COALESCE(${ov}.number, ${b}.number)`;
  return `(${isFractional(num)} AND ${rangeEnd(b, ov)} IS NULL AND ${isShort(
    `COALESCE(NULLIF(${b}.pages, 0), (SELECT ${listedPages('lp_nt.copies')} FROM series_listing lp_nt
      WHERE lp_nt.series_id = ${b}.series_id AND lp_nt.number = ${num}))`)})`;
};

/**
 * A NECESSARY condition for bookIsNotice on the lib_books row `b`, in a form indexes serve: its file's number has a
 * fraction (lib_books_fraction_idx holds just those rows, lib/migrate.ts v0.55.2), or an override gives it one
 * (book_overrides' handful, by primary key). It changes no answer -- bookIsNotice still decides -- it only lets the
 * planner skip the whole numbers without visiting them. On the review's 48k-chapter library a read-progress roll-up
 * went through every chapter to find the 170 notices, and the Library grid's estimate crossed jit_above_cost.
 */
const mayBeNotice = (b: string): string => `(${b}.number <> floor(${b}.number)
     OR ${b}.id = ANY(ARRAY(SELECT bo_nt.book_id FROM book_overrides bo_nt WHERE bo_nt.number <> floor(bo_nt.number))))`;

/** Is the series_listing row `l` a notice, whether or not its series hides them? What the listing says of it. */
export const listedIsNotice = (l: string): string => `(${isFractional(`${l}.number`)} AND ${isShort(listedPages(`${l}.copies`))})`;

/** The type a series is, for alias `s` of lib_series: the admin's override, else what was learned, else unknown. */
export const seriesTypeSql = (s: string): string =>
  `COALESCE((SELECT o_nt.series_type FROM series_overrides o_nt WHERE o_nt.series_id = ${s}.id), ${s}.series_type, 'unknown')`;

/**
 * Does series `s` hide its notice chapters? Its own switch when it has one, else whether its type is one the admin
 * listed. Never NULL. The list is read here, in SQL: an uncorrelated subquery, evaluated once per query.
 */
export const hidesNotices = (s: string): string =>
  `COALESCE(${s}.hide_notices,
     COALESCE((SELECT st_nt.hide_notice_types FROM server_settings st_nt WHERE st_nt.id = 1), '[]'::jsonb) ? ${seriesTypeSql(s)},
     false)`;

/** Is the lib_books row `b` of series `s` (`ov` its LEFT JOINed book_overrides row) a notice that series hides? */
export const noticeHidden = (s: string, b: string, ov: string): string =>
  (active ? `(${bookIsNotice(b, ov)} AND ${hidesNotices(s)})` : 'false');

/** The negation, for a WHERE that keeps what is shown. */
export const noticeShown = (s: string, b: string, ov: string): string => (active ? `NOT ${noticeHidden(s, b, ov)}` : 'true');

/** Is the series_listing row `l` of series `s` a notice that series hides? */
export const listedHidden = (s: string, l: string): string => (active ? `(${listedIsNotice(l)} AND ${hidesNotices(s)})` : 'false');

/** The negation, for a WHERE over the listing that keeps what is shown. */
export const listedShown = (s: string, l: string): string => (active ? `NOT ${listedHidden(s, l)}` : 'true');

/**
 * Is the lib_books row `bookId` (an SQL expression) a hidden notice? Self-contained, for queries that hold only a
 * book id: read_progress, bookmarks, history. A book id that names nothing is not hidden.
 */
export const noticeBook = (bookId: string): string => (!active ? 'false' : `EXISTS (
  SELECT 1 FROM lib_books nb_nt
    JOIN lib_series ns_nt ON ns_nt.id = nb_nt.series_id
    LEFT JOIN book_overrides nov_nt ON nov_nt.book_id = nb_nt.id
   WHERE nb_nt.id = ${bookId} AND ${mayBeNotice('nb_nt')}
     AND ${noticeHidden('ns_nt', 'nb_nt', 'nov_nt')})`);

/**
 * Is the series_listing row `l` a hidden notice? Self-contained, for queries over the listing that hold no lib_series
 * alias: the archive's work list.
 */
export const noticeListed = (l: string): string => (!active ? 'false' : `EXISTS (
  SELECT 1 FROM lib_series nl_nt WHERE nl_nt.id = ${l}.series_id AND ${listedHidden('nl_nt', l)})`);

/**
 * How many of series `s`'s lib_books rows are hidden notices: what lib_series.books_count -- a stored count of every
 * row -- is short of, read at query time so the count is right again the moment the switch goes off. 0 for a series
 * that does not hide, without counting anything.
 *
 * Two counts that partition the candidates by the file's own number, so each is served by an index rather than by
 * every chapter of the series: the files numbered with a fraction (lib_books_fraction_idx, by series), and the
 * whole-numbered files an override gives a fraction (book_overrides). Every series the Library grid sorts runs this;
 * as one count over all its chapters the planner priced the grid past jit_above_cost (the review: 9.9 -> 67 ms).
 * Reintroduce the single count: "the hidden counts are read through the fractional index" in
 * noticeChapters.int.test.ts finds the series index instead.
 */
export const hiddenBookCount = (s: string): string => `(CASE WHEN ${hidesNotices(s)} THEN (
  SELECT count(*) FROM lib_books hb_nt LEFT JOIN book_overrides hov_nt ON hov_nt.book_id = hb_nt.id
   WHERE hb_nt.series_id = ${s}.id AND hb_nt.number <> floor(hb_nt.number)
     AND ${bookIsNotice('hb_nt', 'hov_nt')}
) + (
  SELECT count(*) FROM lib_books hb_nt JOIN book_overrides hov_nt ON hov_nt.book_id = hb_nt.id
   WHERE hb_nt.id = ANY(ARRAY(SELECT bo_nt.book_id FROM book_overrides bo_nt WHERE bo_nt.number <> floor(bo_nt.number)))
     AND hb_nt.series_id = ${s}.id AND hb_nt.number = floor(hb_nt.number) AND ${bookIsNotice('hb_nt', 'hov_nt')}
) ELSE 0 END)::int`;

/**
 * How many notice chapters series `s` hides: every distinct number of a hidden saved chapter (its effective number),
 * and of a hidden number only its sources list. The admin's "Hidden now". Not `hiddenBookCount`: a notice the sources
 * say is short is never downloaded while hidden, so a count of files would miss those. A listed number with a saved
 * chapter is that chapter's, which its own pages judge.
 * Reintroduce by counting lib_books alone: "the hidden count includes notices that were never downloaded" in
 * noticeChapters.int.test.ts reads 2.
 */
export const hiddenNoticeCount = (s: string): string => `(CASE WHEN ${hidesNotices(s)} THEN (
  SELECT count(DISTINCT hn_nt.n) FROM (
    SELECT COALESCE(hov_nt.number, hb_nt.number) AS n FROM lib_books hb_nt
      LEFT JOIN book_overrides hov_nt ON hov_nt.book_id = hb_nt.id
     WHERE hb_nt.series_id = ${s}.id AND ${bookIsNotice('hb_nt', 'hov_nt')}
    UNION ALL
    SELECT hl_nt.number FROM series_listing hl_nt
     WHERE hl_nt.series_id = ${s}.id AND ${listedIsNotice('hl_nt')}
       AND NOT EXISTS (SELECT 1 FROM lib_books xb_nt LEFT JOIN book_overrides xov_nt ON xov_nt.book_id = xb_nt.id
                        WHERE xb_nt.series_id = hl_nt.series_id AND COALESCE(xov_nt.number, xb_nt.number) = hl_nt.number)
  ) hn_nt
) ELSE 0 END)::int`;

/** books_count as a reader sees it. */
export const visibleBookCount = (s: string): string => (active ? `GREATEST(0, ${s}.books_count - ${hiddenBookCount(s)})` : `${s}.books_count`);

/** A whole number? The JS twin of `isFractional`, for lists already in memory (the sweep, the listing). */
export const isFractionalNumber = (n: number): boolean => Number.isFinite(n) && n !== Math.floor(n);

/** The JS twin of `listedPages`: the most pages any copy says it has, null when none says. */
export function listedPagesOf(pages: Iterable<unknown>): number | null {
  let most = 0;
  for (const p of pages) if (typeof p === 'number' && Number.isFinite(p) && p > most) most = p;
  return most > 0 ? most : null;
}

/**
 * The JS twin of `listedIsNotice`, for the sweep, which decides on the copies in hand: is a listed number, whose
 * copies say `pages`, a notice? Only when they say it is short; a number they say nothing about is fetched like any
 * chapter, and judged by its own pages once it is here.
 */
export const isListedNotice = (n: number, pages: Iterable<unknown>): boolean => {
  if (!isFractionalNumber(n)) return false;
  const most = listedPagesOf(pages);
  return most != null && most <= NOTICE_MAX_PAGES;
};

/** The configured types, tidied: known types only, each once, in SERIES_TYPES order. Anything else is empty. */
export function sanitiseNoticeTypes(values: unknown): SeriesType[] {
  if (!Array.isArray(values)) return [];
  const want = new Set(values.filter(isSeriesType));
  return SERIES_TYPES.filter((t) => want.has(t));
}
