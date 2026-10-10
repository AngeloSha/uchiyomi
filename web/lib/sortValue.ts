// What a series card says about the order it is in, and AniList's word on a series beside the reader's own (v0.58.0).
//
// The owner asked for a rating from somewhere else -- AniList's -- while keeping their own stars, and for the Library to
// sort by popularity, by chapters, "etc.". Five Library orders came of it (components/LibraryFilters.tsx SORTS), and a
// shelf sorted by something the covers do not show reads as shuffled: why is this one before that one? So under each
// title the card says the one value the shelf is sorted by -- "312K on AniList", "84% on AniList", "★ 4/5", "37 chapters",
// "Read 3d ago" -- and nothing for the four older orders, whose answer is already on the card or is the title itself.
// A series without the value (no AniList link checked, never rated, never read) says nothing: it sorts after the rest.
//
// Pure, so the lines are unit-tested (test/v580Ratings.test.ts) rather than looked for in a browser.
import { t as tr } from './i18n';
import { bookCountText, compactText, relativeTime } from './format';
import type { AniListNumbers, Series } from './types';

/** A number the server sent, or null: an older server sends nothing, and a value that is not a number is nothing too. */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * AniList's two numbers, each null when unknown -- the score rounded to a whole percent -- or null when neither is known.
 * `yomi.anilist` as the server sends it: null without a checked AniList link, absent from a server older than v0.58.0.
 */
export function anilistNumbers(raw: AniListNumbers | null | undefined): AniListNumbers | null {
  if (!raw || typeof raw !== 'object') return null;
  const score = num(raw.score);
  const popularity = num(raw.popularity);
  if (score === null && popularity === null) return null;
  return { score: score === null ? null : Math.round(score), popularity: popularity === null ? null : Math.round(popularity) };
}

/**
 * The count, shortened in the reader's language ("312K", "312 тыс.", "31万") and isolated: in an Arabic line "312 ألف"
 * is a number and a word, and without the isolate a Latin "AniList" before it pulls the number away from its word.
 */
const countOf = (popularity: number): string => `\u2068${compactText(popularity)}\u2069`;

/**
 * The percent sign kept on its number: French, German, Spanish and Russian write "84 %", and at a card's width the sign
 * broke onto a line of its own (AddSeriesDialog's autoFollowLine glues it the same way, after translation, so no locale
 * file carries an invisible character).
 */
const glued = (s: string): string => s.replace(/(\d) %/g, '$1\u00a0%');

/** "312K on AniList": how many AniList users have it on a list. */
export const popularityText = (popularity: number): string => tr('{count} on AniList', { count: countOf(popularity) });

/** "84% on AniList": AniList's average score. */
export const scoreText = (score: number): string => glued(tr('{score}% on AniList', { score: Math.round(score) }));

/**
 * The value a Library card shows under its title while the shelf is in order `sort` (a SORTS key): '' for the four
 * older orders, and for a series without the value.
 */
export function sortValue(series: Pick<Series, 'booksCount' | 'yomi'>, sort: string): string {
  switch (sort) {
    case 'popular': {
      const p = anilistNumbers(series.yomi?.anilist)?.popularity;
      return p == null ? '' : popularityText(p);
    }
    case 'score': {
      const s = anilistNumbers(series.yomi?.anilist)?.score;
      return s == null ? '' : scoreText(s);
    }
    // The reader's own stars, as the series page writes them: no word to translate.
    case 'rating': {
      const r = num(series.yomi?.rating);
      return r && r > 0 ? `★ ${r}/5` : '';
    }
    case 'chapters': {
      const n = num(series.booksCount);
      return n === null ? '' : bookCountText(n);
    }
    case 'read': {
      const at = series.yomi?.lastReadAt;
      return at && Number.isFinite(Date.parse(at)) ? tr('Read {when}', { when: relativeTime(at) }) : '';
    }
    default:
      return '';
  }
}

/**
 * AniList's word on a series as one line, beside the reader's own stars on the series page: "AniList 84% · 312K", or the
 * half it has ("AniList 84%", "312K on AniList"); '' when AniList has nothing to say.
 */
export function anilistLine(raw: AniListNumbers | null | undefined): string {
  const a = anilistNumbers(raw);
  if (!a) return '';
  if (a.score === null) return popularityText(a.popularity!);
  return glued(a.popularity === null
    ? tr('AniList {score}%', { score: a.score })
    : tr('AniList {score}% · {count}', { score: a.score, count: countOf(a.popularity) }));
}
