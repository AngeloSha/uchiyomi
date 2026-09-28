// Where each active slow archive (#117) draws its line, for the two readers outside the archive that must know it:
// Health's chapter-gaps check and the nightly repair's gap step. A gap wholly below an active boundary is the
// archive's work in progress -- it is fetching exactly those numbers, a few an hour -- not a finding, and not a
// hole for the repair to search other sites about or fetch at full speed.
//
// ⚠️ A module of its own, importing nothing but the database. lib/archive.ts imports the source watchdog, which
// registers itself with lib/healthSummary.ts at load, and healthSummary imports lib/health.ts: were health.ts to
// import archive.ts, loading healthSummary first would run the watchdog's registration before healthSummary had
// defined what it registers with.
import { q } from './db';

/**
 * The boundary of every active archive, by series id: queued and paused ones (a paused archive still owns the
 * numbers below its line -- the sweep floors at it, lib/updater.ts), never a finished one, which has lifted its.
 * A row whose boundary is not placed yet (no listing read, or a renumber pending) owns nothing yet. Empty on a
 * read that fails: a gap then reads as a gap, which is what it was before the archive existed.
 */
export async function activeArchiveBoundaries(seriesIds?: readonly string[]): Promise<Map<string, number>> {
  // `boundary` as the real it is stored as, the way the sweep's floor reads it (lib/updater.ts ARCHIVE_BOUNDARY): a
  // float8 cast turns 10.001 into 10.00100040435791, and the two readers must agree on which numbers are below it.
  const rows = await q<{ series_id: string; boundary: number }>(
    `SELECT series_id, boundary FROM archive_queue
      WHERE state IN ('queued', 'paused') AND boundary IS NOT NULL
        AND ($1::text[] IS NULL OR series_id = ANY($1::text[]))`,
    [seriesIds ? [...seriesIds] : null],
  ).catch(() => []);
  return new Map(rows.map((r) => [r.series_id, Number(r.boundary)]));
}

/** Every one of these (gap) numbers lies below the archive's boundary: the whole hole is the archive's to fill. */
export const allBelow = (numbers: readonly number[], boundary: number | undefined): boolean =>
  boundary !== undefined && numbers.length > 0 && numbers.every((n) => n < boundary);
