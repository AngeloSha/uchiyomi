// The keys on Admin -> Health (v0.41.0; rebuilt for v0.49.0 as keys, legends and status lines).
//
// Health could name a problem and never do anything about it. Each item carries the keys its `actions` list
// asks for, and a card carries its legend and its card-wide actions (Fix all, Reset the solver, Merge all,
// Scan now). v0.49.0 answered the owner's four questions -- what does it do, how, how long, is it working --
// so a repair-backed key now runs through lib/useRepairRun.tsx and the page is checked again when the run
// ENDS, not when it starts.
//
// Read from source, like wall.test.ts and addSeriesDialog.test.ts: these are wiring facts -- which route a
// key posts to, which body it sends, which sentence a refusal gets -- and each guard names the edit that
// fails it. What the routes then DO is bff/test/repair.int.test.ts and repairRoutes.int.test.ts; the pure
// rules are web/test/repairRun.test.ts and healthCopy.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments below quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const unescape = (s: string): string =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\'/g, "'");
const trKeys = (files: string[]): Set<string> => {
  const keys = new Set<string>();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(unescape(m[1]));
    for (const m of src.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1]));
  }
  return keys;
};

const KEYS = 'components/HealthActions.tsx';
const LIVE = 'components/RepairLive.tsx';
const HOOK = 'lib/useRepairRun.tsx';
const COPY = 'lib/healthCopy.ts';
const RUN = 'lib/repairRun.ts';
const PAGE = 'app/admin/page.tsx';
const SETTINGS = 'components/AdminSettings.tsx';
const TYPES = 'lib/types.ts';

/** One arm of HealthRow's `spec()` switch: `case 'x':` up to the next `case`/`default`. */
function arm(src: string, action: string): string {
  const at = src.indexOf(`case '${action}':`);
  assert.notEqual(at, -1, `HealthRow has no key for '${action}'`);
  const rest = src.slice(at + 1);
  const end = rest.search(/\n\s+(case '|default:)/);
  return rest.slice(0, end === -1 ? rest.length : end);
}
const rowOf = (src: string) => src.slice(src.indexOf('export function HealthRow'), src.indexOf('const SCAN_CHECKS'));

// Every action in the contract, the label it must carry, and the one request it makes. The labels are asserted
// as written source, not as rendered text: a key that stopped calling tr() renders English in eight languages.
// `solver_reset` is not here: the step acts on every source that blames the solver whatever row is pressed,
// so it is ONE card-wide action (the test below), never a row's key.
const ACTIONS: { action: string; labels: string[]; wants: RegExp }[] = [
  { action: 'fix_short', labels: ["tr('Fix')"], wants: /const b = itemBody\(a, item\); if \(b\) void rr\.start\(slotKey, a, b\);/ },
  { action: 'confirm_short', labels: ["tr('Not fine')", "tr('It’s fine')"], wants: /\/api\/admin\/books\/\$\{encodeURIComponent\(item\.bookId \|\| ''\)\}\/confirm-short[\s\S]*json: \{ confirmed: !confirmed \}/ },
  { action: 'delete', labels: ["tr('Delete chapter')", "tr('Delete chapters')"], wants: /setAsking\('delete'\)/ },
  { action: 'fill', labels: ["tr('Fill now')"], wants: /const b = itemBody\(a, item\); if \(b\) void rr\.start\(slotKey, a, b\);/ },
  { action: 'retry', labels: ["tr('Retry now')"], wants: /const b = itemBody\(a, item\); if \(b\) void rr\.start\(slotKey, a, b\);/ },
  { action: 'test', labels: ["tr('Test')"], wants: /\/api\/admin\/sources\/\$\{encodeURIComponent\(item\.sourceId \|\| ''\)\}\/test/ },
  { action: 'unblock', labels: ["tr('Clear block')"], wants: /\/api\/admin\/sources\/\$\{encodeURIComponent\(item\.sourceId \|\| ''\)\}\/unblock/ },
  { action: 'disable', labels: ["tr('Turn off')"], wants: /setAsking\('disable'\)/ },
  { action: 'merge', labels: ["tr('Merge')"], wants: /setAsking\('merge'\)/ },
  // v0.48.3: the owner's "no button to ignore this warning so it never repeats again".
  { action: 'ignore', labels: ["tr('Ignore')"], wants: /postIgnore\(check\.id, item, true\)/ },
  { action: 'unignore', labels: ["tr('Stop ignoring')"], wants: /postIgnore\(check\.id, item, false\)/ },
  // #72: the Extension engine row's one-click fix, the same route as the Extensions tab's Connect.
  { action: 'engine_solver', labels: ["tr('Connect')"], wants: /act\(a, async \(\) => \{\s*await api\('\/api\/admin\/extensions\/solver', \{ method: 'POST', json: \{\} \}\);/ },
  // #116: Review opens the plan of whatever waits; its Confirm posts through the row (the test below). Keep the
  // source's numbers asks the route as it stands, without confirm.
  { action: 'renumber', labels: ["tr('Review renumbering')"], wants: /onRun: \(\) => setPlan\(\{ action: a, mode: 'next' \}\)/ },
  { action: 'keep_numbers', labels: ["tr('Keep the source’s numbers')"], wants: /\/api\/admin\/series\/\$\{encodeURIComponent\(item\.seriesId \|\| ''\)\}\/numbering`, \{ json: \{ mode: 'source' \} \}\)/ },
  // v0.49.1: every series whose main source is the row's, in ONE background run (POST /api/admin/sources/find). Its
  // label is the counted one in healthCopy.ts ("Find other sources (189 series)"), whose tr() findSources.test.ts holds.
  // v0.51.0: the press opens the start dialog (follow automatically, or review first); its Start posts the source.
  { action: 'find_sources', labels: ['label: copy.label({ ...ctx, n: item.findSeries })'], wants: /onRun: \(\) => setAsking\('find'\)/ },
];

test('every action the health check can offer renders one key, with the label and the request it promises', () => {
  // The server decides what an item offers; this file decides what each one looks like and does. A missing arm
  // renders NOTHING for that action -- the item silently loses its only remedy -- so the switch is checked
  // against the HealthAction union rather than against itself. Reintroduce by deleting the `case 'fill':`
  // arm: "'fill' has 0 keys, not one" fails.
  const src = rowOf(code(read(KEYS)));
  const types = code(read(TYPES));
  const decl = types.slice(types.indexOf('export type HealthAction'));
  const declared = [...decl.slice(0, decl.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(declared.filter((a) => a !== 'solver_reset').sort(), ACTIONS.map((a) => a.action).sort(), 'HealthAction and the keys have drifted apart');
  for (const { action, labels, wants } of ACTIONS) {
    const arms = (src.match(new RegExp(`case '${action}':`, 'g')) ?? []).length;
    assert.equal(arms, 1, `'${action}' has ${arms} keys, not one: an item offering it renders nothing, or renders twice`);
    const a = arm(src, action);
    for (const l of labels) assert.ok(a.includes(l), `the '${action}' key does not read ${l}`);
    assert.match(a, wants, `the '${action}' key does not make the request its brief promises`);
    assert.match(a, /\.\.\.base/, `the '${action}' key is not built on the tagged base (data-health-action)`);
  }
  // Every key reaches its <button> tagged for the walk-through, and carries its row's state.
  assert.match(src, /buttonProps: \{ 'data-health-action': a \}/, 'the keys are not tagged for the walk-through');
  assert.match(src, /const mine = rowAction === a \? rowNow : IDLE;/, 'a key does not carry the state of its own press');
  // Rectangular keys and a status line under the finding -- never a chip.
  assert.match(src, /<ActionKeys actions=\{specs\}/, 'the finding\'s keys are not ActionKeys');
  assert.match(src, /<ActionStatus state=\{rowNow\} \/>/, 'the finding has no status line');
  assert.doesNotMatch(code(read(KEYS)), /className=\{?[`'"][^`'"]*\bchip\b/, 'a Health action is still a chip');
});

test('the solver reset is one card-wide action, gated on a finding that offers it, and no row renders it', () => {
  // The step acts on every source that blames the solver whatever row was pressed, and does nothing while
  // the solver is down. Reintroduce the per-row key by dropping the filter: "a row renders the solver
  // reset" fails; offer Fix all on any finding: "a card's Fix all is not gated" fails.
  const src = code(read(KEYS));
  assert.match(rowOf(src), /\(item\.actions \|\| \[\]\)\.filter\(\(a\) => a !== 'solver_reset'\)/, 'a row renders the solver reset');
  const card = src.slice(src.indexOf('export function HealthCardActions'), src.indexOf('export function CardProgress'));
  assert.match(card, /const stepRows = step \? stepFindings\(check, step\) : \[\];\n  if \(step && stepRows\.length\) \{/, 'a card\'s Fix all is not gated on findings that carry its step\'s own key');
  assert.match(card, /const body = cardBody\(step\);/, 'a card\'s Fix all does not send its step\'s body (the failures card\'s `now`)');
  assert.match(card, /data-health-fix-all': check\.id/, 'the card\'s Fix all is not tagged for the walk-through');
  assert.match(card, /if \(solverDown\(check\)\)/, 'the solver card says nothing when the solver is down');
  const run = code(read(RUN));
  assert.match(run, /export function stepFindings[\s\S]*?!it\.info && \(it\.actions \?\? \[\]\)\.includes\(want\)/, 'info rows or rows without the step\'s key count as something to fix');
  assert.match(run, /return step === 'failures' \? \{ only: \[step\], now: true \} : \{ only: \[step\] \};/, 'the failures card does not send now');
});

test('every repair-backed key, card Fix all and Fix all issues waits while a sweep or another repair runs', () => {
  // No queue this release (design decision 6): each is disabled, saying why, until the running one ends. The rule
  // is healthCopy.ts repairGate (healthCopy.test.ts); this holds every key to it. Reintroduce `const gate = {};` in
  // HealthRow, or the old `disabled: !!rr.blocked` without a title on a card: the matching assertion fails.
  const src = code(read(KEYS));
  const row = rowOf(src);
  assert.match(row, /const gate = isRepairAction\(a\) \? repairGate\(blocked, status\?\.run, busyHere && rowAction === a\) : \{\};/,
    'a finding\'s repair key is not gated on a running sweep or repair');
  for (const a of ['fix_short', 'fill', 'retry']) assert.match(arm(row, a), /\.\.\.base, \.\.\.gate,/, `the '${a}' key ignores the gate`);
  const card = src.slice(src.indexOf('export function HealthCardActions'), src.indexOf('export function CardProgress'));
  assert.match(card, /\.\.\.repairGate\(rr\.blocked, status\?\.run, busy\),/, 'a card\'s Fix all is not gated');
  const page = src.slice(src.indexOf('export function FixAllIssues'));
  assert.match(page, /const gate = repairGate\(rr\.blocked, status\?\.run, busy\);/, 'Fix all issues is not gated');
  assert.match(page, /disabled: !plan\.length \|\| !!gate\.disabled,\s*disabledWhy: gate\.disabledWhy,/, 'Fix all issues does not say why it waits');
});

test('#72: Connect on the Extension engine row answers on the row and refreshes the Extensions tab', () => {
  // Reintroduce the arm without invalidating ['ext-status']: the Extensions tab says the helper is off for up to 30 s
  // after Health connected it.
  const row = rowOf(code(read(KEYS)));
  const a = arm(row, 'engine_solver');
  assert.match(a, /void qc\.invalidateQueries\(\{ queryKey: \['ext-status'\] \}\);/, 'the Extensions tab keeps the old helper state');
  assert.match(a, /tr\('Connected: the extension engine now uses Uchiyomi’s Cloudflare helper\.'\)/, 'Connect says nothing on its row');
  // A connected engine is no finding: the row is gone when Health answers, before its line can be read. Reintroduce
  // by dropping the notice: "Connected is said nowhere anyone sees it".
  assert.match(a, /toast\(text, 'success'\);\s*return \{ text \};/, 'Connected is said nowhere anyone sees it');
});

test('#116: a numbering key opens the plan, and the plan\'s Confirm is the row\'s own press', () => {
  // Nothing is renamed before the admin has seen which file becomes which chapter: Review only opens the plan, and
  // its Confirm posts `confirm: true` through act(), so the row's status line says "Renaming…" with its clock, then
  // what came of it, then Health again. Reintroduce the sheet posting it by itself (drop onConfirm): the row says
  // nothing about the rename it asked for.
  const row = rowOf(code(read(KEYS)));
  assert.match(row, /<NumberingSheet seriesId=\{item\.seriesId\} mode=\{plan\.mode\} onClose=\{\(\) => setPlan\(null\)\}\s*onConfirm=\{\(mode\) => act\(plan\.action, \(\) => renumber\(mode\), tr\('Renaming…'\)\)\} \/>/,
    'the plan\'s Confirm is not the row\'s press');
  const fn = row.slice(row.indexOf('const renumber = async'), row.indexOf('const doDelete'));
  assert.match(fn, /\{ json: \{ mode, confirm: true \} \}/, 'the plan\'s Confirm does not confirm');
  assert.match(fn, /out = numberingOutcome\(await api<NumberingAnswer>/, 'the answer is not said in words (numberingOutcome)');
  assert.match(fn, /catch \(e\) \{\s*return \{ text: refusalText\(e, tr\('Could not do that'\)\), ok: false \};/, 'a refusal is not said as what it is');
  // Applied, the finding and its row are gone when Health answers: the outcome is said in a notice too, as a
  // delete's and a merge's are. Reintroduce by dropping it: "a renumber is said nowhere anyone sees it".
  assert.match(fn, /if \(out\.ok !== false && !out\.partial\) toast\(out\.text, 'success'\);/, 'a renumber is said nowhere anyone sees it');
  // Keeping the source's numbers on an applied series is the way back, which renames: the plan opens instead.
  const keep = arm(row, 'keep_numbers');
  assert.match(keep, /if \(r\.state === 'needs_confirm'\) \{ setPlan\(\{ action: a, mode: 'source' \}\); return null; \}/, 'the way back renames without its plan');
  assert.match(keep, /if \(r\.state !== 'unchanged'\) return numberingOutcome\(r\);\s*const text = tr\('Kept the source’s numbers'\);\s*toast\(text, 'success'\);\s*return \{ text \};/,
    'keeping the source\'s numbers is said nowhere anyone sees it');
  // A press that changed nothing -- the plan opened instead -- does not ask Health again. Reintroduce by dropping the
  // early return: the row reads "Checking the result…" under an open plan.
  const act = row.slice(row.indexOf('const act = '), row.indexOf('const renumber = async'));
  assert.ok(act.indexOf('if (!out && !err) { setSync(null); return; }') > 0
    && act.indexOf('if (!out && !err) { setSync(null); return; }') < act.indexOf("step: tr('Checking the result…')"), 'a press that changed nothing asks Health again');
  assert.match(act, /\.\.\.\(out\.partial \? \{ partial: true \} : \{\}\)/, 'a rename still running reads as done');
});

test('#117: the slow archive\'s caveat reads as a plain line, the others in amber', () => {
  // Reintroduce the one amber class for every caveat: gaps on their way read as a problem.
  const row = rowOf(code(read(KEYS)));
  assert.match(row, /\.map\(\(c\) => \(\{ text: caveatLine\(c\), tone: caveatTone\(c\) \}\)\)/, 'caveats are not toned');
  assert.match(row, /data-health-caveat=\{c\.tone\} className=\{`mt-1 text-\[11px\] leading-relaxed \$\{c\.tone === 'calm' \? 'text-fog-400' : 'text-amber-300\/90'\}`\}/,
    'a calm caveat is drawn in amber');
});

test('every dialog a Health card opens is on <body>, out of the card', () => {
  // A Health card is a `.card`: its backdrop blur makes it the containing block of a `fixed` dialog inside it, and
  // its overflow-hidden cuts the dialog off. Reintroduce by rendering a ConfirmDialog in place: this names it.
  const src = code(read(KEYS));
  const opens = [...src.matchAll(/<ConfirmDialog\b/g)].map((m) => m.index!);
  assert.equal(opens.length, 5, 'the Health confirmations moved -- update this count');
  for (const at of opens) {
    const before = src.slice(0, at);
    assert.ok(before.lastIndexOf('<OnBody>') > before.lastIndexOf('</OnBody>'), `a Health confirmation is rendered inside its card: ${src.slice(at, at + 90)}`);
  }
  // The plan sheet puts itself on <body> (numbering.test.ts holds NumberingSheet to it).
  assert.match(code(read('components/NumberingSheet.tsx')), /return \(\s*<OnBody>\s*<Sheet\b/, 'the plan sheet is rendered inside the card');
});

test('#115: the Test key holds no verdict of its own, its status line says the limit, and source rows show their stages', () => {
  // The refetched row carries the verdict (item.diagnosis, the stage lines), drawn by SourceEvidence among the
  // row's words: ONE verdict on screen, and it survives a reload. Reintroduce `setFix(...)` in the 'test' arm (and
  // its useState): "the Test key keeps a verdict of its own" fails. Drop `testStep(check.testMs)` from the arm:
  // "the running Test does not say its limit" fails.
  const src = code(read(KEYS));
  assert.doesNotMatch(src, /setFix|const \[fix, /, 'the Test key keeps a verdict of its own');
  const row = rowOf(src);
  const arm = row.slice(row.indexOf("case 'test':"), row.indexOf("case 'unblock':"));
  assert.match(arm, /\}, testStep\(check\.testMs\)\),/, 'the running Test does not say its limit');
  assert.match(row, /setSync\(\{ action: a, at, state: \{ kind: 'working', startedAt: at, step \} \}\);/, 'act ignores the step it is given');
  // Through healthRowEvidence, which drops the fix a row's detail already says and the one under a row listed for
  // reference (lib/sourceEvidence.ts; its rules are held in sourceEvidence.test.ts).
  const page = code(read(PAGE));
  const health = page.slice(page.indexOf('function Health()'), page.indexOf('function DesktopUpdateNote('));
  assert.match(health, /\{c\.id === 'sources' && <SourceEvidence \{\.\.\.healthRowEvidence\(it\)\} \/>\}\n\s*<\/HealthRow>/,
    'Health\'s source rows do not show the stage lines');
});

test('Fix all exists only for the steps the nightly is allowed to do by itself', () => {
  // ⚠️ No `duplicates`, no `outliers`. The nightly never merges, deletes, tombstones or renumbers, and a
  // Fix all that quietly did would be the one button in this console able to destroy a library in a tap.
  // Reintroduce by adding `duplicates: 'gaps'` (or any entry) to CARD_STEP: this test fails.
  const run = code(read(RUN));
  const map = run.slice(run.indexOf('export const CARD_STEP'), run.indexOf('export const STEP_ACTION'));
  assert.match(map, /'short-chapters': 'short'/);
  assert.match(map, /'chapter-gaps': 'gaps'/);
  assert.match(map, /'chapter-failures': 'failures'/);
  assert.match(map, /\bsolver: 'solver'/);
  assert.doesNotMatch(map, /duplicates|outliers|frozen-series|sources/, 'Fix all is offered for a check the nightly must never touch on its own');
  assert.match(run, /export const PAGE_STEPS: readonly RepairStep\[\] = \['solver', 'failures', 'short', 'gaps'\];/);
});

test('a repair-backed key re-checks Health when its run ENDS, never at the press', () => {
  // The v0.48 chips asked Health again as soon as the POST answered -- when the repair had only just begun --
  // so the finding was still there, the row woke up, and the result lived on the Tasks tab. Reintroduce by
  // calling `rr.recheck()` in a repair arm: "Health is checked again at the press" fails.
  const src = rowOf(code(read(KEYS)));
  for (const a of ['fix_short', 'fill', 'retry']) {
    assert.doesNotMatch(arm(src, a), /recheck|onDone|onEnded/, `'${a}': Health is checked again at the press`);
  }
  const hook = code(read(HOOK));
  // The one re-check after a repair: the provider's effect, once per ended run.
  assert.match(hook, /const all = endedRunIds\(prev\.current, next, awaitingRef\.current\);/, 'the page does not watch for its runs to end');
  assert.match(hook, /mark\(ids, 'settling'\);[\s\S]*?ended\.current\(\)[\s\S]*?finally \{\n        for \(const id of ids\) settled\.current\.add\(id\);\n        mark\(ids, 'ended'\);/, 'rows wake before the re-check has answered');
  const start = hook.slice(hook.indexOf('const start = useCallback'), hook.indexOf('const stop = useCallback'));
  assert.equal((start.match(/ended\.current\(\)/g) ?? []).length, 1, 'start() re-checks Health');
  assert.match(start, /if \(!r\?\.run\) \{[\s\S]*?await ended\.current\(\);/, 'only a server that names no run is re-checked at once');
  // Polled every 2 s while a run goes or one this page started is unread; the POST's id is what it waits on.
  assert.match(hook, /refetchInterval: \(q\) => \(q\.state\.data\?\.running \|\| waiting \? POLL_MS : false\)/);
  assert.match(hook, /set\(key, \{ phase: 'awaiting', action, startedAt, runId: r\?\.run \}\);/, 'the run id the POST answers is not kept');
  // A run a poll saw start and end while its POST was in flight is closed without waiting: nothing new comes to wake
  // the effect for it. Reintroduce by dropping both checks: the slot says "Working…" and polls every 2 s for good.
  // But only once Health has ANSWERED for it: while that re-check is in flight the slot is "Checking the result…"
  // and the effect's `finally` closes it. Reintroduce `handled` in the first check (the old early close): the row
  // reads "Done" above the old finding for one round-trip, and "closes before Health answered" fails.
  assert.match(start, /if \(r\?\.run && settled\.current\.has\(r\.run\)\) \{\s*set\(key, \{ phase: 'ended', action, startedAt, runId: r\.run, finishedAt: Date\.now\(\) \}\);\s*return;\s*\}/,
    'a press whose run already ended before its POST answered closes before Health answered, or waits forever');
  assert.match(start, /if \(r\?\.run && handled\.current\.has\(r\.run\)\) \{\s*set\(key, \{ phase: 'settling', action, startedAt, runId: r\.run \}\);\s*return;\s*\}\s*set\(key, \{ phase: 'awaiting'/,
    'a press whose run is being re-checked does not wait for the answer');
  assert.match(hook, /\} finally \{\s*for \(const id of ids\) settled\.current\.add\(id\);\s*mark\(ids, 'ended'\);/, 'what Health answered for is not kept');
  // The effect's own late close follows the same rule. Reintroduce `if (stale.length) mark(stale, 'ended');`: fails.
  assert.match(hook, /mark\(stale\.filter\(\(id\) => settled\.current\.has\(id\)\), 'ended'\);\s*mark\(stale\.filter\(\(id\) => !settled\.current\.has\(id\)\), 'settling'\);/,
    'a late press closes before Health answered for its run');
  // No "Started — the Tasks line shows what it did" toast from Health: success is said on the row.
  assert.doesNotMatch(hook + code(read(KEYS)), /the Tasks line shows what it did/, 'Health still toasts "Started" and points at another tab');
});

test('an action that answers at once stays busy until Health has answered again', () => {
  // v0.48.3: woken before the re-check landed, Ignore still read Ignore over an unchanged row. Reintroduce by
  // setting the done state before awaiting the re-check: the order assertion fails.
  const src = rowOf(code(read(KEYS)));
  const act = src.slice(src.indexOf('const act = '), src.indexOf('const doDelete'));
  const checking = act.indexOf("step: tr('Checking the result…')");
  const asked = act.indexOf('await rr.recheck()');
  const done = act.indexOf("kind: 'done'");
  assert.ok(checking > 0 && asked > checking && done > asked, 'the row reads done before Health has answered again');
  assert.match(act, /try \{ out = await run\(\); \} catch \(e\)/, 'a failed request skips the re-check');
});

test('the refusals do not read the same: a sweep clears by itself, busy is another repair', () => {
  // ⚠️ `sweep_running` and `busy` are opposite facts. A shared "Failed" sent the admin looking for a broken
  // button. Reintroduce by collapsing both into one sentence: this test fails on the distinct keys.
  const copy = code(read(COPY));
  const fn = copy.slice(copy.indexOf('export function refusalLine'), copy.indexOf('export function blockedLine'));
  assert.match(fn, /error === 'sweep_running' \? tr\('A chapter sweep is running — try again in a few minutes'\)/);
  assert.match(fn, /error === 'busy' \? tr\('Another repair is running; this can start when it ends'\)/);
  const hook = code(read(HOOK));
  assert.match(hook, /if \(r\?\.ok === false\) \{[\s\S]*?refusalLine\(r\.error\)[\s\S]*?phase: 'refused'[\s\S]*?toast\(reason, 'error'\)/, 'a 200 refusal is read as a success, or not said on the row and in a notice');
  // The same two sentences in the Tasks panel's own Run now, for the same refusals.
  const page = code(read(PAGE));
  assert.match(page, /r\.error === 'sweep_running' \? tr\('A chapter sweep is running — try again in a few minutes'\)/, 'Tasks reports a sweep clash as "Already running"');
  assert.match(page, /id === 'repair' && r\?\.started\) toast\(tr\('Started — the Tasks line shows what it did'\)/, 'Run now on the repair row toasts a bare "Started"');
});

test('Run now on the chapter sweep says the repair is running, rather than "Already running"', () => {
  // The clash goes both ways: the sweep refuses to start while a repair is running (updater.ts's
  // `runtime.updating || runtime.repairing`). ⚠️ Two halves of one fact in two packages, so both are read
  // here. Reintroduce by deleting the `runtime.repairing` line from the update branch of the task-run route,
  // or by dropping the sentence from Tasks(): one of the two assertions fails.
  const route = readFileSync(join(ROOT, '../bff/src/routes/admin.ts'), 'utf8');
  const at = route.indexOf("if (id === 'update') {");
  assert.ok(at > 0, 'the update branch of POST /api/admin/tasks/:id/run is gone -- update this slice');
  const update = route.slice(at, route.indexOf("if (id === 'extensions') {", at));
  assert.match(update, /if \(runtime\.repairing\) return \{ ok: false, error: 'repair_running' \};/, 'a sweep refused because the repair is running answers the shared "busy"');
  assert.ok(update.indexOf('runtime.repairing') < update.indexOf('runSweep('), 'the repair is checked after runSweep has already refused, so the answer is "busy" anyway');
  const page = code(read(PAGE));
  assert.match(page, /r\.error === 'repair_running' \? tr\('The library repair is running — try again in a few minutes'\)/, 'Tasks reports a repair clash as "Already running"');
});

test('Ignore posts the finding\'s key and says it stays quiet until something changes', () => {
  // The server records everything the finding is about (lib/healthIgnore.ts); the page only names it.
  // Reintroduce by posting `numbers` instead of the key: a gap's ignore would cover only the hundred shown.
  const src = code(read(KEYS));
  const fn = src.slice(src.indexOf('async function postIgnore'), src.indexOf('const keptIndex'));
  assert.match(fn, /api\('\/api\/admin\/health\/ignore', \{ method: 'POST', json: \{ check, key: item\.key, ignored \} \}\)/);
  assert.match(fn, /tr\('Ignored — it stays quiet until something about it changes'\)/);
  assert.match(fn, /tr\('Back on the list'\)/);
});

test('a delete that deleted nothing leads with the bookmark, not with a green count', () => {
  // On this page the rows are chapters whose NUMBER is impossible, and the only skip an admin can act on is a
  // reader's bookmark inside one -- so it leads. ⚠️ And a delete that applied nothing is a failure on its row,
  // not a success: a green "0 deleted" over unchanged rows is what a refused delete used to look like.
  // Reintroduce by returning `{n} deleted` unconditionally: the assertions on the failure branch fail.
  const src = code(read(KEYS));
  const fn = src.slice(src.indexOf('const doDelete'), src.indexOf('const doMerge'));
  assert.match(fn, /\/api\/admin\/series\/\$\{encodeURIComponent\(item\.seriesId \|\| ''\)\}\/chapters\/delete/, 'delete does not use the existing chapter-delete route');
  assert.match(fn, /json: \{ bookIds \}/, 'delete does not send the item\'s book ids');
  const bookmarked = fn.indexOf("tr('{n} skipped: bookmarked by a reader'");
  const notOwned = fn.indexOf("tr('{n} skipped: not downloaded by Uchiyomi'");
  assert.ok(bookmarked > 0 && notOwned > bookmarked, 'the bookmark line is not the first skip reason');
  assert.match(fn, /if \(res\.applied === 0 && lines\.length\) return \{ text: lines\.map\(\(l\) => l\.text\)\.join\(' · '\), ok: false \};/, 'a delete that applied nothing is reported as a success');
  assert.match(fn, /toast\(tr\('\{n\} deleted', \{ n: res\.applied \}\), 'success'\)/, 'a successful delete does not say how many went');
  // The confirmation is not optional: this is the one key on the page that destroys bytes.
  const dialog = src.slice(src.indexOf("asking === 'delete'"), src.indexOf("asking === 'disable'"));
  assert.match(dialog, /<ConfirmDialog/, 'Delete chapters has no confirmation');
  assert.match(dialog, /danger/, 'the delete confirmation is not marked destructive');
  assert.match(dialog, /tr\('A chapter somebody has bookmarked is skipped, and so is anything in a library you built by hand\. There is no undo and no recycle bin\.'\)/, 'the delete dialog does not say what it spares, or that there is no undo');
});

test('Merge all lists every pair, marks the copy that survives, and says the merge is one-way', () => {
  // A merge is irreversible and moves other people's data, so the dialog shows WHAT it will do to each pair
  // before it does it. Reintroduce by merging straight from the row: "Merge all has no confirmation" fails.
  const src = code(read(KEYS));
  const block = src.slice(src.indexOf('export function HealthCardActions'), src.indexOf('export function CardProgress'));
  assert.match(block, /'data-health-merge-all': check\.id/, 'the Merge all row is not tagged for the walk-through');
  assert.match(block, /const pairs = check\.id === 'duplicates' \? findings\.filter\(\(it\) => \(it\.seriesIds \|\| \[\]\)\.length === 2\) : \[\];/, 'Merge all offers itself on checks that are not duplicates, or on half a pair');
  assert.match(block, /onRun: \(\) => setAsking\(true\)/, 'Merge all has no confirmation');
  const dialog = block.slice(block.indexOf('{asking && ('));
  assert.match(dialog, /tr\('This cannot be undone\. Progress, bookmarks, ratings and tracker links move to the kept copy\.'\)/, 'the one-way sentence is gone');
  assert.match(dialog, /\{pairs\.map\(\(p, i\) => \(/, 'the dialog does not list the pairs it is about to merge');
  assert.match(dialog, /j === keptIndex\(p\)[\s\S]*tr\('kept'\)/, 'the surviving copy is not marked');
  assert.match(block, /const keep = ids\[keptIndex\(p\)\];/, 'Merge all ignores the survivor the server suggested');
  // `keep` is a server suggestion, not a promise: an id that is not in the pair must not merge the wrong way.
  assert.match(src, /const i = it\.keep \? \(it\.seriesIds \|\| \[\]\)\.indexOf\(it\.keep\) : -1;\n  return i < 0 \? 0 : i;/, 'an unknown or missing keep id is not defaulted to the first copy');
  // Sequential: two merges landing at once on pairs sharing a series race for the survivor.
  assert.match(block, /for \(const p of pairs\) \{[\s\S]*await api<\{ moved: number \}>/, 'the merges are not run one at a time');
  assert.doesNotMatch(block, /Promise\.all\(/, 'the merges are fired in parallel');
  assert.match(block, /if \(failed\) toast\(failed === 1 \? tr\('One pair could not be merged'\)/, 'pairs that failed to merge are folded into the success line');
});

test('v0.50.0: Fix all on "The same chapter saved twice" deletes each row\'s later files through Delete chapters, after a list', () => {
  // The check never deletes by itself (bff lib/health.ts savedTwice); its Fix all is the one press that does, so it
  // shows what it deletes first, and sends each row's own later files -- the only ids the server put on the row --
  // through the existing route, which keeps the rows as tombstones and skips a bookmarked chapter. Reintroduce by
  // deleting from the press (`onRun: () => { void deleteAll(); }`): "deletes without a confirmation" fails; by
  // sending anything else: "does not send each row's later files" fails.
  const src = code(read(KEYS));
  const block = src.slice(src.indexOf('export function HealthCardActions'), src.indexOf('export function CardProgress'));
  assert.match(block, /'data-health-delete-all': check\.id/, 'the Fix all row is not tagged for the walk-through');
  assert.match(block, /onRun: \(\) => setAskingPurge\(true\)/, 'Fix all deletes without a confirmation');
  assert.match(src, /check\.id === 'saved-twice' \? check\.items\.filter\(\(it\) => !it\.ignored && !!it\.seriesId && \(it\.bookIds\?\.length \?\? 0\) > 0\) : \[\]/,
    'Fix all reaches rows of another check, or an ignored row');
  const fn = block.slice(block.indexOf('const deleteAll'), block.indexOf('const mergeAll'));
  assert.match(fn, /\/api\/admin\/series\/\$\{encodeURIComponent\(it\.seriesId!\)\}\/chapters\/delete`, \{ method: 'POST', json: \{ bookIds: it\.bookIds \} \}/,
    'does not send each row\'s later files through the existing route');
  assert.match(fn, /for \(const it of later\) \{[\s\S]*await api</, 'the rows are not deleted one at a time');
  const dialog = block.slice(block.indexOf('{askingPurge && ('));
  assert.match(dialog, /danger/, 'the confirmation is not marked destructive');
  assert.match(dialog, /\{later\.map\(\(it\) => \(/, 'the dialog does not list what it deletes');
});

test('the survivor of a merge is named in one sentence, not a verb glued to a title', () => {
  // ⚠️ The verb key beside `<strong>{title}</strong>` rendered "KeepSolo Leveling" in English and
  // "الإبقاء علىSolo Leveling" in Arabic. The cure: ONE sentence key, split around its placeholder.
  // Reintroduce by rendering the bare verb key with the title after it: both assertions below fail.
  const src = code(read(KEYS));
  assert.match(src, /const \[keepBefore, keepAfter\] = tr\('Keep \{title\}'\)\.split\('\{title\}'\);/, 'the survivor label is not built from one sentence key');
  const dialog = src.slice(src.indexOf("asking === 'merge'"), src.indexOf('const SCAN_CHECKS'));
  assert.ok(dialog.length > 0, 'the per-pair merge dialog is gone -- update this slice');
  assert.match(dialog, /\{keepBefore\}<strong className="text-fog-100">\{t\}<\/strong>\{keepAfter\}/, 'the title is not wrapped by both halves of the sentence');
});

test('Fix all issues runs ONE repair with every step that has findings, its plan visible before the press', () => {
  // v0.48.3, the owner: "there is no button to fix all issues at once". v0.49.0: its plan, with each step's
  // caps and what it never does, is on the row BEFORE the press. Reintroduce the old footer ("no source is
  // unblocked"): healthCopy.test.ts fails; drop pageBody: the run loses `now`.
  const src = code(read(KEYS));
  const block = src.slice(src.indexOf('export function FixAllIssues'));
  assert.match(block, /const plan = pagePlan\(checks\);/);
  assert.match(block, /const body = pageBody\(plan\);/, 'Fix all issues does not send the plan\'s steps, with `now` for the failures');
  assert.match(block, /how: \[\.\.\.lines, caps, planFooter\(plan\.map\(\(p\) => p\.step\)\)\]\.join\('\\n'\)/, 'the plan is not shown before the press');
  assert.match(block, /'data-health-fix-all-page': ''/, 'the button is not tagged for the walk-through');
  assert.match(block, /onRun: \(\) => \{ void rr\.start\('page', 'fix_all_issues', body\); \}/);
  const page = code(read(PAGE));
  assert.match(page, /<FixAllIssues checks=\{checks\} \/>/, 'the button is not on the Health page');
  assert.match(page, /<RepairLiveStrip \/>/, 'the live strip (and its Stop) is not on the Health page');
  assert.match(page, /<RepairHistory \/>/, 'Recent repairs is not on the Health page');
  // Stop reaches the running run through the one cancel route the Downloads view uses too.
  assert.match(code(read(HOOK)), /api\('\/api\/sources\/runs\/repair\/cancel', \{ method: 'POST' \}\)/, 'the live strip has no Stop');
});

test('the Health page: keys that follow their finding, marks not capsules, the disclosure first, rows findable', () => {
  // Reintroduce `key={`${c.id}-${i}`}`: a Fix's result lands on the next row when a re-check drops one above.
  // Reintroduce the HEALTH_LABEL capsule: the pill assertions fail (and noPills.test.ts). Move an action into
  // the header before the disclosure: the walk opens a card by clicking its FIRST button.
  const src = code(read(PAGE));
  const at = src.indexOf('function Health()');
  const health = src.slice(at, src.indexOf('function DesktopUpdateNote('));
  assert.ok(at > 0 && health.length > 0, 'Health() is gone from the admin page -- update this slice');
  assert.doesNotMatch(health, /`\$\{c\.id\}-\$\{i\}`/, 'Health rows are keyed by index');
  assert.match(health, /const rowKeys = keysFor\(c\.id, c\.items\);/);
  assert.match(health, /<HealthRow key=\{rowKeys\[i\]\} rowKey=\{rowKeys\[i\]\}/);
  assert.doesNotMatch(src, /HEALTH_LABEL|HEALTH_TONE/, 'the capsule tables are still in the page');
  assert.match(health, /<StatusMark \{\.\.\.mark\} size="xs" \/>/, 'the card\'s verdict is not a mark');
  assert.match(health, /<StatusEdge tone=\{mark\.tone\} \/>/);
  assert.match(health, /tr\('Checks that found something: \{n\} of \{m\}'/, 'the header is not translated');
  assert.match(health, /tr\('checked \{when\}', \{ when: relativeTime\(data\.generatedAt\) \}\)/, 'the header\'s relative time is not inside a translated sentence');
  assert.match(health, /\{checkTitle\(c\)\}/, 'the check titles are not translated');
  assert.match(health, /<RepairRunProvider onEnded=\{recheck\}>/);
  const hdr = health.indexOf('type="button"');
  const close = health.indexOf('</button>', hdr);
  assert.ok(hdr > 0 && close > hdr && health.indexOf('<HealthCardActions') > close, 'a card action is inside the disclosure, or before it');
  assert.match(health, /const recheck = \(\) => refetch\(\)\.then\(\(\) => qc\.invalidateQueries\(\{ queryKey: \['health-summary'\] \}\)\);/, 'the header mark is not refreshed after a change on the page');
  // Open is a text link, not a chip: it goes somewhere, it does nothing.
  assert.doesNotMatch(health, /className="chip/, 'a chip is left in Health()');
  // The browser walk finds a key's row with closest('[data-health-item]').
  assert.match(code(read(KEYS)), /<div data-health-item=\{rowKey\} data-repair-state=\{rowNow\.kind\}/, 'the row is not findable, or does not say its state');
});

test('Scan library now says what it found, or why it did not scan, and Health is checked again', () => {
  // The hero dropped the scan's answer: a scan refused because one ran a minute ago looked exactly like one
  // that found nothing. Reintroduce `await triggerRefresh();` with the answer ignored: the first assertion fails.
  const page = code(read(PAGE));
  const hero = page.slice(page.indexOf('function AdminHero'), page.indexOf('function Overview('));
  assert.match(hero, /const r = await triggerRefresh\(\);\n    setScanned\(scanState\(r, at\)\);/, 'the hero ignores the scan\'s answer');
  assert.match(hero, /invalidateQueries\(\{ queryKey: \['admin-health'\] \}\)/, 'Health is not checked again after a scan');
  assert.match(hero, /<ActionStatus state=\{scanned\} \/>/, 'the scan\'s answer is not shown under the button');
  const keys = code(read(KEYS));
  const fn = keys.slice(keys.indexOf('export function scanState'), keys.indexOf('export function HealthRow'));
  assert.match(fn, /r\.reason === 'rate_limited'\) return \{ kind: 'refused', reason: tr\('A scan ran less than a minute ago'\) \}/);
  assert.match(fn, /tr\('Scan done: \{m\} series, \{n\} chapters'/);
  assert.match(code(read('lib/refresh.ts')), /return \{ scanned: false, reason: 'error' \};/, 'a failed scan is not told apart from a refused one');
});

test('the nightly repair has one switch, under Library housekeeping, on unless the server says otherwise', () => {
  // On by default (`repair_enabled NOT NULL DEFAULT true`), so the row reads `!== false`: a server that
  // does not send the key yet is a server that repairs, and the switch says so.
  // ⚠️ Saved through `patch`, the section's prop, not through the local `save` -- that one takes a success
  // sentence as its second argument and would toast `undefined`. Reintroduce by `save({ repairEnabled: next })`.
  const src = code(read(SETTINGS));
  assert.equal((src.match(/repairEnabled/g) ?? []).length, 1, 'the repair switch is saved from more or fewer than one place');
  assert.match(src, /<SwitchRow label=\{tr\('Repair the library nightly'\)\}\s*help=\{tr\('Once a day: counts pages in files never opened[^']*'\)\}\s*on=\{data\.repair_enabled !== false\} onChange=\{\(next\) => patch\(\{ repairEnabled: next \}\)\} \/>/, 'the repair switch is not one SwitchRow with these words, is not on by default, or saves through the wrong function');
  const house = src.slice(src.indexOf('function HousekeepingSection('));
  assert.ok(house.includes("tr('Repair the library nightly')"), 'the repair switch is not in Library housekeeping');
  // The help has to name what runs unattended AND what never does, or an admin cannot decide anything.
  assert.match(src, /Nothing is deleted or merged without you\./, 'the help does not say what the nightly never does');
});

test('the header counts chapters behind in words that agree, in every language', () => {
  // A live Health tab read "1 chapters behind across 1 series", and the line was in no locale file, so it was
  // English in every language. Reintroduce by dropping either singular, or one locale's entry.
  const src = code(read(PAGE));
  assert.match(src, /stats\.backlog\.chapters === 1 \? tr\('1 chapter behind'\)\s*: stats\.backlog\.series === 1 \? tr\('\{n\} chapters behind in 1 series', \{ n: stats\.backlog\.chapters \}\)/,
    'one chapter, or one series, is counted as many');
  const lines = ['1 chapter behind', '{n} chapters behind in 1 series', '{n} chapters behind across {m} series'];
  for (const f of readdirSync(join(ROOT, 'public/locales')).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(read(`public/locales/${f}`));
    for (const k of lines) {
      assert.ok(String(d[k] ?? '').trim(), `${f} has no "${k}"`);
      for (const ph of k.match(/\{\w+\}/g) ?? []) assert.ok(d[k].includes(ph), `${f}: "${k}" lost ${ph}`);
    }
  }
});

test('every string the Health keys, legends and live strip render is in all eight locale files', () => {
  // The parity test (library.test.ts) only compares the eight files with each other, so a string that reaches
  // none of them falls back to English in every language without anything failing. localeCoverage.test.ts
  // sweeps the whole app; this names the Health files so a failure says where. Reintroduce by deleting
  // "Fill now" from public/locales/ar.json.
  const keys = trKeys([KEYS, LIVE, HOOK, COPY]);
  assert.ok(keys.has('Checking the result…') && keys.has('Recent repairs'), 'the Health strings are no longer found -- the scan or the files changed');
  assert.ok(keys.size >= 120, `only ${keys.size} strings found in the Health files -- the scan itself is broken`);
  const locales = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
  assert.equal(locales.length, 8, `expected eight locale files, found ${locales.join(', ')}`);
  for (const f of locales) {
    const d = JSON.parse(read(`public/locales/${f}`));
    const missing = [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${missing.length} strings are missing from ${f}: ${missing.slice(0, 12).join(' | ')}`);
  }
});

test("Health prints the server's words in their own direction: every finding's title and detail, a card's summary and note", () => {
  // The final screenshot review, in Arabic (390-ar-health-row-failed-why.png): the server's English took the
  // page's right-to-left direction, so a sentence printed its full stop at its start (".This source needs a check
  // from an admin") and a closing bracket flipped. v0.49.1 words them in the reader's language (lib/said.ts), but a
  // source's name, a folder or a site's own error inside one is in any script, and a server older than that still
  // sends English. Reintroduce the plain `<p className="text-[11px] text-fog-500">{itemDetail(it)}</p>`: "a
  // finding's detail takes the page's direction" fails.
  const src = code(read(PAGE));
  const health = src.slice(src.indexOf('function Health()'), src.indexOf('function DesktopUpdateNote('));
  const printed: [string, string][] = [
    ["a finding's title", 'itemTitle(it)'], ["a finding's detail", 'itemDetail(it)'], ["a card's summary", 'checkSummary(c)'], ["a card's note", 'checkNote(c)'],
  ];
  for (const [what, expr] of printed) {
    const at = [...health.matchAll(new RegExp(`<p\\b([^>]*)>\\{${expr.replace(/[.()]/g, '\\$&')}\\}</p>`, 'g'))];
    assert.ok(at.length > 0, `${what} is no longer printed in a <p> of its own -- update this test`);
    for (const m of at) assert.match(m[1], /\bdir="auto"/, `${what} takes the page's direction, its full stop at its start in Arabic`);
  }
});
