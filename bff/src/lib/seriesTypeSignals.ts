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
 *   genre    a genre naming one origin (Manhwa, Manhua, Comic, Japanese), from the source or the files.
 */
export const SERIES_TYPE_FROM = ['webtoon', 'anilist', 'source', 'genre'] as const;
export type SeriesTypeFrom = (typeof SERIES_TYPE_FROM)[number];

/** Genre spellings that name an origin, lowercased and trimmed. */
const ORIGIN_GENRES: ReadonlyArray<[KnownSeriesType, readonly string[]]> = [
  ['manhwa', ['manhwa', 'korean', 'korean webtoon']],
  ['manhua', ['manhua', 'chinese', 'chinese webtoon']],
  ['comic', ['comic', 'comics', 'western', 'western comic', 'american comic', 'oel']],
  ['manga', ['manga', 'japanese']],
];
/** "Manga" alone says nothing: many sites file every title under it, Korean and Chinese ones included. */
const GENERIC_GENRES: ReadonlySet<string> = new Set(['manga']);
const WEBTOON_GENRES: readonly string[] = ['webtoon', 'webtoons', 'web comic', 'webcomic'];

const norm = (g: unknown) => String(g ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The type a genre list names, and how strongly: ONE origin, or a Webtoon genre with none.
 *
 * ⚠️ A list naming several origins is no evidence at all. Sites copy their whole genre menu onto a title -- "Manga,
 * Manhwa, Manhua" -- and taking the most specific of them made 19 of 240 typed series on the owner's library manhwa
 * (JoJo Part 7 among them) where MangaDex and AniList knew better, below a genre they could never outrank. Nor is a
 * lone generic "Manga": Dungeon Defense, which is Korean, became manga that way. Both answer null, so the source and
 * AniList decide. An origin still beats a Webtoon genre, whatever order they come in: "Manhwa, Webtoon" is a manhwa.
 * Reintroduce by taking the first origin named: "a genre menu, or a lone Manga, is no evidence" in
 * seriesTypeSignals.test.ts reads manhwa and manga.
 */
export function typeFromGenres(genres: readonly unknown[] | null | undefined): { type: KnownSeriesType; from: SeriesTypeFrom } | null {
  const set = new Set((genres ?? []).map(norm).filter(Boolean));
  if (!set.size) return null;
  const origins = ORIGIN_GENRES.filter(([, names]) => names.some((n) => set.has(n)));
  if (origins.length > 1) return null;
  const [origin] = origins;
  if (origin && origin[1].some((n) => set.has(n) && !GENERIC_GENRES.has(n))) return { type: origin[0], from: 'genre' };
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
