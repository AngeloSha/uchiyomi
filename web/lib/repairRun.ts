/**
 * Which repair run is about which Health row, and when a run has ended (v0.49.0).
 *
 * The owner's complaint was that a Health fix never said whether it was working. Two facts caused it: every
 * chip re-checked Health the moment its POST answered, which is when the repair had only just begun, and no
 * row could tell which run was its own. The server now names each run (the POST answers its id) and says what
 * the running one is on (GET /api/admin/tasks/repair/status). This file is the React-free half of reading
 * that: the body each action sends, whether a run touches a row, and which runs have ended between two polls
 * -- so a test can hold each rule without a browser.
 */
import type { HealthAction, HealthCheck, HealthItem, RepairStep } from './types';

// ---- the server's shapes (bff routes/admin.ts, lib/repair.ts, lib/repairRuns.ts) ----------------------

export type RepairPhase =
  | 'pinging' | 'clearing' | 'counting' | 'rechecking' | 'listing' | 'asking' | 'searching' | 'downloading'
  | 'following' | 'fetching';

export interface RepairCurrent {
  kind: 'series' | 'chapter' | 'source' | 'solver' | 'files';
  seriesId?: string;
  bookId?: string;
  /** Dropped by the server for a series this viewer may not list (the 18+ hide). */
  title?: string;
  number?: number;
  sourceId?: string;
  phase: RepairPhase;
  done?: number;
  of?: number;
}

export type RepairSkipWhy =
  | 'folder_busy' | 'not_eligible' | 'no_gaps' | 'source_cooling_down' | 'source_off' | 'solver_down' | 'no_searches_left';

export interface RepairSkip {
  step: RepairStep;
  target?: { seriesId?: string; bookId?: string; sourceId?: string; title?: string; number?: number };
  why: RepairSkipWhy;
  until?: string;
  detail?: string;
}

/** What a run was pointed at; `label` is a series title or a source's name. */
export interface RunTarget {
  seriesId?: string;
  bookId?: string;
  sourceId?: string;
  now?: boolean;
  number?: number;
  label?: string;
}

export type RunStatus = 'running' | 'done' | 'stopped' | 'failed' | 'skipped' | 'interrupted';

/** The running run, as the status route snapshots it. */
export interface RepairLiveRun {
  id: string;
  startedAt: number;
  origin: 'nightly' | 'manual';
  /** This viewer started it. */
  mine: boolean;
  kind: string;
  only: RepairStep[] | null;
  target: RunTarget;
  steps: RepairStep[];
  step: RepairStep | null;
  /** 0-based; -1 before the first step. */
  stepIndex: number;
  stepStartedAt: number | null;
  planned: Partial<Record<RepairStep, number>>;
  current: RepairCurrent | null;
  budget: { left: number; of: number } | null;
  skips: RepairSkip[];
  cancelRequested: boolean;
}

export interface RepairEstimate { typicalMs: number | null; runs: number; worstMs: number | null; downloads: number }

export interface RepairStatus {
  running: boolean;
  sweepRunning: boolean;
  enabled: boolean;
  nextAt: number | null;
  run: RepairLiveRun | null;
  last: { id: string; finishedAt: number; status: RunStatus; kind: string } | null;
  recent: Array<{ id: string; finishedAt: number | null; status: RunStatus; kind: string; target: RunTarget }>;
  lastFull: { id: string; at: number; ms: number | null; origin: 'nightly' | 'manual' } | null;
  limits: Record<string, number>;
  estimates: Record<string, RepairEstimate>;
}

export interface RepairRunRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  origin: 'nightly' | 'manual';
  username: string | null;
  mine: boolean;
  kind: string;
  only: RepairStep[] | null;
  target: RunTarget;
  status: RunStatus;
  ms: number | null;
  result: any;
}

// ---- what each action sends ------------------------------------------------------------------------

export interface RepairBody { only: RepairStep[]; seriesId?: string; bookId?: string; sourceId?: string; now?: boolean }

/** The Health actions that start a repair run rather than answering at once. */
export const REPAIR_ACTIONS: readonly HealthAction[] = ['fix_short', 'fill', 'retry', 'solver_reset'];
export const isRepairAction = (a: HealthAction): boolean => REPAIR_ACTIONS.includes(a);

/** One row's repair: its one step, narrowed to its one chapter, series or source. */
export function itemBody(action: HealthAction, item: HealthItem): RepairBody | null {
  switch (action) {
    case 'fix_short': return item.bookId ? { only: ['short'], bookId: item.bookId } : null;
    case 'fill': return item.seriesId ? { only: ['gaps'], seriesId: item.seriesId } : null;
    case 'retry': return item.sourceId ? { only: ['failures'], sourceId: item.sourceId } : null;
    // The solver step acts on every source that blames the solver whatever row was pressed, so the reset is
    // one card-level action (cardBody), never a per-row one.
    default: return null;
  }
}

/**
 * Which repair step a whole check's Fix all runs.
 *
 * ⚠️ Deliberately no entry for `duplicates` or `outliers`. The nightly never merges, deletes, tombstones or
 * renumbers anything, and a "Fix all" that quietly did would be the one button in this console capable of
 * destroying a household's library in a tap.
 */
export const CARD_STEP: Readonly<Record<string, RepairStep>> = {
  'short-chapters': 'short',
  'chapter-gaps': 'gaps',
  'chapter-failures': 'failures',
  solver: 'solver',
};

/**
 * The action each step's findings carry. A card's Fix all, and a step of Fix all issues, appears only when
 * some finding offers it: the solver check offers its reset only while the solver answers (the step does
 * nothing otherwise), and a short chapter somebody saved with placeholder pages offers no Fix.
 */
export const STEP_ACTION: Readonly<Record<string, HealthAction>> = { short: 'fix_short', gaps: 'fill', failures: 'retry', solver: 'solver_reset' };

/** The steps Fix all issues can run, in the order the repair runs them (REPAIR_STEPS in bff lib/repair.ts). */
export const PAGE_STEPS: readonly RepairStep[] = ['solver', 'failures', 'short', 'gaps'];

/**
 * A card's Fix all. The failures card sends `now`: without it the step only resets rows a week old and
 * re-checks nothing, which is far less than "try every failed chapter again" promises.
 */
export function cardBody(step: RepairStep): RepairBody {
  return step === 'failures' ? { only: [step], now: true } : { only: [step] };
}

/** Findings of a check that carry a step's own action: what a Fix all has to work on. */
export function stepFindings(check: HealthCheck | undefined, step: RepairStep): HealthItem[] {
  if (!check) return [];
  const want = STEP_ACTION[step];
  return check.items.filter((it) => !it.info && (it.actions ?? []).includes(want));
}

/**
 * The solver check while the solver does not answer: not ok, and no finding offers the reset (bff lib/health.ts
 * puts `solver_reset` only on the rows of a solver that answers its ping: resetting one that does not changes
 * nothing). The card then offers no reset and says what to do instead (healthCopy.ts solverDownLine), and a card
 * with no items stays expandable for it.
 */
export function solverDown(check: HealthCheck): boolean {
  return solverQuiet(check) !== null;
}

/**
 * Which solver the card says is not answering, while it offers no reset (solverDown): `all` of them -- the one there is,
 * or both -- or, with a backup (v0.55.3, FLARESOLVERR_FALLBACK_URL), only the `main` (the backup is solving: the card
 * opens on "solver.backupSolving") or only the `backup` (the card's summary says "solver.backupQuiet" after a ready
 * main). Null while the card is fine or offers its reset. Reintroduce one answer for every case: "the main down, the
 * backup solving" in repairRun.test.ts reads that the solver is not answering.
 */
export function solverQuiet(check: HealthCheck): 'all' | 'main' | 'backup' | null {
  if (check.id !== 'solver' || check.status === 'ok' || check.items.some((it) => (it.actions ?? []).includes('solver_reset'))) return null;
  const said = (check.summarySaid ?? []).map((p) => p.code);
  if (said[0] === 'solver.backupSolving') return 'main';
  if (said[0] !== 'solver.down' && said.includes('solver.backupQuiet')) return 'backup';
  return 'all';
}

/** Fix all issues' plan: every page step some finding offers, with how many findings offer it. */
export function pagePlan(checks: readonly HealthCheck[]): Array<{ step: RepairStep; n: number }> {
  return PAGE_STEPS.flatMap((step) => {
    const c = checks.find((x) => CARD_STEP[x.id] === step);
    const n = stepFindings(c, step).length;
    return n ? [{ step, n }] : [];
  });
}

export function pageBody(plan: ReadonlyArray<{ step: RepairStep }>): RepairBody {
  const only = plan.map((p) => p.step);
  return only.includes('failures') ? { only, now: true } : { only };
}

/**
 * The run's kind as the server names it (bff lib/repairRuns.ts `kindOf`), which is what its estimate and its
 * "usually" are filed under. The same plan pressed twice is one kind whatever order its steps were listed in.
 */
export function kindOfBody(b: RepairBody): string {
  const only = [...new Set(b.only)];
  if (!only.length) return 'full';
  if (only.length === 1) {
    if (only[0] === 'short' && b.bookId) return 'fix_short';
    if (only[0] === 'gaps' && b.seriesId) return 'fill';
    if (only[0] === 'failures' && b.sourceId) return 'retry';
  }
  return `steps:${only.sort().join('+')}${b.now ? ':now' : ''}`;
}

// ---- which run is about which row -----------------------------------------------------------------

/** Does this target name this row? A chapter by its book, a gap by its series, a source by its id. */
function targetsItem(t: RunTarget | undefined, checkId: string, item: HealthItem): boolean {
  if (!t) return false;
  if (checkId === 'short-chapters') return !!t.bookId && t.bookId === item.bookId;
  if (checkId === 'chapter-gaps') return !!t.seriesId && !t.bookId && t.seriesId === item.seriesId;
  if (checkId === 'chapter-failures') return !!t.sourceId && t.sourceId === item.sourceId;
  return false;
}

/**
 * Whether the running run is about this row: `target` when it was started FOR the row (a Fix, a Fill now, a
 * Retry now), `current` when a wider run (a card's Fix all, Fix all issues, the nightly) is on it right now.
 */
export function runTouches(run: RepairLiveRun | null | undefined, checkId: string, item: HealthItem): 'target' | 'current' | null {
  if (!run) return null;
  if (targetsItem(run.target, checkId, item)) return 'target';
  const cur = run.current;
  if (!cur || !run.step || CARD_STEP[checkId] !== run.step) return null;
  if (checkId === 'short-chapters') return cur.bookId && cur.bookId === item.bookId ? 'current' : null;
  if (checkId === 'chapter-gaps') return cur.seriesId && cur.seriesId === item.seriesId ? 'current' : null;
  if (checkId === 'chapter-failures') return cur.sourceId && cur.sourceId === item.sourceId ? 'current' : null;
  return null;
}

/**
 * Where a run is with a card's step: `running` (and how far), `queued` (a later step of this run), `done`
 * (an earlier one), or null when the run does not take that step at all.
 */
export function cardStepState(run: RepairLiveRun | null | undefined, checkId: string):
  { state: 'running' | 'queued' | 'done'; planned?: number; done?: number } | null {
  const step = CARD_STEP[checkId];
  if (!run || !step) return null;
  const i = run.steps.indexOf(step);
  if (i < 0) return null;
  if (run.step === step) return { state: 'running', planned: run.planned[step], done: run.current?.done };
  return i > run.stepIndex ? { state: 'queued' } : { state: 'done' };
}

/**
 * The runs that ended between two polls of the status route.
 *
 * Two ways a run is seen to end:
 * - it was running at the last poll and is not now;
 * - it is one THIS page started (`awaiting`, the ids its POSTs answered) and it is not the running run. A
 *   one-row fix can take five milliseconds and finish before the first poll ever sees it running, and it
 *   must still end in a re-check. ⚠️ The server sets the live run before the POST answers, so an awaited id
 *   that is not running has finished; there is no window in which it has not yet started.
 */
export function endedRunIds(prev: RepairStatus | null | undefined, next: RepairStatus, awaiting: Iterable<string>): string[] {
  const out = new Set<string>();
  const now = next.run?.id ?? null;
  if (prev?.run && prev.run.id !== now) out.add(prev.run.id);
  for (const id of awaiting) if (id && id !== now) out.add(id);
  return [...out];
}

/**
 * Why a repair-backed action cannot start now, or null. A chapter sweep and the repair never overlap, by
 * design, and one repair runs at a time: pressed anyway, the server refuses, which used to be the only way
 * to find out.
 */
export function blockedReason(status: RepairStatus | null | undefined): 'sweep_running' | 'repair_running' | null {
  if (!status) return null;
  if (status.running) return 'repair_running';
  if (status.sweepRunning) return 'sweep_running';
  return null;
}

/** The newest finished run that was started FOR this row, from the history. */
export function recordFor(runs: readonly RepairRunRecord[] | undefined, checkId: string, item: HealthItem): RepairRunRecord | null {
  for (const r of runs ?? []) {
    if (r.status === 'running' || !r.finishedAt) continue;
    if (targetsItem(r.target, checkId, item)) return r;
  }
  return null;
}

/** The newest finished run of exactly one card's Fix all (its one step, no target). */
export function cardRecord(runs: readonly RepairRunRecord[] | undefined, step: RepairStep): RepairRunRecord | null {
  const kind = kindOfBody(cardBody(step));
  return (runs ?? []).find((r) => r.status !== 'running' && !!r.finishedAt && r.kind === kind) ?? null;
}

/** The newest finished Fix all issues run: several of the page's steps, no target. */
export function pageRecord(runs: readonly RepairRunRecord[] | undefined): RepairRunRecord | null {
  return (runs ?? []).find((r) => r.status !== 'running' && !!r.finishedAt && /^steps:[a-z]+\+/.test(r.kind)
    && !r.target?.seriesId && !r.target?.bookId && !r.target?.sourceId) ?? null;
}
