// Actions that say what they do, how, how long, and whether they are working (v0.49.0): the state words in
// lib/actionState.ts, the shared clock in lib/ticker.ts, and the rows in components/ActionList.tsx rendered
// to markup with react-dom/server. Every guard names the edit that makes it fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { actionButton, isBusy, stateSummary, type ActionState } from '../lib/actionState';
import { createTicker } from '../lib/ticker';
import { ActionKeys, ActionList, ActionRow, ActionStatus, type ActionSpec } from '../components/ActionList';

// Under tsx the components compile to the classic `React.createElement` (tsconfig's `jsx: preserve` is for
// Next), which they look up as a global when they render.
(globalThis as any).React = React;

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const T0 = 1_000_000;

/* ================================================================ lib/actionState.ts */

test('a working action says its step, its target and its clock, and announces only that it is working', () => {
  const s: ActionState = { kind: 'working', startedAt: T0, stepIndex: 2, stepCount: 4, step: 'Short chapters' };
  assert.deepEqual(stateSummary(s, T0 + 84_000), { tone: 'accent', text: 'Step 2 of 4 · Short chapters', clock: '1:24', announce: 'Working…' });
  assert.equal(stateSummary({ ...s, step: undefined }, T0).text, 'Step 2 of 4');
  assert.equal(stateSummary({ kind: 'working', startedAt: T0, step: 'Checking the result…' }, T0).text, 'Checking the result…');
  assert.equal(stateSummary({ kind: 'working', startedAt: T0 }, T0).text, 'Working…');
  assert.equal(stateSummary({ kind: 'working', startedAt: T0, stepIndex: 1, stepCount: 1, step: 'Gaps' }, T0).text, 'Gaps', '"Step 1 of 1"');
  assert.equal(stateSummary({ ...s, detail: 'Walk Tale ch 3' }, T0).text, 'Step 2 of 4 · Short chapters · Walk Tale ch 3');
  assert.equal(stateSummary({ kind: 'working', startedAt: T0 + 5_000 }, T0).clock, '0:00', 'a clock read before its start');
  assert.equal(stateSummary({ ...s, onStop: () => {}, stopping: true }, T0).text, 'Stopping…');
});

test('a finished action keeps its outcome and how long it took; partial is amber', () => {
  assert.deepEqual(stateSummary({ kind: 'done', finishedAt: T0, tookMs: 124_000, outcome: 'Replaced with a 24-page copy' }, T0),
    { tone: 'accent', text: 'Replaced with a 24-page copy', clock: 'Took 2:04', announce: 'Done: Replaced with a 24-page copy' });
  assert.equal(stateSummary({ kind: 'done', finishedAt: T0, outcome: '1 of 3 filled', partial: true }, T0).tone, 'warn');
  assert.equal(stateSummary({ kind: 'done', finishedAt: T0, outcome: 'x' }, T0).clock, undefined);
});

test('a refusal is amber and a failure red: the two refusals must never read as a failure', () => {
  // healthActions.test.ts has required since v0.41.0 that "a sweep is running" reads differently from a
  // failure. Reintroduce by mapping 'refused' to 'problem': "a sweep-running refusal reads as a red failure".
  assert.equal(stateSummary({ kind: 'refused', reason: 'A chapter sweep is running' }, T0).tone, 'warn', 'a sweep-running refusal reads as a red failure');
  assert.deepEqual(stateSummary({ kind: 'failed', reason: 'The source did not answer' }, T0),
    { tone: 'problem', text: 'The source did not answer', announce: 'Failed: The source did not answer' });
  assert.deepEqual(stateSummary({ kind: 'idle' }, T0), { tone: 'info', text: '', announce: '' });
  assert.equal(stateSummary({ kind: 'starting' }, T0).text, 'Starting…');
});

test('busy is starting or working; the button says Run, Stop, Try again or Run again', () => {
  assert.equal(isBusy({ kind: 'starting' }), true);
  assert.equal(isBusy({ kind: 'working', startedAt: T0 }), true);
  for (const k of ['idle', 'done', 'failed', 'refused'] as const) assert.equal(isBusy({ kind: k } as ActionState), false, k);
  assert.equal(isBusy(undefined), false);
  assert.deepEqual(actionButton({ kind: 'idle' }), { label: 'Run', stop: false });
  assert.deepEqual(actionButton({ kind: 'idle' }, 'Fill now'), { label: 'Fill now', stop: false });
  assert.deepEqual(actionButton({ kind: 'working', startedAt: T0, onStop: () => {} }), { label: 'Stop', stop: true });
  assert.deepEqual(actionButton({ kind: 'working', startedAt: T0, onStop: () => {}, stopping: true }), { label: 'Stopping…', stop: true });
  assert.deepEqual(actionButton({ kind: 'working', startedAt: T0 }, 'Fill now'), { label: 'Fill now', stop: false });
  assert.deepEqual(actionButton({ kind: 'failed', reason: 'x' }, 'Fill now'), { label: 'Try again', stop: false });
  assert.deepEqual(actionButton({ kind: 'done', finishedAt: T0, outcome: 'x' }), { label: 'Run again', stop: false });
});

/* ================================================================ lib/ticker.ts */

test('one interval for every ticking row, cleared with the last one', () => {
  // A Fix all issues run puts dozens of rows into "working". Reintroduce an interval per subscriber (drop
  // the `id === null` check): "three working rows start three timers" fails.
  const timers: number[] = [];
  const cleared: number[] = [];
  let seq = 0;
  let fire: (() => void) | null = null;
  let t = 1000;
  const ticker = createTicker((fn) => { fire = fn; timers.push(++seq); return seq; }, (id) => { cleared.push(id); }, () => t);
  const calls = [0, 0, 0];
  const offs = calls.map((_, i) => ticker.subscribe(() => { calls[i]++; }));
  assert.equal(timers.length, 1, 'three working rows start three timers');
  const before = ticker.now();
  assert.equal(ticker.now(), before, 'the snapshot changes between ticks (an endless re-render)');
  t = 2000;
  assert.equal(ticker.now(), before, 'the snapshot follows Date.now() instead of the tick');
  fire!();
  assert.equal(ticker.now(), 2000);
  assert.deepEqual(calls, [1, 1, 1]);
  offs[0](); offs[1]();
  assert.deepEqual(cleared, [], 'the clock stopped while a row still watched it');
  offs[2]();
  offs[2]();
  assert.deepEqual(cleared, [1], 'the last row leaving does not stop the clock (or stops it twice)');
  ticker.subscribe(() => {});
  assert.equal(timers.length, 2, 'a row starting later gets no clock');
});

test('the clock does not tick while the page is hidden', () => {
  let fire: (() => void) | null = null;
  let t = 0;
  const ticker = createTicker((fn) => { fire = fn; return 1; }, () => {}, () => t);
  let n = 0;
  ticker.subscribe(() => { n++; });
  (globalThis as any).document = { visibilityState: 'hidden' };
  try {
    t = 5000;
    fire!();
    assert.equal(n, 0, 'a hidden page re-renders every second');
    (globalThis as any).document.visibilityState = 'visible';
    fire!();
    assert.equal(n, 1);
    assert.equal(ticker.now(), 5000);
  } finally {
    delete (globalThis as any).document;
  }
});

/* ================================================================ components/ActionList.tsx */

const fill: ActionSpec = {
  id: 'fill', label: 'Fill now', what: 'Fetches the missing chapters once.', how: 'Asks every source that lists them.',
  eta: 'Up to 5 minutes', onRun: () => {}, buttonProps: { 'data-health-action': 'fill' },
};

test('the live region is always there, and the ticking clock is never in it', () => {
  // A live region that appears with its first message is never announced; a clock inside one is read out
  // every second. Reintroduce `{s.kind !== 'idle' && <span role="status" …>}`: the idle render has no live
  // region and "the live region mounts with its first message" fails; put the clock inside it and "the
  // elapsed clock is announced every second" fails.
  const idle = html(createElement(ActionStatus, {}));
  assert.equal(idle, '<span role="status" aria-live="polite" class="sr-only"></span>', 'the live region mounts with its first message');
  const working = html(createElement(ActionStatus, { state: { kind: 'working', startedAt: T0, step: 'Gaps' } }));
  const region = working.match(/<span role="status" aria-live="polite" class="sr-only">([^<]*)<\/span>/);
  assert.ok(region);
  assert.doesNotMatch(region![1], /\d:\d\d/, 'the elapsed clock is announced every second');
  assert.equal(region![1], 'Working…');
  assert.match(working, /<span aria-hidden="true" class="ms-auto shrink-0 text-fog-500">\d+:\d\d<\/span>/, 'the clock is not aria-hidden');
});

test('an outcome stays on the row: done and failed render their lines, with how long it took', () => {
  const done = html(createElement(ActionStatus, { state: { kind: 'done', finishedAt: T0, tookMs: 124_000, outcome: 'Replaced with a 24-page copy' } }));
  assert.match(done, /data-action-status="done"/);
  assert.match(done, /Replaced with a 24-page copy/);
  assert.match(done, />Took 2:04</);
  const failed = html(createElement(ActionStatus, { state: { kind: 'failed', reason: 'The source did not answer' } }));
  assert.match(failed, /text-red-300/);
  assert.match(failed, />Failed: The source did not answer</);
  const bar = html(createElement(ActionStatus, { state: { kind: 'working', startedAt: T0, progress: 0.25 } }));
  assert.match(bar, /origin-\[var\(--start\)\] bg-accent[^"]*" style="transform:scaleX\(0.25\)"/, 'a known progress has no bar, or one that grows from the left in Arabic');
});

test('a row: what, how, eta, the status, and a button that carries its data attributes', () => {
  // walk41 finds Health's buttons by `button[data-health-action]`. Reintroduce by not spreading
  // buttonProps: "walk41 can no longer find button[data-health-action]" fails.
  const row = html(createElement(ActionRow, fill));
  assert.match(row, /<li data-action-row="fill" data-action-state="idle"/);
  assert.match(row, /Fetches the missing chapters once\./);
  assert.match(row, /<details class="group[^"]*"><summary[^>]*>How it works/);
  assert.match(row, /Up to 5 minutes/);
  assert.match(row, /<button type="button" data-health-action="fill" class="btn-key/, 'walk41 can no longer find button[data-health-action]');
  assert.match(row, />Run<\/button>/);
  assert.doesNotMatch(row, /\bchip\b|rounded-full/, 'a row\'s button is a pill');
  const legend = html(createElement(ActionRow, { ...fill, onRun: undefined }));
  assert.doesNotMatch(legend, /<button/, 'a legend-only row has a button');
  const list = html(createElement(ActionList, { actions: [fill, { ...fill, id: 'retry' }], 'aria-label': 'What you can do here' }));
  assert.match(list, /^<ul role="list" aria-label="What you can do here"/);
  assert.equal((list.match(/<li /g) || []).length, 2);
});

test('a working row is disabled -- except as Stop', () => {
  // Reintroduce `disabled={a.disabled || isBusy(state)}`: Stop is greyed out and "a running action cannot be
  // stopped" fails.
  const busy = html(createElement(ActionRow, { ...fill, state: { kind: 'working', startedAt: T0 } }));
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Run<\/button>/, 'a working action can be started again');
  const stoppable = html(createElement(ActionRow, { ...fill, state: { kind: 'working', startedAt: T0, onStop: () => {} } }));
  assert.match(stoppable, /<button(?![^>]*disabled)[^>]*>Stop<\/button>/, 'a running action cannot be stopped');
  const stopping = html(createElement(ActionRow, { ...fill, state: { kind: 'working', startedAt: T0, onStop: () => {}, stopping: true } }));
  assert.match(stopping, /<button[^>]*disabled=""[^>]*>Stopping…<\/button>/);
  const failed = html(createElement(ActionRow, { ...fill, runLabel: 'Fill now', state: { kind: 'failed', reason: 'No source answered' } }));
  assert.match(failed, />Try again<\/button>/);
  const off = html(createElement(ActionRow, { ...fill, disabled: true, disabledWhy: 'A repair is running' }));
  assert.match(off, /disabled="" title="A repair is running"/);
});

test('keys: one busy key disables its whole group, shows a ring, and keeps its verb', () => {
  // Two repairs of one row at once race each other (HealthActions.tsx's rule since v0.41.0). Reintroduce by
  // disabling only the busy key: "a second key of a busy row can be pressed" fails.
  const keys = html(createElement(ActionKeys, {
    actions: [
      { ...fill, state: { kind: 'working', startedAt: T0 } },
      { id: 'retry', label: 'Retry now', what: 'Tries the failed chapters again.', onRun: () => {}, buttonProps: { 'data-health-action': 'retry' } },
    ],
  }));
  assert.match(keys, /^<div data-action-keys="true" class="flex flex-wrap/);
  const buttons = [...keys.matchAll(/<button([^>]*)>(.*?)<\/button>/g)];
  assert.equal(buttons.length, 2);
  assert.match(buttons[0][1], /disabled=""/);
  assert.match(buttons[0][1], /aria-busy="true"/);
  assert.match(buttons[0][2], /data-ring=/, 'the busy key shows no ring');
  assert.match(buttons[0][2], /<span>Fill now<\/span>/, 'the busy key lost its verb');
  assert.match(buttons[1][1], /disabled=""/, 'a second key of a busy row can be pressed');
  assert.match(buttons[1][1], /title="Tries the failed chapters again\."/, 'a key does not say what it does');
  assert.match(buttons[1][1], /data-health-action="retry"/);
  const calm = html(createElement(ActionKeys, { actions: [fill] }));
  assert.doesNotMatch(calm, /disabled/);
});

/** The first <button> in an element tree, walking props.children the way React would render them. */
function findButton(node: unknown): React.ReactElement<any> | null {
  if (Array.isArray(node)) {
    for (const n of node) { const b = findButton(n); if (b) return b; }
    return null;
  }
  if (!node || typeof node !== 'object' || !('props' in (node as any))) return null;
  const el = node as React.ReactElement<any>;
  if (el.type === 'button') return el;
  return findButton(el.props.children);
}
/** Every <button> in an element tree. */
function findButtons(node: unknown, out: React.ReactElement<any>[] = []): React.ReactElement<any>[] {
  if (Array.isArray(node)) { for (const n of node) findButtons(n, out); return out; }
  if (!node || typeof node !== 'object' || !('props' in (node as any))) return out;
  const el = node as React.ReactElement<any>;
  if (el.type === 'button') out.push(el);
  else findButtons(el.props.children, out);
  return out;
}

test('Stop stops: while working with onStop the button calls onStop, and otherwise onRun', () => {
  // A markup render cannot see a handler, so the rows are called as the functions they are (neither calls a
  // hook) and the <button> is read off the returned tree. Reintroduce `onClick={a.onRun}` on either button:
  // "Stop starts the action again" fails -- pressing Stop on a running repair would start a second one.
  const onRun = () => {};
  const onStop = () => {};
  const spec = { ...fill, onRun };
  const working: ActionState = { kind: 'working', startedAt: T0, onStop };
  const rowBtn = (state: ActionState) => findButton(ActionRow({ ...spec, state }));
  assert.equal(rowBtn(working)!.props.onClick, onStop, 'ActionRow: Stop starts the action again');
  assert.equal(rowBtn({ kind: 'working', startedAt: T0 })!.props.onClick, onRun, 'ActionRow: a working row with no onStop calls something other than onRun');
  for (const state of [{ kind: 'idle' }, { kind: 'done', finishedAt: T0, outcome: 'x' }, { kind: 'failed', reason: 'x' }] as ActionState[]) {
    assert.equal(rowBtn(state)!.props.onClick, onRun, `ActionRow: ${state.kind} does not run the action`);
  }
  const keyBtns = (state: ActionState) => findButtons(ActionKeys({ actions: [{ ...spec, state }, { ...spec, id: 'retry' }] }));
  const [stop, sibling] = keyBtns(working);
  assert.equal(stop.props.onClick, onStop, 'ActionKeys: Stop starts the action again');
  assert.equal(sibling.props.onClick, onRun);
  assert.equal(sibling.props.disabled, true, 'a sibling of a running key can be pressed');
  assert.equal(keyBtns({ kind: 'idle' })[0].props.onClick, onRun, 'ActionKeys: an idle key does not run the action');
  assert.equal(keyBtns({ kind: 'done', finishedAt: T0, outcome: 'x' })[0].props.onClick, onRun);
});

test('only a working row reads the clock: idle and finished rows cost no timer', () => {
  // ticker.ts exists so a page of forty idle Health rows costs nothing (#71). A server render never
  // subscribes, so this is read from source. Reintroduce `useTicker(true)`: "an idle row ticks every
  // second" fails.
  const src = readFileSync(join(__dirname, '..', 'components', 'ActionList.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const calls = [...src.matchAll(/useTicker\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['working'], 'an idle row ticks every second');
  const body = src.slice(src.indexOf('export function ActionStatus('), src.indexOf('export function ActionList('));
  assert.match(body, /const working = s\.kind === 'working';\s*const now = useTicker\(working\);/, 'an idle row ticks every second');
});
