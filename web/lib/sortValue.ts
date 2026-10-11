// What a series card says about the order it is in, and AniList's word on a series beside the reader's own (v0.58.0).
//
// The owner asked for a rating from somewhere else -- AniList's -- while keeping their own stars, and for the Library to
// sort by popularity, by chapters, "etc.". Five Library orders came of it (lib/librarySort.ts SORTS), and a shelf sorted
// by something the covers do not show reads as shuffled: why is this one before that one? So under each title the card
// says the one value the shelf is sorted by, and nothing for the four older orders, whose answer is already on the card
// or is the title itself. A series without the value (no AniList link checked, never rated, never read) says nothing: it
// sorts after the rest.
//
// v0.60.0: the value is a kind and a short text, and the card draws the kind -- a small star before AniList's score
// ("★ 84"), the people icon before its popularity ("312K readers") -- where it used to spell "84% on AniList" under every
// title. The long form stays, as the line's hover and its screen-reader text. The reader's own stars ("★ 4/5"), the
// chapter count and "Read 3d ago" read as they did.
//
// Pure, so the lines are unit-tested (test/v580Ratings.test.ts, test/v600Library.test.ts) rather than looked for in a
// browser.
import { t as tr } from './i18n';
import { bookCountText, compactText, numberText, relativeTime } from './format';
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
const countOf = (popularity: number): string => `⁨${compactText(popularity)}⁩`;

/**
 * The percent sign kept on its number: French, German, Spanish and Russian write "84 %", and at a card's width the sign
 * broke onto a line of its own (AddSeriesDialog's autoFollowLine glues it the same way, after translation, so no locale
 * file carries an invisible character).
 */
const glued = (s: string): string => s.replace(/(\d) %/g, '$1 %');

/** "312K on AniList": how many AniList users have it on a list. */
export const popularityText = (popularity: number): string => tr('{count} on AniList', { count: countOf(popularity) });

/** "84% on AniList": AniList's average score. */
export const scoreText = (score: number): string => glued(tr('{score}% on AniList', { score: Math.round(score) }));

/** "312K readers": AniList's popularity as a card says it, beside the people icon. */
export const readersText = (popularity: number): string =>
  popularity === 1 ? tr('1 reader') : tr('{n} readers', { n: countOf(popularity) });

/**
 * What kind of value a card shows, which is what it draws before the text: `score` a star, `popularity` the people
 * icon; the other three are words already.
 */
export type SortValueKind = 'popularity' | 'score' | 'rating' | 'chapters' | 'read';

export interface SortValue {
  kind: SortValueKind;
  /** The line itself, after its icon: "84", "312K readers", "★ 4/5", "37 chapters", "Read 3d ago". */
  text: string;
  /** The long form, for a hover and a screen reader: "84% on AniList". The text itself where it says it all. */
  hint: string;
}

/**
 * The value a Library card shows under its title while the shelf is in order `sort` (a SORTS key): null for the four
 * older orders, and for a series without the value.
 */
export function sortValue(series: Pick<Series, 'booksCount' | 'yomi'>, sort: string): SortValue | null {
  switch (sort) {
    case 'popular': {
      const p = anilistNumbers(series.yomi?.anilist)?.popularity;
      return p == null ? null : { kind: 'popularity', text: readersText(p), hint: popularityText(p) };
    }
    case 'score': {
      const s = anilistNumbers(series.yomi?.anilist)?.score;
      return s == null ? null : { kind: 'score', text: numberText(s), hint: scoreText(s) };
    }
    // The reader's own stars, as the series page writes them: no word to translate.
    case 'rating': {
      const r = num(series.yomi?.rating);
      return r && r > 0 ? { kind: 'rating', text: `★ ${r}/5`, hint: `★ ${r}/5` } : null;
    }
    case 'chapters': {
      const n = num(series.booksCount);
      if (n === null) return null;
      const text = bookCountText(n);
      return { kind: 'chapters', text, hint: text };
    }
    case 'read': {
      const at = series.yomi?.lastReadAt;
      if (!at || !Number.isFinite(Date.parse(at))) return null;
      const text = tr('Read {when}', { when: relativeTime(at) });
      return { kind: 'read', text, hint: text };
    }
    default:
      return null;
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
