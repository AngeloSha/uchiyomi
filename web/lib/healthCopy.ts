/**
 * What every Health action does, how, how long it usually takes, and what it left behind (v0.49.0).
 *
 * The owner, about Admin -> Health: you cannot tell what each fix does, how it does it, how long it takes, or
 * whether it worked. The answers were in the code and nowhere on the page: "Fix all" on the failures card
 * reset week-old rows and re-checked nothing; "Reset solver sessions" on one row reset every source that
 * blamed the solver; "Fix all issues" promised no source would be unblocked while its solver step unblocked
 * them. This is ONE registry of the words, next to the server's limits and estimates, so a sentence cannot
 * drift from what the press does without a test here noticing.
 *
 * ⚠️ Each later v0.49.0 step that adds a HealthAction adds its entry here in the same commit
 * (healthActions.test.ts holds the union and this registry to each other). Every sentence is a tr() key, and
 * every count has its singular and its plural (web/test/localeCoverage.test.ts).
 */
import { keys, t as tr } from './i18n';
import { activeLocale, durationText, etaLine, relativeTime, untilText } from './format';
import { REPAIR_STEP_KEYS, repairStepLabel } from './jobs';
import { taskResult } from './tasks';
import type { ActionState } from './actionState';
import type { HealthCaveat, HealthCheck, HealthOutcome } from './types';
import type { RepairCurrent, RepairEstimate, RepairLiveRun, RepairPhase, RepairRunRecord, RepairSkip, RunTarget } from './repairRun';

// ---- check titles ------------------------------------------------------------------------------------

/**
 * Each check's title by id, in the English the server sends, so the page can translate it (the server's
 * summaries, details and notes stay English: a known limit). A check the page does not know shows the
 * server's own title.
 */
const CHECK_TITLE_KEYS = keys(
  'Chapter gaps', 'Suspiciously short chapters', 'Chapters that would not download', 'Series that can no longer update',
  'Source health', 'Duplicate series', 'Impossible chapter numbers', 'Cloudflare solver', 'Version',
  'Extension source limit', 'Library scan', 'Downloads missing from the library', 'Extension engine', 'Chapter numbering',
);
export const CHECK_TITLES: Readonly<Record<string, (typeof CHECK_TITLE_KEYS)[number]>> = {
  'chapter-gaps': CHECK_TITLE_KEYS[0],
  'short-chapters': CHECK_TITLE_KEYS[1],
  'chapter-failures': CHECK_TITLE_KEYS[2],
  'frozen-series': CHECK_TITLE_KEYS[3],
  sources: CHECK_TITLE_KEYS[4],
  duplicates: CHECK_TITLE_KEYS[5],
  outliers: CHECK_TITLE_KEYS[6],
  solver: CHECK_TITLE_KEYS[7],
  update: CHECK_TITLE_KEYS[8],
  'extension-cap': CHECK_TITLE_KEYS[9],
  'library-scan': CHECK_TITLE_KEYS[10],
  'downloads-missing': CHECK_TITLE_KEYS[11],
  // #72 (bff lib/engineHealth.ts): the one row about the extension engine itself.
  'extension-engine': CHECK_TITLE_KEYS[12],
  // #116: series whose chapter numbers wait for an admin, or were numbered by posting order by themselves.
  numbering: CHECK_TITLE_KEYS[13],
};

export function checkTitle(c: Pick<HealthCheck, 'id' | 'title'>): string {
  const k = CHECK_TITLES[c.id];
  return k ? tr(k) : c.title;
}

// ---- how long --------------------------------------------------------------------------------------

/**
 * How long a repair-backed action takes, said BEFORE the press: "Usually 40 sec · At most about 3 min of
 * searching and waiting · plus at most 20 chapter downloads".
 *
 * "Usually" is the median of the last runs of the same kind (the server keeps them); "at most" sums only the
 * waits the code bounds -- page lists, listings, the search wall -- and the downloads are a COUNT, never folded
 * into a time: a download has no bound in the code, so a number of minutes for it would be made up.
 */
export function timeLine(est: RepairEstimate | null | undefined): string {
  if (!est) return '';
  const parts: string[] = [];
  if (est.typicalMs != null && est.typicalMs > 0) parts.push(tr('Usually {d}', { d: durationText(est.typicalMs) }));
  if (est.worstMs != null && est.worstMs > 0) parts.push(tr('At most about {d} of searching and waiting', { d: durationText(est.worstMs) }));
  if (est.downloads > 0) parts.push(est.downloads === 1 ? tr('plus at most 1 chapter download') : tr('plus at most {n} chapter downloads', { n: est.downloads }));
  return parts.length ? parts.join(' · ') : tr('Takes a moment');
}

// ---- the registry ------------------------------------------------------------------------------------

/** What a sentence may need: the server's limits, the estimate of this kind, a count, the check it is on. */
export interface CopyCtx {
  limits?: Record<string, number> | null;
  est?: RepairEstimate | null;
  /** How many things the action is about: pairs to merge, sources the solver reset reaches. */
  n?: number;
  check?: HealthCheck;
}

export interface ActionCopy {
  /** The verb on the key. */
  label: (c: CopyCtx) => string;
  /** One line of what it does. */
  what: (c: CopyCtx) => string;
  /** How it does it, behind "How it works". */
  how?: (c: CopyCtx) => string;
  /** How long, before the press. */
  eta: (c: CopyCtx) => string;
  /**
   * What a finished run leaves on the row, from its record in the history -- so it is still there after a
   * reload. Absent for the actions that answer at once (their outcome is their own answer).
   */
  lasting?: (rec: RepairRunRecord) => { text: string; partial?: boolean };
}

/** The server's limits, with the shipped defaults for a moment before the status route has answered. */
const lim = (c: CopyCtx, k: string, fallback: number): number => {
  const v = c.limits?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
const moment = () => tr('Takes a moment');
const repairEta = (c: CopyCtx) => timeLine(c.est) || tr('A few minutes at most');

/**
 * A renumbering's two bounds, both the server's: the plan lists the source afresh, at most 20 s (bff
 * lib/numbering.ts PLAN_LIST_TIMEOUT), and a confirmed apply answers within a minute (bff routes/numbering.ts
 * APPLY_BUDGET_MS) -- past that the renames carry on and the row says so. Nothing else in it waits on anything.
 */
const RENUMBER_MAX_MS = 20_000 + 60_000;

/**
 * The words of every action on the page, keyed by the HealthAction it answers, plus the card-level and
 * page-level actions that have no HealthAction of their own (`fixall:<step>`, `merge_all`, `scan`,
 * `fix_all_issues`).
 */
export const ACTION_COPY: Readonly<Record<string, ActionCopy>> = {
  fix_short: {
    label: () => tr('Fix'),
    what: () => tr('Looks for a longer copy of this chapter and swaps it in only if one is found.'),
    how: (c) => tr('Asks up to {copies} sources this series follows for their page count, then searches the other sources if none is longer. The longest copy is downloaded once. If every source has the same short chapter, it is marked confirmed and stops being reported.', { copies: lim(c, 'shortCopies', 3) }),
    eta: repairEta,
    lasting: (rec) => shortLasting(rec),
  },
  confirm_short: {
    label: () => tr('It’s fine'),
    what: () => tr('Marks the chapter as really this short, so the repair stops looking for a longer copy. Not fine puts it back on the list.'),
    eta: moment,
  },
  delete: {
    label: () => tr('Delete chapters'),
    what: () => tr('Deletes the file of a chapter whose number cannot be right. The chapter stays listed and reading history is kept; a bookmarked chapter is skipped.'),
    eta: moment,
  },
  fill: {
    label: () => tr('Fill now'),
    what: () => tr('Fetches the missing chapters of this series: from a source it already follows when one lists them, otherwise by searching the other sources and following one that has them.'),
    how: (c) => tr('Other sources are searched only when no followed source lists the missing numbers, and one is followed only when it has most of them. At most {max} chapters are downloaded in one go. It works even when updates are paused for the series.', { max: lim(c, 'gapChapters', 20) }),
    eta: repairEta,
    lasting: (rec) => fillLasting(rec),
  },
  retry: {
    label: () => tr('Retry now'),
    what: (c) => tr('Gives every chapter of this source that would not download another try, and re-checks up to {n} of its series straight away.', { n: lim(c, 'retrySeries', 10) }),
    how: () => tr('Each chapter’s failure count goes back to zero, so the next chapter sweep tries them all again. Other sources are not searched. A source that is cooling down or switched off is reset but not asked.'),
    eta: repairEta,
    lasting: (rec) => recordOutcome(rec),
  },
  test: {
    label: () => tr('Test'),
    what: () => tr('Asks this source for a search, a chapter list and a page list right now, and says which part failed.'),
    // The probe's own limit, which #115 puts on the sources check (`testMs`); before the check has answered, the
    // server's default test timeout plus the probe's margin.
    eta: (c) => etaLine({ maxMs: c.check?.testMs ?? 53_000 }),
  },
  unblock: {
    label: () => tr('Clear block'),
    what: () => tr('Ends this source’s cooldown now, so the next sweep asks it again. If the site is still refusing, it goes back into a cooldown.'),
    eta: moment,
  },
  disable: {
    label: () => tr('Turn off'),
    what: () => tr('Stops asking this source for anything until you turn it back on under Providers. Nothing is deleted.'),
    eta: moment,
  },
  merge: {
    label: () => tr('Merge'),
    what: () => tr('Makes the two copies one series. Progress, bookmarks, ratings and tracker links move to the kept copy; it cannot be undone.'),
    eta: moment,
  },
  // Card-level: the step acts on every source that blames the solver, whatever row was pressed.
  solver_reset: {
    label: (c) => (c.n === 1 ? tr('Reset the solver (1 source)') : tr('Reset the solver ({n} sources)', { n: c.n ?? 0 })),
    what: () => tr('Ends the cooldown of the sources that blame the solver and clears what Uchiyomi remembers about its sessions. It also forgets cooldowns that ended more than a day ago. It cannot restart the solver itself.'),
    eta: repairEta,
    lasting: (rec) => recordOutcome(rec),
  },
  // #72: the Extension engine row, when the engine's own Cloudflare helper is off or points at localhost and
  // Uchiyomi has a helper to share. The same route as the Extensions tab's Connect: two GraphQL calls to the
  // engine (read its settings, then write them), each bounded by the engine client's own timeout.
  engine_solver: {
    label: () => tr('Connect'),
    what: () => tr('Points the extension engine’s own Cloudflare helper at the one Uchiyomi uses and switches it on, so extensions on Cloudflare-protected sites can get through.'),
    how: () => tr('Uchiyomi changes one setting on the engine: its Cloudflare helper, switched on, at the address in {name}. Nothing restarts and nothing is installed. It stays that way unless the engine’s own container names another helper.', { name: 'FLARESOLVERR_URL' }),
    eta: moment,
  },
  // #116, the chapter numbering check. Review opens the plan -- which file becomes which chapter -- and its Confirm
  // is this row's press; nothing is renamed before it. The same routes as the series page's notice and sheet.
  renumber: {
    label: () => tr('Review renumbering'),
    what: () => tr('Shows which file becomes which chapter, and renames the files only once you confirm the plan. Reading progress, bookmarks and notes stay with their chapters.'),
    how: () => tr('Uchiyomi lists the source again and matches each chapter on disk to its post: by the post it was fetched from where that was recorded, otherwise by its name or its date. A chapter no post matches keeps its file, at a free number just after the chapter before it. While a renumbering waits for review, the series fetches nothing new.'),
    eta: () => etaLine({ maxMs: RENUMBER_MAX_MS }),
  },
  keep_numbers: {
    label: () => tr('Keep the source’s numbers'),
    what: () => tr('Keeps the chapter numbers the source gives, and Uchiyomi stops proposing a renumbering for this series. A series it has already renumbered shows the plan back to the source’s numbers first.'),
    eta: moment,
  },
  ignore: {
    label: () => tr('Ignore'),
    what: () => tr('Stops reporting this finding until something about it changes. Nothing is deleted; Stop ignoring brings it back.'),
    eta: moment,
  },
  unignore: {
    label: () => tr('Stop ignoring'),
    what: () => tr('Puts this finding back on the list.'),
    eta: moment,
  },
  'fixall:short': {
    label: () => tr('Find longer copies'),
    what: (c) => tr('Looks for a longer copy of up to {n} short chapters in one run, and replaces one only when a longer copy is found.', { n: lim(c, 'shortMax', 20) }),
    // A SERIES follows sources, not a chapter ("each chapter’s followed sources" was translated as "followed by");
    // and the budget is "of {budget}", like the gap step's, with no counted noun to agree with it.
    how: (c) => tr('The sources the series follows are asked for each chapter’s page count. Searches of other sources share one budget of {budget} with the gap step, and this step may use {n} of them.', { budget: lim(c, 'huntBudget', 5), n: lim(c, 'shortHuntMax', 2) }),
    eta: repairEta,
    lasting: (rec) => recordOutcome(rec),
  },
  'fixall:gaps': {
    label: () => tr('Fill gaps'),
    // "Not looked at today" did not say by whom: it is the gap step's own stamp (bff gaps_checked_at, 24 hours).
    what: (c) => tr('Searches for the missing chapters of up to {max} series in one run: the ones missing the most chapters, with updates on and not checked in the last 24 hours, which are not necessarily the rows shown.', { max: lim(c, 'gapsMax', 5) }),
    how: (c) => tr('The searches share one budget of {budget} with the short-chapter step, which may use {n} of them. A source is followed only when it has most of the missing numbers, and at most {chapters} chapters are downloaded per series.', { budget: lim(c, 'huntBudget', 5), n: lim(c, 'shortHuntMax', 2), chapters: lim(c, 'gapChapters', 20) }),
    eta: repairEta,
    lasting: (rec) => recordOutcome(rec),
  },
  'fixall:failures': {
    label: () => tr('Try every failed chapter again'),
    what: (c) => tr('Every failed chapter of every source goes back to zero tries, and up to {max} series from sources that can be asked now are re-checked straight away. Nothing is searched.', { max: lim(c, 'retrySeries', 10) }),
    eta: repairEta,
    lasting: (rec) => recordOutcome(rec),
  },
  merge_all: {
    label: () => tr('Merge all'),
    what: () => tr('Merges every pair on this card, keeping the suggested copy of each. You see the list before anything happens; it cannot be undone.'),
    eta: moment,
  },
  scan: {
    label: () => tr('Scan the library now'),
    what: () => tr('Walks the library folders now and indexes what it finds, then checks Health again. A scan can start once a minute.'),
    eta: () => tr('A minute or two on a large library'),
  },
  fix_all_issues: {
    label: () => tr('Fix all issues'),
    // With the plan's size, FixAllIssues says fixAllWhat(n) instead: one whole sentence per count.
    what: () => tr('One repair run with every step below that has something to do.'),
    eta: repairEta,
    lasting: (rec) => recordOutcome(rec),
  },
};

/**
 * What Fix all issues does, counted: ONE sentence per count, never a translated sentence with a count glued on --
 * "…1回で修復します。 3 ステップ." read a Latin full stop after the Japanese one. Without a plan, the plain line.
 */
export function fixAllWhat(n: number, c: CopyCtx = {}): string {
  if (n === 1) return tr('One repair run with the 1 step below that has something to do.');
  if (n > 1) return tr('One repair run with the {n} steps below that have something to do.', { n });
  return ACTION_COPY.fix_all_issues.what(c);
}

/** The words of one step inside Fix all issues, with its caps. */
export function planLine(step: string, c: CopyCtx): string {
  const key = step === 'solver' ? 'solver_reset' : `fixall:${step}`;
  const copy = ACTION_COPY[key];
  if (!copy) return repairStepLabel(step);
  return `${step === 'solver' ? tr('Reset the solver') : copy.label(c)}: ${copy.what(c)}`;
}

/**
 * What Fix all issues never does, and -- when its plan holds the solver step -- what it does that its old
 * confirmation denied: "no source is unblocked" was false, because the solver step ends the cooldowns of the
 * sources that blame the solver.
 */
export function planFooter(steps: readonly string[]): string {
  const base = tr('Nothing is deleted, merged or switched off.');
  return steps.includes('solver') ? `${base} ${tr('The solver step ends the cooldowns of the sources that blame the solver.')}` : base;
}

// ---- lasting outcomes ------------------------------------------------------------------------------------

/** A run's result as its line, without the time (the status line shows "Took m:ss" beside it). */
export function recordLine(rec: Pick<RepairRunRecord, 'status' | 'result'>): string {
  const line = rec.result ? taskResult({ ...rec.result, ms: undefined }).replace(/^\s*·\s*/, '') : '';
  switch (rec.status) {
    case 'stopped': return line ? `${tr('Stopped before it finished')} · ${line}` : tr('Stopped before it finished');
    case 'failed': return tr('The repair failed; the server log says why');
    case 'interrupted': return tr('Interrupted by a restart');
    case 'skipped': return tr('Skipped: the nightly repair is switched off');
    // ⚠️ 'Done', not 'Finished': that key is the library's read-status filter, "Gelesen", "読了" -- a repair that
    // "was read" in every language but English.
    default: return line || tr('Done');
  }
}

/** A run's result as the outcome on its row, card or page line: partial when it stopped or passed something over. */
export function recordOutcome(rec: RepairRunRecord): { text: string; partial?: boolean } {
  const r = rec.result ?? {};
  const skip: RepairSkip | undefined = r.skips?.[0];
  const partial = rec.status === 'stopped' || !!r.stopped || !!r.skips?.length || !!r.failures?.retried?.failed;
  const text = recordLine(rec);
  // The first thing it passed over, after what it did: "1 failure reset · Not asked: the source is cooling down".
  return { text: skip && rec.status === 'done' ? `${text} · ${skipLine(skip)}` : text, partial };
}

function shortLasting(rec: RepairRunRecord): { text: string; partial?: boolean } {
  if (rec.status !== 'done') return { text: recordLine(rec), partial: true };
  const s = rec.result?.short ?? {};
  const skip: RepairSkip | undefined = rec.result?.skips?.[0];
  if (s.replaced) return { text: tr('Replaced with a longer copy') };
  if (s.confirmed) return { text: tr('Every source has the same short copy') };
  if (skip) return { text: skipLine(skip), partial: true };
  if (s.left) return { text: tr('Left as it is: no source with a longer copy could be reached'), partial: true };
  return { text: tr('Nothing to do: it no longer qualifies'), partial: true };
}

function fillLasting(rec: RepairRunRecord): { text: string; partial?: boolean } {
  if (rec.status !== 'done') return { text: recordLine(rec), partial: true };
  const g = rec.result?.gaps ?? {};
  const skip: RepairSkip | undefined = rec.result?.skips?.[0];
  const fetched = g.fetched ?? 0;
  if (fetched) {
    return {
      text: fetched === 1 ? tr('1 missing chapter fetched') : tr('{n} missing chapters fetched', { n: fetched }),
      partial: !!g.unfillable,
    };
  }
  if (skip) return { text: skipLine(skip), partial: true };
  if (g.unfillable) return { text: tr('No source lists the missing chapters'), partial: true };
  if (g.sweep) return { text: tr('A followed source lists them; the next chapter sweep fetches them'), partial: true };
  return { text: tr('No missing chapter could be fetched'), partial: true };
}

// ---- why a run passed something over ------------------------------------------------------------------

const NOT_ELIGIBLE = keys(
  'Skipped: the chapter is no longer there', 'Skipped: it is already marked fine', 'Skipped: it has placeholder pages, which the chapter sweep re-fetches',
  'Skipped: it was not downloaded by Uchiyomi', 'Skipped: it is no longer short', 'Skipped: it no longer qualifies',
);
const NOT_ELIGIBLE_BY: Record<string, (typeof NOT_ELIGIBLE)[number]> = {
  gone: NOT_ELIGIBLE[0], confirmed: NOT_ELIGIBLE[1], partial: NOT_ELIGIBLE[2], not_owned: NOT_ELIGIBLE[3], not_short: NOT_ELIGIBLE[4],
};

const until = (iso?: string): string => {
  const at = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(at) ? untilText(at - Date.now()) : '';
};

export function skipLine(k: RepairSkip): string {
  switch (k.why) {
    case 'folder_busy': return tr('Skipped: its folder is busy with another download. Try again when that finishes.');
    case 'not_eligible': return tr(NOT_ELIGIBLE_BY[k.detail ?? ''] ?? NOT_ELIGIBLE[5]);
    case 'no_gaps': return tr('Nothing to fill: the series has no gaps now');
    case 'source_cooling_down': {
      const when = until(k.until);
      return when ? tr('Not asked: the source is cooling down and can be asked again {when}', { when }) : tr('Not asked: the source is cooling down');
    }
    case 'source_off': return tr('Not asked: the source is switched off');
    case 'solver_down': return tr('Skipped: the solver is not answering');
    case 'no_searches_left': return tr('Stopped searching: this run used all its searches');
  }
  return tr('Skipped');
}

// ---- what the running step is doing ---------------------------------------------------------------------

const PHASE_KEYS = keys(
  'Asking the solver whether it answers', 'Clearing the solver’s sessions', 'Counting pages', 'Re-checking the series',
  'Refreshing the chapter list', 'Asking the sources for their page counts', 'Searching other sources',
  'Downloading the longer copy', 'Following a source that has them', 'Fetching the missing chapters',
);
const PHASE_BY: Record<RepairPhase, (typeof PHASE_KEYS)[number]> = {
  pinging: PHASE_KEYS[0], clearing: PHASE_KEYS[1], counting: PHASE_KEYS[2], rechecking: PHASE_KEYS[3], listing: PHASE_KEYS[4],
  asking: PHASE_KEYS[5], searching: PHASE_KEYS[6], downloading: PHASE_KEYS[7], following: PHASE_KEYS[8], fetching: PHASE_KEYS[9],
};

export function phaseLine(cur: RepairCurrent | null | undefined): string {
  return cur ? tr(PHASE_BY[cur.phase] ?? PHASE_KEYS[3]) : '';
}

/** What the run is on, by name: "Walk Tale · Ch. 3", "2 of 5". Nothing when the server withheld the title. */
export function currentText(cur: RepairCurrent | null | undefined): string {
  if (!cur) return '';
  const bits: string[] = [];
  if (cur.title) bits.push(cur.number != null ? `${cur.title} · ${tr('Ch. {n}', { n: cur.number })}` : cur.title);
  if (cur.of && cur.of > 1) bits.push(tr('{done} of {of}', { done: Math.min(cur.of, (cur.done ?? 0) + 1), of: cur.of }));
  return bits.join(' · ');
}

/**
 * What a run is about, in a person's words: "Longer-copy search · Walk Tale · Ch. 3", "Full repair".
 *
 * ⚠️ NAMES, never the keys' own labels. A run is named by what was pressed, and it used to BE the key's label --
 * "Fill now", "Fill gaps" -- which a language that puts its keys in the imperative cannot also use as a name:
 * Recent repairs, "Repairing: {what}" and "Latest one-off fix: {what}" read as orders ("املأ الآن"). So each
 * gets a noun of its own, the one-chapter and the one-card run of a kind sharing it (the target tells them
 * apart). Reintroduce by naming a run by `ACTION_COPY[…].label`: "a run's name is never a key's label" in
 * healthCopy.test.ts names it.
 */
const KIND_KEYS = keys('Full repair', 'Longer-copy search', 'Gap fill', 'Failed-chapter retry', 'Solver reset');
/** A one-step run pressed on a card: the name of what was pressed, not its running form ("Checking the solver"). */
const ONE_STEP: Record<string, () => string> = {
  'steps:solver': () => tr(KIND_KEYS[4]),
  'steps:short': () => tr(KIND_KEYS[1]),
  'steps:gaps': () => tr(KIND_KEYS[2]),
  'steps:failures': () => tr(KIND_KEYS[3]),
  'steps:failures:now': () => tr(KIND_KEYS[3]),
};
export function kindLabel(kind: string, target?: RunTarget | null): string {
  const name = kind === 'full' ? tr(KIND_KEYS[0]) : kind === 'fix_short' ? tr(KIND_KEYS[1]) : kind === 'fill' ? tr(KIND_KEYS[2])
    : kind === 'retry' ? tr(KIND_KEYS[3])
    : ONE_STEP[kind] ? ONE_STEP[kind]()
    : (/^steps:([a-z+]+)/.exec(kind)?.[1] ?? '').split('+')
      .sort((a, b) => REPAIR_STEP_KEYS.indexOf(a as any) - REPAIR_STEP_KEYS.indexOf(b as any))
      .map((s) => repairStepLabel(s)).filter(Boolean).join(', ');
  const about = target?.label ? (target.number != null ? `${target.label} · ${tr('Ch. {n}', { n: target.number })}` : target.label) : '';
  return about ? `${name} · ${about}` : name;
}

/** Who started a run. */
export function whoLine(r: { origin: 'nightly' | 'manual'; mine?: boolean; username?: string | null }): string {
  if (r.origin === 'nightly') return tr('Nightly repair');
  if (r.mine) return tr('Started by you');
  return r.username ? tr('Started by {name}', { name: r.username }) : tr('Started by another admin');
}

// ---- a row's lasting lines ------------------------------------------------------------------------------

const shortDate = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  try { return d.toLocaleDateString(`${activeLocale()}-u-nu-latn`, { day: 'numeric', month: 'short' }); } catch { return d.toLocaleDateString(); }
};

const SHORT_WHY = keys(
  'Replaced with a longer copy', 'Every source has the same short copy', 'No source has a longer copy',
  'Some sources did not answer; the next repair asks again', 'Other sources were searched recently; the next repair searches again',
  'This run was out of searches; the next repair searches again', 'Searching other sources is switched off',
  'A longer copy was found but would not download',
);
const SHORT_WHY_BY: Record<string, (typeof SHORT_WHY)[number]> = {
  replaced: SHORT_WHY[0], confirmed: SHORT_WHY[1], no_longer_copy: SHORT_WHY[2], source_silent: SHORT_WHY[3],
  hunt_cooldown: SHORT_WHY[4], no_searches: SHORT_WHY[5], hunt_off: SHORT_WHY[6], download_failed: SHORT_WHY[7],
};
const GAP_WHY = keys(
  'Followed a source that has them', 'No other source lists them', 'The search limit was reached; the next repair searches again',
  'Searching other sources is switched off', 'Searched recently; the next repair searches again',
  'A followed source lists them; the next chapter sweep fetches them',
  'Being archived slowly', 'Numbered by posting order: no other source’s numbers line up with it',
);
const GAP_WHY_BY: Record<string, (typeof GAP_WHY)[number]> = {
  followed: GAP_WHY[0], no_candidate: GAP_WHY[1], cap: GAP_WHY[2], off: GAP_WHY[3], cooldown: GAP_WHY[4], listed: GAP_WHY[5],
  // #117: below an active slow archive's boundary, which fetches them at its own pace -- not a problem.
  archiving: GAP_WHY[6],
  // #116: a series numbered by posting order is never filled from another source (bff lib/repair.ts GapsResult).
  posting_order: GAP_WHY[7],
};

/**
 * What the last attempt at a finding found, from the rows the repair stored -- so it reads the same after a
 * reload, a restart or a week: "Tried 3h ago · 2 of 3 sources answered · Some sources did not answer; the next
 * repair asks again".
 */
export function outcomeLine(o: HealthOutcome | undefined): string {
  if (!o) return '';
  if (o.kind === 'short') {
    if (o.why === 'partial') {
      const n = o.missing ?? 0;
      return n === 1 ? tr('1 page is a placeholder; the chapter sweep re-fetches it') : tr('{n} pages are placeholders; the chapter sweep re-fetches them', { n });
    }
    if (o.why === 'confirmed_by_admin') return o.by ? tr('Marked fine by {name}', { name: o.by }) : tr('Marked fine by an admin');
    const bits: string[] = [];
    if (o.at) bits.push(tr('Tried {when}', { when: relativeTime(o.at) }));
    // A chapter of a series that follows one source is asked once: "1 of 1 sources answered" without its singular.
    if (o.asked) bits.push(o.asked === 1 ? tr('{n} of 1 source answered', { n: o.answered ?? 0 }) : tr('{n} of {m} sources answered', { n: o.answered ?? 0, m: o.asked }));
    const why = SHORT_WHY_BY[o.why];
    if (why) bits.push(tr(why));
    return bits.join(' · ');
  }
  if (o.kind === 'gaps') {
    const bits: string[] = [];
    if (o.at) bits.push(tr('Searched {when}', { when: relativeTime(o.at) }));
    const why = o.why ? GAP_WHY_BY[o.why] : undefined;
    if (why) bits.push(o.why === 'followed' && o.followed ? tr('Followed {source}', { source: o.followed }) : tr(why));
    if (o.fetched) bits.push(o.fetched === 1 ? tr('1 missing chapter fetched') : tr('{n} missing chapters fetched', { n: o.fetched }));
    if (o.unfillable?.length) bits.push(tr('No source lists {ranges}', { ranges: o.unfillable.join(', ') }));
    return bits.join(' · ');
  }
  const bits = [tr('Failing since {date}', { date: shortDate(o.firstAt) }), tr('last tried {when}', { when: relativeTime(o.lastAt) })];
  if (o.resetPending) bits.push(tr('Reset: the next chapter sweep tries them again'));
  return bits.join(' · ');
}

/** What an action on a row will not be able to do, said before the press. */
export function caveatLine(c: HealthCaveat): string {
  switch (c.code) {
    case 'updates_paused': return tr('Updates are paused for this series: Fill now fetches the missing chapters once.');
    case 'source_cooling_down': {
      const when = until(c.until);
      return when ? tr('This source is cooling down and can be asked again {when}: Retry now resets the count but cannot ask it before then.', { when })
        : tr('This source is cooling down: Retry now resets the count but cannot ask it yet.');
    }
    case 'source_off': return tr('This source is switched off: Retry now resets the count but does not ask it.');
    case 'archiving': return tr('The slow archive is fetching these: Fill now gets them at the normal pace instead of waiting for it.');
  }
  return '';
}

/**
 * How a caveat reads: most say what a key will NOT be able to do, in amber; the slow archive's says nothing is
 * wrong -- the gaps are on their way -- and reads as a plain line, not a warning.
 */
export function caveatTone(c: HealthCaveat): 'warn' | 'calm' {
  return c.code === 'archiving' ? 'calm' : 'warn';
}

// ---- a row's live state ---------------------------------------------------------------------------------

/** What this page did about a row or a card: its own press, until the run it started has been read back. */
export interface Slot {
  phase: 'starting' | 'awaiting' | 'settling' | 'ended' | 'refused' | 'failed';
  /** The ACTION_COPY key, for the lasting line. */
  action: string;
  runId?: string;
  startedAt: number;
  finishedAt?: number;
  reason?: string;
  stopping?: boolean;
}

/**
 * One row's (or card's) status line: the press it made, the run working on it (whoever started it), and the
 * newest finished run about it from the history. ActionState is the only row-state vocabulary; the design's
 * extra two states map onto it -- `settling` (the run ended, Health is being asked again) is working with
 * "Checking the result…", and `skipped` is a refusal with its reason.
 */
export function rowState(o: {
  slot?: Slot | null;
  run?: RepairLiveRun | null;
  record?: RepairRunRecord | null;
  action: string;
  onStop?: () => void;
}): ActionState {
  const { slot, run, record } = o;
  if (slot?.phase === 'starting') return { kind: 'starting' };
  if (slot?.phase === 'refused') return { kind: 'refused', reason: slot.reason ?? '' };
  if (slot?.phase === 'failed') return { kind: 'failed', finishedAt: slot.finishedAt, reason: slot.reason ?? '' };
  if (run && (!slot || slot.runId === run.id || slot.phase === 'ended')) {
    const counted = run.steps.length > 1;
    return {
      kind: 'working',
      startedAt: run.startedAt,
      step: phaseLine(run.current) || repairStepLabel(run.step ?? undefined) || undefined,
      ...(counted && run.stepIndex >= 0 ? { stepIndex: run.stepIndex + 1, stepCount: run.steps.length } : {}),
      detail: currentText(run.current) || undefined,
      onStop: o.onStop,
      stopping: run.cancelRequested || !!slot?.stopping,
    };
  }
  // Pressed, and the status has not shown the run yet (or it ended before it could): working. Ended, and
  // Health is being asked again: "Checking the result…", until that answer is in.
  if (slot?.phase === 'awaiting') return { kind: 'working', startedAt: slot.startedAt, step: tr('Working…') };
  if (slot?.phase === 'settling') return { kind: 'working', startedAt: slot.startedAt, step: tr('Checking the result…') };
  const rec = record;
  if (!rec) {
    return slot?.phase === 'ended' ? { kind: 'done', finishedAt: slot.finishedAt ?? Date.now(), outcome: tr('Done') } : { kind: 'idle' };
  }
  if (rec.status === 'failed' || rec.status === 'interrupted') return { kind: 'failed', finishedAt: rec.finishedAt ?? undefined, reason: recordLine(rec) };
  if (rec.status === 'skipped') return { kind: 'refused', reason: recordLine(rec) };
  const out = (ACTION_COPY[o.action]?.lasting ?? recordOutcome)(rec);
  return { kind: 'done', finishedAt: rec.finishedAt ?? Date.now(), tookMs: rec.ms ?? undefined, outcome: out.text, partial: out.partial };
}

/** A refusal of POST /api/admin/tasks/repair/run, in words: a sweep clears by itself; `busy` is another repair. */
export function refusalLine(error: string | undefined): string {
  return error === 'sweep_running' ? tr('A chapter sweep is running — try again in a few minutes')
    : error === 'busy' ? tr('Another repair is running; this can start when it ends')
    : tr('Could not start the repair');
}

/**
 * A repair-backed key while a chapter sweep or ANOTHER repair runs: disabled, with why as its title -- pressed
 * anyway, the server refuses, which used to be the only way to find out. `own`: the run going is this key's own
 * press, whose key stays live (it is the Stop).
 */
export function repairGate(
  blocked: 'sweep_running' | 'repair_running' | null, run: RepairLiveRun | null | undefined, own: boolean,
): { disabled?: true; disabledWhy?: string } {
  return blocked && !own ? { disabled: true, disabledWhy: blockedLine(blocked, run) } : {};
}

/** Why a repair-backed key is disabled right now, as its title. */
export function blockedLine(why: 'sweep_running' | 'repair_running' | null, run?: RepairLiveRun | null): string {
  if (why === 'sweep_running') return tr('A chapter sweep is running; repairs wait until it ends');
  if (why === 'repair_running') {
    const where = run && run.steps.length > 1 && run.stepIndex >= 0 ? tr('step {i} of {n}', { i: run.stepIndex + 1, n: run.steps.length }) : '';
    return where ? tr('Another repair is running ({where}); this can start when it ends', { where }) : tr('Another repair is running; this can start when it ends');
  }
  return '';
}

/**
 * A kept run's status as a word, for its mark in Recent repairs -- the mark's title and its accessible name. The
 * raw status ('done', 'failed') was English in every language.
 */
export function runStatusWord(status: RepairRunRecord['status']): string {
  switch (status) {
    case 'running': return tr('Running');
    case 'done': return tr('Done');
    case 'stopped': return tr('Stopped before it finished');
    case 'failed': return tr('Failed');
    case 'skipped': return tr('Skipped');
    case 'interrupted': return tr('Interrupted by a restart');
  }
  return tr('Done');
}

/**
 * The solver card while the solver does not answer: why no reset is offered, and what to do instead. The desktop
 * app's helper is part of the app, so there the answer is to reopen it, never a container.
 */
export function solverDownLine(desktop: boolean): string {
  return desktop
    ? tr('The Cloudflare helper is not answering. Quit and reopen Uchiyomi; a reset from here would change nothing.')
    : tr('The solver is not answering. Restart its container; a reset from here would change nothing.');
}

/** When the nightly runs next, for the Tasks row and the history's heading. */
export function nextRunLine(nextAt: number | null | undefined): string {
  return nextAt && Number.isFinite(nextAt) ? tr('next run {when}', { when: untilText(nextAt - Date.now()) }) : '';
}
