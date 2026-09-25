/**
 * The server's own downloading, as cards: the nightly sweep, the library repair and a bulk "Fetch newest".
 *
 * #82 (Wolf92s): "I can't find what's currently being downloaded." The download pill (web
 * components/DownloadsIndicator.tsx) only ever knew the jobs a person started from a button -- routes/sources.ts
 * keeps those, one card per series folder. Everything the server does by itself went through `updateSeries`
 * and was invisible: a sweep fetching forty chapters at three in the morning looked exactly like a quiet
 * night until the Updates shelf filled up, and there was no way to stop one that was hammering a source.
 *
 * So each of the three runs registers ONE card while it goes -- one per run, not one per series: a sweep
 * visits two hundred series, and two hundred cards is a log, not a view -- with how far it has got, what it
 * has saved, what it is on right now, and a cancel flag the run checks between chapters. Admins only (the
 * route decides): these are the server's housekeeping, and the series a sweep is on may be in a library the
 * viewer cannot see.
 *
 * In memory, like the per-series jobs: a restart ends every run anyway, and the Tasks panel keeps the
 * persisted result of the last one.
 */

export type RunKind = 'sweep' | 'repair' | 'newest';

export interface RunCard {
  kind: RunKind;
  /** The account that started it, or null for the schedule. */
  by: string | null;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'cancelled' | 'error';
  /** Series looked at so far, of `total`; for the repair, steps. 0 of 0 until the run has sized itself. */
  done: number;
  total: number;
  /** Chapters it saved, and chapters that would not save. */
  fetched: number;
  failed: number;
  /** The series it is inside right now. */
  current?: { id: string; title: string };
  /** The repair's current step (lib/repair.ts REPAIR_STEPS). */
  step?: string;
  /** Someone asked it to stop: it does, after the chapter in flight. */
  cancelRequested?: boolean;
  reason?: string;
}

const runs = new Map<RunKind, RunCard>();

/** How long a finished run stays listed. The same day as the per-series cards (routes/sources.ts DONE_TTL). */
export const RUN_TTL = 24 * 3600_000;

/** A new card for a run that is starting, replacing whatever the last run of that kind left. */
export function beginRun(kind: RunKind, by: string | null, total = 0): RunCard {
  const card: RunCard = { kind, by, startedAt: Date.now(), status: 'running', done: 0, total, fetched: 0, failed: 0 };
  runs.set(kind, card);
  return card;
}

/**
 * Close a run's card. A card whose cancel was asked for ends `cancelled` whatever the caller says, unless the
 * run failed outright: "Cancelled" is the true account of a run that stopped because someone said so.
 */
export function endRun(card: RunCard, status: 'done' | 'error', reason?: string): void {
  card.status = status === 'error' ? 'error' : card.cancelRequested ? 'cancelled' : 'done';
  card.finishedAt = Date.now();
  card.current = undefined;
  card.step = undefined;
  if (reason) card.reason = reason;
}

/** Whether the run of this kind was asked to stop. What the loops check, between chapters and between series. */
export function stopRequested(card: RunCard | null | undefined): boolean {
  return !!card?.cancelRequested;
}

/** Ask the running run of this kind to stop. False when none is running. */
export function requestStop(kind: RunKind): boolean {
  const c = runs.get(kind);
  if (!c || c.status !== 'running') return false;
  c.cancelRequested = true;
  return true;
}

/** Drop a finished card. False when there is none, or it is still running (that one is cancelled, not dismissed). */
export function dismissRun(kind: RunKind): 'ok' | 'running' | 'not_found' {
  const c = runs.get(kind);
  if (!c) return 'not_found';
  if (c.status === 'running') return 'running';
  runs.delete(kind);
  return 'ok';
}

/** Every card still worth showing: the running ones, and finished ones from the last day. Oldest first. */
export function listRuns(now = Date.now()): RunCard[] {
  for (const [k, c] of runs) if (c.status !== 'running' && c.finishedAt && now - c.finishedAt > RUN_TTL) runs.delete(k);
  return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt).map((c) => ({ ...c }));
}

/** For tests: forget every card. */
export function clearRuns(): void { runs.clear(); }
