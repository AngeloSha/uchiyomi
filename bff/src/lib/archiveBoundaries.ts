// What each active slow archive (#117) is going to fetch, for the two readers outside the archive that must know it:
// Health's chapter-gaps check and the nightly repair's gap step. A hole the archive is fetching, a few an hour, is its
// work in progress -- not a finding, and not a hole for the repair to search other sites about or fetch at full speed.
//
// ⚠️ A module of its own, importing nothing but the database. lib/archive.ts imports the source watchdog, which
// registers itself with lib/healthSummary.ts at load, and healthSummary imports lib/health.ts: were health.ts to
// import archive.ts, loading healthSummary first would run the watchdog's registration before healthSummary had
// defined what it registers with.
import { q } from './db';

/** One active archive, as the two readers see it. */
export interface ArchiveHoles {
  /**
   * Nothing is fetching these right now: the row is paused, or the admin paused every archive. The sweep still
   * floors at the boundary meanwhile (lib/updater.ts), so the holes wait for a resume or for Fill now.
   */
  paused: boolean;
  /** The whole numbers it will fetch (see archiveHoles). */
  numbers: ReadonlySet<number>;
}

/**
 * What each active archive will fetch of what is missing, by series id: the numbers LISTED below its boundary that it
 * may take -- available (not held for a group, not blocked) and under the sweep's retry cap, the archive's own rule
 * (lib/archive.ts eligibleSql) and the series page's (lib/seriesListing.ts whyOf) -- floored to the whole numbers a gap
 * is counted in (lib/fill.ts gapsOf). A missing number the source does not list, or one the archive gave up on, is
 * not its work whatever the boundary: it never fetches those, and read as its work they were never searched for
 * until the archive finished, weeks on (integration-2 review). Queued and paused rows, never a finished one, which
 * has lifted its boundary; a row whose boundary is not placed yet (no listing read, or a renumber pending) owns
 * nothing yet.
 * Empty on a read that fails: a gap then reads as a gap, which is what it was before the archive existed.
 * `retryCap` is the sweep's CHAPTER_RETRY_CAP, passed in because lib/updater.ts is not a module this one may import.
 */
export async function archiveHoles(seriesIds: readonly string[] | undefined, retryCap: number): Promise<Map<string, ArchiveHoles>> {
  // `l.number < a.boundary` in the listing's own type, as the archive compares them: both are real, and a float8 cast
  // turns 10.001 into 10.00100040435791.
  const rows = await q<{ series_id: string; paused: boolean; numbers: number[] | null }>(
    `SELECT a.series_id,
            (a.state = 'paused' OR COALESCE((SELECT st.archive_paused FROM server_settings st WHERE st.id = 1), false)) AS paused,
            array_agg(DISTINCT floor(l.number)::float8) FILTER (WHERE l.number IS NOT NULL) AS numbers
       FROM archive_queue a
       LEFT JOIN series_listing l ON l.series_id = a.series_id AND l.status = 'available' AND l.number < a.boundary
            AND COALESCE((SELECT f.attempts FROM chapter_failures f WHERE f.series_id = l.series_id AND f.number = l.number), 0) < $2
      WHERE a.state IN ('queued', 'paused') AND a.boundary IS NOT NULL
        AND ($1::text[] IS NULL OR a.series_id = ANY($1::text[]))
      GROUP BY a.series_id, a.state`,
    [seriesIds ? [...seriesIds] : null, retryCap],
  ).catch(() => []);
  return new Map(rows.map((r) => [r.series_id, { paused: r.paused === true, numbers: new Set((r.numbers ?? []).map(Number)) }]));
}

/** How many of the whole numbers lo..hi the archive will fetch: all of them is `hi - lo + 1`. */
export function archiveTakes(a: ArchiveHoles | undefined, lo: number, hi: number): number {
  if (!a) return 0;
  let n = 0;
  for (const x of a.numbers) if (x >= lo && x <= hi) n++;
  return n;
}
