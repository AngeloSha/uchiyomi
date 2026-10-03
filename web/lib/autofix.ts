/**
 * Health's "Fix everything" (v0.55.0): the web half of the autofix run, with no React in it.
 *
 * The owner: "the fix all button in health should … give an option to auto pick stuff or to manually do it … for auto
 * it just shows at the end what happened and what it did in short without cluttering". Fix all issues was the repair
 * alone -- failed chapters, short chapters, five series of gaps, the solver -- and it vanished when only the other cards
 * were amber. The server now runs ONE background run that drives every existing remedy in turn (bff lib/autofix.ts:
 * ten phases, Stop at a safe point, a stored record), and ends with a summary in three groups: what it did, what clears
 * by itself, and what only a person can do. These are the rules for showing it, apart from the components
 * (components/FixEverythingDialog.tsx), so a test can hold each one:
 * - the key shows whenever any card has a finding, or a run is going, or one this page saw has not been read;
 * - the run polls every 2 s, and the dialog opens on the run while one goes, never on the question;
 * - the end is ONE headline -- what needs you first, else "All green" exactly when the server says so -- at most six
 *   lines of what it did, and each Needs-you item with its one key; everything else is behind Details;
 * - Run again only while something a run could still change is left (the server's `again`).
 *
 * Every sentence of the summary is a said code worded by lib/said.ts (the server's English never reaches the page). A
 * line this build cannot word is left out rather than shown half in English -- except a Needs-you item, which is never
 * hidden: it falls back to its card's name.
 */
import { keys, t as tr } from './i18n';
import { untilText } from './format';
import { saidWords, type Said } from './said';
import { checkTitle } from './healthCopy';
import type { RepairStatus } from './repairRun';
import type { FindStatus } from './findSources';
import type { Tone } from './status';
import type { HealthCheck } from './types';

// ---- the server's shapes (the v0.55.0 contract, §1) ----------------------------------------------------------------

export type AutofixPhase =
  | 'preflight' | 'scan' | 'solver' | 'sources' | 'duplicates' | 'numbering' | 'chapters' | 'extensions' | 'files' | 'recheck';

/** The phases in the order the run takes them (bff lib/autofix.ts PHASES). */
export const AUTOFIX_PHASES: readonly AutofixPhase[] = [
  'preflight', 'scan', 'solver', 'sources', 'duplicates', 'numbering', 'chapters', 'extensions', 'files', 'recheck',
];

export type AutofixStatusWord = 'running' | 'done' | 'stopped' | 'failed' | 'interrupted';

export type DoneKind =
  | 'replaced' | 'retired' | 'tested' | 'unblocked' | 'linked' | 'merged' | 'renumbered' | 'fetched' | 'refetched'
  | 'shortFixed' | 'shortConfirmed' | 'failuresCleared' | 'installed' | 'uninstalled' | 'deletedTwice' | 'deletedOdd' | 'scanned'
  | 'resumedRenumber' | 'solverReset' | 'engineConnected';

/** The one thing a person can do about a Needs-you item: open a page, see a Health card, or Admin → Settings. */
export type NeedsYouAction = { kind: 'open'; href: string } | { kind: 'health'; check: string } | { kind: 'settings'; key: string };

export interface AutofixSummary {
  /**
   * Nothing but Needs you is left (Version's info row does not count). ⚠️ Not "nothing is left": with the solver down it
   * is true beside that Needs-you item (the contract's "Changed by S" 1), so the headline reads Needs you first.
   */
  green: boolean;
  /**
   * Something a run could still change is left -- what this one did not get to -- never a cooldown, the sweep or Needs
   * you alone (the integration's contract change): Run again is offered on it.
   */
  again: boolean;
  /** What it did, one entry per kind, most telling first; `items` names what it installed, merged or deleted. */
  done: Array<{ kind: DoneKind; n: number; said: Said; items?: Said[] }>;
  /** What clears by itself: a cooldown until `at`, a retry tomorrow, what the next run continues. */
  clears: Array<{ said: Said; at?: string }>;
  /** What only a person can do, each with its one action. */
  needsYou: Array<{ check: string; said: Said; action?: NeedsYouAction }>;
}

export interface AutofixRun {
  id: string;
  status: AutofixStatusWord;
  startedAt: string;
  finishedAt?: string;
  /** Who pressed it; null for the nightly. */
  by: string | null;
  /** The phase it is in while it runs. */
  phase: AutofixPhase | null;
  /** 0-based, of AUTOFIX_PHASES.length. */
  phaseIndex: number;
  /** Stop was asked, and the run is winding down to its next safe point: every viewer's "Stopping…". */
  stopping?: boolean;
  /** "Now: …": the series it is on, how far into the phase, or what it waits for. */
  current?: { title?: string; done?: number; of?: number; said?: Said };
  summary?: AutofixSummary;
  /** The full detail, for Details: at most 200 lines, newest last. */
  log?: Said[];
}

/** GET /api/admin/health/autofix: the live run, and the newest finished one. */
export interface AutofixStatus {
  run: AutofixRun | null;
  last: AutofixRun | null;
}

// ---- the run, as it goes --------------------------------------------------------------------------------------------

/**
 * Each phase in the words a person reads while it runs, in AUTOFIX_PHASES' order. Declared through keys(): they reach
 * tr() through `autofixPhaseLabel` (lib/i18n.ts).
 */
export const AUTOFIX_PHASE_LABELS = keys(
  'Getting ready', 'Scanning the library', 'Resetting the solver', 'Testing and replacing sources', 'Merging duplicates',
  'Applying safe renumbering', 'Fetching missing and broken chapters', 'Looking for new sources', 'Removing extra chapter files',
  'Checking Health again',
);

/** The phase in words; nothing for a phase this build does not know (a newer server's). */
export function autofixPhaseLabel(phase: string | null | undefined): string {
  const i = AUTOFIX_PHASES.indexOf(phase as AutofixPhase);
  return i < 0 ? '' : tr(AUTOFIX_PHASE_LABELS[i]);
}

/** "Step 4 of 10": the phase it is in, of the ten. */
export function autofixStepOf(run: Pick<AutofixRun, 'phaseIndex'>): string {
  const n = AUTOFIX_PHASES.length;
  return tr('Step {i} of {n}', { i: Math.min(n, Math.max(0, run.phaseIndex ?? 0) + 1), n });
}

/** "Step 4 of 10 · Testing and replacing sources". */
export function autofixStepLine(run: Pick<AutofixRun, 'phase' | 'phaseIndex'>): string {
  return [autofixStepOf(run), autofixPhaseLabel(run.phase)].filter(Boolean).join(' · ');
}

/**
 * How far the run has got, 0..1, over the ten phases: the phases behind it, and how far into this one when the server
 * says (`current.done` of `current.of`). A finished run is a full bar.
 */
export function autofixProgress(run: Pick<AutofixRun, 'status' | 'phaseIndex' | 'current'> | null | undefined): number {
  if (!run) return 0;
  if (run.status === 'done') return 1;
  const n = AUTOFIX_PHASES.length;
  const i = Math.min(n, Math.max(0, run.phaseIndex ?? 0));
  const of = run.current?.of ?? 0;
  const within = of > 0 ? Math.min(1, Math.max(0, (run.current?.done ?? 0) / of)) : 0;
  return Math.min(1, (i + within) / n);
}

/** How far into the phase, "12 of 40", when the server counts it. */
export function autofixCount(run: Pick<AutofixRun, 'current'>): string {
  const c = run.current;
  return c?.of && c.of > 1 ? tr('{done} of {of}', { done: Math.min(c.of, Math.max(0, c.done ?? 0)), of: c.of }) : '';
}

/** What the run waits for, or what it is doing that has no title -- the server's sentence; '' when there is none. */
export function autofixWait(run: Pick<AutofixRun, 'current'>): string {
  return saidWords(run.current?.said) ?? '';
}

// ---- following it -----------------------------------------------------------------------------------------------------

/** How often the run is asked while it goes: the repair's and Find's 2 s. */
export const AUTOFIX_POLL_MS = 2000;

/**
 * When to ask again: every 2 s while a run goes or one this page started has not been seen to end, else `idle`.
 * Reintroduce `false` for the running case: "the run is polled while it goes" in autofix.test.ts fails.
 */
export function autofixPollMs(data: AutofixStatus | undefined, waiting: boolean, idle: number | false = false): number | false {
  return data?.run?.status === 'running' || waiting ? AUTOFIX_POLL_MS : idle;
}

/**
 * The runs that ended between two answers: the one running at the last answer and not now, and one THIS page started
 * once the answer shows it finished (as `last`). ⚠️ Never merely because it is not running: an answer from before the
 * press does not show it yet (lib/findSources.ts findEndedRunIds, the same rule).
 */
export function autofixEndedIds(prev: AutofixStatus | null | undefined, next: AutofixStatus, awaiting: Iterable<string>): string[] {
  const out = new Set<string>();
  const live = next.run?.status === 'running' ? next.run.id : null;
  if (prev?.run?.status === 'running' && prev.run.id !== live) out.add(prev.run.id);
  for (const id of awaiting) {
    if (!id || id === live) continue;
    if (next.last?.id === id || (next.run?.id === id && next.run.status !== 'running')) out.add(id);
  }
  return [...out];
}

/** This page's own press, until its run has been read back (lib/healthCopy.ts Slot, for one run). */
export interface AutofixSlot {
  phase: 'starting' | 'awaiting' | 'settling' | 'ended' | 'refused' | 'failed';
  runId?: string;
  startedAt: number;
  finishedAt?: number;
  reason?: string;
}

export type FixView = 'ask' | 'run' | 'end';

/**
 * Which view the dialog opens on, and the run it shows:
 * - a run going -- this page's, another admin's, the nightly's -- is the run, never the question;
 * - a press the server has not answered yet is the run, starting;
 * - a run this page saw, or started, that has ended is its end, until the end is set aside (Close, or a new run);
 * - anything else asks.
 * Reintroduce the question for a live run (drop the first branch): "a live run opens the run" in autofix.test.ts fails.
 */
export function fixView(o: {
  status?: AutofixStatus | null;
  slot?: AutofixSlot | null;
  seen: ReadonlySet<string>;
  aside: ReadonlySet<string>;
}): { view: FixView; run: AutofixRun | null } {
  const live = o.status?.run?.status === 'running' ? o.status.run : null;
  if (live) return { view: 'run', run: live };
  const slot = o.slot;
  const last = o.status?.last ?? (o.status?.run && o.status.run.status !== 'running' ? o.status.run : null);
  if (slot && (slot.phase === 'starting' || (slot.phase === 'awaiting' && (!slot.runId || last?.id !== slot.runId)))) return { view: 'run', run: null };
  if (last && last.status !== 'running' && (o.seen.has(last.id) || last.id === slot?.runId) && !o.aside.has(last.id)) {
    return { view: 'end', run: last };
  }
  return { view: 'ask', run: null };
}

// ---- the end ---------------------------------------------------------------------------------------------------------

export type HeadlineKind = 'green' | 'needs' | 'calm' | 'stopped' | 'failed' | 'interrupted';

/**
 * The one line the end opens with, and the line under it:
 * - a run that failed or was cut short by a restart says so first: its summary, if it has one, is not the whole story;
 * - "2 need you" (the pair: "1 needs you") with the amber mark whenever something only a person can do is left -- with
 *   "Everything else is green" under it when the server says nothing else is left (`green`), as the sketch the owner
 *   saw has it. ⚠️ `green` is true beside Needs-you items (the solver down is one), so it is never read first: "All
 *   green" over "1 needs you" was the merge's bug;
 * - otherwise "All green", with the emerald mark, exactly when the server says so;
 * - otherwise a stopped run says it stopped, and a finished one "Nothing needs you": what is left clears by itself, and
 *   the clears lines say when. Amber is for real problems only.
 * Reintroduce `if (s?.green)` before the Needs-you branch: "the solver down reads All green" in autofix.test.ts fails.
 */
export function autofixHeadline(run: Pick<AutofixRun, 'status' | 'summary'>): { kind: HeadlineKind; tone: Tone; text: string; sub?: string } {
  if (run.status === 'failed') return { kind: 'failed', tone: 'problem', text: tr('The run failed. The server log has the details.') };
  if (run.status === 'interrupted') return { kind: 'interrupted', tone: 'warn', text: tr('Interrupted by a restart') };
  const s = run.summary;
  const n = s?.needsYou.length ?? 0;
  if (n > 0) {
    return {
      kind: 'needs', tone: 'warn', text: n === 1 ? tr('1 needs you') : tr('{n} need you', { n }),
      ...(s?.green ? { sub: tr('Everything else is green') } : {}),
    };
  }
  if (s?.green) return { kind: 'green', tone: 'ok', text: tr('All green') };
  if (run.status === 'stopped') return { kind: 'stopped', tone: 'info', text: tr('Stopped before it finished') };
  return { kind: 'calm', tone: 'accent', text: tr('Nothing needs you') };
}

/** How many of what it did the end shows; the rest are under Details. */
export const DONE_SHOWN = 6;

export interface DoneLine { kind: DoneKind; text: string; items: string[] }

/**
 * What it did, worded: the first six for the end, the rest for Details. A line this build cannot word is left out. Each
 * line's `items` -- what it installed, merged, deleted -- go under Details; one that says its line again word for word
 * ("Moved 2 series off fake-a" under "Moved 2 series off fake-a", Replace off one source) is left out, so Details holds
 * only what the line does not already say. Reintroduce by keeping every item: "an item that repeats its line" fails.
 */
export function doneLines(s: Pick<AutofixSummary, 'done'> | null | undefined): { shown: DoneLine[]; rest: DoneLine[] } {
  const all = (s?.done ?? []).map((d) => {
    const text = saidWords(d.said) ?? '';
    return { kind: d.kind, text, items: (d.items ?? []).map((x) => saidWords(x) ?? '').filter((t) => t && t !== text) };
  }).filter((d) => d.text);
  return { shown: all.slice(0, DONE_SHOWN), rest: all.slice(DONE_SHOWN) };
}

/** A Needs-you item's one key: a link (`page`: a whole page load, for another of the console's tabs), or its card. */
export type NeedsYouKey =
  | { kind: 'link'; href: string; label: string; page: boolean; external: boolean }
  | { kind: 'card'; check: string; label: string };

/** Only the app's own addresses and web pages: a server-sent `javascript:` never becomes a link. */
const safeHref = (h: string): boolean => (/^\/(?!\/)/.test(h) || /^https?:\/\//i.test(h)) && !/[\s<>"]/.test(h);

/**
 * The one key of a Needs-you item: `open` opens its page, `health` shows its card on this page, `settings` opens Admin
 * → Settings. ⚠️ The console reads its tab from the address ONCE (lib/useTabParam.ts), so a link to another of its tabs
 * is a whole page load (`page`), never a client-side navigation that would leave Health on screen.
 */
export function needsYouKey(a: NeedsYouAction | null | undefined): NeedsYouKey | null {
  if (!a) return null;
  switch (a.kind) {
    case 'open':
      if (typeof a.href !== 'string' || !safeHref(a.href)) return null;
      return { kind: 'link', href: a.href, label: tr('Open'), page: /^\/admin\//.test(a.href), external: /^https?:/i.test(a.href) };
    case 'health':
      return a.check ? { kind: 'card', check: a.check, label: tr('Show the card') } : null;
    case 'settings':
      return { kind: 'link', href: '/admin/?tab=Settings', label: tr('Settings'), page: true, external: false };
  }
  return null;
}

export interface NeedsYouLine { check: string; text: string; key: NeedsYouKey | null }

/**
 * What only a person can do, each with its key. NEVER left out for want of words -- it is why the headline says "2 need
 * you" -- so a sentence this build cannot word falls back to its card's name.
 */
export function needsYouLines(s: Pick<AutofixSummary, 'needsYou'> | null | undefined): NeedsYouLine[] {
  return (s?.needsYou ?? []).map((n) => ({
    check: n.check,
    text: saidWords(n.said) ?? checkTitle({ id: n.check, title: n.check }),
    key: needsYouKey(n.action),
  }));
}

/** What clears by itself, with when ("in 3 hours") where the server says. */
export function clearsLines(s: Pick<AutofixSummary, 'clears'> | null | undefined, now = Date.now()): Array<{ text: string; when: string }> {
  return (s?.clears ?? []).map((c) => {
    const at = c.at ? Date.parse(c.at) : NaN;
    return { text: saidWords(c.said) ?? '', when: Number.isFinite(at) ? untilText(at - now) : '' };
  }).filter((c) => c.text);
}

/** The log, worded, for Details. */
export function logLines(run: Pick<AutofixRun, 'log'>): string[] {
  return (run.log ?? []).map((l) => saidWords(l) ?? '').filter(Boolean);
}

/**
 * Run again, only while something a run could still change is left: the server's `again` -- what this run did not get
 * to -- never `!green`, which is also true of a cooldown or the sweep alone, where a second run changes nothing. A run
 * that failed or was cut short before its summary left everything it did not reach. Never while one runs. Reintroduce
 * `!run.summary.green`: "Run again for a cooldown alone" in autofix.test.ts fails.
 */
export function canRunAgain(run: Pick<AutofixRun, 'status' | 'summary'> | null | undefined): boolean {
  if (!run || run.status === 'running') return false;
  return run.summary ? run.summary.again === true : true;
}

// ---- Recent repairs ---------------------------------------------------------------------------------------------------

/** How many lines of what it did a Fix everything run shows under Recent repairs, after its headline. */
export const HISTORY_DONE = 2;

const STATUSES: readonly AutofixStatusWord[] = ['running', 'done', 'stopped', 'failed', 'interrupted'];

/**
 * A Fix everything run as Recent repairs holds it (it is kept with the repair's runs, kind `autofix`): its status and,
 * when the record carries them, its summary and log -- the history sends both, so a row never asks for its run. Null when
 * the record has no summary (a run that failed, or one cut short by a restart, before it said what was left).
 */
export function autofixOfRecord(r: { kind: string; status: string; result?: any }): Pick<AutofixRun, 'status' | 'summary' | 'log'> | null {
  if (r.kind !== 'autofix') return null;
  const sum = r.result?.summary;
  if (!sum || typeof sum !== 'object' || !Array.isArray(sum.done)) return null;
  return {
    status: (STATUSES as readonly string[]).includes(r.status) ? r.status as AutofixStatusWord : 'done',
    summary: {
      green: !!sum.green,
      again: sum.again === true,
      done: sum.done,
      clears: Array.isArray(sum.clears) ? sum.clears : [],
      needsYou: Array.isArray(sum.needsYou) ? sum.needsYou : [],
    },
    ...(Array.isArray(r.result?.log) ? { log: r.result.log } : {}),
  };
}

// ---- the key on Health -----------------------------------------------------------------------------------------------

/** How many cards have a finding: the ask view's "{n} cards need a look". */
export const cardsToLook = (checks: readonly Pick<HealthCheck, 'status'>[]): number => checks.filter((c) => c.status !== 'ok').length;

/**
 * Whether Health shows Fix everything: whenever ANY card has a finding -- not only the repair's four steps, as Fix all
 * issues did, which vanished while duplicates and a dead source were still amber -- and while a run goes or its end is
 * unread. Reintroduce the repair's plan as the rule: "the key shows for a finding the repair cannot touch" fails.
 */
export function showFixEverything(checks: readonly Pick<HealthCheck, 'status'>[], o: { live?: boolean; unread?: boolean } = {}): boolean {
  return cardsToLook(checks) > 0 || !!o.live || !!o.unread;
}

// ---- the nightly -------------------------------------------------------------------------------------------------------

/** What the nightly runs (the contract, §2): the safe repair, as before, or a whole Fix everything. */
export type NightlyMode = 'repair' | 'autofix';

/**
 * The nightly's mode from GET /api/admin/settings: `nightlyMode`, the contract's name and the one the server sends (in
 * camelCase, unlike the snake_case columns beside it). ONE name, read one way: anything else is the safe repair, the
 * default. Reintroduce a read of `nightly_mode` too: "the column's name is read" in autofix.test.ts fails.
 */
export function nightlyModeOf(settings: { nightlyMode?: unknown } | null | undefined): NightlyMode {
  return settings?.nightlyMode === 'autofix' ? 'autofix' : 'repair';
}

// ---- refusals --------------------------------------------------------------------------------------------------------

export type AutofixBusy = 'autofix' | 'repair' | 'find' | 'sweep';

/** A refused start in words: 409 `busy` says which run holds the server. */
export function autofixRefusal(running: string | null | undefined): string {
  switch (running) {
    case 'sweep': return tr('A chapter sweep is running; Fix everything can start when it ends');
    case 'repair': return tr('A repair is running; Fix everything can start when it ends');
    case 'find': return tr('A search for other sources is running; Fix everything can start when it ends');
    case 'autofix': return tr('Fix everything is already running');
  }
  return tr('Could not start Fix everything');
}

/**
 * What holds the server before Start is pressed, from what the page already follows: a sweep, a repair, or a Find /
 * Replace run. The server refuses beside each (409 `busy`); said where Start is, the key waits instead.
 */
export function autofixBlocked(repair: Pick<RepairStatus, 'running' | 'sweepRunning'> | null | undefined, find: Pick<FindStatus, 'running'> | null | undefined): AutofixBusy | null {
  if (repair?.sweepRunning) return 'sweep';
  if (repair?.running) return 'repair';
  if (find?.running) return 'find';
  return null;
}
