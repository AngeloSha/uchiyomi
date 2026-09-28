// What every Health action says it does, how, how long, and what it did (v0.49.0, lib/healthCopy.ts).
//
// The owner could not tell what a Health fix did, how, how long it took, or whether it worked -- and where the
// page did say, it was sometimes false: "no source is unblocked" over a run whose solver step unblocks them,
// and a failures card whose Fix all promised every chapter and re-checked none. These hold the words to the
// behaviour and the states a row can be in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTION_COPY, CHECK_TITLES, caveatLine, caveatTone, fixAllWhat, kindLabel, outcomeLine, planFooter, recordLine, repairGate, rowState,
  runStatusWord, skipLine, solverDownLine, timeLine,
} from '../lib/healthCopy';
import type { RepairLiveRun, RepairRunRecord } from '../lib/repairRun';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const LIMITS = { shortMax: 20, gapsMax: 5, huntBudget: 5, shortHuntMax: 2, gapChapters: 20, retrySeries: 10, shortCopies: 3 };

test('every HealthAction, every card action and the page action has what, and when, before the press', () => {
  // A later step that adds a HealthAction adds its words here in the same commit. Reintroduce by deleting the
  // `fill` entry: "fill has no copy" fails.
  const types = read('lib/types.ts');
  const decl = types.slice(types.indexOf('export type HealthAction'));
  const actions = [...decl.slice(0, decl.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(actions.length >= 12, 'the HealthAction union was not read');
  const ctx = { limits: LIMITS, est: { typicalMs: 40_000, runs: 3, worstMs: 180_000, downloads: 20 }, n: 3 };
  for (const a of [...actions, 'fixall:short', 'fixall:gaps', 'fixall:failures', 'merge_all', 'scan', 'fix_all_issues']) {
    const c = ACTION_COPY[a];
    assert.ok(c, `${a} has no copy`);
    assert.ok(c.label(ctx).trim(), `${a} has no label`);
    assert.ok(c.what(ctx).trim().length > 20, `${a} does not say what it does`);
    assert.ok(c.eta(ctx).trim(), `${a} does not say how long`);
  }
  // A repair-backed action keeps a lasting line from its run; the ones that answer at once need none.
  for (const a of ['fix_short', 'fill', 'retry', 'solver_reset', 'fixall:short', 'fixall:gaps', 'fixall:failures', 'fix_all_issues']) {
    assert.ok(ACTION_COPY[a].lasting, `${a} leaves nothing on its row when its run ends`);
  }
});

test('the words match what the press does', () => {
  const ctx = { limits: LIMITS };
  // The gap step shares ONE search budget with the short step (bff lib/repair.ts REPAIR_HUNT_BUDGET).
  assert.match(ACTION_COPY['fixall:gaps'].how!(ctx), /share one budget of 5/);
  assert.match(ACTION_COPY['fixall:gaps'].what(ctx), /not necessarily the rows shown/);
  // The failures card sends `now`: every row of every source, some re-checked at once, and no search.
  assert.match(ACTION_COPY['fixall:failures'].what(ctx), /Every failed chapter of every source/);
  assert.match(ACTION_COPY['fixall:failures'].what(ctx), /Nothing is searched/);
  // The solver reset reaches every source that blames it, and cannot restart the solver.
  assert.match(ACTION_COPY.solver_reset.label({ n: 3 }), /3 sources/);
  assert.match(ACTION_COPY.solver_reset.label({ n: 1 }), /1 source\)/);
  assert.match(ACTION_COPY.solver_reset.what(ctx), /cannot restart the solver/);
  // Fill now works on a series whose updates are paused (the server change it describes).
  assert.match(ACTION_COPY.fill.how!(ctx), /even when updates are paused/);
});

test('with the solver in the plan, Fix all issues says it ends cooldowns, and never that nothing is unblocked', () => {
  // The old confirmation said "no source is unblocked" while its solver step unblocked every source that
  // blamed the solver. Reintroduce that sentence as the footer: the first assertion fails.
  const withSolver = planFooter(['solver', 'failures']);
  assert.doesNotMatch(withSolver, /no source is unblocked/i);
  assert.match(withSolver, /ends the cooldowns of the sources that blame the solver/);
  assert.match(withSolver, /Nothing is deleted, merged or switched off/);
  assert.doesNotMatch(planFooter(['short']), /solver/, 'the solver sentence appears without the solver step');
  // And nothing in the source still says it.
  assert.doesNotMatch(read('components/HealthActions.tsx'), /no source is unblocked/);
});

test('how long: usually from history, at most from the constants, downloads as a count', () => {
  // Reintroduce a fake time for downloads (folding them into "at most"): the count assertion fails.
  assert.equal(timeLine({ typicalMs: 40_000, runs: 5, worstMs: 180_000, downloads: 20 }),
    'Usually 40 sec · At most about 3 min of searching and waiting · plus at most 20 chapter downloads');
  assert.equal(timeLine({ typicalMs: null, runs: 0, worstMs: 60_000, downloads: 1 }),
    'At most about 1 min of searching and waiting · plus at most 1 chapter download');
  assert.equal(timeLine({ typicalMs: null, runs: 0, worstMs: null, downloads: 0 }), 'Takes a moment');
  assert.equal(timeLine(null), '');
});

const live = (over: Partial<RepairLiveRun> = {}): RepairLiveRun => ({
  id: 'r1', startedAt: 1000, origin: 'manual', mine: true, kind: 'fix_short', only: ['short'], target: { bookId: 'b3' },
  steps: ['short'], step: 'short', stepIndex: 0, stepStartedAt: 1000, planned: { short: 1 },
  current: { kind: 'chapter', bookId: 'b3', title: 'Walk Tale', number: 3, phase: 'asking' }, budget: null, skips: [], cancelRequested: false, ...over,
});
const record = (over: Partial<RepairRunRecord> = {}): RepairRunRecord => ({
  id: 'r1', startedAt: 1000, finishedAt: 5000, origin: 'manual', username: null, mine: true, kind: 'fix_short', only: ['short'],
  target: { bookId: 'b3' }, status: 'done', ms: 4000,
  result: { counted: 0, only: ['short'], short: { looked: 1, replaced: 1, confirmed: 0, left: 0 } }, ...over,
});

test('a row is working with its step while its run goes, checking once it ends, then done with how long it took', () => {
  // Reintroduce the old behaviour -- the row reads done the moment the POST answers -- by mapping the
  // `awaiting` slot to done: "a pressed row whose run has not been read back" fails.
  const stop = () => {};
  const w = rowState({ slot: { phase: 'awaiting', action: 'fix_short', runId: 'r1', startedAt: 900 }, run: live(), action: 'fix_short', onStop: stop });
  assert.equal(w.kind, 'working');
  if (w.kind === 'working') {
    assert.equal(w.startedAt, 1000, 'the clock does not count from the run\'s start');
    assert.equal(w.step, 'Asking the sources for their page counts');
    assert.equal(w.detail, 'Walk Tale · Ch. 3');
    assert.equal(w.onStop, stop, 'the row\'s own run cannot be stopped from it');
    assert.equal(w.stepCount, undefined, 'a one-step run counts steps');
  }
  const awaiting = rowState({ slot: { phase: 'awaiting', action: 'fix_short', runId: 'r1', startedAt: 900 }, run: null, action: 'fix_short' });
  assert.equal(awaiting.kind, 'working', 'a pressed row whose run has not been read back');
  const settling = rowState({ slot: { phase: 'settling', action: 'fix_short', runId: 'r1', startedAt: 900 }, run: null, record: record(), action: 'fix_short' });
  assert.equal(settling.kind === 'working' && settling.step, 'Checking the result…', 'a row reads done before Health has answered again');
  const done = rowState({ slot: { phase: 'ended', action: 'fix_short', runId: 'r1', startedAt: 900 }, record: record(), action: 'fix_short' });
  assert.deepEqual(done, { kind: 'done', finishedAt: 5000, tookMs: 4000, outcome: 'Replaced with a longer copy', partial: undefined });
  // After a reload there is no slot: the history alone puts the outcome back on the row.
  assert.equal(rowState({ record: record(), action: 'fix_short' }).kind, 'done');
  // A run started elsewhere (the nightly on this chapter) still shows as working, without a Stop of its own.
  const other = rowState({ run: live({ mine: false, origin: 'nightly' }), action: 'fix_short' });
  assert.equal(other.kind === 'working' && other.onStop, undefined);
});

test('a refused or skipped run reads as a refusal, a crashed one as a failure, a partial one in amber', () => {
  assert.deepEqual(rowState({ slot: { phase: 'refused', action: 'fill', startedAt: 1, reason: 'A chapter sweep is running' }, action: 'fill' }),
    { kind: 'refused', reason: 'A chapter sweep is running' });
  assert.equal(rowState({ record: record({ status: 'failed' }), action: 'fix_short' }).kind, 'failed');
  assert.equal(rowState({ record: record({ status: 'interrupted' }), action: 'fix_short' }).kind, 'failed');
  assert.equal(rowState({ record: record({ status: 'skipped' }), action: 'fix_short' }).kind, 'refused');
  const busy = rowState({ record: record({ result: { counted: 0, only: ['short'], short: { looked: 0, replaced: 0, confirmed: 0, left: 0 }, skips: [{ step: 'short', why: 'folder_busy' }] } }), action: 'fix_short' });
  assert.equal(busy.kind, 'done');
  if (busy.kind === 'done') {
    assert.equal(busy.partial, true, 'a skipped target reads as a success');
    assert.match(busy.outcome, /folder is busy/);
  }
  const confirmed = rowState({ record: record({ result: { counted: 0, only: ['short'], short: { looked: 1, replaced: 0, confirmed: 1, left: 0 } } }), action: 'fix_short' });
  assert.equal(confirmed.kind === 'done' && confirmed.outcome, 'Every source has the same short copy');
});

test('outcomes, caveats and skips read as sentences, from the stored data', () => {
  assert.match(outcomeLine({ kind: 'short', at: new Date().toISOString(), why: 'source_silent', asked: 3, answered: 2 }), /^Tried just now · 2 of 3 sources answered · Some sources did not answer/);
  assert.equal(outcomeLine({ kind: 'short', at: null, why: 'partial', missing: 2 }), '2 pages are placeholders; the chapter sweep re-fetches them');
  assert.equal(outcomeLine({ kind: 'short', at: null, why: 'confirmed_by_admin', by: 'ann' }), 'Marked fine by ann');
  assert.match(outcomeLine({ kind: 'gaps', at: null, why: 'no_candidate', followed: null, coverage: null, fetched: 0, landed: 0, sweep: 0, capped: 0, unfillable: ['6-8'], scanned: 3 }),
    /No other source lists them · No source lists 6-8/);
  assert.match(outcomeLine({ kind: 'failures', firstAt: '2026-09-12T10:00:00Z', lastAt: new Date().toISOString(), attempts: 2, resetPending: true }), /^Failing since .+ · last tried just now · Reset:/);
  assert.match(caveatLine({ action: 'fill', code: 'updates_paused' }), /Fill now fetches the missing chapters once/);
  assert.match(caveatLine({ action: 'retry', code: 'source_cooling_down', until: new Date(Date.now() + 20 * 60_000).toISOString() }), /asked again in 20 minutes/);
  assert.match(caveatLine({ action: 'retry', code: 'source_off' }), /does not ask it/);
  assert.match(skipLine({ step: 'short', why: 'not_eligible', detail: 'partial' }), /placeholder pages/);
  assert.match(skipLine({ step: 'gaps', why: 'no_searches_left' }), /used all its searches/);
});

test('#117: gaps below an active slow archive are on their way, not a problem, and Fill now still fetches them', () => {
  // The critic's ruling: health.ts marks them with the outcome why 'archiving' and Fill now's caveat 'archiving', and
  // the page words them. Reintroduce by dropping GAP_WHY_BY.archiving: the outcome line loses its reason; drop the
  // caveat's case: it reads nothing; tone it 'warn': it reads as a problem, in amber.
  const gaps = { kind: 'gaps' as const, at: null, why: 'archiving', followed: null, coverage: null, fetched: 0, landed: 0, sweep: 0, capped: 0, unfillable: [], scanned: 4 };
  assert.equal(outcomeLine(gaps), 'Being archived slowly', 'the gap does not say it is being archived');
  const caveat = { action: 'fill' as const, code: 'archiving' as const };
  assert.equal(caveatLine(caveat), 'The slow archive is fetching these: Fill now gets them at the normal pace instead of waiting for it.',
    'the archiving caveat reads nothing');
  assert.equal(caveatTone(caveat), 'calm', 'a gap on its way reads as a warning');
  assert.equal(caveatTone({ action: 'fill', code: 'updates_paused' }), 'warn');
  // #116: a series numbered by posting order is never filled from another source.
  assert.equal(outcomeLine({ ...gaps, why: 'posting_order' }), 'Numbered by posting order: no other source’s numbers line up with it',
    'a posting-order gap has no reason');
});

test('#116: the numbering check has a title, and its two keys say what they rename and when', () => {
  // Reintroduce a Review that renames at the press: its copy would have to change, and this holds the words to the
  // arm (healthActions.test.ts), which opens the plan first.
  assert.equal(CHECK_TITLES.numbering, 'Chapter numbering', 'the numbering check shows the server\'s English title');
  assert.equal(ACTION_COPY.renumber.label({}), 'Review renumbering');
  assert.match(ACTION_COPY.renumber.what({}), /renames the files only once you confirm the plan/);
  assert.match(ACTION_COPY.renumber.what({}), /Reading progress, bookmarks and notes stay with their chapters/);
  assert.match(ACTION_COPY.renumber.how!({}), /While a renumbering waits for review, the series fetches nothing new/);
  // The plan's listing (20 s) and the apply's answer (a minute), rounded up as every estimate on the page is.
  assert.equal(ACTION_COPY.renumber.eta({}), 'Up to 2 minutes');
  assert.equal(ACTION_COPY.keep_numbers.label({}), 'Keep the source’s numbers');
  assert.match(ACTION_COPY.keep_numbers.what({}), /already renumbered shows the plan back to the source’s numbers first/);
  assert.equal(ACTION_COPY.keep_numbers.eta({}), 'Takes a moment');
});

test('the history names runs the way a person would, and says when one stopped', () => {
  assert.equal(kindLabel('fix_short', { label: 'Walk Tale', number: 3 }), 'Find a longer copy · Walk Tale · Ch. 3');
  assert.equal(kindLabel('steps:gaps+short+solver:now'), 'Checking the solver, Looking for longer copies, Filling gaps');
  assert.equal(kindLabel('full'), 'Full repair');
  // A card's one-step run is named by what was pressed, not by its running form ("Checking the solver").
  assert.equal(kindLabel('steps:solver'), 'Reset the solver');
  assert.equal(kindLabel('steps:failures:now'), 'Try every failed chapter again');
  assert.equal(kindLabel('steps:count'), 'Counting pages');
  assert.equal(recordLine({ status: 'done', result: { counted: 0, only: ['solver'], solver: { reset: false }, ms: 12 } }), 'solver: nothing to reset');
  assert.match(recordLine({ status: 'stopped', result: { counted: 0, only: ['short'], short: { replaced: 1, confirmed: 0 } } }), /^Stopped before it finished · short: 1 replaced/);
});

test('every check the server runs has a translated title, and no two share an id', () => {
  // A new check in bff lib/health.ts without an entry here would show its English title in every language.
  // Reintroduce by deleting 'downloads-missing' (or #72's 'extension-engine', built in lib/engineHealth.ts under
  // `const ID`) from CHECK_TITLES: the scan below names it.
  const src = read('../bff/src/lib/health.ts');
  const ids = new Set([...src.matchAll(/\bid: '([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(ids.size >= 12, `only ${ids.size} check ids found in health.ts -- the scan is broken`);
  const engine = /\bconst ID = '([a-z-]+)'/.exec(read('../bff/src/lib/engineHealth.ts'));
  assert.ok(engine, 'the engine check\'s id was not found in engineHealth.ts -- the scan is broken');
  ids.add(engine[1]);
  for (const id of ids) assert.ok(CHECK_TITLES[id], `check '${id}' has no CHECK_TITLES entry`);
  const titles = Object.values(CHECK_TITLES);
  assert.equal(new Set(titles).size, titles.length, 'two checks share a title');
});

test('a finished run reads "Done", never the library\'s "Finished" (read)', () => {
  // 'Finished' is the reading-status key ("Gelesen", "読了", "Прочитано"): a repair that "was read" in every language
  // but English. Reintroduce tr('Finished') in recordLine or rowState: these fail.
  assert.equal(recordLine({ status: 'done', result: null }), 'Done', 'a finished run with no result reads the library\'s Finished');
  assert.deepEqual(rowState({ slot: { phase: 'ended', action: 'fill', startedAt: 1, finishedAt: 5 }, action: 'fill' }),
    { kind: 'done', finishedAt: 5, outcome: 'Done' }, 'an ended press with no record reads the library\'s Finished');
  assert.doesNotMatch(read('lib/healthCopy.ts'), /tr\('Finished'\)/, 'healthCopy says the library\'s Finished');
});

test('Recent repairs says each run\'s status as a word, not the raw English status', () => {
  // The mark's title is its accessible name. Reintroduce `title={r.status}` in RepairLive's HistoryRow: the source
  // assertion fails; map a status to itself: the word assertions fail.
  for (const st of ['running', 'done', 'stopped', 'failed', 'skipped', 'interrupted'] as const) {
    const w = runStatusWord(st);
    assert.ok(w.trim() && w !== st, `'${st}' is shown as the raw status`);
  }
  assert.equal(runStatusWord('done'), 'Done');
  assert.equal(runStatusWord('interrupted'), 'Interrupted by a restart');
  assert.match(read('components/RepairLive.tsx'), /<StatusMark tone=\{STATUS_TONE\[r\.status\] \?\? 'info'\} title=\{runStatusWord\(r\.status\)\}/,
    'the history row\'s mark is named by the raw English status');
});

test('a repair key waits while a sweep or another repair runs, and says why; its own run keeps it live', () => {
  // The design has no queue this release: every repair-backed action is disabled while a repair or a sweep runs,
  // with why as its title. Reintroduce `repairGate = () => ({})`: these fail (healthActions.test.ts holds every
  // repair key, the cards' Fix all and Fix all issues to it).
  assert.deepEqual(repairGate('repair_running', null, false), { disabled: true, disabledWhy: 'Another repair is running; this can start when it ends' });
  assert.deepEqual(repairGate('sweep_running', null, false), { disabled: true, disabledWhy: 'A chapter sweep is running; repairs wait until it ends' });
  const two = { id: 'r9', startedAt: 1, origin: 'nightly' as const, mine: false, kind: 'full', only: [], target: {}, steps: ['solver', 'short'], step: 'short',
    stepIndex: 1, stepStartedAt: 1, planned: {}, current: null, budget: null, skips: [], cancelRequested: false };
  assert.equal(repairGate('repair_running', two as RepairLiveRun, false).disabledWhy, 'Another repair is running (step 2 of 2); this can start when it ends');
  assert.deepEqual(repairGate('repair_running', null, true), {}, 'the key whose own run is going is disabled (it is the Stop)');
  assert.deepEqual(repairGate(null, null, false), {}, 'a key is disabled with nothing running');
});

test('the solver card says what to do while the solver is down, the desktop way on desktop', () => {
  // Reintroduce the server wording on desktop (no isDesktop branch): the desktop app has no container to restart.
  assert.match(solverDownLine(false), /Restart its container/);
  assert.match(solverDownLine(true), /Quit and reopen Uchiyomi/);
  assert.doesNotMatch(solverDownLine(true), /container/, 'the desktop app is told to restart a container');
  assert.match(read('components/HealthActions.tsx'), /what: solverDownLine\(isDesktop\(\)\)/, 'the solver-down row does not pick its words by platform');
});

test('Fix all issues says its size in one whole sentence per count', () => {
  // It glued a separate "{n} steps" and an ASCII full stop onto a translated sentence: "…1回で修復します。 3 ステップ."
  // Reintroduce the glued form in FixAllIssues: the source assertion fails; drop the singular: "1 step" fails.
  assert.equal(fixAllWhat(1), 'One repair run with the 1 step below that has something to do.');
  assert.equal(fixAllWhat(3), 'One repair run with the 3 steps below that have something to do.');
  assert.equal(fixAllWhat(0), ACTION_COPY.fix_all_issues.what({}), 'with no plan it is the plain line');
  const keys = read('components/HealthActions.tsx');
  assert.match(keys, /what: fixAllWhat\(plan\.length, ctx\),/, 'Fix all issues does not say its size through fixAllWhat');
  assert.doesNotMatch(keys, /tr\('\{n\} steps'/, 'a count is glued onto the Fix all issues sentence again');
});

test('Connect on the Extension engine row says what it changes, and that nothing restarts', () => {
  // #72: the one-click fix beside the engine's Health row. Its words are held to what POST
  // /api/admin/extensions/solver does (bff lib/extensionEngine.ts connectEngineSolver).
  const c = ACTION_COPY.engine_solver;
  assert.equal(c.label({}), 'Connect');
  assert.match(c.what({}), /Cloudflare helper at the one Uchiyomi uses and switches it on/);
  assert.match(c.how!({}), /at the address in FLARESOLVERR_URL\. Nothing restarts and nothing is installed\./);
  assert.equal(c.eta({}), 'Takes a moment');
  assert.equal(CHECK_TITLES['extension-engine'], 'Extension engine');
});
