// Admin -> Settings "Finish downloads on their own" (server_settings.finish_downloads, ON by default).
//
// The owner, adding series from Discover: they "are getting rate limited and being blocked and not continuing
// automatically and even not trying to continue from other sources automatically -- I expect to come back and see it
// downloaded in any way possible". Measured live (2026-10-17): 20 series with 748 chapters their source lists and the
// server lacks, the newest adds among them -- one added on 10-09 holding 8 of 121 -- while the only thing that ever went
// back for them was the scheduled sweep: five chapters per series every six hours, a sweep that never waits for a site's
// cooldown to end, and a three-tries cap that counted a site's "slow down" as one of the three.
//
// With the switch on:
//   - a series its source lists chapters for that it does not have yet and the sweep would still fetch ("behind",
//     lib_series.finish_missing > 0, or a row no sweep has checked yet) is gone back to every FINISH_MINUTES by a sweep
//     of the behind series alone, and again right after the earliest cooldown of their sources ends (server.ts),
//     FINISH_PER_SERIES chapters a visit;
//   - a refusal (`rate_limited`, `blocked` in chapter_failures) is a later, not a never: it is capped at
//     REFUSAL_RETRY_CAP tries, not CHAPTER_RETRY_CAP, so a site that is busy for a day is waited out, the cooldowns
//     (lib/sourceHealth.ts) spacing the tries, while the second refusal of a number still sends the sweep to other
//     sources for it (lib/chapterFallback.ts, its `persistent` set) -- a broken chapter is capped at three as before;
//   - an add from Discover whose first chapter a site refused keeps the series (routes/sources.ts), behind and never
//     checked, so the next of these sweeps picks it up.
// Off, every one of these behaves as it did in v0.77.x.
import { one } from './db';

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.min(max, Math.floor(v)) : fallback;
};

/** Minutes between the sweeps of the behind series. */
export const FINISH_MINUTES = envInt('FINISH_DOWNLOADS_MINUTES', 15, 5, 24 * 60);
/** Chapters one of those sweeps fetches for a series per visit (the scheduled sweep takes 5). */
export const FINISH_PER_SERIES = envInt('FINISH_DOWNLOADS_PER_SERIES', 10, 1, 200);
/** Download attempts one of those sweeps makes in all, landed and failed (UPDATER_SWEEP_MAX is the full sweep's). */
export const FINISH_SWEEP_MAX = envInt('FINISH_DOWNLOADS_SWEEP_MAX', 60, 1, 2000);
/** Tries a refused chapter gets before the sweep leaves it alone, with the switch on (a broken one gets three). */
export const REFUSAL_RETRY_CAP = envInt('FINISH_DOWNLOADS_REFUSAL_CAP', 12, 1, 1000);

/** Whether the switch is on. A read that fails is off: the old behaviour, never a surprise. */
export async function finishDownloadsOn(): Promise<boolean> {
  const r = await one<{ on: boolean }>('SELECT finish_downloads AS "on" FROM server_settings WHERE id = 1').catch(() => null);
  return r?.on === true;
}

/** A ledger status that is a site saying "not now" -- a rate limit or a block -- rather than a chapter that broke. */
export const isRefusal = (status: string | null | undefined): boolean => status === 'rate_limited' || status === 'blocked';

/**
 * How many tries a chapter's ledger row allows before the unattended sweep leaves it alone: REFUSAL_RETRY_CAP for a
 * refusal while the switch is on, `base` (CHAPTER_RETRY_CAP) for everything else. One rule for the sweep, the series
 * page's "failed" and the repair's gap counts, so the three agree on which chapters are still being tried.
 */
export const retryCapFor = (status: string | null | undefined, finish: boolean, base: number): number =>
  finish && isRefusal(status) ? Math.max(base, REFUSAL_RETRY_CAP) : base;

/**
 * The SQL predicate for "this monitored series is behind": chapters its sources list that the sweep would still fetch
 * (`finish_missing`, the sweep's own stamp beside source_missing, which a row stamped before it existed stands in for),
 * or a row no sweep has checked yet.
 */
export const BEHIND_SQL = '(s.source_checked_at IS NULL OR COALESCE(s.finish_missing, s.source_missing) > 0)';

/**
 * When the earliest cooldown of a source a behind series is asked through ends, or null when none of them is cooling.
 * The finishing sweep is armed for then, so a series waiting on a site's "slow down" is gone back to the minute the
 * site said, not a quarter of an hour, let alone six hours, later.
 */
export async function nextCooldownEnd(): Promise<Date | null> {
  const r = await one<{ at: Date | null }>(
    `SELECT min(h.blocked_until) AS at
       FROM source_health h
      WHERE h.blocked_until > now() AND NOT h.disabled
        AND h.source_id IN (SELECT s.source_id FROM lib_series s
                             WHERE s.auto_update AND s.deleted_at IS NULL AND s.merged_into IS NULL AND ${BEHIND_SQL}
                            UNION
                            SELECT ss.source_id FROM series_sources ss JOIN lib_series s ON s.id = ss.series_id
                             WHERE s.auto_update AND s.deleted_at IS NULL AND s.merged_into IS NULL AND ${BEHIND_SQL})`,
  ).catch(() => null);
  return r?.at ? new Date(r.at) : null;
}

/** How many monitored series are behind: none, and the finishing sweep does not start (no run card, no queries). */
export async function behindCount(): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM lib_series s WHERE s.auto_update AND s.deleted_at IS NULL AND s.merged_into IS NULL AND ${BEHIND_SQL}`,
  ).catch(() => null);
  return r?.n ?? 0;
}
