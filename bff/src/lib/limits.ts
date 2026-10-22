/**
 * The numeric knobs an operator can only set through environment variables, with the value
 * this server is actually running on. Read-only, shown under Settings -> Downloads so "why is it this slow"
 * has an answer without opening the compose file.
 *
 * Numbers only, by construction: every field is picked by name from `env` and coerced to a finite number,
 * so a secret (JWT_SECRET, VAPID_PRIVATE_KEY, a password) cannot be added by accident -- there is no
 * spread of the env object here, and a test pins that.
 */
import { env } from '../env';
import { SOLVER_CONCURRENCY } from './sources/flaresolverr';

export interface Limit { key: string; value: number; unit: 'count' | 'ms' | 'bytes' | 'files' }

const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export function limitsReport(e: { SUWAYOMI_PAGE_CONCURRENCY: number; SOURCE_LATEST_TIMEOUT_MS: number; SOURCE_TEST_TIMEOUT_MS: number; BACKUP_KEEP: number; CACHE_MAX_BYTES: number },
  scanEnv: string | undefined = process.env.SCAN_CONCURRENCY, solver: number = SOLVER_CONCURRENCY): { limits: Limit[]; note: string } {
  return {
    limits: [
      { key: 'SUWAYOMI_PAGE_CONCURRENCY', value: num(e.SUWAYOMI_PAGE_CONCURRENCY, 4), unit: 'count' },
      { key: 'SOURCE_LATEST_TIMEOUT_MS', value: num(e.SOURCE_LATEST_TIMEOUT_MS, 8000), unit: 'ms' },
      { key: 'SOURCE_TEST_TIMEOUT_MS', value: num(e.SOURCE_TEST_TIMEOUT_MS, 45000), unit: 'ms' },
      { key: 'SCAN_CONCURRENCY', value: Math.max(1, num(scanEnv || solver, solver)), unit: 'count' },
      { key: 'BACKUP_KEEP', value: num(e.BACKUP_KEEP, 14), unit: 'files' },
      { key: 'CACHE_MAX_BYTES', value: num(e.CACHE_MAX_BYTES, 0), unit: 'bytes' },
    ],
    note: 'Set by environment variables; change them in the container settings and restart. Read-only here.',
  };
}

export const currentLimits = () => limitsReport(env);
