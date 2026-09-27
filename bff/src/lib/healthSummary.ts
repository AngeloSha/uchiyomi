import { createHash } from 'node:crypto';
import { q, one } from './db';
import { runHealthChecks, type HealthReport, type HealthStatus } from './health';
import { runtime } from './runtime';

/**
 * The Health report, boiled down to what the header needs (#101, @Squeaks72's proposal).
 *
 * Admin -> Health is only ever read by somebody who already decided to go and look, and everything it finds is
 * the kind of thing that goes unnoticed for exactly that reason: a source blocked for a week, chapters failing
 * their retries, folders the library scan cannot index. So an admin's header says so. But the report is ten
 * checks, one of which reads what every series holds -- the right cost for a page someone opened, the wrong
 * one for every app load on every device -- so the header reads THIS: stored whenever the Health page runs,
 * and every six hours by the server (server.ts), never computed on its behalf.
 */
export interface HealthSummary {
  /** When the report behind this was made. */
  at: string;
  worst: HealthStatus;
  /** How many checks found something. */
  count: number;
  /** The worst check's own sentence, e.g. "Chapter failures: 3 chapters across 2 sources keep failing". */
  headline: string | null;
  /**
   * Which checks found something, and how badly: the banner comes back when THIS changes, not when a count
   * inside a check moves -- "4 chapters" instead of "3" is the same problem, still dismissed. Empty when clean.
   */
  key: string;
  checks: Array<{ id: string; title: string; status: HealthStatus; summary: string }>;
}

const rank: Record<HealthStatus, number> = { problem: 0, warn: 1, ok: 2 };

export function summarise(report: HealthReport): HealthSummary {
  const found = report.checks.filter((c) => c.status !== 'ok').sort((a, b) => rank[a.status] - rank[b.status]);
  const worst: HealthStatus = found[0]?.status ?? 'ok';
  const key = found.length
    ? createHash('sha1').update(found.map((c) => `${c.id}:${c.status}`).sort().join('|')).digest('hex').slice(0, 16)
    : '';
  return {
    at: report.generatedAt,
    worst,
    count: found.length,
    headline: found[0] ? `${found[0].title}: ${found[0].summary}` : null,
    key,
    checks: found.map((c) => ({ id: c.id, title: c.title, status: c.status, summary: c.summary })),
  };
}

export async function storeHealthSummary(report: HealthReport): Promise<HealthSummary> {
  const s = summarise(report);
  await q('UPDATE server_settings SET health_summary = $1::jsonb WHERE id = 1', [JSON.stringify(s)]);
  return s;
}

export async function readHealthSummary(): Promise<HealthSummary | null> {
  const row = await one<{ health_summary: HealthSummary | null }>('SELECT health_summary FROM server_settings WHERE id = 1');
  return row?.health_summary ?? null;
}

/** Run the checks and store what they found: the server's own schedule. */
export async function refreshHealthSummary(): Promise<HealthSummary> {
  return storeHealthSummary(await runHealthChecks());
}

/** The fewest milliseconds between two refreshes someone scheduled: the report reads every series' numbers. */
export const SUMMARY_COALESCE_MS = 30_000;
let queued: ReturnType<typeof setTimeout> | null = null;
let lastRefresh = 0;

/**
 * "Something just changed what Health would say" (v0.49.0): a repair ended, a scan ran, a source was tested.
 * THE one way to ask for the stored summary to catch up, so the header's warning clears when the problem
 * does rather than up to six hours later -- the first ask runs at once, and everything asked within
 * SUMMARY_COALESCE_MS after it shares ONE refresh at the end of that window. Detached and never throws.
 *
 * ⚠️ Never while a repair holds its flag: the report would be about a library halfway through being fixed,
 * and the repair asks again itself when it ends (lib/repair.ts runRepair).
 */
export function scheduleHealthSummaryRefresh(): void {
  if (queued) return; // one is already coming, and it will see this change too
  const wait = Math.max(0, lastRefresh + SUMMARY_COALESCE_MS - Date.now());
  queued = setTimeout(() => {
    queued = null;
    if (runtime.repairing) return;
    lastRefresh = Date.now();
    refreshHealthSummary().catch((e) => console.warn(`[health] summary refresh: ${(e as Error)?.message || e}`));
  }, wait);
  queued.unref?.();
}
