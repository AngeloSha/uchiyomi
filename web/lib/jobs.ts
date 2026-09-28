/**
 * What the Downloads view, the nav ring and Discover's strip make of `GET /api/sources/jobs` (#82, v0.49.0).
 *
 * Wolf92s asked where to see what is downloading. The pill only knew the jobs a person started from a
 * button; everything the server does by itself -- the chapter sweep, the library repair, a bulk "Fetch
 * newest" -- was invisible, and none of it could be stopped. The server now lists those as run cards
 * (bff lib/downloadJobs.ts), keeps a finished job for a day instead of five minutes, and takes a Cancel. These
 * are the rules for showing that, apart from the components, so a test can hold them. Since v0.49.0 the pill
 * is gone and Library -> Downloads shows it all (lib/serverDownloads.ts `downloadSections`).
 */
import { keys, t as tr } from './i18n';

export interface JobCard {
  folder: string;
  title: string;
  total: number;
  done: number;
  status: string;
  reason?: string;
  startedAt?: number;
  finishedAt?: number;
  /** This account started it: it may cancel it (an admin is offered every Cancel). */
  mine?: boolean;
  cancelRequested?: boolean;
  cancelled?: boolean;
}

export type RunKind = 'sweep' | 'repair' | 'newest';

/**
 * The repair's steps, in the order a run takes them (bff lib/repair.ts REPAIR_STEPS), each in the words a
 * person reads while it runs. ONE list: the Downloads view's Server tasks card and Health's live strip both
 * name the step through `repairStepLabel`, so the same step never reads two ways on two screens.
 */
export const REPAIR_STEP_LABELS = keys(
  'Checking the solver', 'Counting pages', 'Retrying failed chapters', 'Looking for longer copies',
  'Filling gaps', 'Upgrading to preferred groups', 'Tidying chapter names', 'Learning reading directions',
);
export const REPAIR_STEP_KEYS = ['solver', 'count', 'failures', 'short', 'gaps', 'groups', 'names', 'directions'] as const;

/** The step a repair is on, in words; nothing for a step this build does not know (a newer server's). */
export function repairStepLabel(step: string | undefined): string {
  const i = (REPAIR_STEP_KEYS as readonly string[]).indexOf(step ?? '');
  return i < 0 ? '' : tr(REPAIR_STEP_LABELS[i]);
}

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
  /**
   * `false` on a run that cannot download a chapter: a one-row Health fix that only resets the solver, counts
   * pages, tidies names or learns directions. It is still a Server task, but it does not turn the Library
   * ring -- every Health key starts a repair run, and a ring that turns for a solver reset says the server is
   * fetching when it is not. Absent means it may download (every run before v0.49.0's repair instrumentation).
   */
  downloads?: boolean;
  /**
   * v0.49.0, the repair (bff lib/downloadJobs.ts): which run it is -- `full`, or a Health press (`fix_short`,
   * `fill`, `retry`, `steps:…`) -- and what a one-row press is about: `label` (the series title or the source's
   * name), `number` (the chapter's) and `seriesId` (the series `label` names). The Server tasks card is named from
   * them, "Longer-copy search · Walk Tale · Ch. 3" (lib/serverDownloads.ts runName). The server leaves `label`,
   * `number` and `seriesId` out for a viewer who may not list that series (the 18+ hide), as it does `current`.
   */
  repairKind?: string;
  label?: string;
  number?: number;
  seriesId?: string;
}

/**
 * How long a finished job stays on Discover's strip: the five minutes the server used to keep it for. The
 * server keeps it a day now, for Library -> Downloads, and a day of green "Fetched" cards between the hero
 * and the wall is a log nobody asked Discover to be. A failed one stays until dismissed, as before.
 */
export const STRIP_DONE_MS = 5 * 60_000;

export function forStrip<J extends JobCard>(jobs: readonly J[], now = Date.now()): J[] {
  return jobs.filter((j) => j.status !== 'done' || !j.finishedAt || now - j.finishedAt <= STRIP_DONE_MS);
}

/** Jobs that ended well or were cancelled, newest first. Failed ones go to Needs attention. */
export function finished<J extends JobCard>(jobs: readonly J[]): J[] {
  return jobs.filter((j) => j.status === 'done' && j.total > 0).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
}

/** Whether this viewer is offered a job's Cancel: their own job, or anybody's for an admin, while it runs. */
export function mayCancel(j: JobCard, admin: boolean): boolean {
  return j.status === 'downloading' && !j.cancelRequested && (admin || !!j.mine);
}

/** A run's name on its Server tasks card. */
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

/** "Fetching 1 chapter" or "Fetching {n} chapters": the ring's label, the series band's, and the add dialog's line. */
export const fetchingLabel = (n: number): string => (n === 1 ? tr('Fetching 1 chapter') : tr('Fetching {n} chapters', { n }));

/**
 * The toast every Fetch starts with. It read "Fetching 1 chapters…" for the ☁ on a single ghost chapter,
 * which is the commonest fetch there is.
 */
export const fetchingToast = (n: number): string => (n === 1 ? tr('Fetching 1 chapter…') : tr('Fetching {n} chapters…', { n }));

/** What goes between a sentence and the next: nothing after a CJK full stop, which ends a sentence by itself. */
export const sentenceGap = (a: string): string => (/[。！？]$/.test(a) ? '' : ' ');

/** Two sentences in one line (see sentenceGap). */
export const joinSentences = (a: string, b: string): string => a + sentenceGap(a) + b;

/**
 * What the Library ring says (its title and screen-reader name), in the order a person cares: their downloads,
 * then the chapters the server is fetching by itself (a followed source's check, the scheduled check --
 * `serverChapters`, lib/serverDownloads.ts), then the server's runs, then failures. The pill's label until
 * v0.49.0, word for word.
 */
export function downloadsLabel(active: number, chaptersLeft: number, runs: readonly RunCard[], failed: number, serverChapters = 0): string | null {
  if (active) return fetchingLabel(chaptersLeft);
  if (serverChapters) return fetchingLabel(serverChapters);
  const run = runs.find((r) => r.status === 'running');
  if (run) return runTitle(run.kind);
  if (failed) return tr('{n} failed', { n: failed });
  return null;
}
