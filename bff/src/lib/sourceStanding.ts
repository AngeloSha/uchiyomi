// Whether a series can be updated through a source right now, in one word (v0.54.0).
//
// Every surface that moves a series off a source asks the same question of its other sources: the Replace run
// (lib/findSources.ts), which follower may become the main source; Health (lib/health.ts), which main sources are
// off or failing and which followers still carry a series; the Sources sheet (lib/seriesSources.ts), which follower
// can be made main; the sources overview (lib/sourcesOverview.ts). Four answers written four times would drift the
// first time one learned a case, so the answer is here, once:
//   - `off`: switched off -- under Sources (source_health.disabled) or in an extension's own switches
//     (suwayomi_sources.enabled, which also unregisters it). Before `not_loaded`: an extension source switched off is
//     not loaded either, and "switched off" is the true word for it, and where it comes back on;
//   - `not_loaded`: no adapter by that id now (uninstalled, a site removed, the engine away);
//   - `failing`: a confirmed, current failure (lib/sourceEvidence.ts) at a step an update needs -- the chapter list,
//     the page list or the images -- or the site's own offline notice at any step. A search that fails stops
//     nothing a sweep does: the series is read by its own id, never searched for;
//   - `cooling`: inside a cooldown (blocked_until ahead), or asked to slow down (HTTP 429) at a step an update needs,
//     confirmed and current, its cooldown over or cleared (v0.55.1). Minutes, and it clears itself: a rate limit is
//     never a failure (lib/sourceEvidence.ts isRateLimit);
//   - `usable`: none of those.
//
// Its imports stop at the database, the registry and the evidence rules, so health.ts can read it without the Find
// run's import cycle (lib/findScope.ts says why that matters).
import { q } from './db';
import { getSource } from './sources';
import { currentFailures, currentRateLimits, type Stages } from './sourceEvidence';

export type Standing = 'usable' | 'cooling' | 'failing' | 'off' | 'not_loaded';

/** What a standing is read from: a source_health row, its `disabled` widened to the extension's own switch. */
export interface StandingRow {
  source_id: string;
  disabled: boolean;
  blocked_until: string | Date | null;
  stages: Stages | null;
}

/** The steps a series' update goes through. A failure at one of these is a failure the series feels. */
const UPDATE_STAGES: ReadonlySet<string> = new Set(['chapters', 'pages', 'images']);

/**
 * A source's standing from its row (absent: a source nothing has ever gone wrong with, nor been switched off).
 * Reintroduce a search-only failure as `failing` (drop the stage test): "a search failure stops nothing an update
 * needs" in sourceStanding.test.ts reads failing.
 * A rate limit is `cooling` whether or not its cooldown is still running (v0.55.1): a Test that passed clears the
 * cooldown and proves nothing about the images, and the evidence stays open until a download succeeds. Reintroduce by
 * dropping the rate-limit line: "images failing with 429 are a cooldown" in sourceStanding.test.ts reads usable.
 */
export function standingOf(id: string, row: StandingRow | null | undefined, now = Date.now()): Standing {
  if (row?.disabled) return 'off';
  if (!getSource(id)) return 'not_loaded';
  // currentFailures leaves rate limits out: a site that asked for room is not failing (lib/sourceEvidence.ts).
  if (currentFailures(row?.stages, now).some((f) => UPDATE_STAGES.has(f.stage) || f.kind === 'site_offline')) return 'failing';
  if (row?.blocked_until && new Date(row.blocked_until).getTime() > now) return 'cooling';
  if (currentRateLimits(row?.stages, now).some((f) => UPDATE_STAGES.has(f.stage))) return 'cooling';
  return 'usable';
}

/** A series can still be updated through it: the standings Replace may promote, and Health counts as carrying a series. */
export const carries = (s: Standing): boolean => s === 'usable' || s === 'cooling';

/**
 * SQL: source `id` (an expression naming a source id) is switched off in an extension's own switches, or by its
 * language being hidden in every extension -- either way suwayomi_sources.enabled is false.
 */
export const EXTENSION_OFF = (id: string): string =>
  `EXISTS (SELECT 1 FROM suwayomi_sources ss WHERE 'sw:' || ss.source_id = ${id} AND NOT ss.enabled)`;

/**
 * SQL: where an extension source was switched off -- 'language' (its language hidden in every extension) or
 * 'extension' (the source itself) -- or NULL when it is not switched off there. Health's `offBy` and the overview's
 * read it, so where a source "comes back on" is said one way.
 */
export const EXTENSION_OFF_BY = (id: string): string =>
  `(SELECT CASE WHEN st.hidden_langs ? ss.lang THEN 'language' ELSE 'extension' END
      FROM suwayomi_sources ss LEFT JOIN server_settings st ON st.id = 1
     WHERE 'sw:' || ss.source_id = ${id} AND NOT ss.enabled LIMIT 1)`;

/** The rows standingOf reads, for each of these ids: one for every id, whether or not it has a health row. */
export async function standingRows(ids: readonly string[]): Promise<Map<string, StandingRow>> {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await q<StandingRow>(
    `SELECT i.id AS source_id, (COALESCE(sh.disabled, false) OR ${EXTENSION_OFF('i.id')}) AS disabled,
            sh.blocked_until, sh.stages
       FROM unnest($1::text[]) AS i(id) LEFT JOIN source_health sh ON sh.source_id = i.id`,
    [list],
  );
  return new Map(rows.map((r) => [r.source_id, r]));
}

/** Each id's standing, read in one query. */
export async function standingsOf(ids: readonly string[], now = Date.now()): Promise<Map<string, Standing>> {
  const rows = await standingRows(ids);
  return new Map([...new Set(ids.filter(Boolean))].map((id) => [id, standingOf(id, rows.get(id), now)]));
}

/**
 * Which of these sources an admin switched off (source_health.disabled): what the sweep, Check and the listing
 * refresh never ask. One read for a whole series, or a whole sweep. A read that fails names none -- as isDisabled's
 * callers always took it: a sweep must not stop over its ledger.
 */
export async function switchedOff(ids: readonly string[]): Promise<Set<string>> {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Set();
  const rows = await q<{ source_id: string }>(
    'SELECT source_id FROM source_health WHERE disabled AND source_id = ANY($1::text[])', [list],
  ).catch(() => [] as { source_id: string }[]);
  return new Set(rows.map((r) => r.source_id));
}
