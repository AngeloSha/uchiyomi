// Which repair run is about which Health row, and when a run has ended (v0.49.0, lib/repairRun.ts).
//
// The owner could not tell whether a Health fix was working: the page re-checked the moment the POST
// answered, which is when the repair had only just begun, and no row knew which run was its own. These are
// the rules the page now reads the server's run ids and live state by.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedReason, cardBody, cardRecord, cardStepState, endedRunIds, itemBody, kindOfBody, pageBody, pagePlan,
  recordFor, runTouches, solverDown, solverQuiet, type RepairLiveRun, type RepairRunRecord, type RepairStatus,
} from '../lib/repairRun';
import type { HealthCheck, HealthItem } from '../lib/types';

const run = (over: Partial<RepairLiveRun> = {}): RepairLiveRun => ({
  id: 'r1', startedAt: 1000, origin: 'manual', mine: true, kind: 'fix_short', only: ['short'], target: {},
  steps: ['short'], step: 'short', stepIndex: 0, stepStartedAt: 1000, planned: {}, current: null, budget: null,
  skips: [], cancelRequested: false, ...over,
});
const status = (over: Partial<RepairStatus> = {}): RepairStatus => ({
  running: false, sweepRunning: false, enabled: true, nextAt: null, run: null, last: null, recent: [],
  lastFull: null, limits: {}, estimates: {}, ...over,
});
const rec = (over: Partial<RepairRunRecord> = {}): RepairRunRecord => ({
  id: 'x', startedAt: 0, finishedAt: 10, origin: 'manual', username: null, mine: true, kind: 'fix_short', only: ['short'],
  target: {}, status: 'done', ms: 10, result: null, ...over,
});

test('each repair-backed key sends its one step, narrowed to its one target', () => {
  // Reintroduce the old card body for failures (no `now`): "the failures card asks for now" fails.
  const item: HealthItem = { title: 't', detail: 'd', bookId: 'b1', seriesId: 's1', sourceId: 'src' };
  assert.deepEqual(itemBody('fix_short', item), { only: ['short'], bookId: 'b1' });
  assert.deepEqual(itemBody('fill', item), { only: ['gaps'], seriesId: 's1' });
  assert.deepEqual(itemBody('retry', item), { only: ['failures'], sourceId: 'src' });
  assert.equal(itemBody('solver_reset', item), null, 'the solver reset is card-wide, never a row\'s');
  assert.equal(itemBody('fix_short', { title: 't', detail: 'd' }), null, 'a Fix with no chapter would repair every short chapter');
  assert.deepEqual(cardBody('failures'), { only: ['failures'], now: true }, 'the failures card asks for now');
  assert.deepEqual(cardBody('short'), { only: ['short'] });
});

test('a run kind is named the way the server files its estimates', () => {
  // bff lib/repairRuns.ts kindOf: the three chips by name, everything else by its sorted steps.
  assert.equal(kindOfBody({ only: ['short'], bookId: 'b' }), 'fix_short');
  assert.equal(kindOfBody({ only: ['gaps'], seriesId: 's' }), 'fill');
  assert.equal(kindOfBody({ only: ['failures'], sourceId: 'x' }), 'retry');
  assert.equal(kindOfBody({ only: ['failures'], now: true }), 'steps:failures:now');
  assert.equal(kindOfBody({ only: ['short', 'solver', 'gaps'] }), 'steps:gaps+short+solver');
  assert.equal(kindOfBody({ only: [] }), 'full');
});

test('the safe repair (Fix everything\'s Let me choose) plans only the steps some finding offers, and asks for now with the failures', () => {
  const checks: HealthCheck[] = [
    { id: 'solver', title: '', status: 'warn', summary: '', items: [{ title: 'a', detail: '', sourceId: 'a', actions: ['solver_reset'] }] },
    // Down: no reset offered, so no solver step.
    { id: 'short-chapters', title: '', status: 'warn', summary: '', items: [{ title: 'c', detail: '', info: true, actions: ['fix_short'] }] },
    { id: 'chapter-failures', title: '', status: 'warn', summary: '', items: [{ title: 'f', detail: '', sourceId: 'f', actions: ['retry'] }] },
    { id: 'chapter-gaps', title: '', status: 'warn', summary: '', items: [{ title: 'g', detail: '', seriesId: 'g', actions: ['ignore'] }] },
  ];
  const plan = pagePlan(checks);
  assert.deepEqual(plan, [{ step: 'solver', n: 1 }, { step: 'failures', n: 1 }], 'an info row or a row without the step\'s key joined the plan');
  assert.deepEqual(pageBody(plan), { only: ['solver', 'failures'], now: true });
  assert.deepEqual(pageBody([{ step: 'short' }]), { only: ['short'] }, 'now is sent without the failures step, which the server refuses');
});

test('a run touches the row it was started for, and the row a wider run is on right now', () => {
  const chapter: HealthItem = { title: 'c3', detail: '', bookId: 'b3', seriesId: 's' };
  const other: HealthItem = { title: 'c4', detail: '', bookId: 'b4', seriesId: 's' };
  const fix = run({ target: { bookId: 'b3', seriesId: 's', label: 'Walk Tale', number: 3 } });
  assert.equal(runTouches(fix, 'short-chapters', chapter), 'target');
  assert.equal(runTouches(fix, 'short-chapters', other), null, 'a Fix on chapter 3 lit chapter 4');
  // ⚠️ A chapter's run carries its series id too: the gap card's row for that series is NOT its target.
  assert.equal(runTouches(fix, 'chapter-gaps', { title: 's', detail: '', seriesId: 's' }), null, 'a chapter\'s Fix lit its series\' gap row');
  const wide = run({ id: 'r2', kind: 'steps:short', target: {}, current: { kind: 'chapter', bookId: 'b4', phase: 'asking' } });
  assert.equal(runTouches(wide, 'short-chapters', other), 'current');
  assert.equal(runTouches(wide, 'short-chapters', chapter), null);
  assert.equal(runTouches({ ...wide, step: 'gaps' }, 'short-chapters', other), null, 'a run on another step lit this card\'s row');
  const fill = run({ kind: 'fill', steps: ['gaps'], step: 'gaps', target: { seriesId: 'g1' } });
  assert.equal(runTouches(fill, 'chapter-gaps', { title: 'g', detail: '', seriesId: 'g1' }), 'target');
  const retry = run({ kind: 'retry', steps: ['failures'], step: 'failures', target: { sourceId: 'fake-a' } });
  assert.equal(runTouches(retry, 'chapter-failures', { title: 'a', detail: '', sourceId: 'fake-a' }), 'target');
  assert.equal(runTouches(null, 'short-chapters', chapter), null);
});

test('a card knows where a run is with its step: running, queued or done', () => {
  const r = run({ steps: ['solver', 'failures', 'short', 'gaps'], step: 'failures', stepIndex: 1, planned: { failures: 4 }, current: { kind: 'series', phase: 'rechecking', done: 1, of: 4 } });
  assert.deepEqual(cardStepState(r, 'chapter-failures'), { state: 'running', planned: 4, done: 1 });
  assert.deepEqual(cardStepState(r, 'short-chapters'), { state: 'queued' });
  assert.deepEqual(cardStepState(r, 'solver'), { state: 'done' });
  assert.equal(cardStepState(r, 'duplicates'), null);
  assert.equal(cardStepState(run(), 'chapter-gaps'), null, 'a card lit for a step the run does not take');
});

test('a run that ended between two polls is seen to end, even one that finished before it was ever seen running', () => {
  // ⚠️ A one-row fix can take five milliseconds: the first poll after its POST already finds it finished,
  // only in `recent`. The page must still re-check Health for it. Reintroduce by looking only at the
  // prev.run -> next.run transition: "the fast run" returns [] and the row reads "Checking…" for good.
  const fast = status({ recent: [{ id: 'fast', finishedAt: 5, status: 'done', kind: 'fix_short', target: {} }], last: { id: 'fast', finishedAt: 5, status: 'done', kind: 'fix_short' } });
  assert.deepEqual(endedRunIds(status(), fast, ['fast']), ['fast'], 'the fast run');
  // Running at the last poll, gone now: ended, whoever started it (the nightly, another tab).
  assert.deepEqual(endedRunIds(status({ running: true, run: run({ id: 'n' }) }), status(), []), ['n']);
  // Still running: not ended, whether ours or not.
  const going = status({ running: true, run: run({ id: 'mine' }) });
  assert.deepEqual(endedRunIds(going, going, ['mine']), []);
  // Ours ended and another run began at once: ours is ended, the new one is not.
  assert.deepEqual(endedRunIds(going, status({ running: true, run: run({ id: 'next' }) }), ['mine']), ['mine']);
  assert.deepEqual(endedRunIds(null, status(), []), []);
});

test('a repair key says why it cannot start: another repair, or a chapter sweep', () => {
  assert.equal(blockedReason(status({ running: true })), 'repair_running');
  assert.equal(blockedReason(status({ sweepRunning: true })), 'sweep_running');
  assert.equal(blockedReason(status()), null);
  assert.equal(blockedReason(undefined), null);
});

test('the history gives each row and each card its newest finished run', () => {
  const runs = [
    rec({ id: 'running', status: 'running', finishedAt: null, target: { bookId: 'b3' } }),
    rec({ id: 'new', target: { bookId: 'b3', seriesId: 's' } }),
    rec({ id: 'old', target: { bookId: 'b3', seriesId: 's' } }),
    rec({ id: 'card', kind: 'steps:failures:now', target: { now: true } }),
    rec({ id: 'card-old', kind: 'steps:failures', target: {} }),
  ];
  assert.equal(recordFor(runs, 'short-chapters', { title: '', detail: '', bookId: 'b3' })?.id, 'new');
  assert.equal(recordFor(runs, 'short-chapters', { title: '', detail: '', bookId: 'b9' }), null);
  assert.equal(recordFor(runs, 'chapter-gaps', { title: '', detail: '', seriesId: 's' }), null, 'a chapter run was read as its series\' gap run');
  assert.equal(cardRecord(runs, 'failures')?.id, 'card', 'the failures card reads a run that was not its own (no `now`)');
});

test('the solver card is "down" only while no finding offers the reset: then it says what to do instead', () => {
  // The server offers `solver_reset` only on the rows of a solver that answers its ping. While the ping fails the
  // card must not offer a reset (it would change nothing) and must say what to do instead -- and an item-less card
  // must stay expandable for that line (HealthActions.tsx hasCardActions). Reintroduce `() => false`: the down case
  // fails; drop the reset check: "a solver that answers, with rows to reset, reads as down" fails.
  const check = (over: Partial<HealthCheck>): HealthCheck => ({ id: 'solver', title: 'Cloudflare solver', status: 'warn', summary: '', items: [], ...over });
  assert.equal(solverDown(check({ status: 'problem', items: [{ title: 'Not answering', detail: 'fetch failed' }] })), true, 'a solver that does not answer is not down');
  assert.equal(solverDown(check({ status: 'warn', items: [] })), true, 'a failing solver with no rows is not down');
  assert.equal(solverDown(check({ items: [{ title: 'MangaDex', detail: 'd', sourceId: 'mangadex', actions: ['solver_reset'] }] })), false,
    'a solver that answers, with rows to reset, reads as down');
  assert.equal(solverDown(check({ status: 'ok', items: [{ title: 'v1 → v2', detail: 'a newer solver is out', info: true }] })), false, 'a ready solver reads as down');
  assert.equal(solverDown(check({ id: 'sources', status: 'problem' })), false, 'another check reads as the solver');
});

test('with a backup solver the card says which one is not answering: the main, the backup, or all of them', () => {
  // v0.55.4 (bff lib/health.ts solverHealth): the summary's codes say which. Reintroduce one answer for every case
  // (`return 'all'` alone in solverQuiet): "the main down, the backup solving" reads that the solver is not answering.
  const check = (codes: string[], over: Partial<HealthCheck> = {}): HealthCheck => ({
    id: 'solver', title: 'Cloudflare solver', status: 'warn', summary: '', items: [], summarySaid: codes.map((code) => ({ code })), ...over,
  });
  assert.equal(solverQuiet(check(['solver.backupSolving'])), 'main', 'the main down, the backup solving');
  assert.equal(solverQuiet(check(['solver.ready', 'solver.backupQuiet'])), 'backup', 'the main ready, the backup not answering');
  assert.equal(solverQuiet(check(['solver.down', 'solver.backupQuiet'])), 'all', 'both down: the solver-down card it always was');
  assert.equal(solverQuiet(check(['solver.down'])), 'all', 'one solver, down');
  assert.equal(solverQuiet(check(['solver.ready'], { status: 'ok' })), null, 'both answering');
  assert.equal(solverQuiet(check(['solver.blaming', 'solver.backupQuiet'], { items: [{ title: 'MangaDex', detail: 'd', sourceId: 'mangadex', actions: ['solver_reset'] }] })), null,
    'a card that offers its reset is not down');
});
