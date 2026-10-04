/**
 * Health's "Fix everything" (v0.55.0): one background run that drives every Health card it can to green, then says, in
 * short, what it did and what only a person can do.
 *
 * WHY IT EXISTS
 *   The owner, on Health's Fix all: "the auto pick and fix stuff will try its best to fix everything and keeping
 *   everything green without needing to manually do stuff cause i wana see everything green at the end idc what it does
 *   to do that even if it had to add an extension itself to find a chapter ... and for auto it just shows at the end what
 *   happened and what it did in short without cluttering". Fix all issues was the repair alone -- failures, short
 *   chapters, five series of gaps -- and it disappeared when only broken sources, frozen series, duplicates, numbering,
 *   odd chapter numbers and chapters saved twice were left.
 *
 * WHAT IT MAY DO (the owner's decisions, 2026-10-03)
 *   Everything the repair does, uncapped but paced; Test sources, and clear a block only after a passing Test; Replace
 *   every off or failing source some series reads through, and turn off failing sources nothing uses; link language
 *   editions; MERGE duplicate series whose AniList entry, language and titles or chapters agree; apply renumbering plans
 *   marked clean; DELETE the later copy of a chapter saved twice when the kept copy is complete, and chapters with an
 *   impossible number, with the delete route's own guards; install extensions, the popular first, as long as its time
 *   lasts (v0.55.1, the owner, 2026-10-04: no cap of three), keeping only those that carry something.
 * WHAT IT NEVER DOES
 *   ⚠️ Press Ignore: what it cannot fix is listed as Needs you, never hidden. ⚠️ Turn off a source some series reads as
 *   its main (it retires, which refuses). ⚠️ Clear a block without a passing Test, or a rate limit's at all (v0.55.1). ⚠️
 *   Replace a source that only asked for room, or move a series onto a source that cannot update it (v0.55.1). ⚠️ Apply
 *   a renumbering plan that is not clean (numbering.ts settleNumbering decides at the apply, from the listing it reads
 *   then). ⚠️ Delete outside the download folder, or a bookmarked chapter. ⚠️ Install more than AUTOFIX_INSTALLS a run
 *   when it is set, or try a package twice for one series within a month. ⚠️ Touch a container: a solver or an engine
 *   that is down is the operator's.
 *
 * HOW
 *   Ten phases, one after another (PHASES), each reusing the functions the Health page's own keys run -- never their
 *   routes. ONE run at a time, and never beside a repair, a Find or Replace, or a sweep: it refuses at start (`busy`,
 *   with which), a repair and a Find refuse beside it (runtime.autofixing), and between phases it waits out a sweep that
 *   started meanwhile. It holds the cross-job lock (runtime.repairing) while it scans, runs the repair's steps, merges,
 *   renumbers or deletes, so no sweep starts under those; its Replace and Find runs go through startFind's own machinery,
 *   which waits on that lock, so it does not hold it there. Stop is honoured at the next safe point -- between series,
 *   steps, sources or pairs, never inside a merge, a delete or a renumber -- and the run is recorded `stopped`.
 *   Its whole run is bounded by AUTOFIX_MAX_MINUTES (the network-heavy phases stop when it is spent, and what they leave
 *   "clears by itself: the next Fix everything continues") and its searches by AUTOFIX_SEARCHES.
 *   The record is a row of repair_runs, kind `autofix` -- no new table -- with the summary and the log as said codes
 *   (lib/said.ts `autofix.*`), which the web words: never English from the server.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { q, one } from './db';
import { runtime } from './runtime';
import { logAudit } from './audit';
import { say, saidOf, type Part, type Said } from './said';
import { SYSTEM_CTX, visibleToAll, type ViewCtx } from './visibility';
import { beginRun, endRun, stopRequested, type RunCard } from './downloadJobs';
import { repairState, repairForAutofix, type AutofixDrive, type RepairCurrent, type RepairResult, type RepairStep } from './repair';
import { findRunning, findRunSettled, findState, startFind, stopFind, FIND_BUSY_WAIT_MS, type FindResult } from './findSources';
import { persistScan, DL_ROOT } from './library';
import { updateSeries, runsInside } from './updater';
import { renumberRunning, folderBusy } from './numbering';
import { getSource, reloadAll, isSwAdapterId, SW_PREFIX } from './sources';
import { mangadexLangOf } from './sources/mangadexLangs';
import { solverPing, solverUrl } from './sources/flaresolverr';
import { suwayomiConfigured } from './sources/suwayomi/client';
import { extensionFacts, listExtensions, setExtensionState, sourcesOfExtension, type ExtensionInfo } from './sources/suwayomi/extensions';
import { downloadsPerDay, rankPackages } from './extensionRank';
import { seriesIsAdult } from './sourceHunt';
import { adoptExtensionSources, getHiddenLangs, setSourcesEnabled } from './sources/suwayomi/langs';
import { lastSuwayomiLoad, leftOutByLimit, retrySuwayomiNow, wouldFit } from './sources/suwayomi/register';
import { ourSolverUrl } from './sources/suwayomi/engineSolver';
import { connectEngineSolver, engineProbe } from './extensionEngine';
import { extensionEngineCheck } from './engineHealth';
import { testSource } from './sourceCheck';
import { clearBlock, pruneOrphanedHealth } from './sourceHealth';
import { retireSource } from './retireSource';
import { switchMainSource } from './mainSource';
import { carries, standingOf, standingRows, standingsOf, EXTENSION_OFF, EXTENSION_OFF_BY, type StandingRow } from './sourceStanding';
import { currentFailures } from './sourceEvidence';
import {
  runHealthChecks, sourceTrouble, frozenSeries, duplicateSeries, savedTwiceGroups, impossibleLimit, gapsAnswered, plausibleNumbers,
  type HealthCheck, type HealthItem, type HealthReport, type StoredGaps,
} from './health';
import { gapsOf, splitAtFloor } from './fill';
import { loadIgnores, noIgnores } from './healthIgnore';
import { storeHealthSummary, scheduleHealthSummaryRefresh } from './healthSummary';
import { mergeRefusal, mergeSeries, deleteChapterFiles, getSeriesRow } from './libraryAdmin';
import { linkPair } from './editions';
import { haveNumbers } from './libraryNumbers';
import { effectiveLang, seriesLanguage } from './seriesLang';
import { canonLang, sameLanguage } from './lang';
import { titleMatch } from './autoFollow';
import { altTitlesFor } from './altTitles';
import { normGroup } from './releases';
import type { RunOrigin } from './repairRuns';
import { clearRunDigest, pruneRuns } from './repairRuns';

// ── the shapes on the wire (SP/v491/V0550-API.md §1) ──────────────────────────────────────────────────────────────

export const PHASES = ['preflight', 'scan', 'solver', 'sources', 'duplicates', 'numbering', 'chapters', 'extensions', 'files', 'recheck'] as const;
export type AutofixPhase = (typeof PHASES)[number];

export type DoneKind = 'replaced' | 'retired' | 'tested' | 'unblocked' | 'linked' | 'merged' | 'renumbered' | 'fetched' | 'refetched'
  | 'shortFixed' | 'shortConfirmed' | 'failuresCleared' | 'installed' | 'uninstalled' | 'deletedTwice' | 'deletedOdd' | 'scanned'
  | 'resumedRenumber' | 'solverReset' | 'engineConnected';
export type NeedsYouAction = { kind: 'open'; href: string } | { kind: 'health'; check: string } | { kind: 'settings'; key: string };
export type AutofixStatus = 'running' | 'done' | 'stopped' | 'failed' | 'interrupted';

export interface AutofixSummary {
  /** Nothing but Needs you is left: every finding still on the page is one only a person can act on. */
  green: boolean;
  /**
   * Something a run could still change is left (v0.55.0 integration): what this one did not get to -- stopped, out of
   * time or searches, at its install budget -- which `clears` says as "the next Fix everything continues". Never for a
   * cooldown, the sweep or Needs you alone: Run again is offered on this, not on `!green`.
   */
  again: boolean;
  done: Array<{ kind: DoneKind; n: number; said: Said; items?: Said[] }>;
  clears: Array<{ said: Said; at?: string }>;
  needsYou: Array<{ check: string; said: Said; action?: NeedsYouAction }>;
}

export interface AutofixRun {
  id: string;
  status: AutofixStatus;
  startedAt: string;
  finishedAt?: string;
  /** The admin who started it, by name; null for the nightly (and for an account since deleted). */
  by: string | null;
  phase: AutofixPhase | null;
  phaseIndex: number;
  /** Asked to stop and winding down to its next safe point: every viewer's "Stopping…", not only the one who pressed. */
  stopping?: boolean;
  /** "Now: …": what it is on; with a title, `seriesIds` the series the title names (since v0.55.1, for the 18+ rule). */
  current?: { title?: string; seriesIds?: string[]; done?: number; of?: number; said?: Said };
  summary?: AutofixSummary;
  log?: Said[];
}

// ── the bounds ──────────────────────────────────────────────────────────────────────────────────────────────────

/** An integer knob, clamped; absent, unparseable or out of range is the default (repair.ts envInt, but 0 may be meant). */
function knob(name: string, def: number, lo: number, hi: number): number {
  const raw = process.env[name];
  if (raw === undefined || !raw.trim()) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : def;
}
/** The whole run's time. The network-heavy phases (sources, chapters, extensions) stop at a safe point once it is spent. */
export const AUTOFIX_MAX_MINUTES = knob('AUTOFIX_MAX_MINUTES', 90, 1, 24 * 60);
/** Searches the whole run may start: the repair's hunts for short chapters and gaps share them. */
export const AUTOFIX_SEARCHES = knob('AUTOFIX_SEARCHES', 60, 0, 1000);
/**
 * Extensions one run may install: none by default (v0.55.1) -- the phase goes on until the run's time is spent, and the
 * next run continues down the list. A number caps it; 0 switches the extensions phase off.
 */
export const AUTOFIX_INSTALLS = knob('AUTOFIX_INSTALLS', Number.POSITIVE_INFINITY, 0, 100_000);
/** Sources one run Tests, one at a time: each is up to a minute of requests to a site. */
const AUTOFIX_TESTS = 40;
/** Lines the run's log keeps (the newest), and items a done line keeps. */
const LOG_MAX = 200;
const ITEMS_MAX = 20;
/** Done kinds the summary carries at most, the ones that matter most first (DONE_ORDER). */
const DONE_MAX = 12;
/** How long a package that was searched for a series and did not carry it is not tried for that series again. */
const TRIED_DAYS = 30;

// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: unknown) => void };

/** A package this run installed: `settled` once it was kept or removed again (settle), which happens once. */
interface Installed { pkg: string; name: string; lang: string; sourceId: string; ids: string[]; settled?: boolean }

interface Run {
  id: string;
  by: string | null;
  origin: RunOrigin;
  ctx: ViewCtx;
  startedAt: number;
  deadline: number;
  phase: AutofixPhase | null;
  phaseIndex: number;
  phaseMs: Partial<Record<AutofixPhase, number>>;
  current: { title?: string; seriesIds?: string[]; done?: number; of?: number; said?: Said } | null;
  /** What the repair's step is on, while one runs: read live into `current`. */
  repairCur: RepairCurrent | null;
  stop: boolean;
  card: RunCard;
  log: Log | undefined;
  /** The searches the whole run may start (AUTOFIX_SEARCHES), shared by the repair's hunts. */
  budget: { left: number };
  /** The engine and the solver at the start: `none` when there is none configured. */
  engine: 'up' | 'down' | 'none';
  solver: 'up' | 'down' | 'none';
  /** The time budget ran out in a phase: what is left waits for the next run. */
  timeUp: boolean;
  counts: Partial<Record<DoneKind, number>>;
  items: Partial<Record<DoneKind, Said[]>>;
  /** Chapter files the scan phase counted the pages of. */
  counted: number;
  /** Source names Replace moved series off, package names kept and removed: the done lines name them. */
  replacedNames: string[];
  /**
   * The sources this run Replaces (v0.55.1): no Replace of its own makes one of them a series' main source, nor
   * searches it (lib/findSources.ts `avoid`). The owner's first run moved a series off AllManga onto Mangakakalot, the
   * source it had been replacing a moment before.
   */
  replacing: string[];
  keptPkgs: Array<{ name: string; series: number }>;
  removedPkgs: string[];
  installs: number;
  installed: Installed[];
  /** Packages installed and found to carry nothing, by language: not tried again for a while (TRIED_DAYS). */
  tried: Array<{ pkg: string; lang: string; series?: string[] }>;
  /** What Health cannot show by itself: an extension that would carry series but found the source limit full. */
  noRoom: string[];
  lines: Said[];
  /**
   * The phases that ran to their end: not stopped in or before, not cut short by the run's time, its Tests or its
   * installs (`cut`), and not thrown out of. A finding only these phases work on is Needs you once they have; before,
   * it is what the next run continues (summarise).
   */
  finished: Set<AutofixPhase>;
  cut: Set<AutofixPhase>;
  /** Renumber reviews passed over because a download or a check was inside the series: the next run's. */
  numberingBusy: number;
  /**
   * v0.55.1, read by the recheck for the summary: the sources resting at the end (cooling down or rate-limited now,
   * restingSources), with their cooldown's end when one runs, and the failed chapters each holds that a rate limit
   * caused. Both clear by themselves: never Needs you.
   */
  restingAtEnd: Map<string, string | null>;
  limitedRows: Map<string, number>;
}

let active: Run | null = null;
/** The run going now, or the last one this process started: what the nightly and the tests await. */
let lastRun: Promise<void> = Promise.resolve();
let quietMs = 5_000;
/** What the run's time is read from: the wall clock, but for a test that moves it (setAutofixTiming). */
let clock: () => number = () => Date.now();

const halted = (a: Run): boolean => a.stop || runtime.stopping || stopRequested(a.card);
/** The network-heavy phases also stop when the run's time is spent. */
const outOfTime = (a: Run): boolean => clock() > a.deadline;
/** A phase left work behind for a reason of the run's own -- its time, its Tests, its installs: it did not finish. */
const cutShort = (a: Run, phase: AutofixPhase): void => { a.cut.add(phase); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A line for the run's log, newest last, at most LOG_MAX. */
function note(a: Run, p: Part): void {
  a.lines.push(saidOf(p));
  if (a.lines.length > LOG_MAX) a.lines.splice(0, a.lines.length - LOG_MAX);
}
/** Count a kind of thing done, with the line that says this one (also the log's). */
function did(a: Run, kind: DoneKind, n: number, item?: Part): void {
  if (n > 0) a.counts[kind] = (a.counts[kind] ?? 0) + n;
  if (item) {
    note(a, item);
    const list = (a.items[kind] ??= []);
    if (list.length < ITEMS_MAX) list.push(saidOf(item));
  }
}
/**
 * "Now: …" -- what the run is on, with a title and how far, when it is on a list. A title comes with the series it names
 * (`seriesIds`), which is what an admin who hides 18+ is held to (scrubbed).
 */
function now(a: Run, p: Part | null, extra: { title?: string; seriesIds?: string[]; done?: number; of?: number } = {}): void {
  a.current = p ? { said: saidOf(p), ...extra } : null;
  a.card.current = undefined;
}

/** What else is going that the run must not start beside: the contract's `running`. */
export type AutofixBusy = 'autofix' | 'repair' | 'find' | 'sweep';
function busyWith(): AutofixBusy | null {
  if (active || runtime.autofixing) return 'autofix';
  if (repairState.running || runtime.repairing) return 'repair';
  if (findRunning()) return 'find';
  if (runtime.updating) return 'sweep';
  return null;
}

/**
 * Start a run. Answers `busy` (with what is going) beside another one, a repair, a Find or Replace, or a sweep; else the
 * new run's id, with the run going in the background. `by` is the admin who pressed it (null: the nightly); `ctx` their
 * view -- what Replace and Find act as, so 18+ sources are reachable for an admin as Find's own (#141) -- and the
 * nightly's is SYSTEM_CTX, the background view that sees everything.
 */
export function startAutofix(
  by: string | null, o: { ctx?: ViewCtx; origin?: RunOrigin; log?: Log; req?: FastifyRequest } = {},
): { runId: string } | { busy: AutofixBusy } {
  const busy = busyWith();
  if (busy) return { busy };
  const id = randomUUID();
  const startedAt = Date.now();
  // Claimed synchronously, before the first await: two presses in one turn cannot both start a run.
  runtime.autofixing = true;
  const card = beginRun('autofix', by, PHASES.length);
  card.downloads = undefined;
  const a: Run = {
    id, by, origin: o.origin ?? (by ? 'manual' : 'nightly'), ctx: o.ctx ?? SYSTEM_CTX, startedAt,
    deadline: startedAt + AUTOFIX_MAX_MINUTES * 60_000, phase: null, phaseIndex: 0, phaseMs: {}, current: null, repairCur: null,
    stop: false, card, log: o.log, budget: { left: AUTOFIX_SEARCHES }, engine: 'none', solver: 'none', timeUp: false,
    counts: {}, items: {}, counted: 0, replacedNames: [], replacing: [], keptPkgs: [], removedPkgs: [], installs: 0, installed: [], tried: [], noRoom: [], lines: [],
    finished: new Set(), cut: new Set(), numberingBusy: 0, restingAtEnd: new Map(), limitedRows: new Map(),
  };
  active = a;
  // The audit line is written when the run ends, long after the request: its IP and user agent are taken now.
  const from = o.req ? { ip: o.req.ip, headers: { 'x-forwarded-for': o.req.headers['x-forwarded-for'], 'user-agent': o.req.headers['user-agent'] } } as unknown as FastifyRequest : undefined;
  lastRun = runAll(a, from).catch((e) => console.warn(`[autofix] ${(e as Error)?.message || e}`));
  return { runId: id };
}

/** Ask the running run to stop at its next safe point; its Find or Replace run in flight stops at once. False when none runs. */
export function stopAutofix(): boolean {
  const a = active;
  if (!a) return false;
  a.stop = true;
  a.card.cancelRequested = true;
  if (findRunning()) stopFind();
  return true;
}

/** Tests and the nightly: the run going now (or the last one), ended. */
export async function autofixSettled(): Promise<void> {
  await lastRun.catch(() => {});
}

/** Tests: a shorter wait between looks at a sweep the run waits out, and a clock the run's time is read from. */
export function setAutofixTiming(t: { quietMs?: number; clock?: () => number } = {}): void {
  quietMs = t.quietMs ?? 5_000;
  clock = t.clock ?? (() => Date.now());
}

/** Wait, stop-aware, while a sweep runs: the run never works beside one. False when stopped meanwhile. */
async function waitSweep(a: Run): Promise<boolean> {
  while (runtime.updating) {
    if (halted(a)) return false;
    now(a, say('autofix.now.waitSweep'));
    await nap(quietMs);
  }
  return !halted(a);
}

/** Run `fn` holding the cross-job lock: no sweep starts under a scan, the repair's steps, a merge, a renumber or a delete. */
async function held<T>(fn: () => Promise<T>): Promise<T> {
  runtime.repairing = true;
  try { return await fn(); } finally { runtime.repairing = false; }
}

/** The drive the repair's steps run under: this run's stop and time, its searches, and its "Now: …". */
function drive(a: Run): AutofixDrive {
  return {
    halt: () => halted(a) || outOfTime(a),
    budget: a.budget,
    onCurrent: (cur: RepairCurrent | null, step: RepairStep | null) => {
      a.repairCur = cur;
      const words: Partial<Record<RepairStep, Part>> = {
        count: say('autofix.now.scanning'), failures: say('autofix.now.failures'), short: say('autofix.now.short'), gaps: say('autofix.now.gaps'),
        solver: say('autofix.now.solver'),
      };
      const p = step ? words[step] : null;
      a.current = p ? { said: saidOf(p) } : a.current;
      a.card.current = cur?.seriesId && cur.title ? { id: cur.seriesId, title: cur.title } : undefined;
    },
  };
}

async function runAll(a: Run, from?: FastifyRequest): Promise<void> {
  let status: AutofixStatus = 'done';
  await recordStart(a);
  const steps: Record<Exclude<AutofixPhase, 'recheck'>, (a: Run) => Promise<void>> = {
    preflight, scan, solver, sources, duplicates, numbering, chapters, extensions, files,
  };
  let report: HealthReport | null = null;
  try {
    for (const [i, phase] of PHASES.entries()) {
      // The recheck runs whatever happened before it -- a stopped run still says what it did and what is left -- unless
      // the server is going down.
      if (phase === 'recheck' ? runtime.stopping : halted(a)) continue;
      if (phase === 'recheck' && a.timeUp) note(a, say('autofix.item.skipped', { why: 'time' }));
      if (phase === 'recheck' && a.stop) note(a, say('autofix.item.skipped', { why: 'stopped' }));
      if (phase !== 'recheck' && !(await waitSweep(a))) continue;
      a.phase = phase;
      a.phaseIndex = i;
      a.card.step = phase;
      a.card.done = i;
      now(a, null);
      const t = Date.now();
      try {
        if (phase === 'recheck') report = await recheckReport(a);
        else {
          await steps[phase](a);
          // Ran to its end: what it leaves on its cards is for a person. Stopped inside it, or cut short, it is not --
          // what it did not reach is the next run's, never Needs you (summarise).
          if (!halted(a) && !a.cut.has(phase)) a.finished.add(phase);
        }
      } catch (e) {
        // One phase failing is that phase's; the run goes on to the next, and the recheck says what is left.
        a.log?.warn(`autofix: the ${phase} phase threw: ${(e as Error)?.message || e}`);
        console.warn(`[autofix] ${phase}: ${(e as Error)?.stack || e}`);
      }
      a.phaseMs[phase] = Date.now() - t;
    }
    if (halted(a)) status = runtime.stopping ? 'interrupted' : 'stopped';
  } catch (e) {
    status = 'failed';
    console.warn(`[autofix] the run failed: ${(e as Error)?.message || e}`);
  } finally {
    const summary = report ? summarise(a, report) : null;
    a.card.done = PHASES.length;
    a.current = null;
    endRun(a.card, status === 'failed' ? 'error' : 'done', status === 'failed' ? say('run.failed') : undefined);
    await recordEnd(a, status, summary);
    await logAudit('library.autofix', {
      userId: a.by,
      detail: {
        runId: a.id, status, origin: a.origin, ms: Date.now() - a.startedAt,
        done: Object.fromEntries(Object.entries(a.counts).filter(([, n]) => n)),
        installed: a.keptPkgs.map((p) => p.name), removed: a.removedPkgs,
        green: summary?.green ?? false, needsYou: summary?.needsYou.map((n) => n.check) ?? [],
      },
      req: from,
    }).catch(() => {});
    if (active === a) active = null;
    runtime.autofixing = false;
    scheduleHealthSummaryRefresh();
  }
}

// ── the record (repair_runs, kind `autofix`) ─────────────────────────────────────────────────────────────────────

/**
 * A run starts: any autofix row still `running` belongs to a process that went away under it (one run at a time, and
 * this one is the run), and is closed as `interrupted`; then this run's row. Best effort, as the repair's history is:
 * a run with no row still runs.
 */
async function recordStart(a: Run): Promise<void> {
  await closeInterruptedAutofix(a.id).catch(() => {});
  await q(`INSERT INTO repair_runs (id, started_at, origin, kind, only_steps, target, by_user, status)
           VALUES ($1, to_timestamp($2 / 1000.0), $3, 'autofix', NULL, '{}'::jsonb,
                   (SELECT u.id FROM users u WHERE u.id::text = $4), 'running')`,
    [a.id, a.startedAt, a.origin, a.by ?? '']).catch((e) => console.warn(`[autofix] could not record the start: ${(e as Error)?.message || e}`));
}

/**
 * What a finished run keeps: its summary and its log, and the packages it searched in vain (TRIED_DAYS) -- since v0.55.1
 * with the series each was searched for (`series`); v0.55.0 kept a package by language alone.
 */
interface Stored { phaseIndex: number; summary?: AutofixSummary; log: Said[]; tried?: Array<{ pkg: string; lang: string; series?: string[] }> }

async function recordEnd(a: Run, status: AutofixStatus, summary: AutofixSummary | null): Promise<void> {
  const stored: Stored = { phaseIndex: a.phaseIndex, ...(summary ? { summary } : {}), log: a.lines, ...(a.tried.length ? { tried: a.tried } : {}) };
  await q(`UPDATE repair_runs SET finished_at = now(), status = $2, ms = $3, step_ms = $4::jsonb, result = $5::jsonb WHERE id = $1`,
    [a.id, status, Date.now() - a.startedAt, JSON.stringify(a.phaseMs), JSON.stringify(stored)],
  ).catch((e) => console.warn(`[autofix] could not record the end: ${(e as Error)?.message || e}`));
  await pruneRuns().catch(() => {});
  clearRunDigest();
}

/** Close every autofix row still `running` that is not the run going now: its process went away under it. At boot, too. */
export async function closeInterruptedAutofix(except: string | null = active?.id ?? null): Promise<void> {
  await q(`UPDATE repair_runs SET status = 'interrupted', finished_at = COALESCE(finished_at, now())
            WHERE kind = 'autofix' AND status = 'running' AND id::text IS DISTINCT FROM $1`, [except]);
}

type RunRow = {
  id: string; started_at: Date; finished_at: Date | null; status: AutofixStatus; username: string | null; result: Stored | null;
};
const fromRow = (r: RunRow): AutofixRun => ({
  id: r.id, status: r.status, startedAt: new Date(r.started_at).toISOString(),
  ...(r.finished_at ? { finishedAt: new Date(r.finished_at).toISOString() } : {}),
  by: r.username, phase: null, phaseIndex: r.result?.phaseIndex ?? 0,
  ...(r.result?.summary ? { summary: r.result.summary } : {}),
  log: r.result?.log ?? [],
});

/** The run going now, as the routes answer it: read from memory, which is ahead of its row. */
async function liveView(a: Run): Promise<AutofixRun> {
  const by = a.by ? (await one<{ username: string }>('SELECT username FROM users WHERE id::text = $1', [a.by]).catch(() => null))?.username ?? null : null;
  // The repair's step, while one runs, says which series and how far: read live, as its own status route does. Its title
  // comes with the series it names, never the phase's own (an empty list: one the 18+ rule cannot hold to a series).
  const cur = a.repairCur;
  const current = a.current
    ? {
      ...a.current,
      ...(cur?.title ? { title: cur.title, seriesIds: cur.seriesId ? [cur.seriesId] : [] } : {}),
      ...(cur?.done !== undefined ? { done: cur.done } : {}), ...(cur?.of !== undefined ? { of: cur.of } : {}),
    }
    : undefined;
  return {
    id: a.id, status: 'running', startedAt: new Date(a.startedAt).toISOString(), by, phase: a.phase, phaseIndex: a.phaseIndex,
    // Stop asked, by the route or the run card's generic cancel: said to every viewer until the run reaches its safe point.
    ...(a.stop || stopRequested(a.card) ? { stopping: true } : {}),
    ...(current ? { current } : {}), log: [...a.lines],
  };
}

/**
 * Said lines that name a series by its title, and the "Now:" title. For an admin who hides 18+, each is held to the series
 * it names (`seriesIds`, since v0.55.1): left out when that admin's reach hides one of them (visibility.ts nameableIds --
 * their libraries, age cap and the 18+ switch, whatever became of the series since), kept otherwise. v0.55.0 dropped
 * them all, adult or not. A line from before v0.55.1 carries no ids to hold its title to, and keeps that rule: left out.
 */
const TITLED = new Set(['autofix.item.linked', 'autofix.item.merged', 'autofix.item.notMerged', 'autofix.item.renumbered',
  'autofix.item.notRenumbered', 'autofix.item.deleted']);
/** The series a line or a "Now:" names: its `seriesIds`, else null -- written before v0.55.1, or naming none. */
const namedBy = (ids: unknown): string[] | null =>
  (Array.isArray(ids) && ids.length > 0 && ids.every((x) => typeof x === 'string' && x !== '') ? (ids as string[]) : null);
type Scrubbable = { current?: AutofixRun['current']; log?: Said[]; summary?: AutofixSummary };
function scrubbed<R extends Scrubbable>(r: R, named: ReadonlySet<string>): R {
  // Reintroduce v0.55.0's rule (every titled line left out): "a line naming a series that is not 18+ is kept" in
  // autofixScrub.test.ts fails, and the history in repairRoutes.int.test.ts loses the renumbered line.
  const shown = (ids: unknown): boolean => !!namedBy(ids)?.every((id) => named.has(id));
  const keep = (l: Said): boolean => !TITLED.has(l.code) || shown(l.params?.seriesIds);
  return {
    ...r,
    ...(r.current ? { current: shown(r.current.seriesIds) ? r.current : { ...r.current, title: undefined } } : {}),
    ...(r.log ? { log: r.log.filter(keep) } : {}),
    ...(r.summary ? { summary: { ...r.summary, done: r.summary.done.map((d) => (d.items ? { ...d, items: d.items.filter(keep) } : d)) } } : {}),
  };
}
/**
 * Every series a run's titled lines and its "Now:" name -- of a run, or of a kept record as the repair history reads it --
 * what a route asks nameableIds about, in one query.
 */
export function autofixSeriesIds(run: unknown): string[] {
  if (!run || typeof run !== 'object') return [];
  const r = run as Scrubbable;
  const lines = [...(r.log ?? []), ...(r.summary?.done ?? []).flatMap((d) => d.items ?? [])];
  return [...lines.filter((l) => TITLED.has(l.code)).flatMap((l) => namedBy(l.params?.seriesIds) ?? []), ...(namedBy(r.current?.seriesIds) ?? [])];
}
/**
 * A run as an admin who hides 18+ reads it (`hide`): no line and no "Now:" title naming a series outside `named` -- the
 * ones their reach shows (visibility.ts nameableIds over autofixSeriesIds) -- nor one from before v0.55.1 naming any.
 */
export function scrubAutofixRun(r: AutofixRun | null, hide: boolean, named: ReadonlySet<string> = new Set()): AutofixRun | null {
  return r && hide ? scrubbed(r, named) : r;
}
/**
 * A kept run's record (repair_runs.result: `{phaseIndex, summary?, log, tried?}`) the same way: what the repair history
 * (GET /api/admin/tasks/repair/runs) sends for a Fix everything row, which Recent repairs reads without asking for the
 * run by its id. Reintroduce by sending it as stored: "an admin who hides 18+ reads no adult title in the repair's
 * answers" in repairRoutes.int.test.ts finds the merged title in the history.
 * Never `tried`, for anyone: the run's own memory of the packages it searched in vain, for the next runs (recentlyTried),
 * which since v0.55.1 names every series each was searched for -- 18+ ones too, whoever reads it -- and which nothing in
 * the web reads. The run's own routes never had it (fromRow). Reintroduce by keeping it: "a kept run's `tried` is in no
 * answer" in repairRoutes.int.test.ts finds it in the history.
 */
export function scrubAutofixRecord<R>(r: R, hide: boolean, named: ReadonlySet<string> = new Set()): R {
  if (!r || typeof r !== 'object') return r;
  const { tried: _tried, ...record } = r as Scrubbable & { tried?: unknown };
  return (hide ? scrubbed(record, named) : record) as R;
}

/** GET /api/admin/health/autofix: the run going now, and the newest finished one. */
export async function autofixState(): Promise<{ run: AutofixRun | null; last: AutofixRun | null }> {
  await closeInterruptedAutofix().catch(() => {});
  const a = active;
  const rows = await q<RunRow>(
    `SELECT r.id, r.started_at, r.finished_at, r.status, u.username, r.result FROM repair_runs r LEFT JOIN users u ON u.id = r.by_user
      WHERE r.kind = 'autofix' AND r.status <> 'running' ORDER BY r.started_at DESC LIMIT 1`).catch(() => [] as RunRow[]);
  return { run: a ? await liveView(a) : null, last: rows[0] ? fromRow(rows[0]) : null };
}

/** GET /api/admin/health/autofix/:runId: one run, live or kept; null when no kept run has that id. */
export async function autofixRun(id: string): Promise<AutofixRun | null> {
  const a = active;
  if (a?.id === id) return liveView(a);
  await closeInterruptedAutofix().catch(() => {});
  const row = await one<RunRow>(
    `SELECT r.id, r.started_at, r.finished_at, r.status, u.username, r.result FROM repair_runs r LEFT JOIN users u ON u.id = r.by_user
      WHERE r.kind = 'autofix' AND r.id::text = $1`, [id]).catch(() => null);
  return row ? fromRow(row) : null;
}

// ── 1. preflight ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The engine and the solver, as they are at the start. A solver that is down skips what needs it -- the solver reset,
 * and every Test, Replace and retirement of a source behind Cloudflare or failing inside the solver: those failures say
 * nothing about the site -- and an engine that is down skips what needs it: its sources and the extensions phase. The
 * rest still runs, so every card that does not depend on them can still turn green. What only the operator can bring
 * back is listed as Needs you by the recheck.
 */
async function preflight(a: Run): Promise<void> {
  now(a, say('autofix.now.checking'));
  a.engine = !suwayomiConfigured() ? 'none' : (await engineProbe().catch(() => ({ reachable: false }))).reachable ? 'up' : 'down';
  // An engine that answers, with no registration since it came back (the retry waits up to five minutes): its sources
  // are registered first, as Check again does (v0.55.1). Every engine source this run finds not loaded is read against
  // the last registration -- the source limit only when that left it out (register.ts leftOutByLimit), else it is no
  // longer installed -- and without one every extension source reads as gone: Replaced, and its series sent to the
  // extensions phase. Reintroduce by not registering: "an engine that answers with no registration since" in
  // autofixUnloaded.int.test.ts finds the series moved off its working source.
  if (a.engine === 'up' && !lastSuwayomiLoad()?.reachable) {
    const r = await retrySuwayomiNow().catch(() => null);
    if (!r?.reachable) a.engine = 'down';
  }
  a.solver = !solverUrl() ? 'none' : (await solverPing().catch(() => ({ ok: false }))).ok ? 'up' : 'down';
  if (a.solver === 'down') note(a, say('autofix.item.skipped', { why: 'solver_down' }));
  if (a.engine === 'down') note(a, say('autofix.item.skipped', { why: 'engine_down' }));
}

// ── 2. scan ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The library scan, then the repair's page count -- every uncounted file, so short chapters show up to be fixed. */
async function scan(a: Run): Promise<void> {
  await held(async () => {
    now(a, say('autofix.now.scanning'));
    runtime.lastScan = Date.now();
    await persistScan();
    const r = await repairForAutofix(a.log, { only: ['count'], userId: a.by }, drive(a));
    a.counts.scanned = 1;
    a.counted = r.counted;
  });
}

// ── 3. solver ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The repair's solver step (it resets only a solver that answers and that sources blame, and expires week-old
 * cooldowns), then every renumber a crash interrupted -- a check on the series finishes it (updater.ts) -- and, when
 * Health's engine row offers it and FLARESOLVERR_URL is set, Connect the engine's own Cloudflare helper: pressing Fix
 * everything is the admin asking.
 */
async function solver(a: Run): Promise<void> {
  await held(async () => {
    now(a, say('autofix.now.solver'));
    const r = await repairForAutofix(a.log, { only: ['solver'], userId: a.by }, drive(a));
    if (r.solver.reset) did(a, 'solverReset', Math.max(1, r.solver.unblocked));
    const journals = await q<{ id: string; title: string }>(
      `SELECT s.id, s.title FROM lib_series s WHERE s.renumber_plan IS NOT NULL AND ${visibleToAll('s')} ORDER BY s.title`).catch(() => []);
    for (const [i, s] of journals.entries()) {
      if (halted(a)) return;
      if (renumberRunning(s.id) || runsInside(s.id) > 0) continue;
      now(a, say('autofix.now.solver'), { title: s.title, seriesIds: [s.id], done: i, of: journals.length });
      await updateSeries(s.id, 0).catch(() => null);
      const still = await one<{ j: boolean }>('SELECT renumber_plan IS NOT NULL AS j FROM lib_series WHERE id = $1', [s.id]).catch(() => null);
      if (still && !still.j) did(a, 'resumedRenumber', 1);
    }
  });
  if (a.engine !== 'up' || !ourSolverUrl() || halted(a)) return;
  const engine = await extensionEngineCheck().catch(() => null);
  if (!engine?.items.some((i) => !i.info && i.actions?.includes('engine_solver'))) return;
  const r = await connectEngineSolver();
  if (!r.ok) return;
  did(a, 'engineConnected', 1);
  await logAudit('extension.solver', { userId: a.by, detail: { ...r.audit, via: 'autofix', runId: a.id } });
}

// ── 4. sources ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The source's own state is a rate limit (v0.55.1): it stays `rate_limited` from the 429 until a download succeeds. */
async function rateLimited(id: string): Promise<boolean> {
  return (await one<{ status: string }>('SELECT status FROM source_health WHERE source_id = $1', [id]).catch(() => null))?.status === 'rate_limited';
}

/**
 * The sources the chapters phase leaves alone, with their cooldown's end while one runs (v0.55.1): cooling down
 * (lib/sourceStanding.ts: a cooldown, or a confirmed rate limit at a step an update needs), or rate-limited now -- its
 * status stays `rate_limited` from the 429 until a download succeeds, whatever the cooldown's clock says. The owner's
 * first run re-checked failed chapters through Natomanga and Mangakakalot while they answered 429, and 28 chapters
 * failed again inside four minutes; what a rate limit holds back is the sweep's, once the site is ready.
 */
async function restingSources(): Promise<Map<string, string | null>> {
  const rows = await q<StandingRow & { status: string }>(
    `SELECT sh.source_id, (sh.disabled OR ${EXTENSION_OFF('sh.source_id')}) AS disabled, sh.blocked_until, sh.stages, sh.status
       FROM source_health sh
      WHERE sh.status = 'rate_limited' OR sh.blocked_until > now() OR sh.stages::text LIKE '%failAt%'`).catch(() => []);
  const t = Date.now();
  const out = new Map<string, string | null>();
  for (const r of rows) {
    if (r.disabled || (r.status !== 'rate_limited' && standingOf(r.source_id, r, t) !== 'cooling')) continue;
    const until = r.blocked_until ? new Date(r.blocked_until).getTime() : 0;
    out.set(r.source_id, until > t ? new Date(until).toISOString() : null);
  }
  return out;
}

/** A source the solver being down speaks for: one behind Cloudflare, or one whose failure names the solver. */
async function solverSpeaksFor(a: Run, id: string): Promise<boolean> {
  if (a.solver !== 'down') return false;
  if (getSource(id)?.requiresCloudflare) return true;
  const h = await one<{ e: string | null }>('SELECT last_error AS e FROM source_health WHERE source_id = $1', [id]).catch(() => null);
  return /flaresolverr/i.test(h?.e ?? '');
}

/**
 * Test the sources that need a look -- failing, inconclusive, unchecked for a week, or blocked on a source series use
 * -- one at a time and at most AUTOFIX_TESTS, and clear a block only after a passing Test (the Test route's `canClear`).
 * Then Replace, with turnOff, every source that is some series' main and is switched off or failing (confirmed), or
 * whose extension is gone -- never for a configuration cause: the engine, the source limit, a hidden language, a
 * MangaDex language switched off, or a solver that is down. One Replace run after another, each awaited. Then retire,
 * as `off`, the failing sources no series uses (retire refuses one that is some series' main).
 * ⚠️ A rate limit is left alone (v0.55.1): a source whose row is only a rate limit is not Tested -- a Test sends the
 * site that asked for room four more requests and proves nothing about its images -- and a rate limit's cooldown is
 * never cleared, after any Test. The owner's first run cleared Natomanga's and Mangakakalot's, and its chapters phase
 * then sent them the requests their cooldowns were holding back.
 */
async function sources(a: Run): Promise<void> {
  const trouble = await sourceTrouble(await loadIgnores());
  // A finding an admin chose to ignore is theirs: tested, Replaced or retired by nobody but them.
  const ignored = new Set(trouble.items.filter((i) => i.ignored && i.sourceId).map((i) => i.sourceId!));
  // Reintroduce by Testing a rate limit's row: "a rate limit is never Tested, nor its cooldown cleared" in
  // autofix.int.test.ts finds af-limit tested.
  const testable = trouble.items.filter((i) => i.sourceId && !i.ignored && i.state !== 'off' && getSource(i.sourceId)
    && (i.state === 'failing' || i.state === 'inconclusive' || i.state === 'untested'
      || (i.state === 'blocked' && !i.info && i.cooldown?.status !== 'rate_limited')));
  let tests = 0;
  for (const [n, it] of testable.entries()) {
    if (halted(a)) break;
    // Out of time or Tests with sources still to Test: the next run Tests them.
    if (outOfTime(a) || tests >= AUTOFIX_TESTS) { cutShort(a, 'sources'); break; }
    const id = it.sourceId!;
    if (await solverSpeaksFor(a, id)) continue;
    if (a.engine !== 'up' && isSwAdapterId(id)) continue;
    const src = getSource(id);
    if (!src) continue;
    now(a, say('autofix.now.testing', { name: src.name }), { done: n, of: testable.length });
    const r = await testSource(src, { userId: a.by, via: 'autofix', runId: a.id }).catch(() => 'busy' as const);
    if (r === 'busy') continue;
    tests++;
    did(a, 'tested', 1);
    note(a, say('autofix.item.tested', { name: src.name, ok: r.smoke.ok }));
    // ⚠️ Only after a passing Test: clearing also wipes the escalation memory, and a source still refusing would earn a
    // shorter cooldown than the one before. Reintroduce by clearing every block: "a block is cleared only after a passing
    // Test" in autofix.int.test.ts finds the failing source unblocked. And never a rate limit's (v0.55.1): the Test
    // fetched no image. Reintroduce by dropping `rateLimited`: "a rate limit is never Tested, nor its cooldown cleared"
    // finds af-ratefail's cooldown gone.
    if (r.smoke.ok && r.blocked && !(await rateLimited(id))) {
      await clearBlock(id).catch(() => {});
      did(a, 'unblocked', 1, say('autofix.item.unblocked', { name: src.name }));
    }
  }

  const targets = await replaceTargets(a);
  // Reintroduce by not passing them: "the run's Replace runs never promote onto a source it is replacing too" in
  // autofix.int.test.ts finds a Replace run without them.
  a.replacing = targets.map((t) => t.id);
  for (const t of targets) {
    if (halted(a)) break;
    if (outOfTime(a)) { cutShort(a, 'sources'); break; }
    if (ignored.has(t.id)) continue;
    if (!(await waitSweep(a))) break;
    now(a, say('autofix.now.replacing', { name: t.name }));
    const started = await startFind({ sourceId: t.id }, a.by, a.ctx, undefined, { mode: 'replace', turnOff: true, autofix: a.id, avoid: a.replacing });
    if (!('runId' in started)) continue;
    await findRunSettled();
    const st = await findState({ runId: started.runId }).catch(() => null);
    const moved = st?.run?.promoted ?? 0;
    const left = st?.run?.left ?? 0;
    if (moved) {
      did(a, 'replaced', moved, say('autofix.item.replaced', { name: t.name, n: moved }));
      if (!a.replacedNames.includes(t.name)) a.replacedNames.push(t.name);
    }
    if (left) note(a, say('autofix.item.stillOn', { name: t.name, n: left }));
  }
  for (const k of await configKept(a)) note(a, say('autofix.item.kept', { name: k }));

  if (halted(a)) return;
  const after = await sourceTrouble(await loadIgnores());
  for (const it of after.items.filter((i) => i.group === 'unused' && i.state === 'failing' && i.sourceId && !i.ignored)) {
    if (halted(a)) break;
    if (await solverSpeaksFor(a, it.sourceId!)) continue;
    now(a, say('autofix.now.retiring', { name: it.title }));
    const r = await retireSource(it.sourceId!, { how: 'off', userId: a.by, via: 'autofix', runId: a.id }).catch(() => null);
    if (r && 'ok' in r) did(a, 'retired', 1, say('autofix.item.retired', { name: it.title }));
  }
}

/** Why a main source that cannot update its series is left to a person: a setting, never the site. Null: Replace it. */
type MainFacts = { id: string; name: string; n: number; standing: string; offBy: string | null };
function configCause(a: Run, m: MainFacts): string | null {
  if (m.standing === 'off') return m.offBy === 'language' ? 'language' : null;
  if (m.standing === 'failing') return null;
  // not_loaded: the engine, the limit, a MangaDex language switched off -- or truly gone (an uninstalled extension, a
  // removed site), which Replace is for.
  if (isSwAdapterId(m.id) && a.engine !== 'up') return 'engine';
  if (mangadexLangOf(m.id)) return 'mangadex';
  // The limit only when the last registration left this source out for want of room (v0.55.1), as Health reads it
  // (lib/health.ts frozenSeries): switched on and not loaded alone is also an extension the engine no longer offers --
  // "no longer installed" on Health, with Replace -- which this left on its source as a setting, run after run.
  // Reintroduce v0.55.0's reading (switched on here: the limit): "a source the engine no longer offers is Replaced" in
  // autofixUnloaded.int.test.ts finds no Replace of it.
  if (leftOutByLimit(m.id)) return 'limit';
  return null;
}

/** Every visible series' main source that cannot update it -- off, failing, or not loaded -- with its facts. */
async function mainFacts(a: Run): Promise<MainFacts[]> {
  const mains = await q<{ source_id: string; n: number }>(
    `SELECT s.source_id, count(*)::int AS n FROM lib_series s WHERE s.source_id IS NOT NULL AND ${visibleToAll('s')} GROUP BY s.source_id`,
  ).catch(() => []);
  if (!mains.length) return [];
  const ids = mains.map((m) => m.source_id);
  const rows = await standingRows(ids);
  const extra = new Map((await q<{ id: string; off_by: string | null }>(
    `SELECT i.id, ${EXTENSION_OFF_BY('i.id')} AS off_by FROM unnest($1::text[]) AS i(id)`, [ids]).catch(() => [])).map((r) => [r.id, r]));
  const names = new Map((await q<{ id: string; name: string }>(
    `SELECT '${SW_PREFIX}' || source_id AS id, name FROM suwayomi_sources WHERE '${SW_PREFIX}' || source_id = ANY($1::text[])`, [ids]).catch(() => []))
    .map((r) => [r.id, r.name]));
  const out: MainFacts[] = [];
  for (const m of mains) {
    const standing = standingOf(m.source_id, rows.get(m.source_id));
    if (standing !== 'off' && standing !== 'failing' && standing !== 'not_loaded') continue;
    out.push({
      id: m.source_id, name: getSource(m.source_id)?.name ?? names.get(m.source_id) ?? m.source_id, n: Number(m.n), standing,
      offBy: extra.get(m.source_id)?.off_by ?? null,
    });
  }
  // The most series first: one Replace moves the most.
  return out.sort((x, y) => y.n - x.n || x.name.localeCompare(y.name));
}

/** The main sources to Replace, worst-hit first. ⚠️ Never one whose cause is a setting (configCause) or the solver. */
async function replaceTargets(a: Run): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  for (const m of await mainFacts(a)) {
    if (configCause(a, m)) continue;
    if (m.standing === 'failing' && await solverSpeaksFor(a, m.id)) continue;
    out.push({ id: m.id, name: m.name });
  }
  return out;
}

/** The main sources left alone for a setting, by name, for the log. */
async function configKept(a: Run): Promise<string[]> {
  return (await mainFacts(a)).filter((m) => configCause(a, m) === 'language').map((m) => m.name);
}

// ── 5. duplicates ───────────────────────────────────────────────────────────────────────────────────────────────

/** Whole numbers a series lists or holds: what two copies' chapter lists are compared on. */
async function chapterSet(id: string): Promise<Set<number>> {
  const listed = await q<{ n: number }>('SELECT DISTINCT number::float8 AS n FROM series_listing WHERE series_id = $1', [id]).catch(() => []);
  const held = await haveNumbers(id).catch(() => [] as number[]);
  return new Set([...listed.map((r) => Math.floor(Number(r.n))), ...held.map((n) => Math.floor(n))].filter((n) => Number.isFinite(n)));
}

/** How much two chapter lists agree: the share of the shorter list the longer one holds. Null when either is too short to say. */
function overlap(x: Set<number>, y: Set<number>): number | null {
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  if (small.size < 3) return null;
  let both = 0;
  for (const n of small) if (big.has(n)) both++;
  return both / small.size;
}

/** The share of agreeing chapters at which two copies are the same series, when their titles do not say so. */
const SAME_CHAPTERS = 0.7;

type Copy = { id: string; title: string; lang: string; sourceId: string | null; workId: string | null; books: number; readers: number; created: number; usable: boolean };

/**
 * Link two-language pairs as editions, and merge same-language copies -- only when their AniList entry (the duplicate
 * check's own grouping), their language, and their titles (autoFollow.ts titleMatch, their other names included) or
 * their chapter lists (SAME_CHAPTERS of the shorter) agree. The copy kept is the one in a work, else the one whose main
 * source can still update it, then the one with more live chapters, more readers, the older; three or more copies merge
 * into it one pair at a time, each pair checked again. A merge carries the absorbed copy's working main source over as
 * a follower (libraryAdmin.ts mergeSeries). Ignored findings are left as they are.
 */
async function duplicates(a: Run): Promise<void> {
  const check = await duplicateSeries(await loadIgnores());
  const rows = check.items.filter((i) => !i.info && (i.seriesIds?.length ?? 0) >= 2);
  await held(async () => {
    for (const [i, row] of rows.entries()) {
      if (halted(a)) return;
      now(a, say('autofix.now.duplicates'), { title: row.title, seriesIds: row.seriesIds, done: i, of: rows.length });
      const ids = row.seriesIds!;
      if (row.actions?.includes('link_editions')) {
        const r = await linkPair(ids[0], ids[1]).catch(() => null);
        if (r && 'ok' in r) {
          await logAudit('series.edition_link', {
            userId: a.by, detail: { id: r.joiner.id, title: r.joiner.title, of: r.of.id, ofTitle: r.of.title, lang: r.lang, via: 'autofix', runId: a.id },
          });
          did(a, 'linked', 1, say('autofix.item.linked', { a: r.joiner.title, b: r.of.title, seriesIds: [r.joiner.id, r.of.id] }));
        }
        continue;
      }
      await mergeCopies(a, ids);
    }
  });
}

async function copiesOf(ids: readonly string[]): Promise<Copy[]> {
  const rows = await q<{ id: string; title: string; lang: string | null; source_id: string | null; work_id: string | null; books: number; readers: number; created_at: Date }>(
    `SELECT s.id, COALESCE(o.title, s.title) AS title, s.lang, s.source_id, s.work_id::text AS work_id, s.created_at,
            (SELECT count(*) FROM lib_books b WHERE b.series_id = s.id AND b.pruned_at IS NULL)::int AS books,
            (SELECT count(*) FROM read_progress rp WHERE rp.series_id = s.id)::int AS readers
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE s.id = ANY($1::text[]) AND ${visibleToAll('s')}`, [[...ids]]);
  const standing = await standingRows(rows.map((r) => r.source_id).filter((x): x is string => !!x)).catch(() => new Map());
  return rows.map((r) => {
    const st = r.source_id ? standingOf(r.source_id, standing.get(r.source_id)) : 'not_loaded';
    return {
      id: r.id, title: r.title, lang: effectiveLang(r.lang, r.source_id), sourceId: r.source_id, workId: r.work_id,
      books: Number(r.books), readers: Number(r.readers), created: new Date(r.created_at).getTime(),
      usable: st === 'usable' || st === 'cooling',
    };
  });
}

/** Do two copies agree enough to be one series: their language, and their titles or their chapters. */
async function sameSeries(x: Copy, y: Copy): Promise<boolean> {
  if (!sameLanguage(x.lang, y.lang)) return false;
  const [xa, ya] = await Promise.all([altTitlesFor(x.id, 20).catch(() => []), altTitlesFor(y.id, 20).catch(() => [])]);
  if (titleMatch(x.title, { title: y.title, altTitles: ya }) || titleMatch(y.title, { title: x.title, altTitles: xa })) return true;
  const share = overlap(await chapterSet(x.id), await chapterSet(y.id));
  return share !== null && share >= SAME_CHAPTERS;
}

async function mergeCopies(a: Run, ids: readonly string[]): Promise<void> {
  const copies = await copiesOf(ids);
  if (copies.length < 2) return;
  // The copy kept: one in a work (merging it away would take it out of its work), then one that still updates, then
  // the one with the most to lose (the duplicate check's own suggestion).
  copies.sort((x, y) => Number(!!y.workId) - Number(!!x.workId) || Number(y.usable) - Number(x.usable)
    || y.books - x.books || y.readers - x.readers || x.created - y.created);
  const keep = copies[0];
  for (const other of copies.slice(1)) {
    if (halted(a)) return;
    if (!(await sameSeries(keep, other))) {
      note(a, say('autofix.item.notMerged', { a: keep.title, b: other.title, seriesIds: [keep.id, other.id] }));
      continue;
    }
    if (await mergeRefusal(other.id, keep.id)) continue;
    const r = await mergeSeries(other.id, keep.id);
    await logAudit('series.merge', {
      userId: a.by, detail: { from: other.id, fromTitle: other.title, into: keep.id, intoTitle: keep.title, ...r, via: 'autofix', runId: a.id },
    });
    did(a, 'merged', 1, say('autofix.item.merged', { from: other.title, into: keep.title, seriesIds: [other.id, keep.id] }));
  }
}

// ── 6. numbering ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every renumber waiting for review is applied when the plan built at the apply is clean -- nothing parked, no guess, no
 * collision, no tracker push, no download running (lib/postingOrder.ts) -- through the check that applies a confirmed
 * one (updateSeries `confirmRenumber: 'clean'`). Any other plan waits for the admin, and so does a hint: Needs you.
 */
async function numbering(a: Run): Promise<void> {
  const rows = await q<{ id: string; title: string; folder: string }>(
    `SELECT s.id, s.title, s.folder FROM lib_series s
      WHERE s.numbering_pending IS NOT NULL AND s.renumber_plan IS NULL AND ${visibleToAll('s')} ORDER BY s.title`).catch(() => []);
  if (!rows.length) return;
  await held(async () => {
    for (const [i, s] of rows.entries()) {
      if (halted(a)) return;
      // A download or a check inside it: not judged now, so neither applied nor a person's -- the next run's.
      if (folderBusy(s.folder) || runsInside(s.id) > 0) { a.numberingBusy++; continue; }
      now(a, say('autofix.now.renumbering'), { title: s.title, seriesIds: [s.id], done: i, of: rows.length });
      const r = await updateSeries(s.id, 0, { confirmRenumber: 'clean' }).catch(() => null);
      if (r?.renumber?.state === 'applied') did(a, 'renumbered', 1, say('autofix.item.renumbered', { title: s.title, seriesIds: [s.id] }));
      else note(a, say('autofix.item.notRenumbered', { title: s.title, seriesIds: [s.id] }));
    }
  });
}

// ── 7. chapters ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The repair's failures, short and gap steps as Fix everything drives them (repair.ts `autofix`): every failed chapter of
 * a source that can be asked reset and re-checked, every short chapter and every series with a gap, paced, under the
 * run's time and search budget -- the gap step least recently checked first, leaving a series with an impossible number
 * or a renumber waiting alone.
 */
async function chapters(a: Run): Promise<void> {
  if (outOfTime(a)) { a.timeUp = true; cutShort(a, 'chapters'); return; }
  // v0.55.1: a source cooling down or rate-limited now is left alone -- its failed chapters not reset, nothing listed,
  // fetched or hunted through it (repair.ts AutofixDrive.resting). Reintroduce by driving without it: "a 429 failure is
  // not retried by the run" in autofix.int.test.ts finds its row reset and the site asked.
  const rest = await restingSources();
  const r: RepairResult = await held(() => repairForAutofix(a.log, { only: ['failures', 'short', 'gaps'], userId: a.by },
    { ...drive(a), resting: (id) => rest.has(id) }));
  a.repairCur = null;
  did(a, 'failuresCleared', r.failures.reset);
  did(a, 'refetched', r.failures.retried?.added ?? 0);
  did(a, 'shortFixed', r.short.replaced);
  did(a, 'shortConfirmed', r.short.confirmed);
  did(a, 'fetched', r.gaps.fetched);
  if (outOfTime(a)) { a.timeUp = true; cutShort(a, 'chapters'); }
}

// ── 8. extensions ───────────────────────────────────────────────────────────────────────────────────────────────

type Target = { id: string; title: string; main: string | null; lang: string; kind: 'frozen' | 'gap'; adult: boolean };

/**
 * The series that still have no working source after the sources phase -- for a reason that is the source's own, not a
 * setting -- and the series with a gap nobody else lists ("asked, and nobody has it", fresh). Each with its language,
 * and whether it is rated 18+ (an 18+ package is tried for no other, v0.55.1).
 * ⚠️ A gap's answer counts only while it is about the series as it is now (health.ts gapsAnswered: nothing landed since)
 * and the series still has a hole: an earlier run that filled the gap -- from an extension it installed -- left the
 * answer "nobody has it" behind, and the next run installed another package for a series with nothing missing (and,
 * under the source limit, told the admin to free a slot for it). Reintroduce by reading the stored answer alone: "a gap
 * an earlier run filled is no reason to install" in autofixExtensions.int.test.ts finds a second install.
 */
async function extensionTargets(a: Run): Promise<Target[]> {
  const out: Target[] = [];
  const hidden = new Set(await getHiddenLangs().catch(() => [] as string[]));
  const frozen = await frozenSeries(noIgnores(), a.engine === 'up' ? 'up' : 'unreachable', { all: true });
  const BROKEN = new Set(['frozen.uninstalled', 'frozen.failing', 'frozen.switchedOff', 'frozen.noSource']);
  const ids = frozen.items.filter((i) => !i.info && i.seriesId && BROKEN.has(i.detailSaid?.[0]?.code ?? '')).map((i) => i.seriesId!);
  const answered = await q<{ id: string; gaps_result: StoredGaps | null; gaps_checked_at: Date | null; floor: number | null }>(
    `SELECT s.id, s.gaps_result, s.gaps_checked_at, s.chapter_floor::float8 AS floor FROM lib_series s
      WHERE s.auto_update AND ${visibleToAll('s')} AND s.gaps_result->>'why' = 'no_candidate'
        AND s.numbering_pending IS NULL AND s.renumber_plan IS NULL AND s.numbering IS DISTINCT FROM 'posting_order'
        AND COALESCE((s.gaps_result->>'at')::timestamptz, s.gaps_checked_at) > now() - interval '7 days'`).catch(() => []);
  const gaps: Array<{ id: string }> = [];
  for (const g of answered) {
    const have = await haveNumbers(g.id).catch(() => [] as number[]);
    if (!gapsAnswered(g.gaps_result, g.gaps_checked_at, have.length)) continue;
    if (!splitAtFloor(gapsOf(plausibleNumbers(have)), g.floor).above.length) continue;
    gaps.push({ id: g.id });
  }
  const rows = await q<{ id: string; title: string; source_id: string | null }>(
    `SELECT s.id, s.title, s.source_id FROM lib_series s WHERE s.id = ANY($1::text[])`, [[...ids, ...gaps.map((g) => g.id)]]).catch(() => []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [list, kind] of [[ids, 'frozen'], [gaps.map((g) => g.id), 'gap']] as const) {
    for (const id of list) {
      const r = byId.get(id);
      // Once, as its frozen self: a series with no working source can have a gap nobody had too. Reintroduce by listing
      // it twice: "the package is asked about it once" in autofixUnloaded.int.test.ts finds a second Find run.
      if (!r || out.some((t) => t.id === id)) continue;
      const lang = (await seriesLanguage(id).catch(() => null))?.lang;
      // A series in a language the admin hides is theirs to decide: switching one of its sources on would undo it.
      if (!lang || hidden.has(lang)) continue;
      out.push({ id, title: r.title, main: r.source_id, lang, kind, adult: await seriesIsAdult(id).catch(() => false) });
    }
  }
  return out;
}

/** The series' own translation groups, normalised (releases.ts normGroup): on disk, and listed by its sources. */
async function groupsOf(seriesId: string): Promise<Set<string>> {
  const rows = await q<{ g: string }>(
    `SELECT DISTINCT scanlator AS g FROM lib_books WHERE series_id = $1 AND scanlator IS NOT NULL
     UNION SELECT DISTINCT unnest(groups) AS g FROM series_listing WHERE series_id = $1`, [seriesId]).catch(() => []);
  return new Set(rows.map((r) => normGroup(r.g)).filter((k) => k.length >= 3));
}

/**
 * Whether a package was searched for a target within TRIED_DAYS and did not carry it: it is not tried for that series
 * again yet (v0.55.1, kept per package AND series -- one that missed X is still tried for a new target Y). A run kept by
 * v0.55.0 recorded a package by language, for every series of that language it had then: honoured as that.
 * Reintroduce by reading nothing: "no package is tried twice for the same series" in autofixExtensions.int.test.ts
 * finds the second run installing again.
 */
async function recentlyTried(): Promise<(pkg: string, t: Target) => boolean> {
  const rows = await q<{ result: Stored | null }>(
    `SELECT result FROM repair_runs WHERE kind = 'autofix' AND started_at > now() - ($1 || ' days')::interval`, [String(TRIED_DAYS)]).catch(() => []);
  const pairs = new Set<string>();
  const langs = new Set<string>();
  for (const r of rows) {
    for (const t of r.result?.tried ?? []) {
      if (Array.isArray(t.series)) for (const id of t.series) pairs.add(`${t.pkg}\u0000${id}`);
      else langs.add(`${t.pkg}\u0000${t.lang}`);
    }
  }
  return (pkg, t) => pairs.has(`${pkg}\u0000${t.id}`) || langs.has(`${pkg}\u0000${t.lang}`);
}

/** A catalogue package's language fits a series': the same language, or a package that serves several. */
const pkgFits = (e: ExtensionInfo, lang: string): boolean => {
  if (!e.lang || e.lang === 'all' || e.lang === 'multi') return true;
  const c = canonLang(e.lang);
  return !!c && sameLanguage(c, lang);
};

/**
 * For each language with targets: the catalogue's packages that are not installed, not obsolete, and in that language
 * (or several), tried one at a time in lib/extensionRank.ts's order -- the targets' own translation groups first (a
 * group's own site), then the most downloaded a day, then the most updated, an 18+ package after the others of its
 * rank -- each only for the targets it has not missed within TRIED_DAYS, and an 18+ package only for a series rated 18+.
 * No site is named here.
 *
 * No cap of its own (v0.55.1). The owner: "searching other extensions unlimited and not 3 in the fix everything so it
 * eventually find one with the series also … make sure it tries popular extensions first"; v0.55.0 tried three a run,
 * the first three by name when no group named one. It goes on until every target is carried or the run's time is spent
 * (AUTOFIX_MAX_MINUTES), and the next run continues down the list, past what this one tried; AUTOFIX_INSTALLS, when set,
 * caps a run's installs, and 0 switches the phase off. Reintroduce a default of 3: "with no cap it goes past three until
 * the series is found" in autofixExtensions.int.test.ts stops before Birch Reader.
 *
 * Each package switches on only its source in the targets' language (the bulk switch) and is kept only when it fits
 * under the source limit (register.ts wouldFit, and registered after the reload); the targets are searched on that one
 * source under Find's limits -- a frozen series' main is Replaced by it, a gap's series follows it and its missing
 * chapters are fetched -- and a package that carries none is removed at once (settle), so a miss never holds a slot.
 */
async function extensions(a: Run): Promise<void> {
  if (!AUTOFIX_INSTALLS) return;
  if (a.engine !== 'up') {
    note(a, say('autofix.item.skipped', { why: a.engine === 'none' ? 'no_engine' : 'engine_down' }));
    return;
  }
  if (outOfTime(a)) { a.timeUp = true; cutShort(a, 'extensions'); return; }
  const targets = await extensionTargets(a);
  if (!targets.length) return;
  let catalogue: ExtensionInfo[];
  try { catalogue = await listExtensions(); } catch { return; }
  const tried = await recentlyTried();
  const open = catalogue.filter((e) => !e.installed && !e.obsolete);
  const facts = await extensionFacts();
  const perDay = await downloadsPerDay(open.map((e) => {
    const f = facts.get(e.pkgName);
    return { pkgName: e.pkgName, apkUrl: f?.apkUrl ?? null, jarUrl: f?.jarUrl ?? null, apkName: f?.apkName ?? null, index: f?.index ?? e.repo };
  }));
  const langs = [...new Set(targets.map((t) => t.lang))]
    .sort((x, y) => targets.filter((t) => t.lang === y).length - targets.filter((t) => t.lang === x).length);
  try {
    for (const lang of langs) {
      let mine = targets.filter((t) => t.lang === lang);
      const groups = new Map<string, Set<string>>();
      for (const t of mine) groups.set(t.id, await groupsOf(t.id));
      const ranked = rankPackages(open.filter((e) => pkgFits(e, lang)).map((e) => {
        const key = normGroup(e.name);
        const named = key.length >= 3 ? mine.filter((t) => [...groups.get(t.id)!].some((g) => g.includes(key) || key.includes(g))).length : 0;
        return { e, pkgName: e.pkgName, name: e.name, nsfw: e.nsfw, named, perDay: perDay.get(e.pkgName) ?? null, versionCode: facts.get(e.pkgName)?.versionCode ?? null };
      }));
      for (const c of ranked) {
        if (!mine.length) break;
        if (halted(a)) return;
        // Never a package for a series it was searched for in vain within the month, nor an 18+ package for a series
        // that is not rated 18+. Reintroduce the 18+ rule's absence: "an 18+ package is never tried for a series not
        // rated 18+" in autofixExtensions.int.test.ts finds Thorn Garden moved onto Rose Velvet.
        const forIt = mine.filter((t) => !tried(c.e.pkgName, t) && (!c.e.nsfw || t.adult));
        if (!forIt.length) continue;
        // Out of time, or at AUTOFIX_INSTALLS, with a package still to try: the next run continues down the list, so the
        // series are not Needs you yet. Asked only here: with nothing left to try the phase ends as finished, and what no
        // package in reach carries is Needs you now, not a Run again that would try nothing. Reintroduce by asking before
        // `forIt`: "with nothing left to try, the run's time running out is no reason to run again" in
        // autofixExtensions.int.test.ts finds Run again offered.
        if (outOfTime(a)) { a.timeUp = true; cutShort(a, 'extensions'); return; }
        if (a.installs >= AUTOFIX_INSTALLS) { note(a, say('autofix.item.skipped', { why: 'installs' })); cutShort(a, 'extensions'); return; }
        const r = await tryPackage(a, c.e, lang, forIt);
        if (r === 'full') return;
        mine = mine.filter((t) => !r.has(t.id));
      }
    }
  } finally {
    // What a stop or a throw left between an install and its settling.
    for (const inst of a.installed) await settle(a, inst);
  }
}

/** A series' answer from a run over a package's source that says the package was asked and does not carry it. */
const ASKED = new Set(['no_match', 'refused', 'no_answer', 'followed_already', 'no_source']);

/**
 * One package: install it, switch on its source in `lang`, search the targets on it, then settle it -- kept when a series
 * now reads through it, else removed at once -- with the targets it was asked for and does not carry recorded, so no
 * later run tries it for them within TRIED_DAYS. The targets it now carries, or `full`.
 */
async function tryPackage(a: Run, e: ExtensionInfo, lang: string, targets: Target[]): Promise<Set<string> | 'full'> {
  const carried = new Set<string>();
  // Room first: a source that would not register is a source that would push nothing useful -- or, before the used-first
  // order, a used one -- out. Reintroduce by installing whatever the limit says: "an install that would not fit is not
  // made" in autofix.int.test.ts finds the package installed.
  if (!(await wouldFit(['autofix:new']))) {
    if (!a.noRoom.includes(e.name)) a.noRoom.push(e.name);
    note(a, say('autofix.item.noRoom', { name: e.name }));
    return 'full';
  }
  a.installs++;
  now(a, say('autofix.now.installing', { name: e.name }));
  try {
    await setExtensionState(e.pkgName, 'install');
  } catch {
    note(a, say('autofix.item.installFailed', { name: e.name }));
    return carried;
  }
  await logAudit('extension.install', { userId: a.by, detail: { pkgName: e.pkgName, via: 'autofix', runId: a.id } });
  const provided = await sourcesOfExtension(e.pkgName).catch(() => []);
  // Recorded, every one switched off; then ONLY the source in the targets' language switched on, with the bulk switch.
  // Reintroduce by adopting them as the install route does: "only the series' language is switched on" in
  // autofix.int.test.ts finds the package's other language on.
  await adoptExtensionSources(provided, false);
  const pick = provided.find((s) => !!s.lang && !!canonLang(s.lang) && sameLanguage(canonLang(s.lang)!, lang))
    ?? provided.find((s) => !s.lang || s.lang === 'all');
  const entry: Installed = { pkg: e.pkgName, name: e.name, lang, sourceId: pick ? `${SW_PREFIX}${pick.id}` : '', ids: provided.map((x) => x.id) };
  a.installed.push(entry);
  /** The targets the package was asked about and does not carry: what settle records. */
  const missed = new Set<string>();
  try {
    // No source in this language: it carries none of them, now or on the next run.
    if (!pick) { for (const t of targets) missed.add(t.id); return carried; }
    await setSourcesEnabled({ ids: [pick.id], enabled: true });
    await reloadAll();
    if (!getSource(entry.sourceId)) {
      if (!a.noRoom.includes(e.name)) a.noRoom.push(e.name);
      note(a, say('autofix.item.noRoom', { name: e.name }));
      return 'full';
    }
    now(a, say('autofix.now.searching', { name: e.name }));
    const answered = (res: FindResult) => { if (res.why && ASKED.has(res.why)) missed.add(res.seriesId); };
    // Frozen series, by the main source they are stuck on: Replace that source, asking only the new one, over these
    // series alone (`within`: an 18+ package is not asked for the main's other series, nor one already tried for them).
    const byMain = new Map<string, Target[]>();
    const loose: Target[] = [];
    for (const t of targets) {
      if (t.kind === 'frozen' && t.main) byMain.set(t.main, [...(byMain.get(t.main) ?? []), t]);
      else loose.push(t);
    }
    for (const [main, list] of byMain) {
      if (halted(a)) break;
      if (!(await waitSweep(a))) break;
      const r = await startFind({ sourceId: main }, a.by, a.ctx, undefined,
        { mode: 'replace', turnOff: true, autofix: a.id, only: [entry.sourceId], avoid: a.replacing, within: list.map((t) => t.id) });
      if (!('runId' in r)) continue;
      await findRunSettled();
      const st = await findState({ runId: r.runId }).catch(() => null);
      for (const res of st?.run?.results ?? []) {
        if (res.promoted && list.some((t) => t.id === res.seriesId)) carried.add(res.seriesId);
        else answered(res);
      }
      const moved = (st?.run?.results ?? []).filter((x) => x.promoted).length;
      if (moved) {
        did(a, 'replaced', moved, say('autofix.item.replaced', { name: getSource(main)?.name ?? main, n: moved }));
        const name = getSource(main)?.name ?? main;
        if (!a.replacedNames.includes(name)) a.replacedNames.push(name);
      }
    }
    // Series with a gap nobody had, and frozen series with no main to Replace: follow the new source, then a frozen one
    // makes it its main -- only while it can update the series (v0.55.1: a package installed before can bring back a
    // source already failing; reintroduce by switching whatever it is: "a source failing at its page lists is never
    // made its main source" in autofixExtensions.int.test.ts finds Pine Lake moved onto it) -- and a gap's missing
    // chapters are fetched.
    if (loose.length && !halted(a) && await waitSweep(a)) {
      const r = await startFind({ seriesIds: loose.map((t) => t.id) }, a.by, a.ctx, undefined, { autofix: a.id, only: [entry.sourceId] });
      if ('runId' in r) {
        await findRunSettled();
        const st = await findState({ runId: r.runId }).catch(() => null);
        const takes = carries((await standingsOf([entry.sourceId])).get(entry.sourceId) ?? 'not_loaded');
        for (const res of st?.run?.results ?? []) {
          if (!res.followed.some((f) => f.sourceId === entry.sourceId)) { answered(res); continue; }
          const t = loose.find((x) => x.id === res.seriesId);
          if (t?.kind === 'frozen' && !takes) continue;
          carried.add(res.seriesId);
          if (t?.kind === 'frozen') {
            // After the listing refresh the follow started (quietSeries): beside it the switch is refused `busy`.
            // Reintroduce by switching at once: "a frozen series with no main moves to the new source that carries it"
            // in autofixExtensions.int.test.ts finds Fir Lake still without one.
            if (await quietSeries(a, t.id)) {
              await switchMainSource(t.id, entry.sourceId, { old: 'drop', ctx: a.ctx, userId: a.by, via: 'replace', runId: a.id }).catch(() => null);
            }
          } else if (t) {
            await held(async () => {
              const have = new Set(await haveNumbers(t.id).catch(() => [] as number[]));
              const up = await updateSeries(t.id, 100, { hunt: false, cancelled: () => halted(a) }).catch(() => null);
              if (up?.landed.length) {
                const filled = up.landed.filter((l) => !have.has(l.number)).length;
                did(a, 'fetched', filled);
                await persistScan().catch(() => {});
              }
            });
          }
        }
      }
    }
    return carried;
  } finally {
    // Right after its searches (v0.55.1): a miss is removed before the next package is installed, and never holds a slot
    // under the source limit. Reintroduce v0.55.0's removal at the phase's end (settle only in extensions' finally):
    // "each miss is removed right after its searches" in autofixExtensions.int.test.ts finds two installed at once.
    await settle(a, entry, [...missed].filter((id) => !carried.has(id)));
  }
}

/**
 * Wait, stop-aware and at most FIND_BUSY_WAIT_MS, until no run is inside the series. A Find run that ends with a series
 * following a new source refreshes its listing (findSources.ts scheduleFindRefresh), and a switch beside that refresh is
 * refused `busy` (lib/mainSource.ts): the frozen series with no main followed the new source and never moved.
 */
async function quietSeries(a: Run, seriesId: string): Promise<boolean> {
  const until = Date.now() + FIND_BUSY_WAIT_MS;
  while (runsInside(seriesId) > 0) {
    if (halted(a) || Date.now() > until) return false;
    await nap(100);
  }
  return true;
}

/** How many visible series read through any source of this package: as main, or as a follower. */
async function packageUse(pkg: string): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT count(DISTINCT s.id)::int AS n FROM lib_series s
      WHERE ${visibleToAll('s')}
        AND (s.source_id IN (SELECT '${SW_PREFIX}' || source_id FROM suwayomi_sources WHERE pkg_name = $1)
          OR EXISTS (SELECT 1 FROM series_sources f WHERE f.series_id = s.id
                      AND f.source_id IN (SELECT '${SW_PREFIX}' || source_id FROM suwayomi_sources WHERE pkg_name = $1)))`,
    [pkg]).catch(() => null);
  return row?.n ?? 0;
}

/**
 * Keep a package this run installed when a series reads through it, else remove it -- the uninstall route's way: the
 * engine's uninstall, then the package's rows and their orphaned health rows, then a reload. Never anything this run did
 * not install, and each package once. `missed`: the targets it was asked about and does not carry, recorded with the
 * run (Stored.tried) so no run tries it for them again within TRIED_DAYS.
 */
async function settle(a: Run, inst: Installed, missed: string[] = []): Promise<void> {
  if (inst.settled) return;
  inst.settled = true;
  if (missed.length) a.tried.push({ pkg: inst.pkg, lang: inst.lang, series: missed });
  // adoptExtensionSources records no package; the registration's own remember() does, from the engine's answer. Written
  // here too, so whether a package is used never depends on the engine having said.
  await q(`UPDATE suwayomi_sources SET pkg_name = $2 WHERE source_id = ANY($1::text[]) AND pkg_name IS NULL`,
    [inst.ids, inst.pkg]).catch(() => {});
  const n = inst.sourceId ? await packageUse(inst.pkg) : 0;
  if (n > 0) {
    a.keptPkgs.push({ name: inst.name, series: n });
    did(a, 'installed', 1, say('autofix.item.installed', { name: inst.name, n }));
    return;
  }
  now(a, say('autofix.now.removing', { name: inst.name }));
  const provided = await sourcesOfExtension(inst.pkg).catch(() => []);
  try { await setExtensionState(inst.pkg, 'uninstall'); } catch { /* the engine's own; what is recorded goes regardless */ }
  const ids = [...new Set([...provided.map((s) => s.id), ...inst.ids])];
  await q('DELETE FROM suwayomi_sources WHERE source_id = ANY($1)', [ids]).catch(() => {});
  await pruneOrphanedHealth(ids.map((x) => `${SW_PREFIX}${x}`)).catch(() => 0);
  await logAudit('extension.uninstall', { userId: a.by, detail: { pkgName: inst.pkg, via: 'autofix', runId: a.id } });
  a.removedPkgs.push(inst.name);
  did(a, 'uninstalled', 1, say('autofix.item.uninstalled', { name: inst.name }));
  await reloadAll().catch(() => null);
}

// ── 9. files ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The later copy of a chapter saved twice is deleted only when the copy kept is complete: every file of the earlier
 * group counted (pages > 0), whole (no placeholder pages), and at least as many pages as the later group -- and the
 * delete's own guards hold (libraryAdmin.ts deleteChapterFiles: the download folder only, never a bookmarked chapter).
 * Then the chapters with an impossible number, the same way. What is skipped is Needs you.
 */
async function files(a: Run): Promise<void> {
  await held(async () => {
    now(a, say('autofix.now.files'));
    for (const series of await savedTwiceGroups().catch(() => [])) {
      if (halted(a)) return;
      const ids: string[] = [];
      for (const g of series.groups) {
        const facts = new Map((await q<{ id: string; pages: number; missing: number[] | null; root: string | null; pruned: boolean }>(
          'SELECT id, pages, missing_pages AS missing, root, pruned_at IS NOT NULL AS pruned FROM lib_books WHERE id = ANY($1::text[])',
          [[...g.earlier, ...g.later].map((b) => b.id)]).catch(() => [])).map((r) => [r.id, r]));
        const earlier = g.earlier.map((b) => facts.get(b.id));
        const later = g.later.map((b) => facts.get(b.id));
        if (earlier.some((b) => !b || b.pruned || b.pages <= 0 || (b.missing?.length ?? 0) > 0)) continue;
        if (later.some((b) => !b || b.root !== DL_ROOT)) continue;
        const kept = earlier.reduce((n, b) => n + (b?.pages ?? 0), 0);
        const gone = later.reduce((n, b) => n + (b?.pages ?? 0), 0);
        // Reintroduce by dropping it: "a later copy is deleted only when the kept copy is complete" in autofix.int.test.ts
        // deletes the longer later copy.
        if (kept < gone) continue;
        ids.push(...g.later.map((b) => b.id));
      }
      if (!ids.length) continue;
      now(a, say('autofix.now.files'), { title: series.title, seriesIds: [series.seriesId] });
      const r = await deleteChapterFiles(series.seriesId, ids, { userId: a.by, via: 'autofix', runId: a.id });
      if ('applied' in r && r.applied) {
        did(a, 'deletedTwice', r.applied, say('autofix.item.deleted', { title: series.title, n: r.applied, seriesIds: [series.seriesId] }));
      }
    }
    // Impossible numbers: the Health check's own findings (an ignored one is left), every such chapter of each series.
    const report = await runHealthChecks().catch(() => null);
    const odd = report?.checks.find((c) => c.id === 'outliers')?.items.filter((i) => !i.info && i.seriesId) ?? [];
    for (const it of odd) {
      if (halted(a)) return;
      const have = await haveNumbers(it.seriesId!).catch(() => [] as number[]);
      const limit = impossibleLimit(have);
      if (limit === null) continue;
      const books = await q<{ id: string }>(
        `SELECT b.id FROM lib_books b LEFT JOIN book_overrides o ON o.book_id = b.id
          WHERE b.series_id = $1 AND b.pruned_at IS NULL AND COALESCE(o.number, b.number) > $2`, [it.seriesId, limit]).catch(() => []);
      if (!books.length) continue;
      now(a, say('autofix.now.files'), { title: it.title, seriesIds: [it.seriesId!] });
      const r = await deleteChapterFiles(it.seriesId!, books.map((b) => b.id), { userId: a.by, via: 'autofix', runId: a.id });
      if ('applied' in r && r.applied) did(a, 'deletedOdd', r.applied, say('autofix.item.deleted', { title: it.title, n: r.applied, seriesIds: [it.seriesId!] }));
    }
  });
}

// ── 10. recheck, and the summary ────────────────────────────────────────────────────────────────────────────────

async function recheckReport(a: Run): Promise<HealthReport> {
  now(a, say('autofix.now.rechecking'));
  const report = await runHealthChecks();
  await storeHealthSummary(report).catch(() => {});
  // What a rate limit holds back clears by itself (v0.55.1): the summary needs which sources rest now, and which failed
  // chapters a rate limit caused, beside what Health says.
  a.restingAtEnd = await restingSources();
  a.limitedRows = new Map((await q<{ source_id: string; n: number }>(
    `SELECT f.source_id, count(*)::int AS n FROM chapter_failures f JOIN lib_series s ON s.id = f.series_id AND ${visibleToAll('s')}
      WHERE f.status = 'rate_limited' GROUP BY f.source_id`).catch(() => [])).map((r) => [r.source_id, Number(r.n)]));
  return report;
}

/** The done kinds, the ones that matter most to a person first: the summary keeps DONE_MAX of them. */
const DONE_ORDER: DoneKind[] = [
  'replaced', 'installed', 'merged', 'fetched', 'refetched', 'shortFixed', 'renumbered', 'deletedTwice', 'deletedOdd', 'linked',
  'retired', 'unblocked', 'failuresCleared', 'shortConfirmed', 'resumedRenumber', 'engineConnected', 'solverReset', 'uninstalled',
  'tested', 'scanned',
];

/** A list of names as the done lines carry it: the first three, and how many more. */
const named = (list: string[]) => ({ names: list.slice(0, 3), more: Math.max(0, list.length - 3) });

function doneLines(a: Run): AutofixSummary['done'] {
  const out: AutofixSummary['done'] = [];
  for (const kind of DONE_ORDER) {
    const n = a.counts[kind] ?? 0;
    if (n <= 0) continue;
    const counted = a.counted;
    // v0.55.1: the extensions phase is one line however many it tried -- "Tried 14 extensions and kept Ember Pages" -- or,
    // none kept, "Tried 14 extensions: none of the series were there"; what each one did is under Details.
    const said: Part | null = kind === 'replaced' ? say('autofix.done.replaced', { n, ...named(a.replacedNames) })
      : kind === 'installed' ? say('autofix.done.tried', { n: a.installs, ...named(a.keptPkgs.map((p) => p.name)) })
      : kind === 'uninstalled' ? (a.counts.installed ? null : say('autofix.done.triedNone', { n: a.installs }))
      : kind === 'scanned' ? (counted ? say('autofix.done.counted', { n: counted }) : say('autofix.done.scanned'))
      : kind === 'engineConnected' ? say('autofix.done.engineConnected')
      : say(`autofix.done.${kind}` as 'autofix.done.merged', { n });
    if (!said) continue;
    const items = a.items[kind];
    out.push({ kind, n, said: saidOf(said), ...(items?.length ? { items } : {}) });
    if (out.length >= DONE_MAX) break;
  }
  return out;
}

/** A finding row: an item that is not `info`. */
const findings = (c: HealthCheck | undefined): HealthItem[] => (c && c.status !== 'ok' ? c.items.filter((i) => !i.info) : []);
const healthKey = (check: string): NeedsYouAction => ({ kind: 'health', check });

/**
 * What is left after the run, from Health as it reads now, sorted into what only a person can do (Needs you: one line
 * per kind, with its one key) and what clears by itself (with when, where there is a time). `green` is true when nothing
 * but Needs you is left. ⚠️ Nothing here ignores anything: an unfixable finding is said, never hidden.
 *
 * ⚠️ Needs you never holds what a run could still fix (the v0.55.0 integration): a card's finding is a person's only once
 * every phase that works on that card has run to its end in this run (`a.finished`). A run stopped before its duplicates
 * phase has not looked at the duplicates, and one cut short by its time, its Tests or its installs has not finished with
 * what it left: those are "the next Fix everything continues", which is what `again` says. Reintroduce by sorting a
 * card's findings into Needs you whatever the run reached: "a stopped run leaves what it did not reach to the next run"
 * in autofix.int.test.ts finds the duplicates, the renumbering and the impossible number under Needs you.
 */
function summarise(a: Run, report: HealthReport): AutofixSummary {
  const by = new Map(report.checks.map((c) => [c.id, c]));
  const needsYou: AutofixSummary['needsYou'] = [];
  const clears: AutofixSummary['clears'] = [];
  const need = (check: string, p: Part, action: NeedsYouAction = healthKey(check)) => needsYou.push({ check, said: saidOf(p), action });
  // One line per thing: a source cooling down is named by its Source health row and by its failed chapters' row, and is
  // said once, with its cooldown's end if either knows it. Reintroduce by pushing every line: "a 429 failure is not
  // retried by the run" in autofix.int.test.ts finds af-nato cooling down twice.
  const clear = (p: Part, at?: string | null) => {
    const said = saidOf(p);
    const same = clears.find((c) => c.said.code === said.code && JSON.stringify(c.said.params ?? {}) === JSON.stringify(said.params ?? {}));
    if (same) { if (at && !same.at) same.at = at; return; }
    clears.push({ said, ...(at ? { at } : {}) });
  };
  /** Findings a run did not get to (stopped, or out of time, searches, Tests or installs): the next one continues. */
  let leftover = 0;
  /** `n` findings of a card the phases named work on: a person's once all of them ran to their end, else the next run's. */
  const needAfter = (phases: AutofixPhase[], check: string, n: number, p: Part) => {
    if (n <= 0) return;
    if (phases.every((ph) => a.finished.has(ph))) need(check, p);
    else leftover += n;
  };

  const solverCheck = by.get('solver');
  if (solverCheck && solverCheck.status !== 'ok') {
    // Down is the operator's whatever the run did; answering but failing is the solver step's to reset first. With a
    // backup (v0.55.4) one of the two may be down while the other solves: that one is the operator's too, by name.
    // Reintroduce the two-way split: "with the main down and the backup solving" in autofix.int.test.ts reads that the
    // solver keeps failing.
    const said = (solverCheck.summarySaid ?? []).map((p) => p.code);
    if (said[0] === 'solver.down') need('solver', say('autofix.needs.solverDown'));
    else if (said[0] === 'solver.backupSolving') need('solver', say('autofix.needs.mainSolverDown'));
    else {
      if (said.includes('solver.backupQuiet')) need('solver', say('autofix.needs.backupSolverDown'));
      if (said[0] === 'solver.blaming') needAfter(['solver'], 'solver', 1, say('autofix.needs.solverFailing'));
    }
  }
  // The engine: what the solver phase connects (its Cloudflare helper) is the run's until that phase has run; the rest
  // -- an engine that is down, an older one -- is the operator's.
  const engine = findings(by.get('extension-engine'));
  const connectable = engine.filter((i) => i.actions?.includes('engine_solver')).length;
  if (engine.length > connectable) need('extension-engine', say('autofix.needs.engine'));
  else needAfter(['solver'], 'extension-engine', connectable, say('autofix.needs.engine'));
  if (findings(by.get('folders-twice')).length) need('folders-twice', say('autofix.needs.foldersTwice'));
  const cap = findings(by.get('extension-cap'));
  if (cap.length) {
    const n = Number(by.get('extension-cap')!.summarySaid?.[0]?.params?.n ?? cap.length);
    need('extension-cap', say('autofix.needs.sourceLimit', { n }));
  }
  for (const name of a.noRoom) need('extension-cap', say('autofix.needs.noRoom', { name }));
  const scanned = findings(by.get('library-scan'));
  if (scanned.length) need('library-scan', say('autofix.needs.scan', { n: scanned.length }));
  const missing = findings(by.get('downloads-missing'));
  if (missing.length) {
    const n = Number(by.get('downloads-missing')!.summarySaid?.[0]?.params?.n ?? missing.length) || missing.length;
    need('downloads-missing', say('autofix.needs.downloadsMissing', { n }));
  }

  // Series that can no longer update: the limit is a slot to free, the engine is its own row's; the rest no source carries
  // -- once Replace and the extensions phase have both had their go at them.
  const frozen = findings(by.get('frozen-series'));
  const slot = frozen.filter((i) => i.actions?.includes('free_slot')).length;
  const engineBound = frozen.filter((i) => /^frozen\.engine/.test(i.detailSaid?.[0]?.code ?? '')).length;
  const stuck = frozen.length - slot - engineBound;
  if (slot) need('frozen-series', say('autofix.needs.freeSlot', { n: slot }));
  needAfter(['sources', 'extensions'], 'frozen-series', stuck, say('autofix.needs.frozen', { n: stuck }));
  if (engineBound && !needsYou.some((x) => x.check === 'extension-engine')) need('extension-engine', say('autofix.needs.engine'));

  // Sources: a cooldown and a slow streak end by themselves; a failure that is still there needs a person.
  const src = findings(by.get('sources'));
  for (const it of src.filter((i) => i.state === 'blocked')) {
    const until = it.cooldown?.until && Date.parse(it.cooldown.until) > Date.now() ? it.cooldown.until : null;
    clear(say('autofix.clears.cooldown', { name: it.title }), until);
  }
  const slow = src.filter((i) => i.state === 'slow' || i.state === 'empty').length;
  if (slow) clear(say('autofix.clears.slow', { n: slow }));
  const failing = src.filter((i) => i.state === 'failing' || i.state === 'inconclusive' || i.state === 'untested').length;
  needAfter(['sources'], 'sources', failing, say('autofix.needs.sourceFailing', { n: failing }));

  const dupes = findings(by.get('duplicates')).length;
  needAfter(['duplicates'], 'duplicates', dupes, say('autofix.needs.duplicates', { n: dupes }));
  // A plan passed over while a download or a check was inside its series was not judged: the next run's.
  const renumAll = findings(by.get('numbering')).length;
  const renumBusy = Math.min(renumAll, a.numberingBusy);
  leftover += renumBusy;
  needAfter(['numbering'], 'numbering', renumAll - renumBusy, say('autofix.needs.numbering', { n: renumAll - renumBusy }));
  const odd = findings(by.get('outliers'));
  const oddN = odd.reduce((k, i) => k + (i.bookIds?.length ?? 1), 0);
  needAfter(['files'], 'outliers', odd.length ? oddN : 0, say('autofix.needs.outliers', { n: oddN }));
  const twice = findings(by.get('saved-twice'));
  const twiceN = twice.reduce((k, i) => k + (i.bookIds?.length ?? 1), 0);
  needAfter(['files'], 'saved-twice', twice.length ? twiceN : 0, say('autofix.needs.twice', { n: twiceN }));

  // Short chapters: tried again tomorrow when a source was silent or still cooling; partial ones are the sweep's; the
  // ones the run's searches ran out before are the next run's (a run starts with searches of its own); the rest are a
  // person's call (It's fine, or a copy of their own).
  const short = findings(by.get('short-chapters'));
  const AGAIN = new Set(['source_silent', 'hunt_cooldown', 'download_failed']);
  const shortAgain = short.filter((i) => i.outcome?.kind === 'short' && AGAIN.has(i.outcome.why)).length;
  const shortPartial = short.filter((i) => i.outcome?.kind === 'short' && i.outcome.why === 'partial').length;
  const shortUntried = short.filter((i) => !i.outcome || (i.outcome.kind === 'short' && i.outcome.why === 'no_searches')).length;
  const shortYours = short.length - shortAgain - shortPartial - shortUntried;
  if (shortAgain) clear(say('autofix.clears.tomorrow', { n: shortAgain }), new Date(Date.now() + 24 * 3600_000).toISOString());
  if (shortPartial) clear(say('autofix.clears.partial', { n: shortPartial }));
  leftover += shortUntried;
  needAfter(['chapters'], 'short-chapters', shortYours, say('autofix.needs.short', { n: shortYours }));

  // Chapters that would not download: a source that is off is a person's; reset rows wait for the sweep; rows of a
  // source still failing at their chapters no source here can download.
  // v0.55.1: what a rate limit holds back clears by itself, never Needs you -- every row of a source cooling down or
  // rate-limited now (with the cooldown's end), and a row a rate limit caused on any source. The owner's first run
  // listed 25 such chapters under Needs you. Reintroduce by dropping both: "a 429 failure is not retried by the run and
  // ends in what clears by itself" in autofix.int.test.ts finds chapter-failures under Needs you.
  const fails = findings(by.get('chapter-failures'));
  let sweepN = 0, stuckN = 0;
  for (const it of fails) {
    const n = Number(it.detailSaid?.[0]?.params?.n ?? 1) || 1;
    const cooling = it.caveats?.find((c) => c.code === 'source_cooling_down');
    const resting = it.sourceId && a.restingAtEnd.has(it.sourceId);
    const limited = Math.min(n, (it.sourceId && a.limitedRows.get(it.sourceId)) || 0);
    if (it.caveats?.some((c) => c.code === 'source_off')) stuckN += n;
    else if (cooling || resting) clear(say('autofix.clears.cooldown', { name: it.title }), cooling?.until ?? a.restingAtEnd.get(it.sourceId!) ?? null);
    else if (it.outcome?.kind === 'failures' && it.outcome.resetPending) sweepN += n;
    else {
      if (limited) clear(say('autofix.clears.cooldown', { name: it.title }));
      stuckN += n - limited;
    }
  }
  if (sweepN) clear(say('autofix.clears.sweep', { n: sweepN }));
  needAfter(['chapters'], 'chapter-failures', stuckN, say('autofix.needs.failures', { n: stuckN }));

  // Gaps: a paused series is a person's; one searched too recently is asked again tomorrow; the rest wait for the next
  // run (out of time or searches), or -- searched, and nobody had them -- go grey once answered.
  const gaps = findings(by.get('chapter-gaps'));
  const paused = gaps.filter((i) => i.caveats?.some((c) => c.code === 'updates_paused')).length;
  const cooldown = gaps.filter((i) => !i.caveats?.some((c) => c.code === 'updates_paused') && i.outcome?.kind === 'gaps' && i.outcome.why === 'cooldown').length;
  if (paused) need('chapter-gaps', say('autofix.needs.gapsPaused', { n: paused }));
  if (cooldown) clear(say('autofix.clears.tomorrow', { n: cooldown }), new Date(Date.now() + 24 * 3600_000).toISOString());
  leftover += gaps.length - paused - cooldown;
  if (leftover) clear(say('autofix.clears.nextRun', { n: leftover }));

  const green = clears.length === 0;
  // Run again is worth it while a run has something left to change; a cooldown, the sweep or Needs you alone is not that.
  return { green, again: leftover > 0, done: doneLines(a), clears, needsYou };
}
