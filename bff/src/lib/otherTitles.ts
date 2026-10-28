// The English, romanised and Japanese titles of a series, from the AniList entry it is linked to (series_trackers).
// Asked once and kept (series_other_titles): an answer with names is asked again after a month, an empty one after a
// day. A series with no checked AniList link, or in a library whose AniList lookups are off, has none to show and
// costs no request. AniList being busy or down answers with what is kept, and keeps nothing new.
import { one, q } from './db';
import { fetchAniListTitles, type AniListTitles } from './anilist';

const DAY = 24 * 60 * 60 * 1000;
export const NAMED_TTL_MS = 30 * DAY;
export const EMPTY_TTL_MS = DAY;

export type OtherTitles = AniListTitles;

const named = (t: AniListTitles | null | undefined): t is AniListTitles => !!(t && (t.english || t.romaji || t.native));

export async function otherTitlesFor(seriesId: string): Promise<OtherTitles | null> {
  // The link is read as lib/anilistRelated.ts reads it: the library's lookups on, and the link chosen by a person or checked.
  const link = await one<{ al: string | null; english: string | null; romaji: string | null; native: string | null; age: string | null }>(
    `SELECT t.external_id AS al, o.english, o.romaji, o.native, EXTRACT(EPOCH FROM now() - o.fetched_at) * 1000 AS age
       FROM lib_series s
       JOIN libraries l ON l.id = s.library_id AND l.anilist_lookup
       LEFT JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
                                  AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
       LEFT JOIN series_other_titles o ON o.series_id = s.id
      WHERE s.id = $1`,
    [seriesId],
  );
  const id = Number(link?.al);
  if (!link || !Number.isInteger(id) || id <= 0) return null;
  const kept: OtherTitles | null = link.age === null ? null : { english: link.english, romaji: link.romaji, native: link.native };
  const have = named(kept);
  if (kept && Number(link.age) < (have ? NAMED_TTL_MS : EMPTY_TTL_MS)) return have ? kept : null;
  try {
    const out = (await fetchAniListTitles(id)) ?? { english: null, romaji: null, native: null };
    await q(
      `INSERT INTO series_other_titles (series_id, english, romaji, native) VALUES ($1, $2, $3, $4)
       ON CONFLICT (series_id) DO UPDATE SET english = $2, romaji = $3, native = $4, fetched_at = now()`,
      [seriesId, out.english, out.romaji, out.native],
    );
    return named(out) ? out : null;
  } catch {
    return have ? kept : null;
  }
}
