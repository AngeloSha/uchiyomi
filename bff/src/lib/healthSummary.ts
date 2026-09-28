import { createHash } from 'node:crypto';
import { q, one } from './db';
import { runHealthChecks, type HealthReport, type HealthStatus } from './health';
import { runtime } from './runtime';
import type { Said } from './said';

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
  /**
   * The worst check's own sentence, e.g. "Chapter failures: 3 chapters across 2 sources keep failing": `checks[0]`'s
   * title and summary, in English. The web says it in the reader's language from `checks[0]` (its title by id, its
   * `summarySaid`).
   */
  headline: string | null;
  /**
   * Which checks found something, and how badly: the banner comes back when THIS changes, not when a count
   * inside a check moves -- "4 chapters" instead of "3" is the same problem, still dismissed. Empty when clean.
   */
  key: string;
  /** Worst first: the first is the headline's. `summarySaid` (v0.49.1) is `summary` as codes (lib/said.ts). */
  checks: Array<{ id: string; title: string; status: HealthStatus; summary: string; summarySaid?: Said[] }>;
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
    checks: found.map((c) => ({ id: c.id, title: c.title, status: c.status, summary: c.summary, ...(c.summarySaid ? { summarySaid: c.summarySaid } : {}) })),
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
let coalesceMs = SUMMARY_COALESCE_MS;
let summaryRun: () => Promise<unknown> = refreshHealthSummary;
let queued: ReturnType<typeof setTimeout> | null = null;
let lastRefresh = 0;
/** Jobs that refresh the summary themselves when they end: while one runs, nothing else does (see holdSummaryWhile). */
const holds: Array<() => boolean> = [];
const held = () => holds.some((busy) => busy());
/**
 * An ask was let go while a held job ran. Its end refresh covers every ask made BEFORE that refresh starts reading
 * -- and none made while it reads: it may already have read past the change. So the flag is cleared as the end
 * refresh starts, and an ask that sets it again meanwhile gets a refresh of its own afterwards.
 */
let missed = false;
const warn = (e: unknown) => console.warn(`[health] summary refresh: ${(e as Error)?.message || e}`);

/**
 * "Something just changed what Health would say" (v0.49.0): a repair ended, a scan ran, a source was tested.
 * THE one way to ask for the stored summary to catch up, so the header's warning clears when the problem
 * does rather than up to six hours later -- the first ask runs at once, and everything asked within
 * SUMMARY_COALESCE_MS after it shares ONE refresh at the end of that window. Detached and never throws.
 *
 * Two jobs change its timing, and neither loses a change someone asked about:
 * - ⚠️ Never while a repair holds its flag: the report would be about a library halfway through being fixed. It
 *   waits and asks again every SUMMARY_COALESCE_MS until the flag is down (the repair also asks when it ends,
 *   lib/repair.ts runRepair, and that ask joins the one already waiting).
 * - Never while a job registered with holdSummaryWhile runs (the source check, #115): every source a sweep
 *   records would otherwise ask, and a forty-source sweep ran the whole report -- ten checks, one of which reads
 *   what every series holds -- dozens of times. Asks meanwhile are let go, because the job refreshes once itself
 *   at its end (refreshHealthSummaryNow), and that report sees them too.
 */
export function scheduleHealthSummaryRefresh(): void {
  if (queued) return; // one is already coming and will see this change too
  if (held()) { missed = true; return; } // the held job's end will -- or, if it has begun reading, a refresh after it
  arm(Math.max(0, lastRefresh + coalesceMs - Date.now()));
}

function arm(wait: number): void {
  queued = setTimeout(() => {
    queued = null;
    if (held()) { missed = true; return; } // a held job started meanwhile: its end refreshes
    if (runtime.repairing) return arm(coalesceMs);
    lastRefresh = Date.now();
    summaryRun().catch(warn);
  }, wait);
  queued.unref?.();
}

/**
 * A job whose end is ONE refresh (refreshHealthSummaryNow) and whose steps must not each ask for one: while
 * `busy()` answers true, scheduleHealthSummaryRefresh arms nothing and a refresh that comes due is let go.
 */
export function holdSummaryWhile(busy: () => boolean): void {
  holds.push(busy);
}

/**
 * The refresh a held job runs at its end, awaited, so that whoever reads the job's end reads the summary after
 * it: "Check all now" answers `running: false` only once the header's mark includes what the sweep found (the web
 * refetches the summary at that moment, and not again for a minute). Replaces whatever was queued. Under the
 * repair flag it is put off like any other (scheduleHealthSummaryRefresh's rule), not run beside the repair.
 * Never throws.
 */
export async function refreshHealthSummaryNow(): Promise<void> {
  if (queued) { clearTimeout(queued); queued = null; }
  missed = false;
  // Reintroduce by running beside the repair: "a sweep that ends during a repair leaves its refresh to the repair's
  // end" in sourceCheck.int.test.ts counts a refresh while the repair runs.
  if (runtime.repairing) return arm(coalesceMs);
  lastRefresh = Date.now();
  await summaryRun().catch(warn);
  // Asked while this read: this report may already have read past the change, so it gets one of its own -- armed
  // like any other, and so run once the held job has let go (integration-1 review). Reintroduce by dropping it:
  // "an ask during the sweep's own refresh is not lost" in sourceCheck.int.test.ts stores the older state.
  if (missed) {
    missed = false;
    arm(Math.max(0, lastRefresh + coalesceMs - Date.now()));
  }
}

/**
 * For tests: count the refreshes instead of running the report, on a shorter window. Pass nothing to put both
 * back. Forgets the last refresh and anything queued.
 */
export function setSummaryRefresh(run?: () => Promise<unknown>, timing?: { everyMs?: number }): void {
  summaryRun = run ?? refreshHealthSummary;
  coalesceMs = run ? timing?.everyMs ?? SUMMARY_COALESCE_MS : SUMMARY_COALESCE_MS;
  lastRefresh = 0;
  missed = false;
  if (queued) { clearTimeout(queued); queued = null; }
}
