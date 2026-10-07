// What each piece of evidence says about which way a series reads (#102). Pure, and importing only komgaDto's
// constants and lib/onlineMatch.ts's title rule (modules with no imports of their own), so the scanner and the source
// adapters can use it without pulling in the database side, lib/readingDirection.ts -- which itself imports the
// MangaDex adapter.
import { READING_DIRECTIONS, type ReadingDirection } from './komgaDto';
import { namesMatch, titleKey } from './onlineMatch';

// titleKey lived here until v0.55.7, when the same fold became the rule for every match stored by title.
export { titleKey };

export type { ReadingDirection };

/** Where a stored direction came from, LEAST trusted first: the index is the rank (lib/readingDirection.ts). */
export const DIRECTION_FROM = ['anilist', 'source', 'comicinfo'] as const;
export type DirectionFrom = (typeof DIRECTION_FROM)[number];

export function isReadingDirection(v: unknown): v is ReadingDirection {
  return typeof v === 'string' && (READING_DIRECTIONS as readonly string[]).includes(v);
}

/**
 * ComicInfo's `<Manga>`: Unknown | No | Yes | YesAndRightToLeft. Only the last one names a direction.
 *
 * `No` is deliberately NOT read as left to right. It is what several tagging tools write when nobody chose,
 * and ComicInfo is the most trusted signal here -- a blanket `No` on a Japanese series would outrank MangaDex
 * and AniList and pin it left to right for good. A western comic that says `No` and nothing else reads left
 * to right anyway, because an unknown direction does. `Yes` says "manga" without saying which way.
 */
export function directionFromComicInfo(manga: string | null | undefined): ReadingDirection | null {
  return /^\s*yes\s*and\s*right\s*to\s*left\s*$/i.test(manga ?? '') ? 'RIGHT_TO_LEFT' : null;
}

/**
 * A title's ORIGINAL language (MangaDex `originalLanguage`) as a direction. Japanese is printed right to left;
 * Korean and Chinese comics are overwhelmingly published as long strips now. Anything else says nothing: an
 * English original is as likely a paged comic as a webcomic, and a wrong guess here would outrank AniList.
 */
export function directionFromLanguage(lang: string | null | undefined): ReadingDirection | null {
  const l = String(lang ?? '').trim().toLowerCase();
  if (l === 'ja') return 'RIGHT_TO_LEFT';
  if (l === 'ko' || l === 'zh' || l === 'zh-hk') return 'WEBTOON';
  return null;
}

/** AniList's `countryOfOrigin` (JP, KR, CN, TW) as a direction, by the same reasoning. */
export function directionFromCountry(country: string | null | undefined): ReadingDirection | null {
  const c = String(country ?? '').trim().toUpperCase();
  if (c === 'JP') return 'RIGHT_TO_LEFT';
  if (c === 'KR' || c === 'CN' || c === 'TW') return 'WEBTOON';
  return null;
}

/**
 * AniList's country of origin -- but only from an entry that is visibly this series.
 *
 * The art lookup finds its entry with a title SEARCH (`sort: SEARCH_MATCH`), which answers with its best guess
 * whatever it was asked: a series called "No Direction" came back as "Dear Green: Hitomi no Ounowa", from Japan,
 * and read right to left. So a searched entry speaks for the direction only when one of its titles -- romaji,
 * English, native, or a synonym -- IS the series' title once case, accents and punctuation are set aside: the rule
 * every match stored by title is held to since v0.55.7 (lib/onlineMatch.ts namesMatch). A true match that fails
 * this costs nothing but the weakest signal; the source and the files still speak.
 * A link a person made (series_trackers.linked_by) is trusted as it stands: see detectDirections.
 */
export function directionFromAniListMatch(
  seriesTitles: Array<string | null | undefined> | string,
  match: { country?: string | null; titles?: Array<string | null | undefined> | null } | null | undefined,
): ReadingDirection | null {
  if (!match || !namesMatch(seriesTitles, match.titles)) return null;
  return directionFromCountry(match.country);
}
