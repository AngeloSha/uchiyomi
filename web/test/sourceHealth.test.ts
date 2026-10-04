// Health → Source health, decluttered (v0.53.0).
//
// The owner: "it feels like there is a million extention that i need to fix but it loks complicated". The card listed
// its key glossary and a paragraph first, then thirty-one sources switched off on purpose (each with a Test key), and
// at its very end the handful the library depends on. These hold the card that replaced it: the server's groups in
// its order (bff test/health.int.test.ts holds the order itself), the switched-off and the quiet rows folded away,
// ONE key per row with the rest in a ⋯ menu, a Turn off all that asks first and then turns each source off in turn,
// and the glossary at the foot instead of above the list. The pure rules are lib/sourceHealth.ts; the card is
// rendered as static markup (findSources.test.ts does the same), and the wiring is read from source as
// healthActions.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RepairRunProvider } from '../lib/useRepairRun';
import { FindRunProvider } from '../lib/useFindRun';
import { SourceHealthBody } from '../components/SourceHealthBody';
import {
  bulkTargets, groupOf, paceText, primaryOf, seriesText, stateReason, stateWord, tileLetters, tileTone, turnOffAllLabel, turnOffEach,
  turnOffOutcome, turnOffQuestion,
} from '../lib/sourceHealth';
import type { HealthCheck, HealthItem } from '../lib/types';

(globalThis as any).React = React;
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed: several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

const IN_20_MIN = () => new Date(Date.now() + 20 * 60_000).toISOString();
const AN_HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString();
const item = (o: Partial<HealthItem> & { sourceId: string }): HealthItem => ({
  title: o.sourceId, detail: `${o.sourceId} detail`, actions: ['test', 'disable', 'ignore'], series: 0, ...o,
});
/** The live server's proportions in small: four the series use, two failing nobody uses, three switched off, one quiet. */
const ROWS: HealthItem[] = [
  item({ sourceId: 'mangakakalot', title: 'Mangakakalot', group: 'affected', state: 'blocked', series: 37,
    cooldown: { status: 'rate_limited', until: IN_20_MIN() }, actions: ['test', 'unblock', 'disable', 'find_sources', 'ignore'], findSeries: 37, key: 'source:mangakakalot' }),
  item({ sourceId: 'mangaread', title: 'Mangaread', group: 'affected', state: 'slow', series: 125, key: 'source:mangaread' }),
  item({ sourceId: 'natomanga', title: 'Natomanga', group: 'affected', state: 'empty', series: 123, key: 'source:natomanga' }),
  item({ sourceId: 'manhuaus', title: 'Manhuaus', group: 'affected', state: 'failing', stage: 'pages', series: 48, key: 'source:manhuaus' }),
  item({ sourceId: 'sw:9200000000000000001', title: 'Hentai Shelf (AR)', group: 'unused', state: 'failing', stage: 'search', key: 'source:sw:9200000000000000001' }),
  item({ sourceId: 'weebcentral', title: 'Weeb Central', group: 'unused', state: 'blocked', cooldown: { status: 'down', until: IN_20_MIN() },
    actions: ['test', 'unblock', 'disable', 'ignore'], key: 'source:weebcentral' }),
  item({ sourceId: 'coffeemanga', title: 'Coffee Manga', group: 'quiet', state: 'inconclusive', stage: 'search', info: true, actions: ['test'] }),
  item({ sourceId: 'sw:9100000000000000001', title: 'Kiri Comics 1 (FR)', group: 'off', state: 'off', offBy: 'language', info: true, actions: ['test'] }),
  item({ sourceId: 'sw:9100000000000000002', title: 'Lantern 2 (ID)', group: 'off', state: 'off', offBy: 'language', info: true, actions: ['test'] }),
  item({ sourceId: 'oldsite', title: 'Old Site', group: 'off', state: 'off', offBy: 'admin', info: true, actions: ['test'] }),
];
const CHECK: HealthCheck = {
  id: 'sources', title: 'Source health', status: 'warn', summary: '4 sources your series use need a look · 2 sources nothing uses are failing',
  note: 'A source is failing when…', items: ROWS, testMs: 53_000,
};
const render = (check: HealthCheck): string => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
  createElement(RepairRunProvider, { onEnded: async () => {},
    children: createElement(FindRunProvider, { onEnded: async () => {}, children: createElement(SourceHealthBody, { check }) }) })));
/** Each `<tag …data-source-row="id"…>` row of the markup, as the text of its own element up to the next row. */
const rowsOf = (html: string): string[] => html.split('data-health-item=').slice(1);

/* ================================================================ the pure rules */

test("a row's group is the server's; from an older server, the same rule from what it sent", () => {
  assert.equal(groupOf(ROWS[0]), 'affected');
  assert.equal(groupOf(ROWS[7]), 'off');
  // Before v0.53.0 there was no `group`: a finding is the series' or nobody's, a turned-off row says so in its code.
  assert.equal(groupOf({ title: 'x', detail: '', series: 3 }), 'affected');
  assert.equal(groupOf({ title: 'x', detail: '', series: 0 }), 'unused');
  assert.equal(groupOf({ title: 'x', detail: '', info: true, detailSaid: [{ code: 'sources.turnedOff' }] }), 'off');
  assert.equal(groupOf({ title: 'x', detail: '', info: true, detailSaid: [{ code: 'sources.inconclusive' }] }), 'quiet');
});

test('ONE key per row: Clear block for a cooldown it can clear, Test for the rest, none in a fold', () => {
  // Reintroduce `return 'test'` for everything: "a rate-limited source leads with Clear block" fails.
  assert.equal(primaryOf(ROWS[0]), 'unblock', 'a rate-limited source leads with Clear block');
  assert.equal(primaryOf(ROWS[1]), 'test');
  assert.equal(primaryOf(ROWS[3]), 'test', 'a failing source leads with Test');
  assert.equal(primaryOf(ROWS[5]), 'unblock', 'a cooldown on a source nothing uses leads with Clear block too');
  assert.equal(primaryOf({ ...ROWS[0], actions: ['test', 'disable'] }), 'test', 'no block to clear: Test');
  assert.equal(primaryOf(ROWS[6]), null, 'a quiet row has no key of its own');
  assert.equal(primaryOf(ROWS[7]), null, 'nor does a switched-off one');
});

test('Replace leads wherever it is offered, the switched-off fold included, and opens the Replace dialog', () => {
  // v0.54.0: aqua sat in "Switched off by you", still the main source of 195 series, with nothing to press but Test.
  // The server offers `replace_source` on a source that is off or failing and some series' main (and on the
  // frozen-series rows); it is the row's one key wherever it is. Reintroduce primaryOf without its first line: "a
  // failing main source leads with Test" fails; move the line after the fold check: "the switched-off fold offers no
  // Replace" does.
  const failing = item({ sourceId: 'manhuaus', title: 'Manhuaus', group: 'affected', state: 'failing', stage: 'pages', series: 48,
    actions: ['test', 'disable', 'replace_source', 'find_sources', 'ignore'], findSeries: 48, key: 'source:manhuaus' });
  const aqua = item({ sourceId: 'aqua', title: 'Aqua Manga', group: 'off', state: 'off', offBy: 'admin', info: true, series: 195,
    actions: ['test', 'replace_source'], findSeries: 195, key: 'source:aqua' });
  assert.equal(primaryOf(failing), 'replace_source', 'a failing main source leads with Test');
  assert.equal(primaryOf(aqua), 'replace_source', 'the switched-off fold offers no Replace');
  assert.equal(primaryOf({ ...ROWS[0], actions: [...(ROWS[0].actions ?? []), 'replace_source'] }), 'replace_source', 'Clear block outranks Replace');
  // Drawn: the row's one key reads Replace, filled; Test and the rest are in its ⋯ menu.
  const html = render({ ...CHECK, items: [failing] });
  const row = rowsOf(html)[0];
  assert.match(row, /<button type="button" data-health-action="replace_source" data-health-primary="" class="btn-key btn-key-primary [^"]*"[^>]*><span>Replace<\/span><\/button>/,
    'the row\'s key is not Replace');
  // The key opens the dialog Admin → Sources opens, on <body>, for this source.
  const keys = code(read('components/HealthActions.tsx'));
  assert.match(keys, /case 'replace_source':\s*return \{ \.\.\.base, primary: true, label: tr\('Replace'\), onRun: \(\) => setAsking\('replace'\) \};/);
  assert.match(keys, /\{asking === 'replace' && item\.sourceId && \(\s*<OnBody>\s*<ReplaceDialog sourceId=\{item\.sourceId\}/, 'Replace opens no dialog, or one inside the card');
  // Its glossary entry, with what it does before the press.
  assert.match(read('lib/healthCopy.ts'), /replace_source: \{\s*label: \(\) => tr\('Replace'\),\s*what: /, 'the key glossary has no Replace');
});

test('a row says its state in a word, why, and how many series use it', () => {
  assert.equal(stateWord(ROWS[0]), 'Rate-limited');
  assert.match(stateReason(ROWS[0]), /^trying again in (19|20) minutes$/);
  assert.equal(stateReason({ ...ROWS[0], cooldown: { status: 'rate_limited', until: AN_HOUR_AGO() } }), 'trying again on next use', 'an ended cooldown');
  assert.equal(stateWord(ROWS[5]), 'Not answering', 'down reads as the source card says it');
  assert.equal(stateWord({ ...ROWS[5], cooldown: { status: 'blocked', until: null } }), 'Blocked by the site');
  assert.equal(stateWord({ ...ROWS[5], cooldown: { status: 'a-newer-status', until: null } }), 'Not answering', 'a status this build does not know is never "Healthy"');
  assert.equal(stateWord(ROWS[1]), 'Slow lately');
  assert.equal(stateReason(ROWS[1]), 'answers take longer than the limit');
  assert.equal(stateWord(ROWS[2]), 'Answers empty');
  assert.equal(stateReason(ROWS[2]), 'the site may have changed');
  assert.equal(stateWord(ROWS[3]), 'Failing');
  assert.equal(stateReason(ROWS[3]), 'Page list', 'the stage by its own name, as the stage lines say it');
  assert.equal(stateWord(ROWS[6]), 'Test didn’t finish');
  assert.equal(stateWord({ ...ROWS[6], state: 'untested' }), 'Not checked since it failed');
  assert.equal(stateWord(ROWS[7]), 'Hidden language');
  assert.equal(stateWord(ROWS[9]), 'Turned off');
  assert.equal(stateWord({ ...ROWS[7], offBy: 'extension' }), 'Turned off', 'an extension\'s source switched off by itself');
  assert.equal(stateWord({ title: 'x', detail: 'as sent' }), null, 'no state from an older server: the row shows its detail');
  assert.equal(seriesText(37), '37 series');
  assert.equal(seriesText(1), '1 series');
  assert.equal(seriesText(0), '', 'nothing for a source nothing uses');
  assert.equal(tileTone(ROWS[0]), 'warn');
  assert.equal(tileTone(ROWS[5]), 'problem', 'a site not answering is red');
  assert.equal(tileTone(ROWS[6]), 'info');
  assert.equal(tileTone(ROWS[7]), 'off');
  // The tile's letters: words, never a number or the language suffix ("L1" read as a code, not a name).
  assert.equal(tileLetters('Hentai Shelf (AR)'), 'HS');
  assert.equal(tileLetters('Lantern 10 (FR)'), 'L', 'a number is a letter of the tile ("L1")');
  assert.equal(tileLetters('Kiri Comics 2 (FR)'), 'KC');
  assert.equal(tileLetters('fake-b'), 'FB');
  assert.equal(tileLetters('مانجا'), 'م');
  assert.equal(tileLetters('2024'), '2', 'no letter at all: the avatar\'s rule');
  // v0.54.0, Admin → Sources lists every source: a name that starts with its number is the number and the letter after
  // it, the language suffix left out -- the avatar's rule drew "3(" for "3Hentai (EN)". Reintroduce the words-only rule:
  // these fail.
  assert.equal(tileLetters('3Hentai (EN)'), '3H', 'a name that starts with its number draws its suffix');
  assert.equal(tileLetters('1Manga.co'), '1M');
  assert.equal(tileLetters('24h manga'), '2H', 'a name led by a number keeps only its first digit');
});

test('Turn off all asks about the failing sources nothing uses, in words that agree with the count', () => {
  assert.deepEqual(bulkTargets(ROWS).map((it) => it.sourceId), ['sw:9200000000000000001', 'weebcentral']);
  assert.deepEqual(bulkTargets([{ ...ROWS[4], actions: ['test'] }]), [], 'only a row that can still be turned off');
  assert.equal(turnOffAllLabel(5), 'Turn off all 5');
  assert.equal(turnOffAllLabel(1), 'Turn off', 'one source: the row\'s own verb, never "Turn off all 1"');
  // v0.54.0: it names no place -- it is asked on Admin → Sources itself, where "in Admin → Sources" read as somewhere else.
  // Reintroduce the old words: these two fail.
  assert.equal(turnOffQuestion(5), 'Turn off these 5 sources? No series uses them. You can turn them back on any time.');
  assert.equal(turnOffQuestion(1), 'Turn off this source? No series uses it. You can turn it back on any time.');
  assert.equal(turnOffOutcome(5, 0), '5 sources turned off');
  assert.equal(turnOffOutcome(1, 0), '1 source turned off');
  assert.equal(turnOffOutcome(3, 2), '3 sources turned off · 2 sources could not be turned off');
  assert.equal(turnOffOutcome(0, 1), '1 source could not be turned off');
});

test('Turn off all turns each source off in turn, never at once, and goes on past one that fails', async () => {
  // Reintroduce `await Promise.all(ids.map(post))`: "two requests at once" fails. Stop at the first failure: the
  // sources after it stay on, and "the ones after a failure are still turned off" fails.
  const seen: string[] = [];
  let open = 0;
  let most = 0;
  const steps: Array<[number, number]> = [];
  const post = async (id: string) => {
    open++;
    most = Math.max(most, open);
    seen.push(id);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    if (id === 'b') throw new Error('500');
  };
  const r = await turnOffEach(['a', 'b', 'c'], post, (done, total) => steps.push([done, total]));
  assert.deepEqual(r, { off: ['a', 'c'], failed: ['b'] }, 'the ones after a failure are still turned off');
  assert.equal(most, 1, 'two requests at once');
  assert.deepEqual(seen, ['a', 'b', 'c'], 'every source, in the order of the list');
  assert.deepEqual(steps, [[0, 3], [1, 3], [2, 3], [3, 3]], 'the progress hears each step, and the end');
});

/* ================================================================ the card */

test('the card: the series\' sources first, then the failing ones nothing uses; switched off and quiet are folded, closed', () => {
  // Reintroduce the switched-off rows as an open group (a <Group> rather than a <Fold>): "the switched-off sources
  // are folded away" fails -- thirty rows in the middle of the card again.
  const html = render(CHECK);
  const at = (needle: string) => html.indexOf(needle);
  assert.ok(!html.includes('data-source-group="off"') && !html.includes('data-source-group="quiet"'), 'the switched-off sources are folded away');
  assert.ok(at('data-source-group="affected"') >= 0 && at('data-source-group="unused"') > at('data-source-group="affected"'),
    'the series\' sources come first, the failing ones nobody uses after them');
  assert.ok(at('data-source-fold="off"') > at('data-source-group="unused"') && at('data-source-fold="quiet"') > at('data-source-fold="off"'),
    'the folds come after the two groups');
  for (const id of ['off', 'quiet']) {
    const fold = slice(html, `data-source-fold="${id}"`, '</section>');
    assert.match(fold, /aria-expanded="false"/, `the ${id} fold is closed until opened`);
  }
  for (const name of ['Kiri Comics 1 (FR)', 'Lantern 2 (ID)', 'Old Site', 'Coffee Manga']) {
    assert.ok(!html.includes(name), `${name} is drawn while its fold is closed`);
  }
  // The counts beside the groups and the folds.
  assert.match(slice(html, 'data-source-group="affected"', '</h3>'), />4<\/span>/);
  assert.match(slice(html, 'data-source-fold="off"', '</button>'), />3<\/span>/);
  // The rows in the server's order.
  const names = ['Mangakakalot', 'Mangaread', 'Natomanga', 'Manhuaus', 'Hentai Shelf (AR)', 'Weeb Central'];
  const where = names.map((n) => at(`>${n}</span>`));
  assert.deepEqual([...where].sort((a, b) => a - b), where, `the rows are not in the server's order: ${where}`);
  assert.ok(where.every((w) => w > 0));
});

test('one key per row, the rest behind ⋯; a row reads one line, and its evidence waits behind Details', () => {
  // Reintroduce every key as a key (`<ActionKeys actions={specs} />` in the compact row): "more than one key on a
  // row" fails, Turn off and Ignore sitting beside Test on every row.
  const html = render(CHECK);
  const rows = rowsOf(html);
  assert.equal(rows.length, 6, 'the six rows of the two open groups');
  for (const r of rows) {
    const keys = r.match(/data-health-action="/g) ?? [];
    assert.equal(keys.length, 1, `more than one key on a row: ${r.slice(0, 120)}`);
    assert.match(r, /data-health-primary=""/, 'the key is the primary');
    assert.match(r, /data-health-more="true"[^>]*aria-haspopup="menu"/, 'and a ⋯ with the rest');
  }
  assert.match(rows[0], /data-health-action="unblock"/, 'Mangakakalot\'s key is Clear block');
  assert.match(rows[1], /data-health-action="test"/, 'Mangaread\'s key is Test');
  // The one line: the state word, why, the series.
  assert.match(rows[0], /Rate-limited<\/span> — trying again in (19|20) minutes · 37 series/);
  assert.match(rows[3], /Failing<\/span> — Page list · 48 series/);
  assert.match(rows[4], />Extension</, 'an extension source says so');
  // Behind Details, closed: the stage lines are not drawn until it opens.
  for (const r of rows) assert.match(r, /data-health-details[\s\S]*?aria-expanded="false"/, 'Details is closed');
  assert.ok(!html.includes('data-source-evidence'), 'the stage lines are drawn while Details is closed');
});

test('a source at a raised pace says it downloads slowly: a quiet row of its own, a phrase on any other (v0.55.3)', () => {
  // The owner's Natomanga, its chapters coming one at a time for hours after its image server's 429s, and the card
  // said nothing of why. Reintroduce by dropping the `slowed` case in stateWord: the row falls back to its detail. Drop
  // the `pace` segment in SourceRow: the rate-limited row's line says nothing of its pace.
  const slowed = item({ sourceId: 'natomanga', title: 'Natomanga', group: 'quiet', state: 'slowed', slowed: true, info: true, series: 116 });
  assert.equal(stateWord(slowed), 'Downloading slowly');
  assert.equal(stateReason(slowed), 'the site asked for fewer requests');
  assert.equal(paceText(slowed), '', 'said once, by its word');
  assert.equal(tileTone(slowed), 'info', 'grey: nothing to fix');
  assert.equal(primaryOf(slowed), null, 'and nothing to press in its fold');
  const limited = { ...ROWS[0], slowed: true };
  assert.equal(paceText(limited), 'Downloading slowly', 'beside a cooldown, after its reason');
  assert.equal(paceText(ROWS[0]), '', 'nothing for a row at its own pace');
  const html = render({ ...CHECK, items: [limited] });
  assert.match(rowsOf(html)[0], /Rate-limited<\/span> — trying again in (19|20) minutes · Downloading slowly · 37 series/);
  // In the quiet fold, closed: drawn only once it opens.
  const folded = render({ ...CHECK, items: [slowed] });
  assert.match(slice(folded, 'data-source-fold="quiet"', '</section>'), /aria-expanded="false"/);
  assert.ok(!folded.includes('Natomanga'), 'the quiet row waits behind its fold');
});

test('Turn off all is a key in its group\'s head, and it asks before it does anything', () => {
  // Reintroduce the head key running at once (`onClick={() => { void run(); }}` on it): "the head's key only asks" fails.
  const html = render(CHECK);
  const head = slice(html, 'data-source-group="unused"', '</h3>');
  assert.ok(head.length > 0);
  const group = slice(html, 'data-source-group="unused"', 'data-health-item=');
  assert.match(group, /<button[^>]*data-source-bulk-off="true"[^>]*aria-expanded="false"[^>]*>Turn off all 2<\/button>/, 'the group\'s key says how many');
  assert.ok(!html.includes('data-source-bulk-confirm'), 'nothing is asked before the key is pressed');
  assert.ok(!slice(html, 'data-source-group="affected"', 'data-source-group="unused"').includes('data-source-bulk-off'), 'only the group nobody uses has it');
  const src = code(read('components/SourceHealthBody.tsx'));
  const bulk = slice(src, 'function useTurnOffAll(', 'function Foot(');
  assert.match(bulk, /data-source-bulk-off aria-expanded=\{asking\} disabled=\{busy\} onClick=\{\(\) => setAsking\(!asking\)\}/, 'the head\'s key only asks');
  assert.equal((bulk.match(/run\(\)/g) ?? []).length, 1, 'the run starts from one place');
  assert.match(bulk, /data-source-bulk-go onClick=\{\(\) => \{ void run\(\); \}\}/, 'and that place is the question\'s own key');
  // Each source through the row's own request, in turn, with one notice at the end and Health asked again.
  assert.match(bulk, /await turnOffEach\(targets\.map\(\(t\) => t\.sourceId!\), disableSource,/, 'not each row\'s Turn off');
  assert.equal((bulk.match(/toast\(/g) ?? []).length, 1, 'one notice for the whole run');
  assert.match(bulk, /await rr\.recheck\(\)/, 'Health is not asked again, so the rows never move to Switched off');
  // The row's Turn off and this make the one same request.
  const keys = code(read('components/HealthActions.tsx'));
  assert.match(keys, /export const disableSource = \(sourceId: string\) =>\s*api\(`\/api\/admin\/sources\/\$\{encodeURIComponent\(sourceId\)\}\/disable`, \{ method: 'POST' \}\);/);
  assert.match(slice(keys, 'const doDisable = async', 'const ctx: CopyCtx'), /await disableSource\(item\.sourceId \|\| ''\);/);
});

test('the glossary is at the foot, behind a link, no longer above the list', () => {
  // Reintroduce `<HealthCardActions check={c} />` above the sources card's body (the generic body in Health()), or at
  // the top of SourceHealthBody: "the glossary stands above the list" fails.
  const html = render(CHECK);
  assert.ok(!html.includes('data-health-legend'), 'the glossary stands above the list');
  assert.ok(!html.includes('data-health-note'), 'and so does the note');
  const foot = html.indexOf('data-source-foot="note"');
  assert.ok(foot > html.indexOf('data-source-fold="quiet"'), 'the links are at the foot, after the folds');
  assert.match(html, /data-source-foot="legend"[^>]*aria-expanded="false"[^>]*>What the buttons do/);
  assert.match(html, /data-source-foot="note"[^>]*aria-expanded="false"[^>]*>How a source counts as failing/);
  // Health() gives the sources card this body, and every other card the one it had.
  const page = code(read('app/admin/page.tsx'));
  const health = slice(page, 'function Health()', 'function DesktopUpdateNote(');
  assert.match(health, /\{isOpen && c\.id === 'sources' && \(\s*<div id=\{`health-\$\{c\.id\}-details`\} className="border-t border-ink-800\/70">\s*<SourceHealthBody check=\{c\} \/>\s*<\/div>\s*\)\}/,
    'the sources card does not draw its own body');
  assert.match(health, /\{isOpen && c\.id !== 'sources' && \(\s*<div id=\{`health-\$\{c\.id\}-details`\} className="border-t border-ink-800\/70">\s*<HealthCardActions check=\{c\} \/>/,
    'the other cards lost their glossary');
  const body = code(read('components/SourceHealthBody.tsx'));
  const main = slice(body, 'export function SourceHealthBody(', 'function Group(');
  assert.ok(!main.includes('<HealthCardActions'), 'the glossary is drawn in the card\'s body, above or among the groups');
  assert.match(slice(body, 'function Foot(', ''), /\{open === 'legend' && \(\s*<div id="health-sources-legend">\s*<HealthCardActions check=\{check\}/);
  // The switched-off fold points where they come back on: Admin → Sources since v0.54.0, which turns on every kind --
  // where Providers and Extensions were two links, and Providers could not turn an extension's source on.
  // Reintroduce either old link: "a switched-off source is sent to a tab that is gone" fails.
  const fold = slice(main, "<Fold id=\"off\"", '</Fold>');
  assert.match(fold, /<a href="\/admin\/\?tab=Sources" data-source-turn-on="sources" [^>]*>\{tr\('Turn sources back on in Admin → Sources'\)\}/, 'the fold does not say where they come back on');
  assert.equal((fold.match(/<a href=/g) ?? []).length, 1, 'the fold has more than one way back');
  assert.doesNotMatch(fold, /tab=(Providers|Extensions)/, 'a switched-off source is sent to a tab that is gone');
});

test('the card stays a Health card: no capsules, its rows findable, names in their own direction', () => {
  const body = code(read('components/SourceHealthBody.tsx'));
  // The rows are HealthRow's, compact: its keys, states, runs and confirmations, never a copy of them.
  assert.match(body, /<HealthRow check=\{check\} item=\{it\} rowKey=\{rowKey\}\s*compact=\{\{/);
  assert.doesNotMatch(body, /\/api\/admin\/sources\//, 'a request of its own, beside the row\'s');
  assert.match(body, /<span dir="auto" data-source-name/, 'a source\'s name takes the page\'s direction');
  assert.match(body, /<p dir="auto" data-health-detail/, 'the server\'s sentence takes the page\'s direction');
  assert.match(body, /<SourceEvidence \{\.\.\.healthRowEvidence\(it\)\} \/>/, 'Details does not hold the stage lines and the fix');
  assert.match(body, /details: groupOf\(it\) === 'off' \? undefined : \(/, 'a switched-off row repeats "turned off" behind a Details of its own');
  const keys = code(read('components/HealthActions.tsx'));
  const row = slice(keys, 'export function HealthRow', 'const SCAN_CHECKS');
  const compact = slice(row, 'if (compact) {', '\n  return (');
  assert.match(compact, /<div data-health-item=\{rowKey\} data-repair-state=\{rowNow\.kind\}/, 'the row is not findable, or does not say its state');
  assert.match(compact, /<ActionStatus state=\{rowNow\} \/>/, 'the row has no status line');
  assert.match(compact, /\{finds\.length > 0 && <ActionStatus state=\{findNow\} \/>\}/, 'a search for other sources has no status line');
  assert.match(compact, /\{dialogs\}/, 'the row\'s confirmations are missing');
  // A menu item runs exactly what its key would, and is disabled as its key would be.
  const menu = slice(row, 'const menu = useContextMenu(', 'if (compact) {');
  assert.match(menu, /onSelect: \(\) => \{ if \(btn\.stop && st\.kind === 'working'\) st\.onStop\?\.\(\); else sp\.onRun\?\.\(\); \}/);
  assert.match(menu, /disabled: !!sp\.disabled \|\| \(st\.kind === 'working' && !!st\.stopping\) \|\| \(groupBusy && !btn\.stop\)/);
  assert.match(menu, /hook: sp\.id/, 'a menu item is not tagged for the walks');
  assert.doesNotMatch(body, /\brounded-full\b/, 'a capsule on the card');
  // Turn off and Ignore move a row into a closed fold, its status line with it: said in a notice too. Reintroduce by
  // dropping the line: a Turn off from the menu makes the row vanish without a word.
  assert.match(slice(row, 'const act = ', 'const renumber = async'),
    /if \(compact && out\.ok !== false && \(a === 'disable' \|\| a === 'ignore' \|\| a === 'unignore'\)\) toast\(out\.text, 'success'\);/,
    'a row that moves into a fold says nothing');
});
