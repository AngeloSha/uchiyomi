// #116 on the web side: the add dialog's numbering notice and switch, the series page's notice and plan sheet,
// the versions sheet's per-copy titles, and Admin → Extensions' settings sheet.
//
// The pure pieces (lib/numbering.ts, lib/sourcePrefs.ts, lib/versions.ts) are driven directly; the wiring is read
// from source, like addSeriesDialog.test.ts, and each guard names the edit that fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  addNumberingView, noticeKind, numberingOutcome, planCounts, numLabel, pendingLine, refusalText,
  type DetailNumbering, type NumberingSummary, type RenumberPlan,
} from '../lib/numbering';
import { prefControl, prefSummary, toggleChoice, needsRenumberConfirm, entryLabel, extensionSettingsHref } from '../lib/sourcePrefs';
import { copyTitlesDiffer, postsShareNumber, normCopyTitle } from '../lib/versions';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// Istrevelia as GET /api/sources/detail answers it: 226 posts numbered 1..226, the source's own 13 numbers under `alt`.
const STRONG: DetailNumbering = {
  verdict: 'strong', applied: 'posting_order', ordered: true, posts: 226, numbers: 13, biggest: { number: 7, posts: 73 },
  examples: ['E7 - 315-317'], alt: { count: 13, first: 1, last: 8 }, extSourceId: '2522335540328470744',
};

test('the add dialog shows and sends the numbering its switch chose', () => {
  const d = { count: 226, first: 1, last: 226, numbering: STRONG };
  // Untouched: the server's own decision stands, and `auto` says so.
  assert.deepEqual(addNumberingView(d, false), { count: 226, first: 1, last: 226, posting: true, send: 'auto', offer: 'keep' });
  // Reintroduce by counting `d` whatever the switch says: "Keep the source's numbers" reads 226 chapters still.
  assert.deepEqual(addNumberingView(d, true), { count: 13, first: 1, last: 8, posting: false, send: 'source', offer: 'keep' },
    'keeping the source\'s numbers shows its 13 numbers and asks for them');
  // A hint numbers nothing by itself; the switch asks for posting order and shows its count.
  const hint = { count: 20, first: 1, last: 20, numbering: { ...STRONG, verdict: 'hint' as const, applied: 'source' as const, alt: { count: 34, first: 1, last: 34 } } };
  assert.deepEqual(addNumberingView(hint, false), { count: 20, first: 1, last: 20, posting: false, send: 'auto', offer: 'number' });
  assert.deepEqual(addNumberingView(hint, true), { count: 34, first: 1, last: 34, posting: true, send: 'posting_order', offer: 'number' });
  // Nothing to say, or an older server: no switch, and nothing sent but `auto`.
  assert.equal(addNumberingView({ count: 5, first: 1, last: 5, numbering: { ...STRONG, verdict: 'none', applied: 'source', alt: null } }, true).offer, null);
  assert.deepEqual(addNumberingView({ count: 5, first: 1, last: 5 }, true), { count: 5, first: 1, last: 5, posting: false, send: 'auto', offer: null });
});

test('the add dialog wires the switch into the request, the counts and the other-sources block', () => {
  const src = code(read('components/AddSeriesDialog.tsx'));
  // Reintroduce by dropping `numbering` from the add body: the switch is shown and ignored.
  // (#117's "Archive the rest slowly" rides after it, pinned in addSeriesDialog.test.ts.)
  assert.match(src, /json: \{ source: picked\.source, sourceId: picked\.sourceId, chapterCount, chapterFrom, autoUpdate, force, alsoFollow: alsoFollowBody, numbering(?:, \.\.\.\(archiving \? \{ archive: true \} : \{\}\))? \}/,
    'the add body does not carry the numbering');
  assert.match(src, /const numbering = view\?\.send \?\? 'auto';/);
  assert.match(src, /const view = detail \? addNumberingView\(detail, flipNumbering\) : null;/, 'the counts do not follow the switch');
  // The count line, the All option and the presets read the view -- the numbering the add will use.
  // Reintroduce by counting `detail.count` in the count line: "Keep the source's numbers" still reads 226.
  assert.match(src, /\{view\.count\} \{view\.count === 1 \? tr\('chapter'\) : tr\('chapters'\)\}/, 'the count line does not follow the switch');
  assert.match(src, /\{view!\.count > 0 && <option value="all">\{tr\('All \(\{n\}\)', \{ n: view!\.count \}\)\}<\/option>\}/, 'All (n) does not follow the switch');
  assert.match(src, /const presets = CHAPTER_PRESETS\.filter\(\(n\) => view && n < view\.count\);/, 'the presets do not follow the switch');
  assert.match(src, /\{detail\.numbering && view!\.offer && \(\s*<AddNumberingNotice n=\{detail\.numbering\}/, 'the notice is not rendered from detail.numbering');
  // The switch belongs to the pick it was flipped on: another source starts from its own verdict.
  assert.match(src, /const flipNumbering = !!pickKey && flippedFor === pickKey;/, 'the switch outlives the source it was flipped on');
  // Other sources cannot line up with posts numbered 1..K: no switch, one line, and nothing sent.
  assert.match(src, /mayFollow && others\.length > 0 && view\?\.posting && \(/, 'no reason is given for hiding the other sources');
  assert.match(src, /mayFollow && others\.length > 0 && !view\?\.posting && \(\s*<div className="mt-3" data-also-follow>/, 'the also-follow switch shows under posting order');
  assert.match(src, /alsoFollow && others\.length && !view\?\.posting \?/, 'candidates are still sent under posting order');
});

test('the series page\'s notice says what was done or what waits, and to whom', () => {
  const base: NumberingSummary = { mode: null, by: null, pending: null, note: null, changedAt: null, sourceName: 'Webtoons.com' };
  const note = { verdict: 'strong' as const, ordered: true, posts: 226, numbers: 13, extras: 213, biggest: { number: 7, posts: 73 }, examples: [], source: 'sw:1' };
  assert.equal(noticeKind(undefined), null);
  assert.equal(noticeKind(base), null);
  assert.equal(noticeKind({ ...base, pending: 'posting_order', note }), 'review');
  assert.equal(noticeKind({ ...base, pending: 'source', mode: 'posting_order' }), 'review');
  // Reintroduce by folding `remap` into `review`: the notice asks about posting order for a series whose source's
  // own numbers moved.
  assert.equal(noticeKind({ ...base, pending: 'remap' }), 'remap', 'a remap is its own notice');
  assert.equal(noticeKind({ ...base, mode: 'posting_order', by: 'auto', note }), 'applied');
  assert.equal(noticeKind({ ...base, note: { ...note, verdict: 'hint' } }), 'hint');
  // An admin who kept the source's numbers said so: no nagging.
  assert.equal(noticeKind({ ...base, mode: 'source', by: 'manual', note }), null);

  const page = code(read('app/series/page.tsx'));
  // Above the band and the list: the order the critic set (NumberingNotice, the band, the chapter list).
  const at = page.indexOf('<NumberingNotice ');
  assert.ok(at > 0 && at < page.indexOf('<SeriesServerDownloads '), 'the notice is not above the downloads band');
  assert.match(page, /<NumberingNotice seriesId=\{id\} numbering=\{listing\?\.numbering\} isAdmin=\{isAdmin\} onReview=\{setNumberingSheet\} \/>/);
  assert.match(page, /\{numberingSheet && isAdmin && <NumberingSheet /, 'the plan sheet is not admin-only');
  // The versions sheet closes before the plan opens: two sheets stacked both answer Escape.
  assert.match(page, /onNumbering=\{isAdmin && [^}]*\? \(\) => \{ setChapterSheet\(null\); setNumberingSheet\('posting_order'\); \} : undefined\}/);
  // Not while another change waits (a remap, an undo): confirming posting order there overwrote the queued remap with a
  // plan built on the source's new numbers. Reintroduce by dropping the `pending` clause: this fails.
  assert.match(page, /onNumbering=\{isAdmin && listing\?\.numbering\?\.mode !== 'posting_order' && !listing\?\.numbering\?\.pending\s/,
    'the versions sheet offers posting order while another change waits');
  const notice = code(read('components/NumberingNotice.tsx'));
  assert.match(notice, /\{isAdmin \? \(/, 'the keys are not the admin\'s alone');
});

test('the plan sheet counts what moves before it lists it', () => {
  const move = (from: number, to: number, via: 'rename' | 'none' = 'rename') =>
    ({ bookId: `b${from}`, root: '/dl', from, to, fromFile: `S/Chapter ${from}.cbz`, file: `S/Chapter ${to}.cbz`, via, how: 'name' as const });
  const plan: RenumberPlan = {
    mode: 'posting_order', moves: [move(1, 1, 'none'), move(2, 21), move(3, 42)], parked: [move(9, 226.5)],
    collisions: [], clean: false, reasons: ['unmatched'], newFloor: null,
  };
  assert.deepEqual(planCounts(plan), { renamed: 2, unchanged: 1, parked: 1, collisions: 0 });
  assert.equal(numLabel(7.0200005), '7.02');
  const sheet = code(read('components/NumberingSheet.tsx'));
  // Reintroduce by confirming without `confirm: true`: the route answers the plan again and nothing moves.
  assert.match(sheet, /\{ json: \{ mode: m, confirm: true \} \}/, 'Confirm does not confirm');
  assert.match(sheet, /tr\('Reading progress, bookmarks and notes stay with their chapters\.'\)/);
  assert.match(sheet, /<Sheet\b[^>]*\boverBottomNav\b/s, 'the plan sheet opens under the phone nav');
});

test('the plan sheet: the plan that waits, a Confirm a Health row can take, on <body>, and "Show all" by its list', () => {
  const sheet = code(read('components/NumberingSheet.tsx'));
  // `next` asks the route for no mode -- it picks what waits -- and the change confirmed is the one the plan is about.
  assert.match(sheet, /numbering\$\{mode === 'next' \? '' : `\?mode=\$\{mode\}`\}/, 'the plan that waits is not asked for');
  assert.match(sheet, /const m: RenumberMode \| undefined = mode === 'next' \? data\?\.mode : mode;/, 'the confirmed change is not the plan\'s');
  // Health's row takes the Confirm, so its own status line carries the rename. Reintroduce by posting here regardless.
  assert.match(sheet, /if \(onConfirm\) \{ onConfirm\(m\); onClose\(\); return; \}/, 'the Confirm cannot be handed to a Health row');
  // On <body>: Health opens it inside a `.card`, whose backdrop blur would make the card its containing block.
  // Reintroduce `return (<Sheet`: this fails, and so does healthActions.test.ts's dialog scan.
  assert.match(sheet, /return \(\s*<OnBody>\s*<Sheet\b/, 'the plan sheet is not on <body>');
  // A held rename says what held it (the review found a stray file told "the source may not have answered").
  assert.match(sheet, /setError\(pendingLine\(r\)\);/, 'a held rename is said as the source not answering');
  assert.match(sheet, /setError\(refusalText\(e, tr\('Could not do that'\)\)\);/, 'a refusal is not said as what it is');
  // "Show all" right under the moves it unfolds, before "Not matched". Reintroduce it after the parked list: fails.
  const all = sheet.indexOf('data-plan-all');
  assert.ok(all > sheet.indexOf('{shown.map(line)}') && all < sheet.indexOf("tr('Not matched')"), '"Show all" is drawn after "Not matched"');
});

test('a held or refused rename is said as what held it, and a Health row reads what it came to', () => {
  // Reintroduce the one sentence for every cause: a stray file at a target name reads "the source may not have answered".
  const plan = (reasons: RenumberPlan['reasons']): RenumberPlan => ({ mode: 'posting_order', moves: [], parked: [], collisions: [], clean: false, reasons, newFloor: null });
  assert.equal(pendingLine({ running: true }), 'Still renaming. The series page shows the new numbers when it is done.');
  assert.equal(pendingLine({ error: 'Chapter 21.cbz is already on disk' }), 'Chapter 21.cbz is already on disk', 'the server\'s refusal is dropped');
  assert.equal(pendingLine({ plan: plan(['busy']) }), 'Chapters are being fetched for this series. Try again when that ends.', 'a busy folder reads as the source');
  assert.equal(pendingLine({ plan: plan(['unmatched']) }), 'It could not be applied yet. The source may not have answered; try again in a moment.');
  // The route's 409 while a download writes into the folder, in the reader's language; any other refusal as sent.
  assert.equal(refusalText({ body: JSON.stringify({ error: 'busy', message: 'Beschäftigt' }) }, 'x'),
    'Chapters are being fetched for this series. Try again when that ends.', 'a busy folder is said as the server wrote it, not in the reader\'s language');
  assert.equal(refusalText({ body: JSON.stringify({ error: 'not_found', message: 'gone' }) }, 'x'), 'gone');
  assert.equal(refusalText(new Error('boom'), 'fallback'), 'fallback');
  // What a Health row's status line says: done, still renaming (it carries on: partial, never failed), not applied.
  assert.deepEqual(numberingOutcome({ state: 'applied', numbering: null }), { text: 'Renumbered' });
  assert.deepEqual(numberingOutcome({ state: 'pending', running: true, numbering: null }), { text: 'Still renaming. The series page shows the new numbers when it is done.', partial: true },
    'a rename still running reads as failed');
  assert.deepEqual(numberingOutcome({ state: 'pending', error: 'Chapter 21.cbz is already on disk', numbering: null }), { text: 'Chapter 21.cbz is already on disk', ok: false });
});

test('the versions sheet shows each copy\'s own title, and says when copies are really different posts', () => {
  // Istrevelia's episode 7 as the listing stores it: one source, no group, different posts.
  const posts = [
    { title: 'E7 - 315-317 (ch. 7)', source: 'sw:1', groups: [], scanlator: null },
    { title: 'Ee7 - 318-320 (ch. 7)', source: 'sw:1', groups: [], scanlator: null },
  ];
  // Three groups' "Chapter 5": versions of one chapter.
  const versions = ['A', 'B', 'C'].map((g) => ({ title: 'Chapter 5', source: 'mangadex', groups: [g], scanlator: null }));
  // Reintroduce by returning false from copyTitlesDiffer: every copy is back to a row of "—".
  assert.equal(copyTitlesDiffer(posts), true, 'Istrevelia\'s posts under one number are told apart by title');
  assert.equal(copyTitlesDiffer(versions), false);
  assert.equal(copyTitlesDiffer([{ title: 'Chapter 5 (ch. 5)' }, { title: 'chapter 5' }]), false, 'the extension\'s " (ch. N)" and case are not a difference');
  assert.equal(normCopyTitle('  E7 - 315-317 (ch. 7) '), 'e7 - 315-317');
  assert.equal(postsShareNumber(posts), true, 'one group, two titles: two posts');
  assert.equal(postsShareNumber([{ title: 'Chapter 5', source: 'a', groups: ['A'], scanlator: null }, { title: 'Chapter 5: The Return', source: 'a', groups: ['B'], scanlator: null }]), false,
    'two groups naming one chapter differently are versions');
  const sheet = code(read('components/ChapterVersionsSheet.tsx'));
  assert.match(sheet, /const titled = copyTitlesDiffer\(rows\);/);
  assert.match(sheet, /\{titled && <span dir="auto" className="block truncate text-sm text-fog-100" data-copy-title>\{c\.title\?\.trim\(\) \|\| '—'\}<\/span>\}/,
    'the copy\'s title is not its first line');
  assert.match(sheet, /\{sharing && \(/);
});

test('a source refused because the series is numbered by posting order says so, in Find missing and the add', () => {
  // The fill scan names each follower of a posting-order series with why 'posting_order', and auto-follow refuses
  // with it (bff routes/sources.ts, lib/autoFollow.ts). Without a case the rows read "Not usable" and the raw code.
  // Reintroduce by deleting the case from whyText: the first assertion fails.
  assert.match(code(read('components/FindMissingDialog.tsx')), /case 'posting_order': return tr\('Numbers these posts its own way: this series is numbered by posting order'\);/,
    'Find missing reads "Not usable" for a posting-order refusal');
  assert.match(code(read('components/AddSeriesDialog.tsx')), /case 'posting_order': return tr\('this series is numbered by posting order'\);/,
    'the add prints the raw code for a posting-order refusal');
  assert.match(code(read('lib/types.ts')), /export type FollowWhy = [^;]*\| 'posting_order';/, 'FollowWhy does not know posting order');
});

test('the settings sheet draws every kind of setting with the right control', () => {
  // Reintroduce by mapping `checkbox` to 'hidden': Webtoons' "Show author's notes" disappears from the sheet.
  assert.equal(prefControl({ type: 'switch', visible: true }), 'switch');
  assert.equal(prefControl({ type: 'checkbox', visible: true }), 'switch', 'a checkbox setting is not drawn');
  assert.equal(prefControl({ type: 'list', visible: true }), 'select');
  assert.equal(prefControl({ type: 'multiselect', visible: true }), 'checks');
  assert.equal(prefControl({ type: 'text', visible: true }), 'text');
  assert.equal(prefControl({ type: 'switch', visible: false }), 'hidden', 'a setting the extension hides is not drawn');
  const list = { summary: '%s', type: 'list' as const, value: 'high', entries: ['High', 'Medium'], entryValues: ['high', 'medium'] };
  assert.equal(prefSummary(list), 'High', 'a list\'s %s is its selected entry');
  assert.equal(entryLabel(list, 'unknown'), 'unknown');
  assert.deepEqual(toggleChoice({ entryValues: ['a', 'b', 'c'], value: ['c'] }, 'a', true), ['a', 'c'], 'in the extension\'s own order');
  assert.deepEqual(toggleChoice({ entryValues: ['a', 'b'], value: ['a', 'b'] }, 'a', false), ['b']);
  // A numbering setting asks again only when there is a series to renumber.
  assert.equal(needsRenumberConfirm({ numbering: true }, 3), true);
  assert.equal(needsRenumberConfirm({ numbering: true }, 0), false);
  assert.equal(needsRenumberConfirm({ numbering: false }, 3), false);
  assert.equal(extensionSettingsHref('2522335540328470744'), '/admin/?tab=Extensions&settings=2522335540328470744');
});

test('the settings sheet writes by key, warns in the row, and asks its second word inside the sheet', () => {
  const src = code(read('components/ExtensionSettings.tsx'));
  // Reintroduce by sending a position: the server refuses it (bad_request), and a position is what must never
  // address a write.
  assert.match(src, /\{ json: \{ key: pref\.key, value \} \}/, 'a write does not name the key');
  assert.doesNotMatch(src, /position/, 'the sheet knows about positions');
  // Reintroduce by opening ConfirmDialog for the numbering change: a Modal is z-50 under this z-60 sheet and the
  // confirm cannot be tapped.
  assert.doesNotMatch(src, /<ConfirmDialog\b|<Modal\b|import \{[^}]*\b(ConfirmDialog|Modal)\b[^}]*\}/, 'the numbering confirm is a dialog the sheet would cover');
  assert.match(src, /if \(needsRenumberConfirm\(pref, data\?\.renumbers \?\? 0\)\) setPending\(\{ pref, value \}\);/);
  assert.match(src, /\{p\.numbering && \(\s*<div className="[^"]*" data-renumber-warning>/, 'the renumber warning is not in the setting\'s row');
  assert.match(src, /<Sheet\b[^>]*\boverBottomNav\b/s, 'the settings sheet opens under the phone nav');
  // An extension whose package lists no source says so, and stops saying "Loading…" beside it. Reintroduce the guard
  // without `!pkgSources`: this fails.
  assert.match(src, /\{\(isLoading \|\| \(!sourceId && !pkgFailed && !pkgSources\)\) && <p[^>]*>\{tr\('Loading…'\)\}<\/p>\}/, 'an empty package reads "Loading…" for good');
  // Reintroduce by returning the Sheet itself: inside the Extensions `.card` (backdrop-filter) it covers the card
  // only, and the admin header shows through above it.
  assert.match(src, /return createPortal\(\s*<Sheet\b/, 'the settings sheet is not portalled out of the card');
  assert.match(src, /<\/Sheet>,\s*document\.body,\s*\);/);
  // The deep link: read once, dropped from the address on close.
  assert.match(src, /const id = params\.get\('settings'\);/, 'the sheet does not read ?settings=');
  assert.match(src, /u\.searchParams\.delete\('settings'\);/, 'a closed sheet reopens on reload');

  const admin = code(read('app/admin/page.tsx'));
  const ext = admin.slice(admin.indexOf('function Extensions('), admin.indexOf('\n}\n', admin.indexOf('function Extensions(')));
  // Reintroduce by dropping the hook from Extensions: /admin/?tab=Extensions&settings=<id> opens nothing.
  assert.match(ext, /const \[settingsFor, setSettingsFor\] = useExtensionSettingsParam\(\);/, 'Extensions does not read the ?settings= deep link');
  assert.match(ext, /\{e\.installed && \(\s*<button onClick=\{\(\) => setSettingsFor\(\{ pkgName: e\.pkgName, name: e\.name \}\)\} className="btn-key">\{tr\('Settings'\)\}<\/button>/,
    'an installed extension has no Settings key');
  assert.match(ext, /\{settingsFor && status\.reachable && <ExtensionSettings target=\{settingsFor\} onClose=\{\(\) => setSettingsFor\(null\)\} \/>\}/);
  // The hook sits with the other state, before the early returns (hooks keep their order).
  assert.ok(ext.indexOf('useExtensionSettingsParam()') < ext.indexOf('if (!status) return null;'), 'the deep-link hook runs after an early return');
});
