// The Fix buttons on Admin -> Health (v0.41.0).
//
// Health could name a problem and never do anything about it: "Suspiciously short chapters 14", "Chapter
// gaps 40", "Chapters that would not download 183", with an Open link beside each and every remedy
// somewhere else in the console. Each item now carries the chips its `actions` list asks for, and a check
// carries Fix all (the repair, one step) or Merge all (duplicates, confirmed, one way).
//
// Read from source, like wall.test.ts and addSeriesDialog.test.ts: these are wiring facts -- which route a
// chip posts to, which body it sends, which sentence a refusal gets -- and each guard names the edit that
// fails it. What the routes then DO is bff/test/repair.int.test.ts and repairRoutes.int.test.ts.
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

const CHIPS = 'components/HealthActions.tsx';
const PAGE = 'app/admin/page.tsx';
const SETTINGS = 'components/AdminSettings.tsx';
const TYPES = 'lib/types.ts';

/** One arm of the `chip()` switch: `case 'x':` up to the next `case`/`default`. */
function arm(src: string, action: string): string {
  const at = src.indexOf(`case '${action}':`);
  assert.notEqual(at, -1, `HealthActions has no chip for '${action}'`);
  const rest = src.slice(at + 1);
  const end = rest.search(/\n\s+(case '|default:)/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

// Every action in the contract, the label it must carry, and the one request it makes. The labels are
// asserted as written source, not as rendered text: a chip that stopped calling tr() renders English in
// eight languages and nothing else would notice.
const ACTIONS: { action: string; labels: string[]; wants: RegExp }[] = [
  { action: 'fix_short', labels: ["tr('Fix')"], wants: /postRepair\(\{ only: \['short'\], bookId: item\.bookId! \}, toast\)/ },
  { action: 'confirm_short', labels: ["tr('Not fine')", "tr('It’s fine')"], wants: /\/api\/admin\/books\/\$\{encodeURIComponent\(item\.bookId \|\| ''\)\}\/confirm-short[\s\S]*json: \{ confirmed: !confirmed \}/ },
  { action: 'delete', labels: ["tr('Delete chapter')", "tr('Delete chapters')"], wants: /setAsking\('delete'\)/ },
  { action: 'fill', labels: ["tr('Fill now')"], wants: /postRepair\(\{ only: \['gaps'\], seriesId: item\.seriesId! \}, toast\)/ },
  { action: 'retry', labels: ["tr('Retry now')"], wants: /postRepair\(\{ only: \['failures'\], sourceId: item\.sourceId! \}, toast\)/ },
  { action: 'test', labels: ["tr('Test')"], wants: /\/api\/admin\/sources\/\$\{encodeURIComponent\(item\.sourceId \|\| ''\)\}\/test/ },
  { action: 'unblock', labels: ["tr('Clear block')"], wants: /\/api\/admin\/sources\/\$\{encodeURIComponent\(item\.sourceId \|\| ''\)\}\/unblock/ },
  { action: 'disable', labels: ["tr('Turn off')"], wants: /setAsking\('disable'\)/ },
  { action: 'merge', labels: ["tr('Merge')"], wants: /setAsking\('merge'\)/ },
  { action: 'solver_reset', labels: ["tr('Reset solver sessions')"], wants: /postRepair\(\{ only: \['solver'\] \}, toast\)/ },
  // v0.48.3: the owner's "no button to ignore this warning so it never repeats again".
  { action: 'ignore', labels: ["tr('Ignore')"], wants: /postIgnore\(check, item, true, toast\)/ },
  { action: 'unignore', labels: ["tr('Stop ignoring')"], wants: /postIgnore\(check, item, false, toast\)/ },
];

test('every action the health check can offer renders one chip, with the label and the request it promises', () => {
  // The server decides what an item offers; this file decides what each one looks like and does. A missing
  // arm renders NOTHING for that action -- the item silently loses its only remedy -- so the switch is
  // checked against the HealthAction union rather than against itself.
  // Reintroduce by deleting the `case 'fill':` arm: "'fill' has 0 chips, not one" fails.
  const src = code(read(CHIPS));
  const types = code(read(TYPES));
  const decl = types.slice(types.indexOf('export type HealthAction'));
  const declared = [...decl.slice(0, decl.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), ACTIONS.map((a) => a.action).sort(), 'HealthAction and the chips have drifted apart');
  for (const { action, labels, wants } of ACTIONS) {
    const arms = (src.match(new RegExp(`case '${action}':`, 'g')) ?? []).length;
    assert.equal(arms, 1, `'${action}' has ${arms} chips, not one: an item offering it renders nothing, or renders twice`);
    const a = arm(src, action);
    for (const l of labels) assert.ok(a.includes(l), `the '${action}' chip does not read ${l}`);
    assert.match(a, wants, `the '${action}' chip does not make the request its brief promises`);
    assert.match(a, new RegExp(`action=\\{a\\}|action="${action}"`), `the '${action}' chip is not tagged for the walk-through`);
  }
  assert.ok(arm(src, 'fill').includes("tr('Fill now')"), 'chapter gaps lose their Fill now chip');
  // A chip that does nothing when there is nothing to act on is worse than no chip: it reads as a broken
  // button. An item with no `actions` renders nothing at all.
  assert.match(src, /const actions = item\.actions \|\| \[\];\n  if \(!actions\.length\) return null;/, 'an item without actions still renders a chip row');
});

test('Ignore posts the finding\'s key and says it stays quiet until something changes', () => {
  // The server records everything the finding is about (lib/healthIgnore.ts); the page only names it.
  // Reintroduce by posting `numbers` instead of the key: a gap's ignore would cover only the hundred shown.
  const src = code(read(CHIPS));
  const fn = src.slice(src.indexOf('async function postIgnore'), src.indexOf('/** One action.'));
  assert.match(fn, /api\('\/api\/admin\/health\/ignore', \{ method: 'POST', json: \{ check, key: item\.key, ignored \} \}\)/);
  assert.match(fn, /tr\('Ignored — it stays quiet until something about it changes'\)/);
  assert.match(fn, /tr\('Back on the list'\)/);
});

test('a chip is disabled while a request is in flight, and the row always asks Health again afterwards', () => {
  // A chip that leaves a fixed item on screen reads as a chip that did nothing (#34's shape). `onDone` is
  // in a `finally`, so a failed request refetches too -- the failure may itself be the item having been
  // dealt with elsewhere. Reintroduce by moving `onDone()` into the try: a repair that 500s leaves the
  // page showing the finding as though nothing was attempted. And the chip stays busy until Health has
  // ANSWERED (v0.48.3): woken before the re-check landed, Ignore still read Ignore over an unchanged row.
  const src = code(read(CHIPS));
  assert.match(src, /try \{ await run\(\); \} finally \{ await onDone\(\); setBusy\(null\); \}/, 'the chips do not wait for Health to answer again');
  assert.match(src, /const act = \(a: HealthAction, run: \(\) => Promise<void>\) => \{\n    if \(busy\) return;/, 'a second tap can start a second request');
  assert.match(src, /const b = !!busy;/, 'only the tapped chip goes quiet, so its siblings are enabled buttons that do nothing');
  assert.match(src, /disabled=\{busy\}/, 'the chip element is not disabled while its row is working');
});

test('the repair chip says where to look, and the two refusals do not read the same', () => {
  // ⚠️ `sweep_running` and `busy` are opposite facts: one clears by itself in a few minutes, the other is
  // "it is already doing this". A shared "Failed" sent the admin looking for a broken button.
  // Reintroduce by collapsing both into one sentence: this test fails on the distinct keys.
  const src = code(read(CHIPS));
  const fn = src.slice(src.indexOf('async function postRepair'), src.indexOf('/** One action.'));
  assert.match(fn, /api<\{ ok\?: boolean; error\?: string; started\?: boolean \}>\('\/api\/admin\/tasks\/repair\/run', \{ method: 'POST', json: body \}\)/, 'the chips do not post the repair run');
  assert.match(fn, /r\?\.ok === false/, 'a 200 refusal is read as a success');
  assert.match(fn, /tr\('A chapter sweep is running — try again in a few minutes'\)/, 'sweep_running has no sentence of its own');
  assert.match(fn, /tr\('The repair is already running'\)/, 'busy has no sentence of its own');
  assert.match(fn, /tr\('Started — the Tasks line shows what it did'\)/, 'a started repair does not say where its result appears');
  // The same two sentences in the Tasks panel's own Run now, for the same refusals.
  const page = code(read(PAGE));
  assert.match(page, /r\.error === 'sweep_running' \? tr\('A chapter sweep is running — try again in a few minutes'\)/, 'Tasks reports a sweep clash as "Already running"');
  assert.match(page, /id === 'repair' && r\?\.started\) toast\(tr\('Started — the Tasks line shows what it did'\)/, 'Run now on the repair row toasts a bare "Started"');
});

test('Run now on the chapter sweep says the repair is running, rather than "Already running"', () => {
  // The clash goes both ways: the sweep refuses to start while a repair is running (updater.ts's
  // `runtime.updating || runtime.repairing`), and every refusal on that branch used to be `busy`, which
  // this panel words as "Already running" -- a sentence about a chapter sweep that is not running at all.
  // ⚠️ Two halves of one fact in two packages, so both are read here: a route that answers a code the
  // panel has no sentence for falls through to the same wrong words. wall.test.ts reads bff/src the same
  // way, for the same reason. Reintroduce by deleting the `runtime.repairing` line from the update branch
  // of the task-run route, or by dropping the sentence from Tasks(): one of the two assertions fails.
  const route = readFileSync(join(ROOT, '../bff/src/routes/admin.ts'), 'utf8');
  const at = route.indexOf("if (id === 'update') {");
  assert.ok(at > 0, 'the update branch of POST /api/admin/tasks/:id/run is gone -- update this slice');
  const update = route.slice(at, route.indexOf("if (id === 'extensions') {", at));
  assert.match(update, /if \(runtime\.repairing\) return \{ ok: false, error: 'repair_running' \};/, 'a sweep refused because the repair is running answers the shared "busy"');
  assert.ok(update.indexOf('runtime.repairing') < update.indexOf('runSweep('), 'the repair is checked after runSweep has already refused, so the answer is "busy" anyway');
  const page = code(read(PAGE));
  assert.match(page, /r\.error === 'repair_running' \? tr\('The library repair is running — try again in a few minutes'\)/, 'Tasks reports a repair clash as "Already running"');
});

test('a delete that deleted nothing leads with the bookmark, not with a green count', () => {
  // On this page the rows are chapters whose NUMBER is impossible, and the only skip an admin can act on
  // is a reader's bookmark inside one -- so it leads, unlike the series page where "not downloaded by
  // Uchiyomi" is the common case. ⚠️ And a delete that applied nothing is an error, not a success: a green
  // "0 deleted" over unchanged rows is what a refused delete used to look like.
  // Reintroduce by toasting `{n} deleted` unconditionally: the assertions on the error branch fail.
  const src = code(read(CHIPS));
  const fn = src.slice(src.indexOf('const doDelete'), src.indexOf('const doMerge'));
  assert.match(fn, /\/api\/admin\/series\/\$\{encodeURIComponent\(item\.seriesId \|\| ''\)\}\/chapters\/delete/, 'delete does not use the existing chapter-delete route');
  assert.match(fn, /json: \{ bookIds \}/, 'delete does not send the item\'s book ids');
  const bookmarked = fn.indexOf("tr('{n} skipped: bookmarked by a reader'");
  const notOwned = fn.indexOf("tr('{n} skipped: not downloaded by Uchiyomi'");
  assert.ok(bookmarked > 0 && notOwned > bookmarked, 'the bookmark line is not the first skip reason');
  assert.match(fn, /res\.applied === 0 && lines\.length/, 'a delete that applied nothing is reported as a success');
  assert.match(fn, /toast\(head\.text, 'error'\)/, 'the dominant skip reason is not shown in red');
  assert.match(fn, /toast\(tr\('\{n\} deleted', \{ n: res\.applied \}\), 'success'\)/, 'a successful delete does not say how many went');
  // The confirmation is not optional: this is the one chip on the page that destroys bytes.
  const dialog = src.slice(src.indexOf("asking === 'delete'"), src.indexOf("asking === 'disable'"));
  assert.match(dialog, /<ConfirmDialog/, 'Delete chapters has no confirmation');
  assert.match(dialog, /danger/, 'the delete confirmation is not marked destructive');
  assert.match(dialog, /tr\('A chapter somebody has bookmarked is skipped, and so is anything in a library you built by hand\. There is no undo and no recycle bin\.'\)/, 'the delete dialog does not say what it spares, or that there is no undo');
});

test('Merge all lists every pair, marks the copy that survives, and says the merge is one-way', () => {
  // A merge is irreversible and moves other people's data, so the dialog has to show WHAT it will do to
  // each pair before it does it -- five pairs behind one button is exactly the shape of an accident.
  // Reintroduce by confirming straight from the chip: "Merge all has no confirmation" fails.
  const src = code(read(CHIPS));
  const block = src.slice(src.indexOf('export function HealthCheckActions'));
  assert.match(block, /data-health-merge-all=\{check\.id\}/, 'the Merge all chip is not tagged for the walk-through');
  assert.match(block, /const pairs = check\.id === 'duplicates' \? findings\.filter\(\(it\) => \(it\.seriesIds \|\| \[\]\)\.length === 2\) : \[\];/, 'Merge all offers itself on checks that are not duplicates, or on half a pair');
  const dialog = block.slice(block.indexOf('{asking && ('));
  assert.ok(dialog.length > 0, 'Merge all has no confirmation');
  assert.match(dialog, /tr\('This cannot be undone\. Progress, bookmarks, ratings and tracker links move to the kept copy\.'\)/, 'the one-way sentence is gone');
  assert.match(dialog, /\{pairs\.map\(\(p, i\) => \(/, 'the dialog does not list the pairs it is about to merge');
  assert.match(dialog, /\{\(p\.titles \|\| \[\]\)\.map\(\(t, j\) => \(/, 'the dialog does not name both titles of a pair');
  assert.match(dialog, /j === keptIndex\(p\)[\s\S]*tr\('kept'\)/, 'the surviving copy is not marked');
  assert.match(block, /const keep = ids\[keptIndex\(p\)\];/, 'Merge all ignores the survivor the server suggested');
  // `keep` is a server suggestion, not a promise: an id that is not in the pair must not silently merge
  // the wrong way round. Reintroduce by `indexOf` without the `< 0` fallback: `ids[-1]` is undefined and
  // the merge posts to /undefined/merge.
  assert.match(src, /const i = it\.keep \? \(it\.seriesIds \|\| \[\]\)\.indexOf\(it\.keep\) : -1;\n  return i < 0 \? 0 : i;/, 'an unknown or missing keep id is not defaulted to the first copy');
  // Sequential: two merges landing at once on pairs sharing a series race for the survivor.
  assert.match(block, /for \(const p of pairs\) \{[\s\S]*await api<\{ moved: number \}>/, 'the merges are not run one at a time');
  assert.doesNotMatch(block, /Promise\.all\(/, 'the merges are fired in parallel');
  assert.match(block, /if \(failed\) toast\(failed === 1 \? tr\('One pair could not be merged'\)/, 'pairs that failed to merge are folded into the success line');
});

test('the survivor of a merge is named in one sentence, not a verb glued to a title', () => {
  // ⚠️ The verb key beside `<strong>{title}</strong>` has no separator and no order of its own: it rendered
  // "KeepSolo Leveling" in English and "الإبقاء علىSolo Leveling" in Arabic, where الإبقاء على is the
  // fragment "keeping of" -- in the one dialog that decides which copy of a duplicate survives a merge
  // that cannot be undone. It is the failure ConfirmDialog.tsx:105-111 already documents ("TYPGONE FOR
  // GOOD TO CONFIRM") and the cure is the same: ONE sentence key, split around its placeholder so the
  // title keeps its own colour and so German and Japanese can put the title first.
  // Reintroduce by rendering the bare verb key with the title after it: both assertions below fail.
  const src = code(read(CHIPS));
  assert.match(src, /const \[keepBefore, keepAfter\] = tr\('Keep \{title\}'\)\.split\('\{title\}'\);/, 'the survivor label is not built from one sentence key');
  const dialog = src.slice(src.indexOf("asking === 'merge'"), src.indexOf('const FIX_ALL'));
  assert.ok(dialog.length > 0, 'the per-pair merge dialog is gone -- update this slice');
  assert.match(dialog, /\{keepBefore\}<strong className="text-fog-100">\{t\}<\/strong>\{keepAfter\}/, 'the title is not wrapped by both halves of the sentence');
});

test('Fix all exists only for the steps the nightly is allowed to do by itself', () => {
  // ⚠️ No `duplicates`, no `outliers`. The nightly never merges, deletes, tombstones or renumbers, and a
  // Fix all that quietly did would be the one button in this console able to destroy a library in a tap.
  // Reintroduce by adding `duplicates: 'gaps'` (or any entry) to FIX_ALL: this test fails.
  const src = code(read(CHIPS));
  const map = src.slice(src.indexOf('const FIX_ALL'), src.indexOf('export function HealthCheckActions'));
  assert.match(map, /'short-chapters': 'short'/, 'Fix all on short chapters runs the wrong step');
  assert.match(map, /'chapter-gaps': 'gaps'/, 'Fix all on chapter gaps runs the wrong step');
  assert.match(map, /'chapter-failures': 'failures'/, 'Fix all on chapter failures runs the wrong step');
  assert.match(map, /\bsolver: 'solver'/, 'Fix all on the solver check runs the wrong step');
  assert.doesNotMatch(map, /duplicates|outliers|frozen-series|sources/, 'Fix all is offered for a check the nightly must never touch on its own');
  const block = src.slice(src.indexOf('export function HealthCheckActions'));
  assert.match(block, /const findings = check\.items\.filter\(\(it\) => !it\.info\);/, 'info items count as findings, so Fix all appears with nothing to fix');
  assert.match(block, /if \(!findings\.length\) return null;/, 'a check with nothing to fix still offers Fix all');
  assert.match(block, /postRepair\(\{ only: \[step\] \}, toast\)/, 'Fix all does not narrow the repair to one step');
});

test('Fix all issues runs ONE repair with every step that has findings, and checks Health again when it ends', () => {
  // v0.48.3, the owner: "there is no button to fix all issues at once". Reintroduce by calling onDone right
  // after the press (as the cards' chips do): Health shows the same findings a second later and the button
  // reads as broken.
  const src = code(read(CHIPS));
  const block = src.slice(src.indexOf('export function HealthFixAll'));
  assert.ok(block.length > 100, 'HealthFixAll is gone -- update this test');
  // The cards' own steps, in the repair's order: nothing that merges, deletes or unblocks is reachable.
  assert.match(src, /const PAGE_STEPS: RepairStep\[\] = \['solver', 'failures', 'short', 'gaps'\];/);
  assert.match(block, /FIX_ALL\[x\.id\] === step/, 'the page button runs steps the cards do not');
  assert.match(block, /c\.items\.filter\(\(it\) => !it\.info && /, 'info rows count as something to fix');
  // `now` only with the failures step: the server refuses it anywhere else.
  assert.match(block, /plan\.some\(\(p\) => p\.step === 'failures'\) \? \{ now: true \} : \{\}/);
  // A step joins the plan only when a finding offers its chip (the solver offers its reset only while it answers).
  assert.match(block, /\(it\.actions \?\? \[\]\)\.includes\(STEP_ACTION\[step\]\)/);
  // Re-checked when a run ENDS -- ours (its lastRun moved), or any run seen running, whoever started it -- never
  // at the press; and the tasks list is polled while any repair runs, or a run begun elsewhere reads "Fixing…"
  // for good (the review's first finding).
  assert.match(block, /const ended = wasRunning\.current && !running;/);
  assert.match(block, /\(repair\.lastRun \?\? null\) !== waitingFrom/);
  assert.match(block, /refetchInterval: \(q\) => \(waiting \|\| q\.state\.data\?\.content\?\.find\(\(t\) => t\.id === 'repair'\)\?\.running \? 4000 : false\)/);
  // A run that threw leaves no result: that is not "The repair finished".
  assert.match(block, /if \(!repair!\.lastResult \|\| repair!\.lastResult\.stopped\)/);
  const start = block.slice(block.indexOf('const start'), block.indexOf('const line'));
  assert.doesNotMatch(start, /onDone\(\)|done\.current\(\)/, 'Health is checked again at the press, before anything changed');
  // The confirmation says how much one run takes on, and what it never does.
  assert.match(block, /One run takes up to \{short\} short chapters and \{gaps\} series with gaps/);
  assert.match(block, /Nothing is deleted or merged, and no source is unblocked or switched off/);
  const page = code(read('app/admin/page.tsx'));
  assert.match(page, /<HealthFixAll checks=\{checks\} onDone=\{recheck\} \/>/, 'the button is not on the Health page');
});

test('the chips are mounted beside the Health disclosure, never inside it, and the disclosure is unchanged', () => {
  // A button inside a button is invalid HTML and browsers repair it by hoisting the inner one out of the
  // header entirely. ⚠️ And the check-level chips come AFTER the disclosure, because walk40.mjs opens a
  // card by clicking the first button inside `[data-health-check="…"]`.
  // Reintroduce by moving <HealthCheckActions> above the <button>: the order assertion below fails.
  const src = code(read(PAGE));
  const at = src.indexOf('function Health()');
  const health = src.slice(at, src.indexOf('\ninterface ExtStatus'));
  assert.ok(at > 0 && health.length > 0, 'Health() is gone from the admin page -- update this slice');
  const hdr = health.indexOf('type="button"');
  const close = health.indexOf('</button>', hdr);
  const mount = health.indexOf('<HealthCheckActions');
  assert.ok(hdr > 0 && close > hdr, 'the Health disclosure button is gone');
  assert.ok(mount > close, 'the check-level chips are inside the disclosure button, or before it');
  assert.match(health, /<HealthActions check=\{c\.id\} item=\{it\} onDone=\{recheck\} \/>/, 'the per-item chips are not mounted, or do not refetch Health');
  // ...and the header's mark with it (v0.48.3): an ignored or fixed finding must not leave the header amber.
  assert.match(health, /const recheck = \(\) => refetch\(\)\.then\(\(\) => qc\.invalidateQueries\(\{ queryKey: \['health-summary'\] \}\)\);/, 'the header mark is not refreshed after a change on the page, or the chips cannot wait for it');
  assert.doesNotMatch(health, /setMerge\(/, 'the old inline merge dialog is still in the page as a second place to merge');
  // The three fragments partialSurfaces.test.ts pins, verbatim, because this file rewrote the rows around them.
  assert.match(health, /const expandable = !!c\.items\.length \|\| !!c\.note;/, 'a note without findings cannot make its Health card expandable');
  assert.match(health, /aria-expanded=\{expandable \? isOpen : undefined\}[\s\S]*?aria-controls=\{expandable \? `health-\$\{c\.id\}-details` : undefined\}[\s\S]*?disabled=\{!expandable\}/, 'the Health disclosure no longer announces or controls its note panel');
  assert.match(health, /id=\{`health-\$\{c\.id\}-details`\}[\s\S]*?data-health-note/, 'the Health note panel lost the id named by its disclosure');
  // The row wraps: a source item carries Test, Clear block and Turn off, and at 390 px they go under the
  // title rather than off the edge of the card.
  assert.match(health, /className=\{`flex flex-wrap items-center gap-x-3 gap-y-1\.5 px-4 py-2\.5 \$\{it\.info \? 'opacity-60' : ''\}`\}/, 'the item row cannot wrap, so the chips overflow at 390 px');
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

test('every string the chips render is in all eight locale files', () => {
  // The parity test (library.test.ts) only compares the eight files with each other, so a string that
  // reaches none of them falls back to English in every language without anything failing. This reads the
  // component instead. AdminSettings.tsx is deliberately NOT in this list: settingsConsole.test.ts already
  // sweeps it, and one fact with two owners is how the two drift.
  // Reintroduce by deleting "Fix all" from public/locales/ar.json.
  const keys = trKeys([CHIPS]);
  assert.ok(keys.has('Reset solver sessions'), 'the solver chip is no longer rendered -- the scan or the file changed');
  assert.ok(keys.size >= 45, `only ${keys.size} strings found in the chips -- the scan itself is broken`);
  const locales = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
  assert.equal(locales.length, 8, `expected eight locale files, found ${locales.join(', ')}`);
  for (const f of locales) {
    const d = JSON.parse(read(`public/locales/${f}`));
    const missing = [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${missing.length} strings are missing from ${f}: ${missing.slice(0, 12).join(' | ')}`);
  }
});
