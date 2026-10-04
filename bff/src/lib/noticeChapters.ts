// Notice chapters: the chapters a source numbers N.x to tell readers something.
//
// Many sites post an announcement -- a hiatus, a season break, a recruitment call -- as a chapter numbered after
// the latest real one with a fraction: 100.1, 100.5. The admin may hide every chapter whose number is not whole,
// per series type (Settings, server_settings.hide_notice_types) and per series (lib_series.hide_notices, NULL =
// the type's switch). A hidden chapter is gone from everything a person or a client reads -- the chapter list,
// next/previous, the counts and badges, Home, Updates, history, OPDS, the Komga-compatible API Mihon reads and
// what the trackers are told -- and the sweep does not download new ones (lib/updater.ts). Nothing is deleted:
// switching it off shows every one again at once, and the next sweep fetches those never downloaded.
//
// Off by default (an empty list and NULL everywhere), and while nothing hides, nothing costs anything: every fragment
// below is then a constant (`active`), so every query is the one the previous release ran.
//
// ⚠️ The ONE definition. Every query that needs the rule interpolates a fragment from here, so "which chapters
// are notices" and "which series hide them" cannot drift apart between the chapter list and the counts. No
// fragment binds a parameter: they are interpolated into queries whose parameter lists are written by hand, as
// browsable() in lib/visibility.ts is. Everything they read comes from the database itself.
//
// Pure: no database (seriesTypeSignals.test.ts imports it). The reads that need one are lib/noticeSettings.ts.
import { SERIES_TYPES, isSeriesType, type SeriesType } from './seriesTypeSignals';

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

/**
 * Is a chapter of series `s`, numbered `num`, hidden? `num` must be the EFFECTIVE number (the admin's renumber
 * when there is one), as booksSrc reads it. The cheap test first: a whole number never reaches the subqueries.
 */
export const noticeHidden = (s: string, num: string): string => (active ? `(${isFractional(num)} AND ${hidesNotices(s)})` : 'false');

/** The negation, for a WHERE that keeps what is shown. */
export const noticeShown = (s: string, num: string): string => (active ? `NOT ${noticeHidden(s, num)}` : 'true');

/**
 * Is the lib_books row `bookId` (an SQL expression) a hidden notice? Self-contained, for queries that hold only a
 * book id: read_progress, bookmarks, history. A book id that names nothing is not hidden.
 */
export const noticeBook = (bookId: string): string => (!active ? 'false' : `EXISTS (
  SELECT 1 FROM lib_books nb_nt
    JOIN lib_series ns_nt ON ns_nt.id = nb_nt.series_id
    LEFT JOIN book_overrides nov_nt ON nov_nt.book_id = nb_nt.id
   WHERE nb_nt.id = ${bookId}
     AND ${noticeHidden('ns_nt', 'COALESCE(nov_nt.number, nb_nt.number)')})`);

/**
 * Is number `num` of series `seriesId` (both SQL expressions) a hidden notice? Self-contained, for queries over
 * series_listing that hold no lib_series alias: the archive's work list.
 */
export const noticeNumber = (seriesId: string, num: string): string => (!active ? 'false' : `EXISTS (
  SELECT 1 FROM lib_series nl_nt WHERE nl_nt.id = ${seriesId} AND ${noticeHidden('nl_nt', num)})`);

/**
 * How many of series `s`'s lib_books rows are hidden notices: what lib_series.books_count -- a stored count of every
 * row -- is short of, read at query time so the count is right again the moment the switch goes off. 0 for a series
 * that does not hide, without counting anything.
 */
export const hiddenBookCount = (s: string): string => `(CASE WHEN ${hidesNotices(s)} THEN (
  SELECT count(*) FROM lib_books hb_nt LEFT JOIN book_overrides hov_nt ON hov_nt.book_id = hb_nt.id
   WHERE hb_nt.series_id = ${s}.id AND ${isFractional('COALESCE(hov_nt.number, hb_nt.number)')}
) ELSE 0 END)::int`;

/**
 * How many notice chapters series `s` hides: every distinct fractional number it has, on disk (the effective number)
 * or only listed by its sources. The admin's "N hidden now". Not `hiddenBookCount`: most notices are never
 * downloaded -- the sweep skips them while hidden -- so a count of files read 0 for nearly every series.
 * Reintroduce by counting lib_books alone: "the hidden count includes notices that were never downloaded" in
 * noticeChapters.int.test.ts reads 0.
 */
export const hiddenNoticeCount = (s: string): string => `(CASE WHEN ${hidesNotices(s)} THEN (
  SELECT count(DISTINCT hn_nt.n) FROM (
    SELECT COALESCE(hov_nt.number, hb_nt.number) AS n FROM lib_books hb_nt
      LEFT JOIN book_overrides hov_nt ON hov_nt.book_id = hb_nt.id WHERE hb_nt.series_id = ${s}.id
    UNION ALL
    SELECT hl_nt.number FROM series_listing hl_nt WHERE hl_nt.series_id = ${s}.id
  ) hn_nt WHERE ${isFractional('hn_nt.n')}
) ELSE 0 END)::int`;

/** books_count as a reader sees it. */
export const visibleBookCount = (s: string): string => (active ? `GREATEST(0, ${s}.books_count - ${hiddenBookCount(s)})` : `${s}.books_count`);

/** A whole number? The JS twin of `isFractional`, for lists already in memory (the sweep, the listing). */
export const isFractionalNumber = (n: number): boolean => Number.isFinite(n) && n !== Math.floor(n);

/** The configured types, tidied: known types only, each once, in SERIES_TYPES order. Anything else is empty. */
export function sanitiseNoticeTypes(values: unknown): SeriesType[] {
  if (!Array.isArray(values)) return [];
  const want = new Set(values.filter(isSeriesType));
  return SERIES_TYPES.filter((t) => want.has(t));
}

