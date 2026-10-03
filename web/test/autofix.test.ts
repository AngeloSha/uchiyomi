// Health's "Fix everything" (v0.55.0): the web half.
//
// The owner: "the fix all button in health should … give an option to auto pick stuff or to manually do it … for auto
// it just shows at the end what happened and what it did in short without cluttering". The server runs ONE background
// run of every remedy (bff lib/autofix.ts, the v0.55.0 contract); these hold what the page makes of it -- when the key
// shows, which view the dialog opens on, the end's headline, its six lines, each Needs-you key, Run again, the nightly
// choice, Free a slot, Server tasks and Recent repairs. The pure rules are lib/autofix.ts; the dialog is rendered
// statically, as findSources.test.ts and sourcesPanel.test.ts render theirs; the wiring a static render cannot press is
// read from source, as healthActions.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setActiveLocale } from '../lib/format';
import {
  AUTOFIX_PHASES, AUTOFIX_POLL_MS, DONE_SHOWN, autofixEndedIds, autofixHeadline, autofixOfRecord, autofixPhaseLabel, autofixPollMs,
  autofixProgress, autofixStepLine, canRunAgain, cardsToLook, clearsLines, doneLines, fixView, needsYouKey, needsYouLines,
  nightlyModeOf, showFixEverything,
  type AutofixRun, type AutofixStatus, type AutofixSummary,
} from '../lib/autofix';
import { pageBody, pagePlan } from '../lib/repairRun';
import { kindLabel } from '../lib/healthCopy';
import { runProgress, runTitle } from '../lib/jobs';
import { navRing, runName } from '../lib/serverDownloads';
import { freeSlotHref, sourceTarget, settingsTarget } from '../lib/sourcesPanel';
import { AutofixContext, type AutofixApi } from '../lib/useAutofixRun';
import { RepairRunProvider } from '../lib/useRepairRun';
import { FixEverythingDialog } from '../components/FixEverythingDialog';
import { NightlyModeRow } from '../components/AdminSettings';
import type { HealthCheck } from '../lib/types';

(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');

const ROOT = join(__dirname, '..');
/** The file with its comments removed: several comments quote the code they forbid. */
const code = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};
const noop = () => {};
const said = (text: string) => ({ code: 'text', params: { text } });
const check = (id: string, status: HealthCheck['status'], items: HealthCheck['items'] = []): HealthCheck => ({ id, title: id, status, summary: '', items });

const summary = (o: Partial<AutofixSummary> = {}): AutofixSummary => ({ green: false, again: false, done: [], clears: [], needsYou: [], ...o });
const run = (o: Partial<AutofixRun> = {}): AutofixRun => ({
  id: 'af1', status: 'done', startedAt: '2026-10-03T10:00:00.000Z', finishedAt: '2026-10-03T10:40:00.000Z', by: 'admin', phase: null, phaseIndex: 10, ...o,
});
const EIGHT: AutofixSummary['done'] = [
  { kind: 'replaced', n: 184, said: said('Moved 184 series off Aqua Manga') },
  { kind: 'fetched', n: 37, said: said('Fetched 37 missing chapters') },
  { kind: 'installed', n: 1, said: said('Installed Asura Scans (found 3 series)'), items: [said('Asura Scans (EN): Solo Leveling')] },
  { kind: 'merged', n: 2, said: said('Merged 2 duplicates') },
  { kind: 'deletedTwice', n: 3, said: said('Deleted 3 chapters saved twice') },
  { kind: 'renumbered', n: 1, said: said('Renumbered 1 series') },
  { kind: 'shortFixed', n: 4, said: said('Replaced 4 short chapters with longer copies') },
  { kind: 'retired', n: 5, said: said('Turned off 5 sources nothing uses') },
];

/** An autofix follower with nothing pressed, or what the test gives it. */
const api = (o: Partial<AutofixApi> = {}): AutofixApi => ({
  status: { run: null, last: null }, slot: null, seen: new Set(), aside: new Set(), stopping: null,
  start: async () => {}, stop: async () => {}, dismiss: noop, ...o,
});
/** The dialog as Health renders it: under the repair's follower (Let me choose) and the autofix one. */
function dialog(af: AutofixApi, checks: HealthCheck[] = [check('duplicates', 'warn')]): string {
  const client = new QueryClient();
  const el: ReactElement = createElement(QueryClientProvider, { client },
    createElement(RepairRunProvider, {
      onEnded: async () => {},
      children: createElement(AutofixContext.Provider, { value: af },
        createElement(FixEverythingDialog, { checks, onClose: noop, onShowCheck: noop })),
    }));
  return renderToStaticMarkup(el);
}
/** The view a run's end opens on: seen going by this page, and not set aside. */
const ended = (r: AutofixRun) => api({ status: { run: null, last: r }, seen: new Set([r.id]) });

/* ================================================================ the key */

test('the key shows whenever any card has a finding -- one the repair cannot touch too -- and while a run goes', () => {
  // Fix all issues showed only for the repair's four steps (lib/repairRun.ts pagePlan), and vanished while a dead source
  // and a duplicate pair were still amber. Reintroduce `pagePlan(checks).length > 0` as the rule in showFixEverything:
  // "a duplicate alone shows the key" fails.
  const dupes = [check('duplicates', 'warn', [{ title: 'Eleceed', detail: '', seriesIds: ['a', 'b'], actions: ['merge'] }]), check('update', 'ok')];
  assert.deepEqual(pagePlan(dupes), [], 'the fixture is no longer one the repair cannot touch');
  assert.equal(showFixEverything(dupes), true, 'a duplicate alone shows the key');
  assert.equal(showFixEverything([check('solver', 'problem')]), true, 'a solver that is down shows the key');
  assert.equal(showFixEverything([check('update', 'ok'), check('library-scan', 'ok')]), false, 'all green shows the key');
  assert.equal(showFixEverything([check('update', 'ok')], { live: true }), true, 'a run going hides its own key');
  assert.equal(showFixEverything([check('update', 'ok')], { unread: true }), true, 'an unread end hides its key');
  assert.equal(cardsToLook([check('a', 'warn'), check('b', 'problem'), check('c', 'ok')]), 2);
  // The key reads the rule, and Health draws it beside Re-check, where Fix all issues' row was.
  const key = slice(code('components/FixEverythingDialog.tsx'), 'export function FixEverythingKey(', 'export function FixEverythingDialog(');
  assert.match(key, /if \(!af \|\| !showFixEverything\(checks, \{ live: view === 'run', unread \}\)\) return null;/, 'the key does not follow the rule');
  assert.match(key, /className="btn-key btn-key-primary" data-fix-everything="">/, 'the idle key is not the filled one');
  const health = slice(code('app/admin/page.tsx'), 'function Health()', 'function DesktopUpdateNote()');
  assert.match(health, /<FixEverythingKey checks=\{checks\} onOpen=\{\(\) => setFixing\(true\)\} \/>/, 'the key is not on Health');
  assert.match(health, /tr\('Re-check'\)\}\s*<\/button>\s*(?:\{\}\s*)?<FixEverythingKey/, 'the key is not beside Re-check');
  assert.doesNotMatch(code('components/HealthActions.tsx'), /FixAllIssues/, 'Fix all issues\' row is still there');
  assert.doesNotMatch(health, /FixAllIssues/, 'Fix all issues\' row is still on Health');
});

/* ================================================================ the question */

test('Fix it for me is the default, with its three lines; Let me choose is the safe repair Fix all issues ran', () => {
  // Reintroduce `useState<'auto' | 'manual'>('manual')`: "Fix it for me is not chosen by default" fails.
  const html = dialog(api(), [check('duplicates', 'warn'), check('sources', 'warn'), check('update', 'ok')]);
  assert.match(html, /data-fix-view="ask"/);
  assert.match(html, /<span data-fix-cards="2">2 cards need a look<\/span>/, 'the subtitle does not count the cards with a finding');
  const radio = (mode: string) => [...html.matchAll(/<input [^>]*\/>/g)].map((m) => m[0]).find((t) => t.includes(`data-fix-mode="${mode}"`)) ?? '';
  assert.match(radio('auto'), /\bchecked=""/, 'Fix it for me is not chosen by default');
  assert.doesNotMatch(radio('manual'), /\bchecked=""/, 'Let me choose is chosen by default');
  assert.match(html, />Fix it for me<\/span><span class="[^"]*">Recommended<\/span>/, 'Fix it for me is not marked recommended');
  for (const l of [
    'Replaces broken sources, fetches missing and broken chapters, and finds new sources, installing up to 3 extensions if it has to.',
    'Merges duplicate series, deletes chapters saved twice or numbered impossibly, and applies safe renumbering. These can’t be undone.',
    'What only you can fix is listed at the end.',
  ]) assert.ok(html.includes(l), `Fix it for me does not say: ${l}`);
  assert.ok(html.includes('Fix the safe things only (retries, short chapters, gaps), and decide the rest card by card.'));
  assert.match(html, /<button type="button" class="btn-key" data-fix-cancel="true">Cancel<\/button><button type="button" class="btn-key btn-key-primary" data-fix-start="true">Start<\/button>/,
    'the keys are not Cancel and Start, Start the filled one');
  // Start: Fix it for me posts the run; Let me choose runs today's repair plan -- every step some finding offers, `now`
  // with the failures -- and closes, the page's live strip saying what it does. Reintroduce `rr.start('page', …, { only:
  // ['gaps'] })`: "Let me choose does not run the safe repair's plan" fails.
  const ask = slice(code('components/FixEverythingDialog.tsx'), 'function AskView(', 'function RunView(');
  assert.match(ask, /const plan = pagePlan\(checks\);/, 'Let me choose does not plan from the cards');
  assert.match(ask, /if \(mode === 'auto'\) \{ void af\?\.start\(\); return; \}\s*void rr\.start\('page', 'safe_repair', pageBody\(plan\)\);\s*onClose\(\);/,
    'Let me choose does not run the safe repair\'s plan');
  assert.match(ask, /const canStart = mode === 'auto' \? !!af && !blocked : plan\.length > 0 && !gate\.disabled;/, 'Start does not wait for what holds the server');
  // The plan it runs: the repair's four steps, from the findings that offer them.
  const checks: HealthCheck[] = [
    check('chapter-failures', 'warn', [{ title: 'f', detail: '', sourceId: 'f', actions: ['retry'] }]),
    check('chapter-gaps', 'warn', [{ title: 'g', detail: '', seriesId: 'g', actions: ['fill'] }]),
    check('duplicates', 'warn', [{ title: 'd', detail: '', seriesIds: ['a', 'b'], actions: ['merge'] }]),
  ];
  assert.deepEqual(pageBody(pagePlan(checks)), { only: ['failures', 'gaps'], now: true });
});

test('with nothing safe to fix, Let me choose cannot start and says why; a busy server holds Fix it for me', () => {
  // A static render cannot pick Let me choose, so the rule is read where it is: no plan, no Start.
  const ask = slice(code('components/FixEverythingDialog.tsx'), 'function AskView(', 'function RunView(');
  assert.match(ask, /\(plan\.length \? null : tr\('Nothing is safe to fix by itself right now: every card waits for your choice\.'\)\)/);
  // A refused start (409 busy) is said where Start is, and Start stays to try again.
  const html = dialog(api({ slot: { phase: 'refused', startedAt: 1, reason: 'A repair is running; Fix everything can start when it ends' } }));
  assert.match(html, /data-fix-busy="true">A repair is running; Fix everything can start when it ends</, 'a refusal is not said where Start is');
  assert.match(html, /data-fix-view="ask"/, 'a refused start does not stay on the question');
});

/* ================================================================ the run */

test('the run is polled every 2 s while it goes, and the dialog opens on a live run, never on the question', () => {
  // Reintroduce `false` for a running run in autofixPollMs: "the run is polled while it goes" fails; drop fixView's first
  // branch: "a live run opens the run" fails.
  const live = run({ id: 'af2', status: 'running', phase: 'sources', phaseIndex: 3, current: { title: 'Solo Leveling', done: 12, of: 40 }, finishedAt: undefined });
  assert.equal(autofixPollMs({ run: live, last: null }, false), AUTOFIX_POLL_MS, 'the run is polled while it goes');
  assert.equal(AUTOFIX_POLL_MS, 2000);
  assert.equal(autofixPollMs({ run: null, last: null }, true), AUTOFIX_POLL_MS, 'a press not yet seen to end is not polled');
  assert.equal(autofixPollMs({ run: null, last: null }, false), false, 'an idle page polls');
  assert.equal(autofixPollMs({ run: null, last: null }, false, 30_000), 30_000);
  // The provider asks with that rule, and Server tasks too.
  assert.match(code('lib/useAutofixRun.tsx'), /refetchInterval: \(qq\) => autofixPollMs\(qq\.state\.data, !!awaiting\),/, 'the provider does not poll by the rule');
  // Opened while a run goes -- another admin's, the nightly's, with nothing pressed here -- the dialog is the run.
  const none = new Set<string>();
  assert.deepEqual(fixView({ status: { run: live, last: run() }, slot: null, seen: none, aside: none }), { view: 'run', run: live }, 'a live run opens the run');
  assert.equal(fixView({ status: { run: null, last: null }, slot: { phase: 'starting', startedAt: 1 }, seen: none, aside: none }).view, 'run', 'a press not yet answered asks');
  assert.equal(fixView({ status: { run: null, last: run({ id: 'old' }) }, slot: { phase: 'awaiting', runId: 'af3', startedAt: 1 }, seen: none, aside: none }).view, 'run',
    'a press whose run the status does not show yet shows the previous run\'s end');
  const html = dialog(api({ status: { run: live, last: null } }));
  assert.match(html, /data-fix-view="run" data-fix-run="running"/);
  assert.match(html, /data-fix-phase="sources">Testing and replacing sources</, 'the run does not say its phase');
  assert.match(html, /data-fix-step="true">Step 4 of 10 · 12 of 40</, 'the run does not say how far it has got');
  assert.match(html, /<bdi dir="auto" class="[^"]*">Solo Leveling<\/bdi>/, 'the run does not say what it is on');
  // The server words every phase (`current.said`) and names the series only on a list: both show. Reintroduce the
  // either-or (the sentence in place of the title): "the series it is on is not shown beside what it does" fails.
  const both = dialog(api({ status: { run: { ...live, current: { said: { code: 'autofix.now.gaps' }, title: 'Solo Leveling', done: 2, of: 5 } }, last: null } }));
  assert.match(both, /data-fix-waiting="true">Filling gaps<\/p>/, 'what the run does is not said');
  assert.match(both, /data-fix-now="true">[\s\S]*?<bdi dir="auto" class="[^"]*">Solo Leveling<\/bdi>/, 'the series it is on is not shown beside what it does');
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="33"/, 'the bar is not over the ten phases');
  assert.match(html, /data-fix-stop="true">Stop<\/button><button type="button" class="btn-key" data-fix-background="true">Run in background</, 'no Stop and Run in background');
  assert.equal(autofixProgress(live), (3 + 12 / 40) / 10);
  assert.equal(autofixProgress(run()), 1, 'a finished run is not a full bar');
  assert.equal(autofixStepLine(live), 'Step 4 of 10 · Testing and replacing sources');
  assert.equal(AUTOFIX_PHASES.length, 10);
  // Stopping: the key says so, and why it may take a moment.
  const stopping = dialog(api({ status: { run: live, last: null }, stopping: 'af2' }));
  assert.match(stopping, /disabled="" class="btn-key btn-key-danger" data-fix-stop="true">Stopping…</);
  assert.ok(stopping.includes('It stops at the next safe point, never in the middle of a merge, a delete or a renumbering.'));
  // Stop pressed by another admin, by the run card, or on this page before a reload: the server says `stopping`, and
  // every viewer reads it (the integration's answer to W's question 5). Reintroduce this page's press alone: "another
  // admin's Stop reads Stopping" fails.
  const theirs = dialog(api({ status: { run: { ...live, stopping: true }, last: null } }));
  assert.match(theirs, /disabled="" class="btn-key btn-key-danger" data-fix-stop="true">Stopping…</, 'another admin\'s Stop reads Stopping');
  assert.match(dialog(api({ status: { run: live, last: null } })), /class="btn-key btn-key-danger" data-fix-stop="true">Stop</, 'a run nobody stopped reads Stopping');
});

test('a run seen to end is followed up once, Health asked again; its end shows until it is set aside', () => {
  // The useRepairRun rule: re-check when the run ENDS. Reintroduce "not running means ended" for an awaited id: "an
  // answer from before the press reads as the end" fails.
  const live = run({ status: 'running', finishedAt: undefined });
  assert.deepEqual(autofixEndedIds({ run: live, last: null }, { run: null, last: run() }, []), ['af1']);
  assert.deepEqual(autofixEndedIds({ run: null, last: null }, { run: null, last: null }, ['af9']), [], 'an answer from before the press reads as the end');
  assert.deepEqual(autofixEndedIds(null, { run: null, last: run({ id: 'af9' }) }, ['af9']), ['af9']);
  assert.deepEqual(autofixEndedIds({ run: live, last: null }, { run: live, last: null }, []), [], 'a run still going reads as ended');
  const hook = code('lib/useAutofixRun.tsx');
  assert.match(hook, /ended\.current\(\),\s*qc\.refetchQueries\(\{ queryKey: REPAIR_RUNS_KEY \}\),/, 'Health and Recent repairs are not asked again when a run ends');
  const r = run();
  assert.equal(fixView({ status: { run: null, last: r }, seen: new Set(['af1']), aside: new Set() }).view, 'end', 'a run seen going does not show its end');
  assert.equal(fixView({ status: { run: null, last: r }, seen: new Set(['af1']), aside: new Set(['af1']) }).view, 'ask', 'an end set aside comes back');
  assert.equal(fixView({ status: { run: null, last: r }, seen: new Set(), aside: new Set() }).view, 'ask', 'last night\'s run opens on its end');
  // Close sets the end aside; the ✕ only hides it, so the next Needs-you item is a press away.
  const end = slice(code('components/FixEverythingDialog.tsx'), 'function EndView(', 'export function SafeRepairLine(');
  assert.match(end, /const close = \(\) => \{ af\?\.dismiss\(run\.id\); onClose\(\); \};/);
  assert.match(end, /onClick=\{close\} className="btn-key" data-fix-close>/);
});

/* ================================================================ the end */

test('the headline: who needs you first, "Everything else is green" under it when so; "All green" only with nobody needed', () => {
  // The integration's rule. `green` is "nothing but Needs you is left" -- true beside a Needs-you item (the solver down) --
  // so the headline reads Needs you first. Reintroduce `if (s?.green)` before the Needs-you branch (the merge's headline):
  // "the solver down reads All green" fails. Reintroduce `s?.green || !s?.needsYou.length` as the green rule: "nothing
  // left but a cooldown reads all green" fails.
  const needs = (n: number, o: Partial<AutofixSummary> = {}) =>
    summary({ needsYou: Array.from({ length: n }, (_, i) => ({ check: `c${i}`, said: said(`x${i}`) })), ...o });
  // The solver down, nothing else left: the server's green, and one item for a person.
  const solverDown = run({ summary: summary({ green: true, needsYou: [{ check: 'solver', said: said('The Cloudflare solver is not answering') }] }) });
  const head = autofixHeadline(solverDown);
  assert.notEqual(head.text, 'All green', 'the solver down reads All green');
  assert.equal(head.text, '1 needs you');
  assert.equal(head.tone, 'warn');
  assert.equal(head.sub, 'Everything else is green', 'what is not the solver is not said to be green');
  assert.equal(autofixHeadline(run({ summary: needs(2, { green: true }) })).text, '2 need you');
  // Something left that clears by itself as well: who needs you, and nothing said about the rest being green.
  const mixed = autofixHeadline(run({ summary: needs(2, { clears: [{ said: said('Natomanga is cooling down') }] }) }));
  assert.equal(mixed.text, '2 need you');
  assert.equal(mixed.sub, undefined, 'a cooldown left reads as everything else green');
  assert.equal(autofixHeadline(run({ summary: needs(1) })).text, '1 needs you', 'one item is not said in the singular');
  // Nobody needed: All green exactly when the server says so, else "Nothing needs you" over what clears by itself.
  assert.equal(autofixHeadline(run({ summary: summary({ green: true }) })).text, 'All green');
  assert.equal(autofixHeadline(run({ summary: summary({ green: true }) })).tone, 'ok', 'all green is not the emerald mark');
  assert.equal(autofixHeadline(run({ summary: summary({ green: true }) })).sub, undefined);
  const calm = autofixHeadline(run({ summary: summary({ clears: [{ said: said('Natomanga is cooling down') }] }) }));
  assert.notEqual(calm.text, 'All green', 'nothing left but a cooldown reads all green');
  assert.equal(calm.text, 'Nothing needs you');
  assert.notEqual(calm.tone, 'warn', 'nothing for a person to do is amber');
  assert.equal(autofixHeadline(run({ status: 'stopped', summary: summary({ green: true }) })).text, 'All green', 'a stopped run that left all green says otherwise');
  assert.equal(autofixHeadline(run({ status: 'stopped', summary: summary({ clears: [{ said: said('3 more to do') }] }) })).kind, 'stopped');
  assert.equal(autofixHeadline(run({ status: 'failed' })).kind, 'failed');
  assert.equal(autofixHeadline(run({ status: 'interrupted', summary: summary({ green: true }) })).kind, 'interrupted', 'a run cut short reads all green');
  // Drawn: the headline in its tone, the line under it muted (the sketch the owner saw).
  const green = dialog(ended(run({ summary: summary({ green: true, done: EIGHT.slice(0, 2) }) })));
  assert.match(green, /text-emerald-300[^"]*" data-fix-headline="green">/, 'all green is not drawn emerald');
  assert.ok(green.includes('>All green</span>'));
  assert.doesNotMatch(green, /data-fix-headline-sub/);
  const two = dialog(ended(run({ summary: needs(2) })));
  assert.match(two, /text-amber-300[^"]*" data-fix-headline="needs">/, 'what needs you is not drawn amber');
  assert.doesNotMatch(two, /Everything else is green/);
  const down = dialog(ended(solverDown));
  assert.match(down, /data-fix-headline="needs">[\s\S]*?>1 needs you<\/span><\/p><p class="mt-1 text-\[12px\] text-fog-400" data-fix-headline-sub="true">Everything else is green<\/p>/,
    'the solver down is not "1 needs you" over "Everything else is green"');
  // Recent repairs and the key read the same headline.
  assert.equal(autofixHeadline(autofixOfRecord({ kind: 'autofix', status: 'done', result: { summary: solverDown.summary } })!).text, '1 needs you');
});

test('the end shows at most six lines of what it did; the rest, and what each named, are under Details', () => {
  // Reintroduce `slice(0, 8)` (or no cap) in doneLines: "seven lines of what it did" fails.
  const { shown, rest } = doneLines(summary({ done: EIGHT }));
  assert.equal(DONE_SHOWN, 6);
  assert.deepEqual(shown.map((d) => d.kind), ['replaced', 'fetched', 'installed', 'merged', 'deletedTwice', 'renumbered'], 'more than six lines of what it did are shown');
  assert.deepEqual(rest.map((d) => d.kind), ['shortFixed', 'retired'], 'the lines past six are not kept for Details');
  assert.deepEqual(shown[2].items, ['Asura Scans (EN): Solo Leveling']);
  // A sentence this build cannot word is left out, never half English.
  assert.deepEqual(doneLines(summary({ done: [{ kind: 'fetched', n: 1, said: { code: 'autofix.unknownCode' } }] })).shown, []);
  const html = dialog(ended(run({ summary: summary({ done: EIGHT }), log: [said('Step 1: a line of the log')] })));
  const lines = [...html.matchAll(/data-fix-done="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.equal(lines.length, 6, `${lines.length} lines of what it did`);
  assert.match(html, /data-fix-details="true">/, 'there is no Details');
  assert.match(html, /aria-expanded="false"[^>]*>Details/, 'Details is open by default');
  assert.doesNotMatch(html, /Turned off 5 sources nothing uses/, 'the seventh line is out from under Details');
  assert.doesNotMatch(html, /Step 1: a line of the log/, 'the log is out from under Details');
  // Nothing past six and no log: no Details.
  assert.doesNotMatch(dialog(ended(run({ summary: summary({ green: true, done: EIGHT.slice(0, 2) }) }))), /data-fix-details/);
});

test('each Needs-you item has its one key: its page, its card, or Admin → Settings', () => {
  // Reintroduce a needs-you line without its key (drop <NeedsKey> in EndView): "an item has no key" fails.
  assert.deepEqual(needsYouKey({ kind: 'open', href: '/series/?id=s6' }), { kind: 'link', href: '/series/?id=s6', label: 'Open', page: false, external: false });
  assert.deepEqual(needsYouKey({ kind: 'open', href: '/admin/?tab=Sources&source=aqua' }), { kind: 'link', href: '/admin/?tab=Sources&source=aqua', label: 'Open', page: true, external: false },
    'another of the console\'s tabs is a client-side link, which leaves Health on screen');
  assert.deepEqual(needsYouKey({ kind: 'health', check: 'solver' }), { kind: 'card', check: 'solver', label: 'Show the card' });
  assert.deepEqual(needsYouKey({ kind: 'settings', key: 'repairEnabled' }), { kind: 'link', href: '/admin/?tab=Settings', label: 'Settings', page: true, external: false });
  for (const bad of ['javascript:alert(1)', '//evil.example/x', 'data:text/html,x']) {
    assert.equal(needsYouKey({ kind: 'open', href: bad }), null, `${bad} becomes a link`);
  }
  // Never hidden for want of words: a sentence this build cannot word is its card's name.
  assert.deepEqual(needsYouLines(summary({ needsYou: [{ check: 'solver', said: { code: 'autofix.unknownCode' } }] })).map((n) => n.text), ['Cloudflare solver']);
  const html = dialog(ended(run({ summary: summary({ needsYou: [
    { check: 'chapter-gaps', said: said('Omniscient Reader, chapters 12–14: no source has them'), action: { kind: 'open', href: '/series/?id=s6' } },
    { check: 'solver', said: said('The Cloudflare solver is not answering: restart its container'), action: { kind: 'health', check: 'solver' } },
    { check: 'extension-cap', said: said('Raise the source limit'), action: { kind: 'settings', key: 'x' } },
  ] }) })));
  const items = [...html.matchAll(/<li [^>]*data-fix-needs="([^"]+)">([\s\S]*?)<\/li>/g)];
  assert.equal(items.length, 3);
  const keyOf = (body: string) => /data-fix-key="([a-z]+)"/.exec(body)?.[1] ?? null;
  assert.deepEqual(items.map((m) => [m[1], keyOf(m[2])]), [['chapter-gaps', 'open'], ['solver', 'health'], ['extension-cap', 'settings']], 'an item has no key');
  // A page of the app's own is a client-side link (Next's Link, which writes the address without the slash).
  assert.match(items[0][2], /<a class="btn-key shrink-0" data-fix-key="open" href="\/series\/?\?id=s6">Open<\/a>/);
  assert.match(items[2][2], /<a href="\/admin\/\?tab=Settings" class="btn-key shrink-0" data-fix-key="settings">Settings<\/a>/, 'Admin → Settings is not a whole page load');
  assert.match(items[1][2], /<button type="button" class="btn-key shrink-0" data-fix-key="health">Show the card<\/button>/);
  // Sentences in the reader's language take the page's direction: `dir="auto"` read an Arabic sentence opening on a name
  // ("Omniscient Reader، الفصول 12–14…") left-to-right, the name at its far end (the Arabic 390 screenshot). Reintroduce
  // `dir="auto"` on the item's text: this fails.
  for (const m of items) assert.doesNotMatch(m[2], /<p dir="auto"/, `${m[1]}: a sentence takes its direction from its first letter`);
  assert.doesNotMatch(dialog(ended(run({ summary: summary({ done: EIGHT }) }))), /<span dir="auto" class="min-w-0 break-words">/, 'a line of what it did takes its direction from its first letter');
  // The card key closes the dialog, opens the card and scrolls to it, clear of the top bar.
  const health = slice(code('app/admin/page.tsx'), 'function Health()', 'function DesktopUpdateNote()');
  assert.match(health, /setFixing\(false\);\s*setOpen\(id\);\s*requestAnimationFrame\(\(\) => document\.querySelector\(`\[data-health-check="\$\{CSS\.escape\(id\)\}"\]`\)\?\.scrollIntoView/);
  assert.match(health, /data-health-check=\{c\.id\} className=\{`[^`]*\bscroll-mt-4\b[^`]*\blg:scroll-mt-20\b/, 'the card scrolls under the top bar');
  // What clears by itself: one muted line each, with when.
  const at = new Date(Date.now() + 3 * 3_600_000 + 60_000).toISOString();
  assert.deepEqual(clearsLines(summary({ clears: [{ said: said('Natomanga is cooling down'), at }] })), [{ text: 'Natomanga is cooling down', when: 'in 3 hours' }]);
});

test('Run again only while something a run could still change is left: the server\'s `again`, never `!green`', () => {
  // Reintroduce `!run.summary.green` (W's rule before the contract had `again`): "Run again for a cooldown alone" fails.
  assert.equal(canRunAgain(run({ summary: summary({ green: true }) })), false, 'Run again after all green');
  assert.equal(canRunAgain(run({ summary: summary({ green: false, again: false, clears: [{ said: said('Natomanga is cooling down') }] }) })), false,
    'Run again for a cooldown alone');
  assert.equal(canRunAgain(run({ summary: summary({ green: false, again: true }) })), true, 'no Run again with the next run\'s work left');
  assert.equal(canRunAgain(run({ summary: summary({ green: true, again: false, needsYou: [{ check: 'solver', said: said('x') }] }) })), false,
    'Run again for Needs you alone');
  assert.equal(canRunAgain(run({ status: 'stopped', summary: summary({ again: true }) })), true);
  assert.equal(canRunAgain(run({ status: 'failed' })), true, 'a run that ended before its summary left everything');
  assert.equal(canRunAgain(run({ status: 'running', finishedAt: undefined })), false);
  assert.equal(canRunAgain(null), false);
  assert.doesNotMatch(dialog(ended(run({ summary: summary({ green: true }) }))), /data-fix-again/, 'all green offers Run again');
  assert.doesNotMatch(dialog(ended(run({ summary: summary({ needsYou: [{ check: 'solver', said: said('x') }], clears: [{ said: said('y') }] }) }))),
    /data-fix-again/, 'a cooldown and Needs you offer Run again');
  assert.match(dialog(ended(run({ summary: summary({ again: true, needsYou: [{ check: 'solver', said: said('x') }], clears: [{ said: said('y') }] }) }))),
    /data-fix-again="true">Run again<\/button><button type="button" class="btn-key" data-fix-close="true">Close<\/button>/);
  // The history's record carries it too.
  assert.equal(autofixOfRecord({ kind: 'autofix', status: 'done', result: { summary: { green: false, again: true, done: [] } } })!.summary!.again, true);
});

/* ================================================================ the nightly */

test('the nightly choice: Safe repair or Fix everything, saved as it is picked', () => {
  // Reintroduce `patch({ nightly: m })` (or drop the row): "the nightly choice is not saved as nightlyMode" fails.
  const settings = code('components/AdminSettings.tsx');
  assert.match(settings, /<NightlyModeRow mode=\{nightlyModeOf\(data\)\} off=\{data\.repair_enabled === false\} onPick=\{\(m\) => patch\(\{ nightlyMode: m \}\)\} \/>/,
    'the nightly choice is not saved as nightlyMode');
  const row = slice(settings, 'export function NightlyModeRow(', 'function HousekeepingSection(');
  assert.match(row, /if \(!\(await run\(\(\) => onPick\(m\)\)\)\) setLocal\(mode\);/, 'a refused save leaves the choice where it was not saved');
  assert.match(row, /<Segmented square label=\{label\} value=\{local\} disabled=\{off\}/);
  const html = renderToStaticMarkup(createElement(NightlyModeRow, { mode: 'autofix', off: false, onPick: async () => {} }));
  assert.match(html, /role="radiogroup" aria-label="Every night"/);
  assert.match(html, /aria-checked="true"[^>]*>(?:<span[^>]*><\/span>)?<span class="relative text-accent">Fix everything</, 'the stored choice is not the checked one');
  assert.ok(html.includes('Safe repair: retries, short chapters, gaps and the solver; nothing is deleted or merged.'));
  assert.match(renderToStaticMarkup(createElement(NightlyModeRow, { mode: 'repair', off: true, onPick: async () => {} })), /disabled=""/, 'the choice is live while the nightly is off');
  // The answer's name is the contract's `nightlyMode`, the one the server sends, and the only one read (the
  // integration's answer to W's question 3); anything else is the safe repair. Reintroduce a read of `nightly_mode`:
  // "the column's name is read" fails.
  assert.equal(nightlyModeOf({ nightlyMode: 'autofix' }), 'autofix');
  assert.equal(nightlyModeOf({ nightly_mode: 'autofix' } as { nightlyMode?: unknown }), 'repair', 'the column\'s name is read');
  assert.equal(nightlyModeOf({ nightlyMode: 'bogus' }), 'repair');
  assert.equal(nightlyModeOf(undefined), 'repair');
  // The switch above no longer says "nothing is deleted or merged" over a nightly Fix everything.
  assert.match(settings, /help=\{nightlyModeOf\(data\) === 'autofix'\s*\? tr\('Once a day, Fix everything runs by itself/);
});

/* ================================================================ Free a slot */

test('Free a slot opens Admin → Sources on the frozen series\' source, as a whole page load', () => {
  // Reintroduce `/admin/?tab=Sources` alone: "the source's sheet is not asked for" fails; read `source=` nowhere in
  // SourcesPanel: "the panel does not open the source's sheet" fails.
  assert.equal(freeSlotHref({ sourceId: 'sw:5000000000000000001' }), '/admin/?tab=Sources&source=sw%3A5000000000000000001', 'the source\'s sheet is not asked for');
  assert.equal(freeSlotHref({}), '/admin/?tab=Sources');
  const p = (q: string) => new URLSearchParams(q);
  assert.equal(sourceTarget(p('tab=Sources&source=sw%3A5000000000000000001')), 'sw:5000000000000000001');
  assert.equal(sourceTarget(p('tab=Sources')), null);
  assert.equal(sourceTarget(p('source=%3Cscript%3E')), null);
  assert.equal(settingsTarget(p('source=sw%3A1')), null, 'source= opens an extension\'s settings');
  const panel = code('components/SourcesPanel.tsx');
  assert.match(panel, /const \[arrived\] = useState\(\(\) => \(settingsTarget\(params\) \? null : sourceTarget\(params\)\)\);/, 'the panel does not open the source\'s sheet');
  assert.match(panel, /return arrived \? \{ id: arrived \} : null;/, 'the panel does not open the source\'s sheet');
  assert.match(panel, /u\.searchParams\.delete\('source'\);/, 'a reload opens the sheet again');
  // The key: Health's own words for it, and its legend row.
  const row = slice(code('components/HealthActions.tsx'), "case 'free_slot':", 'default:');
  assert.match(row, /label: tr\('Free a slot'\), onRun: \(\) => \{ window\.location\.assign\(freeSlotHref\(item\)\); \}/);
});

/* ================================================================ Server tasks and Recent repairs */

test('Server tasks shows the server\'s own card as "Fixing everything" with its phase, and stops it through its own route', () => {
  // The integration's answer to W's question 1: the server lists the run among its own (GET /api/sources/jobs `runs`,
  // kind `autofix`, an admin's), with `cancelRequested` once anybody asks it to stop -- so every admin's Server tasks
  // reads the same card. The web no longer builds one from the autofix status (a second poll of an admin route on every
  // Downloads view). Reintroduce that card: "Server tasks builds a card of its own" fails.
  const card = {
    kind: 'autofix' as const, startedAt: 1, status: 'running' as const, done: 6, total: 10, fetched: 0, failed: 0,
    step: 'chapters', current: { id: 's1', title: 'Nano Machine' },
  };
  assert.equal(runName(card), 'Fixing everything');
  assert.equal(runTitle('autofix'), 'Fixing everything');
  assert.equal(runProgress(card), 'step 7 of 10');
  assert.equal(autofixPhaseLabel(card.step), 'Fetching missing and broken chapters', 'the card\'s step is not the phase in words');
  // The Library ring does not turn for it: what it downloads turns it through the repair's card and the chapters.
  assert.equal(navRing({ content: [], runs: [card] }).show, false, 'the Library ring turns for Fix everything');
  const view = code('components/ServerDownloadsView.tsx');
  assert.doesNotMatch(view, /useAutofixStatus|withAutofixCard|autofixRunCard/, 'Server tasks builds a card of its own');
  assert.match(view, /const data = raw as SourceJobs<Job> \| undefined;/);
  // Stop on the card is Fix everything's own route (a safe point), never the sweep's Cancel; the card says Stopping…
  // from the server's `cancelRequested`, whoever pressed.
  assert.match(view, /if \(kind !== 'autofix'\) return call\(/, 'Stop on the card is the sweep\'s Cancel');
  assert.match(view, /try \{ await stopAutofix\(\); \}/);
  assert.match(view, /const stops = find \|\| r\.kind === 'autofix';/);
  assert.match(view, /\{running && r\.cancelRequested && <p className="[^"]*">\{stops \? tr\('Stopping…'\) : tr\('Stopping after this chapter…'\)\}<\/p>\}/);
  assert.match(code('lib/useAutofixRun.tsx'), /export const stopAutofix = \(\) => api\(`\$\{AUTOFIX_URL\}\/stop`, \{ method: 'POST' \}\);/);
});

test('Recent repairs lists a Fix everything run with its headline and its first two lines of what it did', () => {
  // Reintroduce the repair's result line for it: "a Fix everything run reads as a repair" fails.
  assert.equal(kindLabel('autofix'), 'Fixing everything');
  assert.notEqual(kindLabel('autofix'), 'Fix everything', 'the run is named by its key\'s label');
  const rec = { kind: 'autofix', status: 'done', result: { summary: { green: false, done: EIGHT.slice(0, 3), needsYou: [{ check: 'solver', said: said('x') }] } } };
  const inline = autofixOfRecord(rec)!;
  assert.equal(autofixHeadline(inline).text, '1 needs you');
  assert.deepEqual(doneLines(inline.summary).shown.slice(0, 2).map((d) => d.text), ['Moved 184 series off Aqua Manga', 'Fetched 37 missing chapters']);
  assert.equal(autofixOfRecord({ kind: 'full', status: 'done', result: { counted: 3 } }), null);
  assert.equal(autofixOfRecord({ kind: 'autofix', status: 'done', result: null }), null);
  const live = code('components/RepairLive.tsx');
  assert.match(live, /\{fix \? <AutofixLines r=\{r\} \/> : <p className="[^"]*">\{recordLine\(r\)\}<\/p>\}/, 'a Fix everything run reads as a repair');
  assert.match(live, /const first = doneLines\(run\.summary\)\.shown\.slice\(0, HISTORY_DONE\);/);
  // The integration's answer to W's question 2: the history sends each run's summary, so no row asks for its run (twenty
  // rows were twenty requests). Reintroduce the read by id: "Recent repairs asks for nothing per row" fails.
  const lines = slice(live, 'function AutofixLines(', 'function HistoryRow(');
  assert.doesNotMatch(lines, /useQuery|AUTOFIX_URL|api</, 'Recent repairs asks for nothing per row');
  assert.match(lines, /if \(!run\) return r\.status === 'running' \? null : <p className="[^"]*">\{runStatusWord\(r\.status\)\}<\/p>;/,
    'a run that ended before its summary says nothing');
});
