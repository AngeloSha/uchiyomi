/**
 * What the download pill and Discover's strip make of `GET /api/sources/jobs` (#82).
 *
 * Wolf92s asked where to see what is downloading. The pill only knew the jobs a person started from a
 * button; everything the server does by itself -- the chapter sweep, the library repair, a bulk "Fetch
 * newest" -- was invisible, and none of it could be stopped. The server now lists those as run cards
 * (bff lib/downloadJobs.ts), keeps a finished job for a day instead of five minutes, and takes a Cancel. These
 * are the rules for showing that, apart from the components, so a test can hold them.
 */
import { t as tr } from './i18n';

export interface JobCard {
  folder: string;
  title: string;
  total: number;
  done: number;
  status: string;
  reason?: string;
  startedAt?: number;
  finishedAt?: number;
  /** This account started it: it may cancel it (an admin's pill offers every Cancel). */
  mine?: boolean;
  cancelRequested?: boolean;
  cancelled?: boolean;
}

export type RunKind = 'sweep' | 'repair' | 'newest';

export interface RunCard {
  kind: RunKind;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'cancelled' | 'error';
  done: number;
  total: number;
  fetched: number;
  failed: number;
  current?: { id: string; title: string };
  step?: string;
  cancelRequested?: boolean;
  reason?: string;
  mine?: boolean;
}

/**
 * How long a finished job stays on Discover's strip: the five minutes the server used to keep it for. The
 * server keeps it a day now, for the pill's Finished list, and a day of green "Fetched" cards between the
 * hero and the wall is a log nobody asked Discover to be. A failed one stays until dismissed, as before.
 */
export const STRIP_DONE_MS = 5 * 60_000;

export function forStrip<J extends JobCard>(jobs: readonly J[], now = Date.now()): J[] {
  return jobs.filter((j) => j.status !== 'done' || !j.finishedAt || now - j.finishedAt <= STRIP_DONE_MS);
}

/** The pill's Finished list: jobs that ended well or were cancelled, newest first. Failed ones have their own list. */
export function finished<J extends JobCard>(jobs: readonly J[]): J[] {
  return jobs.filter((j) => j.status === 'done' && j.total > 0).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
}

/** Whether this viewer's pill offers a job's Cancel: their own job, or anybody's for an admin, while it runs. */
export function mayCancel(j: JobCard, admin: boolean): boolean {
  return j.status === 'downloading' && !j.cancelRequested && (admin || !!j.mine);
}

/** A run's name on its card and on the pill. */
export function runTitle(kind: RunKind): string {
  return kind === 'sweep' ? tr('Checking for new chapters')
    : kind === 'repair' ? tr('Library repair')
    : tr('Fetch newest');
}

/**
 * The line under a run's name: how far it has got and what it has saved. The repair counts steps, the other
 * two count series; "0 of 0" is a run that has not sized itself yet and says nothing rather than that.
 */
export function runProgress(r: RunCard): string {
  const bits: string[] = [];
  if (r.total > 0) {
    bits.push(r.kind === 'repair'
      ? tr('step {done} of {total}', { done: Math.min(r.total, r.done + (r.status === 'running' ? 1 : 0)), total: r.total })
      : tr('{done} of {total} series', { done: r.done, total: r.total }));
  }
  if (r.fetched) bits.push(tr('{n} chapters saved', { n: r.fetched }));
  if (r.failed) bits.push(tr('{n} could not be saved', { n: r.failed }));
  return bits.join(' · ');
}

/**
 * The pill's own label, in the order a person cares: their downloads, then the chapters the server is fetching
 * by itself (a followed source's check, the scheduled check -- `serverChapters`, lib/serverDownloads.ts), then
 * the server's runs, then failures.
 */
export function pillLabel(active: number, chaptersLeft: number, runs: readonly RunCard[], failed: number, serverChapters = 0): string | null {
  const fetching = (n: number) => (n === 1 ? tr('Fetching 1 chapter') : tr('Fetching {n} chapters', { n }));
  if (active) return fetching(chaptersLeft);
  if (serverChapters) return fetching(serverChapters);
  const run = runs.find((r) => r.status === 'running');
  if (run) return runTitle(run.kind);
  if (failed) return tr('{n} failed', { n: failed });
  return null;
}
