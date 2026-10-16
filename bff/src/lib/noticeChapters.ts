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
// v0.55.3 (#147, TIGamingTV's switch): unless the admin says otherwise. "Only hide short ones" (server_settings.
// hide_notice_short_only) is on by default and is the rule above; off, every chapter numbered with a fraction is a
// notice, of the types and the series switched on -- the rule #147 was first written with, real chapters a site split
// into parts included, which is why it is a choice and says so where it is made.
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
//
// AND THE NUMBERS AN ADMIN HIDES BY HAND (#240, rebuilt to hide only). A source sometimes lists a chapter that is not
// part of the work -- a 0.5 from an unrelated title, a stray number no source-side action removes -- and an admin may
// hide that number from the series, for everyone (lib_series.hidden_numbers, the effective number, as a notice is
// judged). It is the same hide as a notice's, so it is written into the same fragments below rather than beside them:
// every surface that leaves a hidden notice out leaves a hidden number out by the same clause, and the sweep never
// fetches one (lib/updater.ts, lib/chapterFallback.ts). Nothing is deleted, and Restore shows it again at once. Never a
// file holding a range of chapters, as a notice never is. While no series hides a number, every fragment is exactly
// what it was (`handActive`), so an install that never hides one runs the queries it always ran.
import { SERIES_TYPES, isSeriesType, type SeriesType } from './seriesTypeSignals';
import { holds, isRange, rangeEnd } from './chapterRanges';

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

/**
 * v0.55.3: whether a notice must also be short (server_settings.hide_notice_short_only, "Only hide short ones"). Kept
 * by refreshNoticesActive beside `active`, at boot and after the switch, so each query is written for ONE rule and the
 * planner prices only that one: off, no fragment reads a page count at all. True until read: the default, and v0.55.2.
 */
let shortOnly = true;
export const setNoticesShortOnly = (on: boolean): void => { shortOnly = on; };
export const noticesShortOnly = (): boolean => shortOnly;

/**
 * Does any series hide a number by hand (lib_series.hidden_numbers not NULL)? Kept like `active`: by
 * refreshNoticesActive at boot and after every Restore, and set at once by a hide (lib/hiddenChapters.ts) -- a stale
 * true costs a clause that matches nothing, a stale false would show a hidden chapter, so only a refresh lowers it.
 */
let handActive = false;
export const setHiddenNumbersActive = (on: boolean): void => { handActive = on; };
export const hiddenNumbersActive = (): boolean => handActive;

/** Is anything hidden at all, a notice or a number? While not, every fragment below is a constant. */
export const hidingActive = (): boolean => active || handActive;

/**
 * Is the effective number `num` (an SQL expression) one that series `s` (an alias of lib_series) hid by hand? Never
 * NULL: a NULL number is not hidden. `real = ANY(real[])`, so the stored 12.5 and a file's 12.5 compare exactly.
 */
export const numberHidden = (s: string, num: string): string =>
  (handActive ? `COALESCE(${num} = ANY(${s}.hidden_numbers), false)` : 'false');

/**
 * Is the lib_books row `b` (`ov` its LEFT JOINed book_overrides row) of series `s` at a number that series hid? By the
 * effective number, and never a file holding a range of chapters: `Chapter 01-07.cbz` is seven chapters, and hiding
 * one number must not take the other six with it (the notice rule, bookIsNotice).
 */
const bookHiddenByHand = (s: string, b: string, ov: string): string =>
  `(${rangeEnd(b, ov)} IS NULL AND ${numberHidden(s, `COALESCE(${ov}.number, ${b}.number)`)})`;

/** The hand half alone, for a caller that keeps notices and hidden numbers apart (lib/libraryNumbers.ts). */
export const bookHiddenNumber = (s: string, b: string, ov: string): string => (handActive ? bookHiddenByHand(s, b, ov) : 'false');

/**
 * The ids of the chapters at a number their series hid, as bookHiddenByHand judges them: an uncorrelated ARRAY, which
 * Postgres reads ONCE per query (an InitPlan) -- a handful of rows from the few series that hide anything, by the series
 * index -- and a row is then tested with `id = ANY(...)`. For the fragments that hold a book id and no series alias.
 * Written as a correlated EXISTS, it was planned as an anti-join over every chapter of the library probing each one's
 * series: on a copy of a 50,000-chapter library the Library's read-progress roll-up went from 6 ms to 160 ms, and
 * Continue reading past jit_above_cost, the moment one number was hidden. Reintroduce the EXISTS: "the hide fragments
 * read the hidden chapters once" in hiddenChapters.int.test.ts finds no InitPlan.
 */
const hiddenBookIds = (): string => `ARRAY(
  SELECT hb_hn.id FROM lib_series hs_hn
    JOIN lib_books hb_hn ON hb_hn.series_id = hs_hn.id AND hb_hn.number = ANY(hs_hn.hidden_numbers)
   WHERE hs_hn.hidden_numbers IS NOT NULL AND NOT ${isRange('hb_hn')}
     AND NOT EXISTS (SELECT 1 FROM book_overrides bo_hn WHERE bo_hn.book_id = hb_hn.id AND bo_hn.number IS NOT NULL)
  UNION ALL
  SELECT bo_hn.book_id FROM book_overrides bo_hn
    JOIN lib_books hb_hn ON hb_hn.id = bo_hn.book_id
    JOIN lib_series hs_hn ON hs_hn.id = hb_hn.series_id
   WHERE bo_hn.number = ANY(hs_hn.hidden_numbers))`;

/**
 * The hand half alone and self-contained, for a query over lib_books that holds no lib_series alias: the jobs that
 * delete or rewrite files (the read-chapter cleanup, Fix everything's files step, the completion pass) leave a chapter
 * at a hidden number exactly as it is.
 */
export const atHiddenNumber = (b: string): string => (handActive ? `${b}.id = ANY(${hiddenBookIds()})` : 'false');

/** Either clause, or the one that is on: a hide written once for both kinds. Only called while something hides. */
const either = (notice: string | null, hand: string | null): string =>
  (notice && hand ? `(${notice} OR ${hand})` : (notice ?? hand ?? 'false'));

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
 * dropping the range test: "a range is never a notice" in noticeRanges.int.test.ts finds the two-page 9.5-10 gone.
 */
export const bookIsNotice = (b: string, ov: string): string => {
  const num = `COALESCE(${ov}.number, ${b}.number)`;
  // v0.55.3: with "Only hide short ones" off, the fraction alone -- and still never a range.
  if (!shortOnly) return `(${isFractional(num)} AND ${rangeEnd(b, ov)} IS NULL)`;
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

/**
 * Is the series_listing row `l` a notice, whether or not its series hides them? What the listing says of it -- or, with
 * "Only hide short ones" off (v0.55.3), its number alone.
 */
export const listedIsNotice = (l: string): string =>
  (shortOnly ? `(${isFractional(`${l}.number`)} AND ${isShort(listedPages(`${l}.copies`))})` : isFractional(`${l}.number`));

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

/** The notice half alone: a notice the series hides, whatever it hides by hand. */
const noticeOnly = (s: string, b: string, ov: string): string => `(${bookIsNotice(b, ov)} AND ${hidesNotices(s)})`;

/**
 * Is the lib_books row `b` of series `s` (`ov` its LEFT JOINed book_overrides row) hidden: a notice that series hides,
 * or at a number it hid by hand?
 */
export const noticeHidden = (s: string, b: string, ov: string): string =>
  (hidingActive() ? either(active ? noticeOnly(s, b, ov) : null, handActive ? bookHiddenByHand(s, b, ov) : null) : 'false');

/** The negation, for a WHERE that keeps what is shown. */
export const noticeShown = (s: string, b: string, ov: string): string => (hidingActive() ? `NOT ${noticeHidden(s, b, ov)}` : 'true');

/**
 * Is the series_listing row `l` of series `s` a notice that series hides -- the notice half alone? For the held numbers
 * (lib/libraryNumbers.ts HAVE_SQL), which count a hidden notice only the sources list as held, and a number hidden by
 * hand by its own rule.
 */
export const listedNoticeHidden = (s: string, l: string): string => (active ? `(${listedIsNotice(l)} AND ${hidesNotices(s)})` : 'false');

/** Is the series_listing row `l` of series `s` hidden: a notice that series hides, or a number it hid by hand? */
export const listedHidden = (s: string, l: string): string =>
  (hidingActive() ? either(active ? listedNoticeHidden(s, l) : null, handActive ? numberHidden(s, `${l}.number`) : null) : 'false');

/** The negation, for a WHERE over the listing that keeps what is shown. */
export const listedShown = (s: string, l: string): string => (hidingActive() ? `NOT ${listedHidden(s, l)}` : 'true');

/**
 * Is the lib_books row `bookId` (an SQL expression) hidden? Self-contained, for queries that hold only a book id:
 * read_progress, bookmarks, history. A book id that names nothing is not hidden. The notice test is a lookup by the
 * book's own key behind its index-served one (mayBeNotice); a number hidden by hand is the hidden chapters' ids, read
 * once (hiddenBookIds).
 *
 * ⚠️ With both on, the hand test goes INSIDE the notice EXISTS, never beside it. Callers write `NOT ${noticeBook(..)}`,
 * and `NOT (EXISTS (..) OR x = ANY(..))` is a shape the planner cannot turn into an anti-join: the notice lookup became a
 * subplan per row, and on a copy of a 50,000-chapter library Continue reading was priced at 834,549 -- past
 * jit_inline_above_cost, so a Postgres with JIT spent six seconds compiling a query that runs in thirty milliseconds.
 * Folded in, it is priced as the notice test alone (242,001, v0.71.0's own 246,457). Reintroduce the OR beside it:
 * "...and keep the notice lookup an anti-join" in hiddenChapters.int.test.ts finds no anti-join.
 */
export const noticeBook = (bookId: string): string => {
  if (!hidingActive()) return 'false';
  if (!active) return `${bookId} = ANY(${hiddenBookIds()})`;
  const notice = `${mayBeNotice('nb_nt')} AND ${noticeOnly('ns_nt', 'nb_nt', 'nov_nt')}`;
  return `EXISTS (
  SELECT 1 FROM lib_books nb_nt
    JOIN lib_series ns_nt ON ns_nt.id = nb_nt.series_id
    LEFT JOIN book_overrides nov_nt ON nov_nt.book_id = nb_nt.id
   WHERE nb_nt.id = ${bookId} AND ${handActive ? `((${notice}) OR nb_nt.id = ANY(${hiddenBookIds()}))` : notice})`;
};

/**
 * Is the series_listing row `l` hidden? Self-contained, for queries over the listing that hold no lib_series alias:
 * the archive's work list.
 */
export const noticeListed = (l: string): string => (!hidingActive() ? 'false' : `EXISTS (
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
 *
 * Plus the rows at a number the series hid by hand, a notice it hides counted once, on the notice side. Two counts as
 * well, each an index's: the rows whose file's own number is hidden (lib_books_series_idx, by series and number), and
 * the handful an override puts on one. Only for a series that hides a number: the rest count nothing.
 */
export const hiddenBookCount = (s: string): string => {
  const notice = active ? `(CASE WHEN ${hidesNotices(s)} THEN (
  SELECT count(*) FROM lib_books hb_nt LEFT JOIN book_overrides hov_nt ON hov_nt.book_id = hb_nt.id
   WHERE hb_nt.series_id = ${s}.id AND hb_nt.number <> floor(hb_nt.number)
     AND ${bookIsNotice('hb_nt', 'hov_nt')}
) + (
  SELECT count(*) FROM lib_books hb_nt JOIN book_overrides hov_nt ON hov_nt.book_id = hb_nt.id
   WHERE hb_nt.id = ANY(ARRAY(SELECT bo_nt.book_id FROM book_overrides bo_nt WHERE bo_nt.number <> floor(bo_nt.number)))
     AND hb_nt.series_id = ${s}.id AND hb_nt.number = floor(hb_nt.number) AND ${bookIsNotice('hb_nt', 'hov_nt')}
) ELSE 0 END)` : null;
  const notNotice = (b: string, ov: string) => (active ? ` AND NOT ${noticeOnly(s, b, ov)}` : '');
  const hand = handActive ? `(CASE WHEN ${s}.hidden_numbers IS NOT NULL THEN (
  SELECT count(*) FROM lib_books hb_hn LEFT JOIN book_overrides hov_hn ON hov_hn.book_id = hb_hn.id
   WHERE hb_hn.series_id = ${s}.id AND hb_hn.number = ANY(${s}.hidden_numbers) AND hov_hn.number IS NULL
     AND ${bookHiddenByHand(s, 'hb_hn', 'hov_hn')}${notNotice('hb_hn', 'hov_hn')}
) + (
  SELECT count(*) FROM book_overrides hov_hn JOIN lib_books hb_hn ON hb_hn.id = hov_hn.book_id
   WHERE hov_hn.number = ANY(${s}.hidden_numbers) AND hb_hn.series_id = ${s}.id
     AND ${bookHiddenByHand(s, 'hb_hn', 'hov_hn')}${notNotice('hb_hn', 'hov_hn')}
) ELSE 0 END)` : null;
  return `(${[notice, hand].filter(Boolean).join(' + ') || '0'})::int`;
};

/**
 * How many notice chapters series `s` hides: every distinct number of a hidden saved chapter (its effective number),
 * and of a hidden number only its sources list. The admin's "Hidden now". Not `hiddenBookCount`: a notice the sources
 * say is short is never downloaded while hidden, so a count of files would miss those. A listed number a saved file
 * holds is that file's, which its own pages judge -- its own number, or one inside a range it holds
 * (lib/chapterRanges.ts `holds`, as the missing-chapter rows have it): `01-07` holds a listed two-page 3.5, which no
 * switch shows or hides.
 * Reintroduce by counting lib_books alone: "the hidden count includes notices that were never downloaded" in
 * noticeChapters.int.test.ts reads 2. Reintroduce the exact number for a listed one: "Hidden now" in
 * noticeRanges.int.test.ts counts the 3.5 a range file holds.
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
                        WHERE xb_nt.series_id = hl_nt.series_id AND ${holds('xb_nt', 'xov_nt', 'hl_nt.number')})
  ) hn_nt
) ELSE 0 END)::int`;

/** books_count as a reader sees it. */
export const visibleBookCount = (s: string): string => (hidingActive() ? `GREATEST(0, ${s}.books_count - ${hiddenBookCount(s)})` : `${s}.books_count`);

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
 * chapter, and judged by its own pages once it is here. With "Only hide short ones" off (v0.55.3), any fraction is.
 */
export const isListedNotice = (n: number, pages: Iterable<unknown>): boolean => {
  if (!isFractionalNumber(n)) return false;
  if (!shortOnly) return true;
  const most = listedPagesOf(pages);
  return most != null && most <= NOTICE_MAX_PAGES;
};

/** The configured types, tidied: known types only, each once, in SERIES_TYPES order. Anything else is empty. */
export function sanitiseNoticeTypes(values: unknown): SeriesType[] {
  if (!Array.isArray(values)) return [];
  const want = new Set(values.filter(isSeriesType));
  return SERIES_TYPES.filter((t) => want.has(t));
}
