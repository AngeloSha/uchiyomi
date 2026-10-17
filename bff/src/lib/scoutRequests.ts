// Asking the scout to look for a series on other sources (v0.80.0, lib/sourceScout.ts).
//
// Every place a series gets stuck says so here: the sweep's visit when every source it follows is cooling or did not
// answer, or refused its chapters; the sweep when a series never got a source to go on; an add, a Fetch or a job whose
// sources refused; a chapter left at its retry cap. One cheap upsert, no network and nothing else read: the worker
// decides what, if anything, is searched, and when (its backoff lives on the same row). Imports only the database, so
// the updater and the routes can call it without pulling the scout in.
import { q } from './db';

/** Why a series was put forward, most pressing first: the worker takes a higher `priority` first. */
export type ScoutReason =
  /** A person's add, Fetch or download every source refused or could not serve now. */
  | 'refused'
  /** Every source it follows was cooling, did not answer, or refused it, with chapters still to come. */
  | 'stuck'
  /** Chapters left at their retry cap: no source it follows could serve them. */
  | 'capped'
  /** The worker's own pick, with nothing else waiting. */
  | 'idle';

export const SCOUT_PRIORITY: Readonly<Record<ScoutReason, number>> = { refused: 3, stuck: 2, capped: 1, idle: 0 };

/**
 * Put a series forward for the scout. A series already waiting keeps its place in the backoff (`next_at` is never
 * moved here: a series the scout just looked at is not looked at again because the sweep said "stuck" once more); its
 * reason becomes the newest, its priority the higher, and its numbers and seeds are merged. Best effort: a sweep or a
 * route must never fail over its scout request.
 */
export async function requestScout(
  seriesId: string,
  reason: ScoutReason,
  opts: {
    numbers?: readonly number[];
    seeds?: readonly string[];
    /** Only when the series is behind (lib/finishDownloads.ts BEHIND_SQL's terms): the sweep's triggers, on every visit. */
    ifBehind?: boolean;
  } = {},
): Promise<void> {
  const numbers = [...new Set((opts.numbers ?? []).filter((n) => Number.isFinite(n)))].slice(0, 200);
  const seeds = [...new Set((opts.seeds ?? []).filter(Boolean))].slice(0, 12);
  const behind = opts.ifBehind
    ? ` AND (s.source_checked_at IS NULL OR COALESCE(s.finish_missing, s.source_missing) > 0 OR s.finish_after IS NOT NULL)`
    : '';
  await q(
    `INSERT INTO series_scout (series_id, reason, numbers, seeds, priority)
     SELECT $1, $2, $3::real[], $4::text[], $5 WHERE EXISTS (SELECT 1 FROM lib_series s WHERE s.id = $1${behind})
     ON CONFLICT (series_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       numbers = (SELECT COALESCE(array_agg(DISTINCT n ORDER BY n), '{}') FROM
                   (SELECT n FROM unnest(series_scout.numbers || EXCLUDED.numbers) AS n LIMIT 400) x),
       seeds = (SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM unnest(series_scout.seeds || EXCLUDED.seeds) AS x),
       priority = GREATEST(series_scout.priority, EXCLUDED.priority),
       asked_at = now()`,
    [seriesId, reason, numbers, seeds, SCOUT_PRIORITY[reason]],
  ).catch(() => {});
}
