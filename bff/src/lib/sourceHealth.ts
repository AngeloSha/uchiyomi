// Per-source health: detect when a provider blocks us (Cloudflare 403, rate-limit 429, downtime) and track
// a cooldown so the UI can warn + the updater can back off. Failures elsewhere are silently swallowed, so we
// report here from the one place that matters most — the chapter downloader.
import { q, one } from './db';

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
}

/** Classify an error message / HTTP status into a health signal (or null if it's not a source-health issue). */
export function classify(err: unknown, httpStatus?: number): SourceStatus | null {
  const m = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (httpStatus === 429 || /\b429\b|rate.?limit|too many requests|slow down/.test(m)) return 'rate_limited';
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

export const clearBlock = (sourceId: string) =>
  q(`UPDATE source_health SET status = 'ok', consecutive = 0, blocked_until = NULL, updated_at = now() WHERE source_id = $1`, [sourceId]);
