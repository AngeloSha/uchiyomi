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

/** Is this source currently in a cooldown (recently blocked/rate-limited)? Used to warn before adding. */
export async function blockedNow(sourceId: string): Promise<SourceHealth | null> {
  const h = await one<SourceHealth>(
    'SELECT * FROM source_health WHERE source_id = $1 AND blocked_until IS NOT NULL AND blocked_until > now()',
    [sourceId],
  );
  return h;
}

export const healthAll = () =>
  q<SourceHealth>('SELECT source_id, status, consecutive, last_error, last_fail_at, last_ok_at, blocked_until, disabled, updated_at FROM source_health');

export const isDisabled = async (sourceId: string) =>
  !!(await one<{ disabled: boolean }>('SELECT disabled FROM source_health WHERE source_id = $1', [sourceId]))?.disabled;

export const setDisabled = (sourceId: string, disabled: boolean) =>
  q(`INSERT INTO source_health (source_id, disabled, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (source_id) DO UPDATE SET disabled = $2, updated_at = now()`, [sourceId, disabled]);

export const clearBlock = (sourceId: string) =>
  q(`UPDATE source_health SET status = 'ok', consecutive = 0, blocked_until = NULL, updated_at = now() WHERE source_id = $1`, [sourceId]);
