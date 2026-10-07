// What kind of comic a series is (lib/seriesTypeSignals.ts), stored on lib_series with where it came from, the
// admin's override on series_overrides beating it, and NULL -- nobody knows -- reading as `unknown`.
//
// Learned the way the reading direction is (lib/readingDirection.ts): a weaker signal never overwrites a stronger
// one, and the same signal may correct itself. The admin's "Hide notice chapters" switches are keyed by it
// (lib/noticeChapters.ts).
import { q } from './db';
import {
  SERIES_TYPE_FROM, isKnownSeriesType, typeFromGenres, typeFromLanguage, typeFromAniListMatch,
  type KnownSeriesType, type SeriesTypeFrom,
} from './seriesTypeSignals';
import type { ScopedQuery } from './anilistPolicy';

export * from './seriesTypeSignals';

/**
 * Record what one piece of evidence says, unless something more trusted already spoke. By id, or by folder where
 * the add flow has not learned the id yet. A null type is no evidence and changes nothing.
 */
export async function learnSeriesTypeWith(
  qq: ScopedQuery,
  where: { id: string } | { folder: string },
  type: KnownSeriesType | null | undefined,
  from: SeriesTypeFrom,
): Promise<boolean> {
  if (!isKnownSeriesType(type)) return false;
  const byId = 'id' in where;
  const rows = await qq<{ id: string }>(
    `UPDATE lib_series SET series_type = $2, series_type_from = $3
      WHERE ${byId ? 'id' : 'folder'} = $1
        AND COALESCE(array_position($4::text[], series_type_from), 0) <= array_position($4::text[], $3::text)
        AND (series_type IS DISTINCT FROM $2 OR series_type_from IS DISTINCT FROM $3)
      RETURNING id`,
    [byId ? where.id : where.folder, type, from, SERIES_TYPE_FROM],
  );
  return rows.length > 0;
}

/** Unconditional/manual wrapper. Automatic AniList work uses the scoped form under `withAniListMutation`. */
export async function learnSeriesType(
  where: { id: string } | { folder: string },
  type: KnownSeriesType | null | undefined,
  from: SeriesTypeFrom,
): Promise<boolean> {
  return learnSeriesTypeWith(q, where, type, from);
}

/**
 * Everything a source's own description of a title says: its genres, then its original language. Both are
 * tried, in rank order, so the stronger wins whichever comes first. Best effort: never throws.
 */
export async function learnTypeFromSource(
  where: { id: string } | { folder: string },
  series: { genres?: readonly unknown[] | null; originalLanguage?: string | null } | null | undefined,
): Promise<void> {
  if (!series) return;
  const lang = typeFromLanguage(series.originalLanguage);
  if (lang) await learnSeriesType(where, lang, 'source').catch(() => false);
  const g = typeFromGenres(series.genres);
  if (g) await learnSeriesType(where, g.type, g.from).catch(() => false);
}

/** AniList's country, from the art match, when the entry is visibly this title. Best effort. */
export async function learnTypeFromAniListWith(
  qq: ScopedQuery,
  where: { id: string } | { folder: string },
  title: Array<string | null | undefined> | string,
  match: { country?: string | null; titles?: Array<string | null | undefined> | null } | null | undefined,
): Promise<boolean> {
  return learnSeriesTypeWith(qq, where, typeFromAniListMatch(title, match), 'anilist');
}

/** Unconditional/manual wrapper used by explicit Admin actions. */
export async function learnTypeFromAniList(
  where: { id: string } | { folder: string },
  title: Array<string | null | undefined> | string,
  match: { country?: string | null; titles?: Array<string | null | undefined> | null } | null | undefined,
): Promise<void> {
  await learnTypeFromAniListWith(q, where, title, match).catch(() => false);
}
