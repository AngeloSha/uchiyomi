// What each piece of evidence says about what KIND of comic a series is: manga, manhwa, manhua, webtoon or comic.
// Pure, like lib/directionSignals.ts beside it, so the scanner and the source adapters can use it without the
// database side (lib/seriesType.ts).
//
// The type is what the admin's "Hide notice chapters" switch is keyed by (lib/noticeChapters.ts): one switch per
// type, because the habit of posting notices as x.y chapters belongs to some scenes and not to others.
import { titleKey } from './directionSignals';

/** Every type a series can be. `unknown` is never stored: NULL means nothing has spoken, and reads as unknown. */
export const SERIES_TYPES = ['manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'unknown'] as const;
export type SeriesType = (typeof SERIES_TYPES)[number];

/** The types evidence can name (all but `unknown`). */
export type KnownSeriesType = Exclude<SeriesType, 'unknown'>;

export function isSeriesType(v: unknown): v is SeriesType {
  return typeof v === 'string' && (SERIES_TYPES as readonly string[]).includes(v);
}

export function isKnownSeriesType(v: unknown): v is KnownSeriesType {
  return isSeriesType(v) && v !== 'unknown';
}

/**
 * Where a stored type came from, LEAST trusted first: the index is the rank (lib/seriesType.ts learnSeriesType).
 *
 *   webtoon  a "Webtoon" genre and no genre naming an origin. Weakest on purpose: Korean and Chinese series are
 *            tagged Webtoon as often as Manhwa or Manhua, and the origin is what the switch is about.
 *   anilist  AniList's country of origin, from an entry that is visibly this series.
 *   source   the followed source's own word: MangaDex's original language.
 *   genre    a genre naming the origin (Manga, Manhwa, Manhua, Comic), from the source or the files.
 */
export const SERIES_TYPE_FROM = ['webtoon', 'anilist', 'source', 'genre'] as const;
export type SeriesTypeFrom = (typeof SERIES_TYPE_FROM)[number];

/**
 * Genre spellings that name a type, lowercased and trimmed. The origin ones are tried in this order, so a series
 * tagged both "Manga" and "Manhwa" -- sites use "Manga" for the whole medium -- is the more specific Manhwa.
 */
const ORIGIN_GENRES: ReadonlyArray<[KnownSeriesType, readonly string[]]> = [
  ['manhwa', ['manhwa', 'korean', 'korean webtoon']],
  ['manhua', ['manhua', 'chinese', 'chinese webtoon']],
  ['comic', ['comic', 'comics', 'western', 'western comic', 'american comic', 'oel']],
  ['manga', ['manga', 'japanese']],
];
const WEBTOON_GENRES: readonly string[] = ['webtoon', 'webtoons', 'web comic', 'webcomic'];

/** Exposed for the boot-time backfill, which applies the same table in SQL (lib/migrate.ts). */
export const GENRE_TYPE_TABLE: ReadonlyArray<[KnownSeriesType, readonly string[]]> = [
  ...ORIGIN_GENRES,
  ['webtoon', WEBTOON_GENRES],
];

const norm = (g: unknown) => String(g ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The type a genre list names, and how strongly. An origin genre beats a Webtoon one, whatever order they come
 * in: "Manhwa, Webtoon" is a manhwa. Nothing that names a type answers null.
 */
export function typeFromGenres(genres: readonly unknown[] | null | undefined): { type: KnownSeriesType; from: SeriesTypeFrom } | null {
  const set = new Set((genres ?? []).map(norm).filter(Boolean));
  if (!set.size) return null;
  for (const [type, names] of ORIGIN_GENRES) if (names.some((n) => set.has(n))) return { type, from: 'genre' };
  if (WEBTOON_GENRES.some((n) => set.has(n))) return { type: 'webtoon', from: 'webtoon' };
  return null;
}

/** A title's ORIGINAL language (MangaDex `originalLanguage`) as a type. Anything else says nothing. */
export function typeFromLanguage(lang: string | null | undefined): KnownSeriesType | null {
  const l = String(lang ?? '').trim().toLowerCase();
  if (l === 'ja' || l === 'ja-ro') return 'manga';
  if (l === 'ko' || l === 'ko-ro') return 'manhwa';
  if (l === 'zh' || l === 'zh-hk' || l === 'zh-tw' || l === 'zh-ro') return 'manhua';
  return null;
}

/** AniList's `countryOfOrigin` (JP, KR, CN, TW, HK) as a type. */
export function typeFromCountry(country: string | null | undefined): KnownSeriesType | null {
  const c = String(country ?? '').trim().toUpperCase();
  if (c === 'JP') return 'manga';
  if (c === 'KR') return 'manhwa';
  if (c === 'CN' || c === 'TW' || c === 'HK') return 'manhua';
  return null;
}

/**
 * AniList's country -- only from an entry that is visibly this series, by the rule
 * lib/directionSignals.ts directionFromAniListMatch applies to the reading direction.
 */
export function typeFromAniListMatch(
  seriesTitles: Array<string | null | undefined> | string,
  match: { country?: string | null; titles?: Array<string | null | undefined> | null } | null | undefined,
): KnownSeriesType | null {
  if (!match) return null;
  const want = new Set((Array.isArray(seriesTitles) ? seriesTitles : [seriesTitles]).map(titleKey).filter(Boolean));
  if (!(match.titles ?? []).some((t) => want.has(titleKey(t)))) return null;
  return typeFromCountry(match.country);
}
