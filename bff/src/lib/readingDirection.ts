// Which way a series reads (#102).
//
// Every series used to answer `readingDirection: 'WEBTOON'` from a constant in lib/ownedCatalog seriesDto, so
// the reader's "Series default" direction could never lay a page out right to left, a right-to-left double
// spread was never reassembled, a downloaded chapter carried WEBTOON to the reader offline, and the
// Komga-compatible API told Mihon that every manga was a webtoon. The direction is now learned from evidence and
// stored on lib_series, with the admin's override on series_overrides beating it, and NULL -- nobody knows --
// still reading as WEBTOON, so a series nothing speaks for behaves exactly as before.
//
// The evidence, most trusted first:
//   comicinfo  `<Manga>YesAndRightToLeft</Manga>` in the first chapter's ComicInfo.xml, read by the scanner.
//              The file says so itself, about this very copy.
//   source     what the followed source says about the title: MangaDex's `originalLanguage`. Learned when a
//              series is added, and by the nightly repair's `directions` step for series added before this.
//   anilist    AniList's `countryOfOrigin`, from the same match that already finds the art and the tracker
//              link, and from the link itself for series that have one -- only from an entry that is
//              visibly this series, unless a person made the link (directionFromAniListMatch).
// A weaker signal never overwrites a stronger one (learnDirection); the same signal may correct itself.
import { q } from './db';
import { visibleToAll } from './visibility';
import { isDisabled } from './sourceHealth';
import { mangadexOriginalLanguages } from './sources/mangadex';
import { fetchAniListCountries } from './anilist';
import {
  DIRECTION_FROM, isReadingDirection, directionFromLanguage, directionFromCountry, directionFromAniListMatch,
  type DirectionFrom, type ReadingDirection,
} from './directionSignals';

export * from './directionSignals';

/**
 * Record what one piece of evidence says, unless something more trusted already spoke.
 *
 * Returns whether the row changed. By id, or by folder where the add flow has not learned the id yet (the
 * routing stamps beside it are written the same way). A null direction is no evidence and changes nothing:
 * "AniList has no country for this" must not erase what the source said.
 * ⚠️ The rank comparison is `<=`, not `<`: the same signal may correct itself (a series re-linked to the right
 * AniList entry), and only a weaker one is refused. Reintroduce `<`: readingDirection.int.test.ts "a signal
 * may correct its own earlier answer" keeps the stale value.
 */
export async function learnDirection(
  where: { id: string } | { folder: string },
  dir: ReadingDirection | null | undefined,
  from: DirectionFrom,
): Promise<boolean> {
  if (!isReadingDirection(dir)) return false;
  const byId = 'id' in where;
  const rows = await q<{ id: string }>(
    `UPDATE lib_series SET reading_direction = $2, reading_direction_from = $3
      WHERE ${byId ? 'id' : 'folder'} = $1
        AND COALESCE(array_position($4::text[], reading_direction_from), 0) <= array_position($4::text[], $3::text)
        AND (reading_direction IS DISTINCT FROM $2 OR reading_direction_from IS DISTINCT FROM $3)
      RETURNING id`,
    [byId ? where.id : where.folder, dir, from, DIRECTION_FROM],
  );
  return rows.length > 0;
}

// ---- the nightly backfill (lib/repair.ts, step `directions`) -------------------------------------------------

/**
 * The two batch lookups the backfill makes. Both take many ids per request -- MangaDex 100, AniList 50 -- so a
 * whole library is a handful of calls. Swappable for tests only (setDirectionLookups), because this runs from
 * the nightly repair and a test must never reach the real services.
 */
export interface DirectionLookups {
  /** MangaDex manga id -> originalLanguage, for the ids it answered. */
  mangadex(ids: string[]): Promise<Map<string, string>>;
  /** AniList media id -> countryOfOrigin and every title the entry goes by, for the ids it answered. */
  anilist(ids: number[]): Promise<Map<number, { country: string; titles: string[] }>>;
}
const REAL_LOOKUPS: DirectionLookups = { mangadex: mangadexOriginalLanguages, anilist: fetchAniListCountries };
let lookups: DirectionLookups = REAL_LOOKUPS;
/** Exposed for tests. Pass nothing to put the real services back. */
export function setDirectionLookups(l?: DirectionLookups): void { lookups = l ?? REAL_LOOKUPS; }

/** MangaDex's ids are UUIDs; nothing else is put into its query string. */
const MANGADEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DirectionsResult {
  /** Series a service was asked about and answered for. */
  asked: number;
  /** Of those, the ones whose stored direction changed. */
  learned: number;
}

type Log = { info: (m: string) => void; warn: (m: string) => void };

/**
 * Ask the services about series that have no direction yet, at most `max` per signal.
 *
 * MangaDex first, for every series that follows it and knows no better than AniList; then AniList for every
 * linked series that still knows nothing -- after the first pass, so a series MangaDex has just answered for is
 * not asked again. `ORDER BY random()` rather than a stamp: a series neither service can place (an English
 * original, an unlinked title) is asked again on another night, which costs a share of one batch request, and
 * a library larger than `max` is still covered over a few nights rather than the same `max` forever.
 *
 * A failed request ends that signal for the night and is logged; nothing stored changes because of it.
 * MangaDex switched off by the admin is not asked at all.
 */
export async function detectDirections(opts: { max: number; log?: Log }): Promise<DirectionsResult> {
  const out: DirectionsResult = { asked: 0, learned: 0 };
  const max = Math.max(1, Math.floor(opts.max));

  if (!(await isDisabled('mangadex').catch(() => false))) {
    // The primary source first, then a followed one: either is "the followed source's metadata".
    const rows = await q<{ id: string; md: string }>(
      `SELECT s.id,
              COALESCE(CASE WHEN s.source_id = 'mangadex' THEN s.source_series_id END,
                       (SELECT ss.source_series_id FROM series_sources ss
                         WHERE ss.series_id = s.id AND ss.source_id = 'mangadex' LIMIT 1)) AS md
         FROM lib_series s
        WHERE ${visibleToAll('s')}
          AND (s.reading_direction_from IS NULL OR s.reading_direction_from = 'anilist')
          AND (s.source_id = 'mangadex'
               OR EXISTS (SELECT 1 FROM series_sources ss WHERE ss.series_id = s.id AND ss.source_id = 'mangadex'))
        ORDER BY random()
        LIMIT $1`,
      [max],
    );
    const byMd = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.md || !MANGADEX_ID.test(r.md)) continue;
      byMd.set(r.md.toLowerCase(), [...(byMd.get(r.md.toLowerCase()) ?? []), r.id]);
    }
    if (byMd.size) {
      try {
        const langs = await lookups.mangadex([...byMd.keys()]);
        for (const [md, lang] of langs) {
          for (const id of byMd.get(md.toLowerCase()) ?? []) {
            out.asked++;
            if (await learnDirection({ id }, directionFromLanguage(lang), 'source')) out.learned++;
          }
        }
      } catch (e) {
        opts.log?.warn(`repair: MangaDex did not answer for reading directions: ${(e as Error)?.message || e}`);
      }
    }
  }

  // Most links were made automatically, from the same title search the art comes from (series_trackers
  // linked_by NULL), and that search answers with its best guess whatever it was asked -- so such a link speaks
  // only when the entry is visibly this series (directionFromAniListMatch). A link a person made or confirmed
  // (an admin's pick, a tracker-list import) is taken as it stands.
  type Linked = { id: string; media: string; title: string; otitle: string | null; human: boolean };
  const linked = await q<Linked>(
    `SELECT s.id, t.external_id AS media, s.title,
            (SELECT o.title FROM series_overrides o WHERE o.series_id = s.id) AS otitle,
            t.linked_by IS NOT NULL AS human
       FROM lib_series s
       JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
      WHERE ${visibleToAll('s')} AND s.reading_direction_from IS NULL AND t.external_id ~ '^[0-9]{1,10}$'
      ORDER BY random()
      LIMIT $1`,
    [max],
  );
  const byMedia = new Map<number, Linked[]>();
  for (const r of linked) byMedia.set(Number(r.media), [...(byMedia.get(Number(r.media)) ?? []), r]);
  if (byMedia.size) {
    try {
      const answers = await lookups.anilist([...byMedia.keys()]);
      for (const [media, a] of answers) {
        for (const r of byMedia.get(media) ?? []) {
          out.asked++;
          const dir = r.human ? directionFromCountry(a.country) : directionFromAniListMatch([r.title, r.otitle], a);
          if (await learnDirection({ id: r.id }, dir, 'anilist')) out.learned++;
        }
      }
    } catch (e) {
      opts.log?.warn(`repair: AniList did not answer for reading directions: ${(e as Error)?.message || e}`);
    }
  }

  if (out.learned) opts.log?.info(`repair: reading direction learned for ${out.learned} series`);
  return out;
}
