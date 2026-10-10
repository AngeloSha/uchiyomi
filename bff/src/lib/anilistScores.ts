// A series' outside rating, from AniList (v0.58.0).
//
// The owner: "add series rating from somewhere else as well, but also keep the one where we rate it", and sort by
// popularity in the Library and on Home. A series linked to its AniList entry (series_trackers, the link a person
// made or the online-match check confirmed -- an unchecked automatic link may be another work) gets that entry's score
// out of 100 and how many AniList users list it, kept in anilist_scores by AniList id. The owner's own stars
// (ratings) are untouched: they are another column, another sort.
//
// Refreshed in the background: a few minutes after boot, then every six hours, each round asking only for the entries
// with no row yet or a row older than three days -- a library of a few hundred series is a handful of requests, fifty
// ids each (lib/anilist.ts fetchAniListScores, paced and 429-aware). A series in a library whose AniList lookups are
// off (libraries.anilist_lookup) is never asked about.
import { q } from './db';
import { runtime } from './runtime';
import { visibleToAll } from './visibility';
import { fetchAniListScores } from './anilist';

type Log = { info: (m: string) => void; warn: (m: string) => void };

/** A row older than this is asked again: scores and popularity move slowly. */
export const SCORE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
/** The most entries one round asks about (fifty a request): a first round on a big library spreads over a few. */
const MAX_PER_ROUND = 1000;

/**
 * SQL: the checked AniList link of series `alias`.id joined to its score row -- what the sorts, the Home rail and the
 * enrichment read. `col` is the column wanted (score or popularity).
 */
export const anilistScoreOf = (alias: string, col: 'score' | 'popularity'): string =>
  `(SELECT a.${col} FROM series_trackers t JOIN anilist_scores a ON a.anilist_id = t.external_id
     WHERE t.series_id = ${alias}.id AND t.provider = 'anilist' AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL))`;

export interface ScoresOutcome { asked: number; stored: number; missing: number }

/**
 * One round: the AniList ids of visible, checked-linked series in libraries with lookups on whose row is missing or
 * stale, asked fifty at a time; each answer stored, and an id AniList did not answer stored empty (so it waits for the
 * next stale round rather than being asked every six hours). Throws when AniList fails: the next round tries again.
 */
export async function refreshAniListScores(o: { maxAgeMs?: number; max?: number } = {}): Promise<ScoresOutcome> {
  const maxAge = o.maxAgeMs ?? SCORE_MAX_AGE_MS;
  const rows = await q<{ id: string }>(
    `SELECT DISTINCT t.external_id AS id
       FROM series_trackers t
       JOIN lib_series s ON s.id = t.series_id AND ${visibleToAll('s')}
       JOIN libraries l ON l.id = s.library_id AND l.anilist_lookup
       LEFT JOIN anilist_scores a ON a.anilist_id = t.external_id
      WHERE t.provider = 'anilist' AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
        AND t.external_id ~ '^[0-9]+$'
        AND (a.anilist_id IS NULL OR a.fetched_at < now() - ($1::bigint * interval '1 millisecond'))
      ORDER BY 1
      LIMIT $2`,
    [maxAge, o.max ?? MAX_PER_ROUND],
  );
  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return { asked: 0, stored: 0, missing: 0 };
  const got = await fetchAniListScores(ids);
  let missing = 0;
  for (const id of ids) {
    const s = got.get(id);
    if (!s) missing++;
    await q(
      `INSERT INTO anilist_scores (anilist_id, score, popularity, fetched_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (anilist_id) DO UPDATE SET score = EXCLUDED.score, popularity = EXCLUDED.popularity, fetched_at = now()`,
      [String(id), s?.score ?? null, s?.popularity ?? null],
    );
  }
  return { asked: ids.length, stored: ids.length - missing, missing };
}

/** A few minutes after boot, then every six hours: one round each time (lib/matchCheck.ts's pattern). */
export function scheduleAniListScores(log: Log, delayMs = 4 * 60_000, everyMs = 6 * 60 * 60_000): void {
  const tick = async () => {
    if (!runtime.stopping) {
      try {
        const r = await refreshAniListScores();
        if (r.asked) log.info(`anilist scores: ${r.stored} of ${r.asked} entries scored${r.missing ? `, ${r.missing} not answered` : ''}`);
      } catch (e) {
        log.warn(`anilist scores: the refresh failed: ${(e as Error)?.message || e}`);
      }
    }
    setTimeout(tick, everyMs).unref?.();
  };
  setTimeout(tick, delayMs).unref?.();
}
