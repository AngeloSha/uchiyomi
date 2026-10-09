// Per-source health: detect when a provider blocks us (Cloudflare 403, rate-limit 429, downtime) and track
// a cooldown so the UI can warn + the updater can back off. Failures elsewhere are silently swallowed, so we
// report here from the one place that matters most — the chapter downloader.
import { q, one } from './db';
import { visibleToAll } from './visibility';
import { RATE_LIMIT_WORDS, type EvidenceBy, type FailKind, type Stage, type Stages } from './sourceEvidence';
import { isSiteOffline } from './sources/offline';

export type SourceStatus = 'ok' | 'rate_limited' | 'blocked' | 'down';

export interface SourceHealth {
  source_id: string;
  status: SourceStatus;
  consecutive: number;
  last_error: string | null;
  last_fail_at: string | null;
  last_ok_at: string | null;
  blocked_until: string | null;
  disabled: boolean;
  /** Consecutive empty `latest()` pages. Evidence for the diagnosis layer; nothing else reads it. */
  empty_streak: number;
  last_empty_at: string | null;
  /** When the watchdog last checked this source deliberately, and what it concluded. */
  checked_at: string | null;
  check_code: string | null;
  /** Times our own budget ran out on this source. Never feeds the blocked/down backoff. */
  slow_streak: number;
  last_slow_at: string | null;
  updated_at: string;
  // ---- v0.49.0 (#115): evidence, written only by noteStage and recordLive below. Present on rows read by
  // healthAllWithEvidence() and the per-source reads that name them; absent from healthAll(). ----
  live_at?: string | null;
  live_by?: 'test' | 'sweep' | null;
  live_state?: 'pass' | 'fail' | 'inconclusive' | null;
  live_code?: string | null;
  live_stage?: Stage | null;
  live_detail?: string | null;
  live_checks?: unknown[] | null;
  stages?: Stages;
}

/** Classify an error message / HTTP status into a health signal (or null if it's not a source-health issue). */
export function classify(err: unknown, httpStatus?: number): SourceStatus | null {
  const m = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (httpStatus === 429 || RATE_LIMIT_WORDS.test(m)) return 'rate_limited';
  if (httpStatus === 403 || /\b403\b|just a moment|cloudflare|challenge|cf-chl|forbidden|access denied|blocked/.test(m)) return 'blocked';
  if (httpStatus === 503 || httpStatus === 502 || httpStatus === 504 || /timeout|timed out|econn|enotfound|fetch failed|network|\b50[234]\b/.test(m)) return 'down';
  return null;
}

export async function reportOk(sourceId: string): Promise<void> {
  await q(
    `INSERT INTO source_health (source_id, status, consecutive, last_ok_at, blocked_until, updated_at)
     VALUES ($1, 'ok', 0, now(), NULL, now())
     ON CONFLICT (source_id) DO UPDATE SET status = 'ok', consecutive = 0, last_ok_at = now(), blocked_until = NULL, updated_at = now()`,
    [sourceId],
  ).catch(() => {});
}

export async function reportFail(sourceId: string, status: SourceStatus, error: string): Promise<void> {
  const base = status === 'rate_limited' ? 15 : status === 'blocked' ? 30 : 5; // minutes of base cooldown
  await q(
    `INSERT INTO source_health (source_id, status, consecutive, last_error, last_fail_at, blocked_until, updated_at)
     VALUES ($1, $2, 1, $3, now(), now() + make_interval(mins => $4), now())
     ON CONFLICT (source_id) DO UPDATE SET
       status = $2,
       consecutive = source_health.consecutive + 1,
       last_error = $3,
       last_fail_at = now(),
       blocked_until = now() + make_interval(mins => LEAST(source_health.consecutive + 1, 6) * $4),
       updated_at = now()`,
    [sourceId, status, error.slice(0, 300), base],
  ).catch(() => {});
}

/**
 * What a `latest()` answer says about a source's health. The whole rule lives here because it has three
 * edges and every one of them has bitten something.
 *
 * 1. **Only page 1 is evidence.** Discover scrolls this endpoint to page 5. An empty page 3 is a healthy
 *    source running out of pagination, so counting it would turn infinite scroll into a machine for
 *    condemning the sources people use most.
 * 2. **A non-empty page reports OK, exactly as before.** The invariant documented in routes/sources.ts is
 *    preserved literally: `reportOk` still fires only when something came back.
 * 3. **An empty page records emptiness and NOTHING else.** Not `status`, not `consecutive`, not
 *    `blocked_until`. Several adapters answer a failed Cloudflare challenge with `[]` rather than throwing,
 *    so calling `reportOk` here would clear a cooldown the downloader legitimately recorded; calling
 *    `reportFail` would hand a merely quiet source a thirty-minute ban and inflate the backoff multiplier.
 *    Both were tried in the design and both are wrong. The streak is evidence, never a verdict.
 *
 * Note `reportOk` deliberately does not clear the streak -- only this function does, and only via the
 * latest path. `reportOk` is also called by the chapter downloader, and "downloads fine, but its listing
 * no longer parses" is a real state worth being able to see.
 */
export async function reportLatest(sourceId: string, count: number, page: number): Promise<void> {
  if (page > 1) return;
  if (count > 0) {
    await reportOk(sourceId);
    await q(
      `UPDATE source_health SET empty_streak = 0, slow_streak = 0
        WHERE source_id = $1 AND (empty_streak <> 0 OR slow_streak <> 0)`,
      [sourceId],
    ).catch(() => {});
    return;
  }
  await q(
    `INSERT INTO source_health (source_id, empty_streak, last_empty_at, updated_at)
     VALUES ($1, 1, now(), now())
     ON CONFLICT (source_id) DO UPDATE SET
       empty_streak = source_health.empty_streak + 1,
       last_empty_at = now(),
       updated_at = now()`,
    [sourceId],
  ).catch(() => {});
}

/** After this many consecutive over-budget answers, stop paying the full budget on every single load. */
export const SLOW_PATIENCE = 3;

/**
 * WE ran out of patience. The site did not refuse us.
 *
 * This is a different fact from `reportFail` and had been recorded as the same one, which is how a working
 * source became invisible. Aqua Manga answers in about 11.5 seconds through the Cloudflare solver; the wall
 * allowed 8. Every load timed out, `classify` read "timeout" as `down`, and `reportFail` handed it an
 * escalating five-to-thirty-minute cooldown -- during which `/api/sources/latest` short-circuits and never
 * asks again. A source was thereby punished for being slower than our own budget, and the punishment
 * removed every chance it had to prove otherwise. 190 series went missing while every diagnostic reported
 * the source healthy.
 *
 * So this writes NEITHER `status` NOR `consecutive`: it cannot escalate, and it cannot make a slow source
 * look like a blocked one. It only counts, and only once the count shows a pattern does it ask for a short,
 * FIXED breather -- enough that browsing does not spend the whole budget on the same source over and over,
 * never enough to hide it for half an hour.
 */
export async function reportSlow(sourceId: string, ms: number): Promise<void> {
  await q(
    `INSERT INTO source_health (source_id, slow_streak, last_slow_at, last_error, updated_at)
     VALUES ($1, 1, now(), $2, now())
     ON CONFLICT (source_id) DO UPDATE SET
       slow_streak   = source_health.slow_streak + 1,
       last_slow_at  = now(),
       last_error    = $2,
       -- Fixed, never multiplied, and only once it is clearly a pattern rather than one slow afternoon.
       blocked_until = CASE WHEN source_health.slow_streak + 1 >= ${SLOW_PATIENCE}
                            THEN now() + interval '5 minutes' ELSE source_health.blocked_until END,
       updated_at    = now()`,
    [sourceId, `timeout after ${ms}ms`],
  ).catch(() => {});
}

/**
 * A search answered inside our budget ends a slow streak, as a listing page that arrives in time does (reportLatest):
 * SLOW_PATIENCE counts over-budget answers IN A ROW. A Discover search counted its timeouts here and never ended a
 * streak, so one evening's burst of searches through a busy solver left mangaread, Manhuaus, Manhuaplus and Natomanga
 * "slow" on Health for six days of fast searches, downloads and passing daily checks (v0.55.10). Status, cooldown and
 * the failure counter are reportOk's and untouched here.
 */
export async function reportTimely(sourceId: string): Promise<void> {
  await q('UPDATE source_health SET slow_streak = 0 WHERE source_id = $1 AND slow_streak <> 0', [sourceId]).catch(() => {});
}

/** How long a slow streak speaks for its source with nothing added to it: a day of browsing. */
export const SLOW_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * The slow streak as evidence now: the stored count while its newest over-budget answer is under SLOW_FRESH_MS old, else
 * 0. "It keeps taking longer than 15 s" is about browsing today, and a streak nobody has added to in a day says nothing
 * about the next search. Health, a Test's verdict and Discover's source list read it through here; the stored count is
 * left as it is, so a source slow again tomorrow carries on from it. Reintroduce by reading `slow_streak` as stored:
 * "a slow streak nobody has added to in a day is no finding" in health.int.test.ts finds the row.
 */
export function slowStreakNow(
  row: { slow_streak?: number | null; last_slow_at?: string | Date | null } | null | undefined, now = Date.now(),
): number {
  const n = row?.slow_streak ?? 0;
  if (n <= 0) return 0;
  // reportSlow stamps every count; a streak with no stamp has an unknown age, and unknown is not stale.
  if (!row?.last_slow_at) return n;
  return now - new Date(row.last_slow_at).getTime() < SLOW_FRESH_MS ? n : 0;
}

/** Is this source currently in a cooldown (recently blocked/rate-limited)? Used to warn before adding. */
export async function blockedNow(sourceId: string): Promise<SourceHealth | null> {
  const h = await one<SourceHealth>(
    'SELECT * FROM source_health WHERE source_id = $1 AND blocked_until IS NOT NULL AND blocked_until > now()',
    [sourceId],
  );
  return h;
}

export const healthAll = () =>
  q<SourceHealth>('SELECT source_id, status, consecutive, last_error, last_fail_at, last_ok_at, blocked_until, disabled, empty_streak, last_empty_at, checked_at, check_code, slow_streak, last_slow_at, updated_at FROM source_health');

export const isDisabled = async (sourceId: string) =>
  !!(await one<{ disabled: boolean }>('SELECT disabled FROM source_health WHERE source_id = $1', [sourceId]))?.disabled;

export const setDisabled = (sourceId: string, disabled: boolean) =>
  q(`INSERT INTO source_health (source_id, disabled, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (source_id) DO UPDATE SET disabled = $2, updated_at = now()`, [sourceId, disabled]);

/**
 * Drop the health rows of sources that no longer exist, unless a series still points at them.
 *
 * Nothing else ever deletes from source_health. Uninstalling an extension removed its suwayomi_sources rows
 * and left these behind: live that had accumulated twelve orphans, three of them recording 404s from the very
 * evening their extensions were pulled. A row whose source still has series is kept on purpose -- it is the
 * only record those series ever had a home, and they are frozen, not gone (the health page says so).
 * `visibleToAll` rather than a hand-written predicate: a merged-away or deleted series must not keep a dead
 * source's row alive either.
 */
export async function pruneOrphanedHealth(sourceIds: string[]): Promise<number> {
  if (!sourceIds.length) return 0;
  const rows = await q<{ source_id: string }>(
    `DELETE FROM source_health h WHERE h.source_id = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM lib_series s WHERE s.source_id = h.source_id AND ${visibleToAll('s')})
      RETURNING h.source_id`,
    [sourceIds],
  ).catch(() => [] as { source_id: string }[]);
  return rows.length;
}

// ⚠️ clearBlock, reportOk and the repair's lapsed-block reset (repair.ts stepSolver) are ERASERS of escalation
// memory, and must never touch `stages` or `live_*`: evidence of a failure is only closed by a success at the same
// stage (lib/sourceEvidence.ts). An eraser that cleared evidence is how #115's failing source read "ok" on Health.
export const clearBlock = (sourceId: string) =>
  q(`UPDATE source_health SET status = 'ok', consecutive = 0, blocked_until = NULL, updated_at = now() WHERE source_id = $1`, [sourceId]);

// ---- v0.49.0 (#115): per-stage evidence, non-escalating --------------------------------------------------------
//
// Everything below writes `stages` and `live_*` and NOTHING else: not status, consecutive, blocked_until,
// last_error, last_*_at, checked_at or updated_at. Those drive cooldowns (updater blockedNow, autoFollow,
// sourceHunt, Discover) and the desktop watchdog's schedule (server.ts reads max(checked_at)), and a diagnostic or
// a note must change neither. sourceCheck.int.test.ts pins it.

/**
 * One stage's merge, as SQL over the stored object `o` and the patch `p` (both jsonb expressions). What a patch
 * cannot know is decided here, under the row lock, from what the row holds at the moment of the write:
 * - `since`: when the failure that is open now began -- kept while it stays open, restarted once it had closed;
 * - `streak`: failures in a row (a success's patch resets it to 0);
 * - `failBy`: a traffic failure landing on a failure a live check confirmed keeps the live check's name, so one
 *   more failed Discover search cannot turn a confirmed failure back into a streak-of-one rumour.
 * ⚠️ Keep the SQL merge: a read-modify-write in TypeScript would race recordLive against a traffic note on the
 * same row, and the single UPDATE is what serialises them.
 */
const OPEN = (o: string) =>
  `((${o}->>'failAt') IS NOT NULL AND ((${o}->>'okAt') IS NULL OR (${o}->>'failAt')::timestamptz > (${o}->>'okAt')::timestamptz))`;
const STAGE_MERGE = (o: string, p: string) => `(${o} || ${p} || CASE WHEN ${p} ? 'failAt' THEN jsonb_build_object(
    'since',  CASE WHEN ${OPEN(o)} THEN COALESCE(${o}->>'since', ${o}->>'failAt') ELSE ${p}->>'failAt' END,
    'streak', COALESCE((${o}->>'streak')::int, 0) + 1,
    'failBy', CASE WHEN ${p}->>'failBy' = 'traffic' AND ${OPEN(o)} AND (${o}->>'failBy') IN ('test', 'sweep')
                   THEN ${o}->>'failBy' ELSE ${p}->>'failBy' END)
  ELSE '{}'::jsonb END)`;
const MERGE_PATCH = (param: string) =>
  `source_health.stages || COALESCE((SELECT jsonb_object_agg(p.key, ${STAGE_MERGE("COALESCE(source_health.stages -> p.key, '{}'::jsonb)", 'p.value')})
                                       FROM jsonb_each(${param}::jsonb) p), '{}'::jsonb)`;

/**
 * A successful note is skipped when this process wrote one for the same source and stage in the last five minutes
 * and no failure since: searchAll fans one search out over every source, and a write per source per search is
 * cost for no new fact. A failure always writes (the streak needs it) and forgets the entry, so the next success,
 * the one that closes it, is never the one skipped. Per process, which is harmless: at worst a second write.
 */
const OK_NOTE_EVERY_MS = 5 * 60 * 1000;
const okNoted = new Map<string, number>();
const noteKey = (sourceId: string, stage: Stage) => `${sourceId}\u0000${stage}`;

async function mergeStages(sourceId: string, patch: Stages, live?: {
  by: 'test' | 'sweep'; state: 'pass' | 'fail' | 'inconclusive'; code: string | null; stage: Stage | null;
  detail: string | null; checks: unknown[] | null;
}, insert = true): Promise<void> {
  // The row may not exist yet (a source nothing has ever failed or been tested). Inserted bare, then merged, so
  // both writers share one UPDATE and one merge. Not for a traffic success: with no row there is no failure for it
  // to close, and a row per source per search fan-out is noise ("no health row at all" still means "nothing
  // has gone wrong here", which downloadBlame.int.test.ts relies on).
  if (insert) await q(`INSERT INTO source_health (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING`, [sourceId]);
  if (!live) {
    await q(`UPDATE source_health SET stages = ${MERGE_PATCH('$2')} WHERE source_id = $1`, [sourceId, JSON.stringify(patch)]);
    return;
  }
  await q(
    `UPDATE source_health SET live_at = now(), live_by = $3, live_state = $4, live_code = $5, live_stage = $6,
            live_detail = $7, live_checks = $8::jsonb, stages = ${MERGE_PATCH('$2')}
      WHERE source_id = $1`,
    [sourceId, JSON.stringify(patch), live.by, live.state, live.code, live.stage,
      live.detail ? live.detail.slice(0, 300) : null, live.checks ? JSON.stringify(live.checks) : null],
  );
}

/**
 * What ordinary use just saw at one stage: a search, a chapter list, a page list, a chapter's bytes.
 *
 * Lightweight and never a verdict: one traffic failure is noise until TRAFFIC_CONFIRM in a row
 * (lib/sourceEvidence.ts), and nothing here pushes, escalates or clears a cooldown -- the existing reportFail /
 * reportOk calls beside each caller stay exactly as they were. Never throws: evidence is best effort, and the
 * paths calling this are the ones readers are waiting on.
 */
export async function noteStage(
  sourceId: string, stage: Stage, outcome: 'ok' | 'fail', opts: { error?: string; kind?: FailKind; by?: EvidenceBy } = {},
): Promise<void> {
  const key = noteKey(sourceId, stage);
  if (outcome === 'ok') {
    const last = okNoted.get(key);
    if (last !== undefined && Date.now() - last < OK_NOTE_EVERY_MS) return;
    okNoted.set(key, Date.now());
  } else {
    okNoted.delete(key);
  }
  const at = new Date().toISOString();
  const by = opts.by ?? 'traffic';
  const rec = outcome === 'ok'
    ? { okAt: at, okBy: by, streak: 0 }
    // A site's own offline notice is a kind of its own (v0.49.1), read off the classified error's message: every
    // caller hands its error over as a string, and none of them need learn to tell it apart. So is a site asking us to
    // slow down (v0.55.1): a cooldown, never a failure (lib/sourceEvidence.ts isRateLimit), in classify()'s own words.
    : {
        failAt: at, failBy: by, error: String(opts.error || 'failed').slice(0, 300),
        kind: opts.kind ?? (isSiteOffline(opts.error) ? 'site_offline' : RATE_LIMIT_WORDS.test(opts.error ?? '') ? 'rate_limited' : 'error'),
      };
  await mergeStages(sourceId, { [stage]: rec }, undefined, outcome === 'fail').catch(() => {});
}

/**
 * What a deliberate live check found: the Test button (by 'test') or the daily check and "Check all now" (by
 * 'sweep'). Writes live_* and merges the run's stage patch (liveStagesPatch). The caller has already read the
 * previous live state, which it needs to decide whether a failure is new.
 */
export async function recordLive(sourceId: string, r: {
  by: 'test' | 'sweep'; state: 'pass' | 'fail' | 'inconclusive'; code: string | null; stage: Stage | null;
  detail: string | null; checks: unknown[] | null; patch: Stages;
}): Promise<void> {
  // A failure written here must not be followed by a skipped success: forget the throttle for the failed stages.
  for (const [stage, rec] of Object.entries(r.patch)) if (rec?.failAt) okNoted.delete(noteKey(sourceId, stage as Stage));
  await mergeStages(sourceId, r.patch, r).catch(() => {});
}

/**
 * healthAll() plus the evidence, for the admin surfaces only. A separate read rather than more columns on
 * healthAll(), which the public GET /api/sources, Discover's search and the fill dialog read on every call: they
 * need none of this, and the engine's raw error text in `stages` has no business near a reader's route.
 */
export const healthAllWithEvidence = () =>
  q<SourceHealth>(`SELECT source_id, status, consecutive, last_error, last_fail_at, last_ok_at, blocked_until, disabled,
                          empty_streak, last_empty_at, checked_at, check_code, slow_streak, last_slow_at, updated_at,
                          live_at, live_by, live_state, live_code, live_stage, live_detail, live_checks, stages
                     FROM source_health`);
