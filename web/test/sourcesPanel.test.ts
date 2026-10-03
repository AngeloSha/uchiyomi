// Admin → Sources (v0.54.0): ONE tab for every source, where Providers and Extensions were two, with Replace for a
// dead main source and Make main on a series' follower.
//
// The owner: "why do we have 2 when they are basically the same … i have to go one by one test and find replacement
// sources and its cluttered and messy". Each test holds one behaviour of the new tab, the Replace dialog and Make
// main, and names the edit that brings its fault back. The rules are lib/sourcesPanel.ts and lib/mainSource.ts,
// called; the components are rendered where a render says more than their source (the one list, Needs attention, the
// Replace dialog and its run, the sheet's keys, Make main's question), and read where only a press would show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';
import {
  attentionRows, initialView, needsAttention, replaceLine, replacePlan, rowAction, settingsTarget, sheetKeys, splitSources, turnOffQuestion,
  type OverviewSource, type ReplacePreview, type SourcesOverview,
} from '../lib/sourcesPanel';
import { makeMainQuestion, mayMakeMain } from '../lib/mainSource';
import type { FindRun } from '../lib/findSources';
import type { FindRunApi } from '../lib/useFindRun';
import type { SeriesSource } from '../lib/types';
import { Attention, YourSources } from '../components/SourcesPanel';
import { SourceSheet } from '../components/SourceSheet';
import { ReplaceDialog } from '../components/ReplaceDialog';
import { SourceRow as SeriesSourceRow } from '../components/SourcesSheet';
import { msgOf } from '../components/ConfirmDialog';

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
const params = (q: string) => new URLSearchParams(q);

/** One source of the overview, healthy and used by nothing, unless said otherwise. */
const src = (id: string, over: Partial<OverviewSource> = {}): OverviewSource => ({
  id, name: id, kind: 'builtin', lang: 'en', standing: 'usable', state: 'ok', main: 0, followed: 0, withBackup: 0, ...over,
});
/** The live server's shape in small: aqua offline and switched off, still the main source of 195 series. */
const AQUA = src('aqua', { name: 'Aqua Manga', kind: 'site', standing: 'off', offBy: 'admin', state: 'off', offline: true, main: 195, withBackup: 184, address: 'https://aquamanga.org' });
const OVERVIEW: SourcesOverview = {
  sources: [
    AQUA,
    src('sw:1533', { name: 'Hentai Shelf (AR)', kind: 'extension', lang: 'ar', standing: 'failing', state: 'failing', stage: 'search', pkgName: 'pkg.shelf' }),
    src('mangaread', { name: 'Mangaread', main: 125, followed: 3 }),
    src('natomanga', { name: 'Natomanga', standing: 'cooling', state: 'blocked', cooldown: { status: 'rate_limited', until: null }, main: 123 }),
    src('mangadex', { name: 'MangaDex', kind: 'mangadex', main: 4 }),
    src('sw:2001', { name: 'Asura Scans', kind: 'extension', main: 47, pkgName: 'pkg.asura', icon: true }),
    src('pack:one', { name: 'Pack One', kind: 'pack', lang: null }),
    src('sw:3001', { name: 'Kiri Comics (FR)', kind: 'extension', lang: 'fr', standing: 'off', offBy: 'language', state: 'off', pkgName: 'pkg.kiri' }),
  ],
  attention: { replace: ['aqua'], failingUnused: ['sw:1533'], updates: 1 },
};
const noop = () => {};
const later = async () => {};
/** The extension actions the panel hands down, doing nothing: a render never presses them. */
const ACTIONS = { busy: {}, act: async () => null, updateAll: later, refresh: later, refreshAll: async () => [], refreshError: null } as never;
const withQueries = (el: React.ReactElement, data: Array<[readonly unknown[], unknown]> = []) => {
  const client = new QueryClient();
  for (const [k, v] of data) client.setQueryData(k, v);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, el));
};

// ---- the tab, from its address -----------------------------------------------------------------------------------

test('the old tabs\' parameters open the matching view, and settings=<id> that source\'s sheet on its settings', () => {
  // ?tab=Providers and ?tab=Extensions land on Sources (settingsConsole.test.ts); what they carried keeps working.
  // Reintroduce an initialView that ignores Extensions' `view=browse`, or settingsTarget without the `sw:` prefix the
  // overview names an extension source by: these fail.
  assert.equal(initialView(params('tab=Extensions&view=browse')), 'add', 'Extensions\' Browse lands on Your sources');
  assert.equal(initialView(params('tab=Extensions&view=installed')), 'yours');
  assert.equal(initialView(params('tab=Sources&view=add')), 'add');
  assert.equal(initialView(params('tab=Providers&card=mangadex')), 'add', 'the MangaDex languages link lands where they are not');
  assert.equal(initialView(params('tab=Sources')), 'yours', 'a plain visit opens on Add sources');
  assert.equal(settingsTarget(params('tab=Extensions&settings=2522335540328470744')), 'sw:2522335540328470744', 'the settings link opens no sheet');
  assert.equal(settingsTarget(params('settings=-17')), 'sw:-17', 'an extension source\'s negative id is refused');
  assert.equal(settingsTarget(params('settings=aqua')), null, 'a settings link opens the sheet of something that is not an extension source');
  assert.equal(settingsTarget(params('tab=Sources')), null);
  // Read once, on arrival, as every address the console reads is (lib/useTabParam.ts): a switch writes `view=` back.
  const panel = code('components/SourcesPanel.tsx');
  assert.match(panel, /const \[view, setView\] = useState<SourcesView>\(\(\) => initialView\(params\)\);/, 'the view is not read from the address once');
  assert.match(panel, /u\.searchParams\.set\('view', v\);\s*window\.history\.replaceState\(/, 'a switch of view is not written back');
});

// ---- Your sources ----------------------------------------------------------------------------------------------------

test('Your sources is ONE list of every kind, the most used first, the switched-off ones folded away', () => {
  // Providers listed built-ins, MangaDex, sites and only the extension sources registered; Extensions the packages. One
  // answer now lists every source. Reintroduce a filter by kind (`on.filter((s) => s.kind !== 'extension')`, Providers'
  // registered-only list): "the list is not every source, the most used first" fails; show the switched-off ones in the
  // list: the same assertion, then "a switched-off source is in the list", does.
  const html = renderToStaticMarkup(createElement(YourSources, {
    overview: OVERVIEW, failed: false, evidence: new Map(), onRetry: noop, onOpen: noop, onChanged: later, onAdd: noop,
  }));
  const list = slice(html, 'data-sources-list', '</ul>');
  const rows = [...list.matchAll(/data-sources-row="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['mangaread', 'natomanga', 'sw:2001', 'mangadex', 'sw:1533', 'pack:one'], 'the list is not every source, the most used first');
  const kinds = new Set([...list.matchAll(/data-source-kind="([a-z]+)"/g)].map((m) => m[1]));
  assert.ok(kinds.has('extension'), 'an extension\'s source is not in the one list');
  for (const k of ['builtin', 'mangadex', 'pack']) assert.ok(kinds.has(k), `a ${k} source is not in the one list`);
  assert.ok(!rows.includes('aqua') && !rows.includes('sw:3001'), 'a switched-off source is in the list');
  // The fold: closed, its count beside its name.
  const fold = slice(html, 'data-sources-fold="off"', '</section>');
  assert.match(fold, /aria-expanded="false"/, 'the fold opens by itself');
  assert.match(fold, />Switched off<span[^>]*>2<\/span>/, 'the fold does not count what it holds');
  assert.deepEqual(splitSources(OVERVIEW.sources).off.map((s) => s.id), ['aqua', 'sw:3001']);
  // One line a row: its state in a word, how many series use it, its language -- and the kind as a squared tag.
  const row = slice(list, 'data-sources-row="mangaread"', '</li>');
  assert.match(row, /data-source-line="true"><span class="text-emerald-300">Healthy<\/span><span> · <bdi>128 series<\/bdi><\/span><span> · <bdi>English<\/bdi><\/span>/,
    'a row says more, or less, than its one line');
  assert.match(row, /data-source-kind="builtin">Built-in</);
  assert.match(slice(list, 'data-sources-row="sw:1533"', '</li>'), /<span class="text-amber-300">Failing<\/span> — Search step<span> · <bdi>not used<\/bdi>/,
    'a failing source does not say so, and at which step');
});

test('the list leads with the sources your series use, the most used first, then the rest by name', () => {
  // The server's order leads with what needs a look (attention first), and Needs attention already shows those: the
  // failing sources nothing uses topped Your sources a second time, above the sources the library reads from. The web
  // sorts the list for finding a source; the server's order stays Needs attention's. Reintroduce the server's order
  // (`list.filter(...)` as it comes): "a failing source nothing uses is repeated at the top" fails.
  const order = (sources: OverviewSource[]) => { const { on, off } = splitSources(sources); return [on.map((s) => s.id), off.map((s) => s.id)]; };
  const [on, off] = order([
    src('zz-unused', { name: 'Zeta' }),
    src('sw:1533', { name: 'Hentai Shelf (AR)', standing: 'failing', state: 'failing' }),
    src('b-used', { name: 'Beta', main: 1, followed: 1 }),
    src('a-most', { name: 'Alpha', main: 120, followed: 5 }),
    src('c-tie', { name: 'Gamma', main: 3 }),
    src('d-tie', { name: 'Delta', followed: 3 }),
    src('a-unused', { name: 'alpha two' }),
    src('off-used', { name: 'Off Used', standing: 'off', state: 'off', main: 4 }),
    src('off-more', { name: 'Off More', standing: 'off', state: 'off', main: 195 }),
    src('off-none', { name: 'A Off', standing: 'off', state: 'off' }),
  ]);
  assert.equal(on[0], 'a-most', 'a failing source nothing uses is repeated at the top');
  assert.deepEqual(on, ['a-most', 'd-tie', 'c-tie', 'b-used', 'a-unused', 'sw:1533', 'zz-unused'],
    'not the most used first (main and followed together), then the rest by name, whatever their state');
  assert.deepEqual(off, ['off-more', 'off-used', 'off-none'], 'the switched-off fold is not in the same order');
  // The panel draws that order, and the count on its tab is of the sources switched on.
  assert.match(code('components/SourcesPanel.tsx'), /const \{ on, off \} = splitSources\(overview\.sources\);/);
});

test('a row offers at most one key -- Turn on, for a source switched off that series use -- else a chevron', () => {
  // Providers gave every card two to five keys. Reintroduce Turn on for every switched-off source: "a source nothing
  // uses offers Turn on" fails; offer it beside Replace: "a source Needs attention replaces offers Turn on" does.
  const a = OVERVIEW.attention;
  assert.equal(rowAction(src('x', { standing: 'off', state: 'off', offBy: 'admin', followed: 2 }), a), 'turn-on');
  assert.equal(rowAction(src('x', { standing: 'off', state: 'off', offBy: 'admin' }), a), null, 'a source nothing uses offers Turn on');
  assert.equal(rowAction(AQUA, a), null, 'a source Needs attention replaces offers Turn on');
  assert.equal(rowAction(src('x', { main: 9 }), a), null, 'a working source offers a key');
  const row = slice(code('components/SourcesPanel.tsx'), 'function SourceRow(', 'function AddSources(');
  assert.match(row, /\{!action && <IcChevronRight /, 'a row with a key keeps its chevron');
  assert.equal((row.match(/<button\b/g) ?? []).length, 2, 'a row has a key besides its opener and Turn on');
  // The accent without its fill: filled is for Replace, Start and Connect.
  assert.match(row, /className=\{`btn-key btn-key-accent relative \$\{busyKey\(busy\)\}`\} data-sources-turn-on=\{s\.id\}>/);
});

// ---- Needs attention ------------------------------------------------------------------------------------------------

test('Needs attention shows only when something needs someone, a row each, Replace the one filled key', () => {
  // Reintroduce the section for everyone (`{overview && (`): "Needs attention is drawn with nothing in it" fails;
  // needsAttention answering true: the lib assertions do.
  const none = { replace: [], failingUnused: [], updates: 0 };
  assert.equal(needsAttention(none), false, 'Needs attention is drawn with nothing in it');
  assert.equal(needsAttention(undefined), false);
  assert.equal(needsAttention({ ...none, replace: ['aqua'] }), true);
  assert.equal(needsAttention({ ...none, failingUnused: ['x'] }), true);
  assert.equal(needsAttention({ ...none, updates: 2 }), true);
  assert.equal(attentionRows(OVERVIEW.attention), 3, 'one row per source to replace, one for the failing, one for the updates');
  assert.equal(attentionRows({ replace: ['a', 'b'], failingUnused: ['c', 'd', 'e'], updates: 4 }), 4);
  const panel = slice(code('components/SourcesPanel.tsx'), 'export function SourcesPanel(', 'function AttentionRow(');
  assert.match(panel, /\{overview && needsAttention\(overview\.attention\) && \(\s*<Attention /, 'Needs attention is drawn with nothing in it');
  // aqua's row: why, how many series it is the main source of, how many already have a working backup.
  assert.deepEqual(replaceLine(AQUA, '2026-09-23T08:00:00Z'), ['Offline since Sep 23', 'main source of 195 series', '184 already have a working backup']);
  assert.deepEqual(replaceLine({ ...AQUA, offline: false, withBackup: 0 }), ['Turned off', 'main source of 195 series']);
  assert.deepEqual(replaceLine({ ...AQUA, offline: false, standing: 'failing', state: 'failing', main: 1, withBackup: 1 }), ['Failing', 'main source of 1 series', '1 already has a working backup']);
  const installed = [{ pkgName: 'pkg.asura', name: 'Asura Scans', hasUpdate: true, sources: [], on: 0, used: 47 }] as never;
  const html = renderToStaticMarkup(createElement(Attention, {
    overview: OVERVIEW, evidence: new Map(), installed, actions: ACTIONS, onOpen: noop, onReplace: noop, onChanged: later,
  }));
  assert.match(html, />Needs attention<span[^>]*>3<\/span>/);
  const replace = slice(html, 'data-sources-attention-row="replace"', '</li>');
  assert.match(replace, /<bdi dir="auto">Aqua Manga<\/bdi>/);
  assert.match(replace, /Site offline<\/span><span> · main source of 195 series<\/span><span> · 184 already have a working backup<\/span>/);
  assert.match(replace, /<button type="button" class="btn-key btn-key-primary" data-sources-replace="aqua">Replace<\/button>/, 'Replace is not the row\'s filled key');
  assert.equal((html.match(/btn-key-primary/g) ?? []).length, 1, 'Needs attention has a filled key besides Replace');
  assert.match(slice(html, 'data-sources-attention-row="failing-unused"', '</li>'), /1 source nothing uses is failing[\s\S]*data-source-bulk-off="true">Turn off</);
  assert.match(slice(html, 'data-sources-attention-row="updates"', '</li>'), /1 extension has an update[\s\S]*data-ext-update="true"[^>]*>Update</);
});

test('Turn off all asks first, inside its row, then switches each off through retire, one at a time', () => {
  // v0.53.0's Health did it through each source's own Turn off; the retire route refuses a source that became some
  // series' main source meanwhile. Reintroduce the row's key running at once (`onClick={() => void run()}`): "Turn off
  // all switches off without asking" fails; the old /disable: "not through retire" does.
  const row = slice(code('components/SourcesPanel.tsx'), 'function TurnOffAll(', 'function ViewTabs(');
  assert.match(row, /onClick=\{\(\) => setAsking\(!asking\)\} aria-expanded=\{asking\}[^>]*data-source-bulk-off>/, 'Turn off all switches off without asking');
  assert.match(row, /\{asking && \(\s*<div role="group" [^>]*data-source-bulk-confirm/, 'the question is not asked in the row');
  assert.match(row, /<p [^>]*>\{turnOffQuestion\(n\)\}<\/p>/, 'the question does not say what it does');
  assert.match(row, /<button type="button" autoFocus onClick=\{\(\) => setAsking\(false\)\} className="btn-key" data-source-bulk-cancel>/, 'a second Enter switches them off');
  assert.match(row, /onClick=\{\(\) => \{ void run\(\); \}\} className="btn-key btn-key-danger" data-source-bulk-go>/);
  assert.match(row, /await turnOffEach\(ids,\s*\(id\) => api\(`\/api\/admin\/sources\/\$\{encodeURIComponent\(id\)\}\/retire`, \{ json: \{ how: 'off' \} \}\),/, 'not through retire');
  assert.doesNotMatch(row, /\/disable`|Promise\.all/, 'not through retire, one at a time');
});

// ---- Replace -----------------------------------------------------------------------------------------------------

const PREVIEW: ReplacePreview = { main: 195, withBackup: 184, toSearch: 9, postingOrder: 2, busy: false };
const FR = (over: Partial<FindRunApi> = {}): FindRunApi => ({ status: undefined, slots: {}, start: async () => ({}) as never, stop: later, runOf: () => null, ...over });

test('Replace says what it will do in the preview\'s numbers, before anything moves', () => {
  // The numbers are the server's, worked out before Start (GET …/replace-preview). Reintroduce the plan from the
  // overview's row (`main - withBackup` searched for, posting order forgotten): "the other 9" reads "the other 11".
  assert.deepEqual(replacePlan(PREVIEW, 'Aqua Manga', true), [
    '184 already follow a working source: it becomes their main source.',
    'The other 9 are searched for on your other sources.',
    '2 numbered by posting order stay as they are.',
    '⁨Aqua Manga⁩ is turned off once nothing uses it.',
  ], 'the plan says other numbers than the preview\'s');
  assert.deepEqual(replacePlan({ ...PREVIEW, withBackup: 0, postingOrder: 0, toSearch: 1 }, 'X', false), ['It is searched for on your other sources.'], 'Turn it off when done is off and still said');
  assert.deepEqual(replacePlan({ ...PREVIEW, withBackup: 1, toSearch: 0, postingOrder: 1 }, 'X', false), [
    '1 already follows a working source: it becomes its main source.', '1 numbered by posting order stays as it is.',
  ]);
  const html = withQueries(createElement(ReplaceDialog, { sourceId: 'aqua', name: 'Aqua Manga', fr: FR(), slot: 'replace:aqua', onClose: noop }),
    [[['replace-preview', 'aqua'], PREVIEW]]);
  assert.match(html, /data-replace-phase="ask"/);
  assert.match(html, /Replace Aqua Manga/);
  assert.match(html, /data-replace-main="195">195 series use it as their main source</);
  const lines = [...slice(html, 'data-replace-plan', '</ol>').matchAll(/<span class="min-w-0">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(lines, replacePlan(PREVIEW, 'Aqua Manga', true), 'the dialog says something other than the preview\'s plan');
  // Turn it off when done, on; review, off; Start the filled key, ready.
  const box = (hook: string) => [...html.matchAll(/<input [^>]*\/>/g)].map((m) => m[0]).find((t) => t.includes(hook)) ?? '';
  assert.match(box('data-replace-turnoff'), /\bchecked=""/, 'Turn it off when done is not on by default');
  assert.doesNotMatch(box('data-replace-review'), /\bchecked=""/, 'review first is on by default');
  assert.match(html, /<button type="button" class="btn-key btn-key-primary" data-replace-start="true">Start<\/button>/, 'Start is not ready');
  // Start: the replace run, with Turn it off when done -- or review first, which turns nothing off (the server refuses
  // the two together).
  const ask = slice(code('components/ReplaceDialog.tsx'), 'function AskView(', 'function RunView(');
  assert.match(ask, /void fr\.start\(slot, \{ sourceId, mode: 'replace', \.\.\.\(review \? \{ review: true \} : \{ turnOff \}\) \}\);/, 'Start does not start the replace run');
  assert.match(ask, /const lines = p \? replacePlan\(p, name, turnOff && !review\) : \[\];/, 'the plan does not follow the choices');
  // Another run holds the server: Start waits, and says why.
  const busy = withQueries(createElement(ReplaceDialog, { sourceId: 'aqua', name: 'Aqua Manga', fr: FR(), slot: 's', onClose: noop }),
    [[['replace-preview', 'aqua'], { ...PREVIEW, busy: true }]]);
  assert.match(busy, /data-replace-busy="true"/, 'a busy server is not said');
  assert.match(busy, /<button type="button" disabled="" class="btn-key btn-key-primary" data-replace-start="true">/, 'Start can be pressed while another run holds the server');
});

test('the run says how far it has got, three counts, and each series as it lands, "from → to" or why', () => {
  // Reintroduce the run as Find other sources shows it (followed counts, no `promoted`): the counts read 0, 0, 0.
  const run: FindRun = {
    id: 'r1', status: 'running', total: 195, done: 3, followed: 1, startedBy: null, startedAt: Date.now(), mode: 'replace', promoted: 2,
    current: { seriesId: 's4', title: 'Solo Leveling' },
    results: [
      { seriesId: 's1', title: 'One Piece', followed: [], promoted: { from: 'aqua', fromName: 'Aqua Manga', to: 'mangaread', toName: 'Mangaread', via: 'follower', old: 'dropped' } },
      { seriesId: 's2', title: 'Two', followed: [{ sourceId: 'natomanga', name: 'Natomanga', chapters: 40 }], promoted: { from: 'aqua', fromName: 'Aqua Manga', to: 'natomanga', toName: 'Natomanga', via: 'search', old: 'dropped' } },
      { seriesId: 's3', title: 'Three', followed: [], why: 'no_match' },
    ],
  };
  const html = withQueries(createElement(ReplaceDialog, { sourceId: 'aqua', name: 'Aqua Manga', fr: FR({ runOf: () => run }), slot: 'replace:aqua', onClose: noop }));
  assert.match(html, /data-replace-phase="run"/);
  assert.match(html, /data-replace-progress="true"><span>3 of 195 series<\/span>/, 'the run does not say how far it has got');
  assert.match(html, /<bdi dir="auto" class="[^"]*">Solo Leveling<\/bdi>/, 'the run does not say the series it is on');
  const counts = Object.fromEntries([...html.matchAll(/data-replace-count="([a-z]+)"><dt[^>]*>[^<]*<\/dt><dd[^>]*>(\d+)<\/dd>/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(counts, { moved: 1, found: 1, none: 1 }, 'the three counts are not the run\'s');
  // Newest first: each row its title, then "from → to" (read out as a sentence), or why.
  const rows = [...html.matchAll(/data-replace-row="([^"]+)" data-replace-row-state="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [['s3', 'no_match'], ['s2', 'search'], ['s1', 'follower']]);
  assert.match(slice(html, 'data-replace-row="s1"', '</li>'), /From ⁨Aqua Manga⁩ to ⁨Mangaread⁩[\s\S]*<bdi class="min-w-0 truncate">Aqua Manga<\/bdi><span class="inline-block shrink-0 rtl:-scale-x-100">→<\/span>/);
  assert.match(slice(html, 'data-replace-row="s3"', '</li>'), /No other source lists it under its title or other names/, 'a series with no replacement does not say why');
  // Stop, and Run in background; the list scrolls inside the dialog, not the page behind it.
  assert.match(html, /data-replace-stop="true">Stop</);
  assert.match(html, /data-replace-background="true">Run in background</);
  assert.match(html, /data-lenis-prevent="true" data-replace-rows="true"/, 'the rows scroll the page behind the dialog');
});

test('Replace opened again while its source\'s run goes shows that run, wherever it is opened from', () => {
  // The server names a run's source in its summary and on its card (bff lib/findSources.ts namedSource). A dialog with
  // no run of its own -- Health's other row, the page reloaded, Run in background and back -- finds the run going for its
  // source by it, and shows it rather than the offer to start one. Reintroduce by matching any Replace run: Mangaread's
  // dialog shows aqua's run. By dropping the match: aqua's dialog asks again.
  const run: FindRun = {
    id: 'r9', status: 'running', total: 195, done: 12, followed: 0, startedBy: null, startedAt: Date.now(), mode: 'replace', promoted: 12,
    sourceId: 'aqua', sourceName: 'Aqua Manga', results: [],
  };
  const open = (fr: FindRunApi, sourceId: string) => withQueries(
    createElement(ReplaceDialog, { sourceId, name: sourceId, fr, slot: `health:${sourceId}`, onClose: noop }), [[['replace-preview', sourceId], PREVIEW]]);
  const going = FR({ status: { running: true, run, recent: [run] } });
  const again = open(going, 'aqua');
  assert.match(again, /data-replace-phase="run"/, 'Replace opened again offers to start a second run for the source');
  assert.match(again, /data-replace-progress="true"><span>12 of 195 series<\/span>/, 'and does not show how far its run has got');
  assert.match(open(going, 'mangaread'), /data-replace-phase="ask"/, 'another source\'s Replace shows this source\'s run');
  // A Find run over the same source is not its Replace: the dialog asks, and says another run holds the server.
  const find = open(FR({ status: { running: true, run: { ...run, mode: undefined }, recent: [] } }), 'aqua');
  assert.match(find, /data-replace-phase="ask"/, 'a Find run reads as the source\'s Replace run');
  assert.match(find, /data-replace-busy="true"/, 'and Start does not say why it waits');
});

// ---- the sheet -----------------------------------------------------------------------------------------------------

test('the sheet\'s keys by state and kind: Replace only for a dead main source, Remove only for a site', () => {
  // Reintroduce Replace for any source that is not working (drop `s.main > 0`): "a source nothing uses offers Replace"
  // fails; Remove for every kind: "a working built-in offers a key it has no use for" does; Test for a source its
  // extension switched off (it is not loaded, and its Test would only say so): "an unloaded source offers Test" does.
  const a = OVERVIEW.attention;
  assert.deepEqual(sheetKeys(AQUA, a), ['replace', 'test', 'turn-on', 'remove']);
  assert.deepEqual(sheetKeys(src('mangaread', { main: 125 }), a), ['test', 'turn-off'], 'a working built-in offers a key it has no use for (Replace, Remove)');
  assert.deepEqual(sheetKeys(src('x', { standing: 'failing', state: 'failing' }), a), ['test', 'turn-off'], 'a source nothing uses offers Replace');
  assert.deepEqual(sheetKeys(src('x', { standing: 'failing', state: 'failing', main: 3 }), a), ['replace', 'test', 'turn-off']);
  assert.deepEqual(sheetKeys(src('n', { standing: 'cooling', state: 'blocked', main: 123 }), a), ['test', 'unblock', 'turn-off'], 'a cooldown offers Replace, or no Clear block');
  assert.deepEqual(sheetKeys(src('sw:3001', { kind: 'extension', standing: 'off', offBy: 'language', state: 'off' }), a), ['turn-on'], 'an unloaded source offers Test');
  assert.deepEqual(sheetKeys(src('sw:9', { kind: 'extension', standing: 'not_loaded', state: 'ok', main: 2 }), a), ['replace'], 'an unloaded source offers Test');
  assert.deepEqual(sheetKeys(src('site', { kind: 'site' }), a), ['test', 'turn-off', 'remove']);
  assert.ok(!sheetKeys(src('b'), a).includes('remove'), 'a built-in offers Remove');
  // A source Needs attention replaces is replaced from its sheet too, whatever its standing says.
  assert.deepEqual(sheetKeys(src('q', { main: 5 }), { replace: ['q'] }), ['replace', 'test', 'turn-off']);
  // Drawn: aqua's sheet leads with Replace, filled, says Offline and offers Remove in its footer; Turn off is not offered.
  const sheet = (target: { id: string }, s = OVERVIEW) => withQueries(createElement(SourceSheet, {
    target, overview: s, evidence: new Map(), testMs: 53_000, status: undefined, actions: ACTIONS, installed: [], hiddenLangs: [],
    onClose: noop, onReplace: noop, onLanguages: noop, onChanged: noop,
  }));
  const html = sheet({ id: 'aqua' });
  const keys = [...slice(html, 'data-source-keys', '</div>').matchAll(/data-source-key="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['replace', 'test', 'turn-on'], 'the sheet draws other keys than sheetKeys says');
  assert.match(html, /class="btn-key btn-key-primary tabular-nums[^"]*"[^>]*>Replace</, 'Replace is not the filled key');
  assert.match(html, /data-source-key="remove"[^>]*>Remove</, 'a site has no Remove');
  assert.match(html, /data-source-status="off"/);
  assert.match(html, />Site offline</, 'the sheet does not say the site is offline');
  // (next/link drops the address's trailing slash outside the app, whose export keeps it.)
  assert.match(slice(html, 'data-source-used', '</a>'), /href="\/library\/?\?src=aqua"><span[^>]*>Used by 195 series<\/span>/, '"Used by" does not open the Library on its main source');
  assert.match(html, /data-source-address="true"[\s\S]*https:\/\/aquamanga\.org[\s\S]*Update address/, 'a site\'s address is not in its sheet');
  const fine = sheet({ id: 'mangaread' });
  assert.deepEqual([...slice(fine, 'data-source-keys', '</div>').matchAll(/data-source-key="([a-z-]+)"/g)].map((m) => m[1]), ['test', 'turn-off']);
  assert.doesNotMatch(fine, /data-source-key="remove"|data-source-address/, 'a built-in offers what only a site has');
});

test('Turn off asks first inside the sheet when series use the source, with words that are true', () => {
  // A ConfirmDialog is z-50 under the sheet's z-60. Reintroduce the bare `void turnOff()` for every source: series stop
  // updating unasked, and this fails. The words are true since v0.54.0, when a switched-off source stopped being asked
  // by the sweep too.
  const sheet = code('components/SourceSheet.tsx');
  assert.match(sheet, /key\('turn-off', tr\('Turn off'\), \(\) => \(used > 0 \? setAsking\('turn-off'\) : void turnOff\(\)\), 'btn-key btn-key-danger'\)/, 'series stop updating unasked');
  assert.match(sheet, /\{asking === 'turn-off' && \(\s*<div role="alertdialog" [^>]*data-source-off-confirm>/);
  assert.doesNotMatch(sheet, /<ConfirmDialog\b|<Modal\b/, 'the sheet asks in a dialog it would cover');
  assert.equal(turnOffQuestion({ main: 1, followed: 0 }), '1 series uses it. It stops getting new chapters from this source until you turn it back on. Nothing is deleted.');
  assert.equal(turnOffQuestion({ main: 120, followed: 5 }), '125 series use it. They stop getting new chapters from this source until you turn it back on. Nothing is deleted.');
  // Remove is a site's, through retire: a source some series still use as their main source is refused, in words.
  assert.match(sheet, /await api\(`\/api\/admin\/sources\/\$\{encodeURIComponent\(s\.id\)\}\/retire`, \{ json: \{ how: 'remove' \} \}\);/);
  assert.match(sheet, /setRefusal\(\{ key, text: msgOf\(e, tr\('Could not save that'\)\) \}\);/, 'a refused Remove is not said in the server\'s words');
});

test('"in use" has one wording, the server\'s: a refused Remove says retire.inUse in the reader\'s language', () => {
  // The retire route's 409 (bff routes/admin.ts inUse) carries its code, `retire.inUse`, and the sheet words it as it
  // words every refusal with a code (msgOf, lib/said.ts). Reintroduce the sheet's own sentence for it (the lane's
  // retireRefusal, "It is still the main source of 3 series. Replace it first."): "the web says in use in words of its
  // own" names the file.
  const err = { status: 409, body: JSON.stringify({ error: 'in_use', main: 3, message: 'It is the main source of 3 series. Replace it first.', messageSaid: { code: 'retire.inUse', params: { n: 3 } } }) };
  assert.equal(msgOf(err, 'fallback'), 'It is the main source of 3 series. Replace it first.');
  const de = JSON.parse(readFileSync(join(ROOT, 'public/locales/de.json'), 'utf8')) as Record<string, string>;
  try {
    setActiveDict(de);
    assert.equal(msgOf(err, 'fallback'), de['It is the main source of {n} series. Replace it first.'].replace('{n}', '3'),
      'a refused Remove is said in the server\'s English, not the reader\'s language');
  } finally {
    setActiveDict({});
  }
  // No second sentence for the same refusal anywhere in the web: lib/said.ts holds the server's words for it.
  const dirs = ['components', 'lib', 'app/admin'];
  const own = dirs.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${d}/${f}`))
    .filter((f) => f !== 'lib/said.ts' && /Replace it first/.test(code(f)));
  assert.deepEqual(own, [], 'the web says in use in words of its own');
});

// ---- Make main -----------------------------------------------------------------------------------------------------

const ss = (sourceId: string, over: Partial<SeriesSource> = {}): SeriesSource =>
  ({ sourceId, name: sourceId, primary: false, registered: true, ...over }) as SeriesSource;

test('Make main is offered on a follower that works, asks first in one line, and says each refusal in the reader\'s words', () => {
  // Reintroduce Make main on every follower (`!s.primary` alone): "a failing follower offers Make main" fails; the
  // question without what becomes of the old main: "the question does not say" does; the refusal's English
  // (`e.message`): "a refusal is said in the server's English" does.
  assert.equal(mayMakeMain(ss('a', { standing: 'usable' })), true);
  assert.equal(mayMakeMain(ss('a', { standing: 'cooling' })), true, 'a follower cooling down for a while offers nothing');
  assert.equal(mayMakeMain(ss('a', { standing: 'failing' })), false, 'a failing follower offers Make main');
  assert.equal(mayMakeMain(ss('a', { standing: 'off' })), false);
  assert.equal(mayMakeMain(ss('a', { standing: 'usable', primary: true })), false, 'the main source offers Make main');
  assert.equal(mayMakeMain(ss('a', { standing: 'usable', registered: false })), false);
  assert.equal(mayMakeMain(ss('a')), false, 'an older server, with no standing, offers what it cannot do');
  const mr = ss('mangaread', { name: 'Mangaread', standing: 'usable' });
  assert.equal(makeMainQuestion(mr, ss('aqua', { name: 'Aqua Manga', standing: 'off' })), 'Make ⁨Mangaread⁩ this series’ main source? ⁨Aqua Manga⁩ is dropped.', 'the question does not say');
  assert.equal(makeMainQuestion(mr, ss('nato', { name: 'Natomanga', standing: 'cooling' })), 'Make ⁨Mangaread⁩ this series’ main source? ⁨Natomanga⁩ is kept as a backup.');
  assert.equal(makeMainQuestion(mr, null), 'Make ⁨Mangaread⁩ this series’ main source?');
  // Drawn: asked in one line under the row, inside the sheet, Cancel taking the focus; a refusal under it.
  const props = { question: 'Q?', busy: false, refusal: null, asking: false, onAsk: noop, onCancel: noop, onConfirm: noop };
  const key = renderToStaticMarkup(createElement(SeriesSourceRow, { s: mr, makeMain: props }));
  assert.match(key, /<button type="button" class="btn-key shrink-0" data-make-main="mangaread">Make main<\/button>/);
  const asking = renderToStaticMarkup(createElement(SeriesSourceRow, { s: mr, makeMain: { ...props, asking: true } }));
  assert.doesNotMatch(asking, /data-make-main="mangaread"/, 'the key stays beside its own question');
  assert.match(asking, /role="alertdialog" aria-label="Q\?"[^>]*data-make-main-confirm="mangaread"><p[^>]*>Q\?<\/p>[\s\S]*data-make-main-yes="true">Make main</);
  const refused = renderToStaticMarkup(createElement(SeriesSourceRow, { s: mr, makeMain: { ...props, refusal: 'Because.' } }));
  assert.match(refused, /<p role="alert" [^>]*data-make-main-refusal="true">Because\.<\/p>/, 'a refusal is not said under its row');
  // The refusal: by its said code, in the reader's words -- here the one a series being checked answers (`busy`).
  const err = { status: 409, body: JSON.stringify({ error: 'busy', message: 'English', messageSaid: { code: 'renumber.checking' } }) };
  assert.equal(msgOf(err, 'fallback'), 'This series is being checked right now. Try again when that ends.', 'a refusal is said in the server\'s English');
  const sheet = slice(code('components/SourcesSheet.tsx'), 'const makeMain = async (s: SeriesSource) => {', 'const [unfollowing, setUnfollowing]');
  assert.match(sheet, /await api\(`\/api\/admin\/series\/\$\{encodeURIComponent\(id\)\}\/main-source`, \{ json: \{ sourceId: s\.sourceId \} \}\);/);
  assert.match(sheet, /setRefused\(\{ id: s\.sourceId, why: msgOf\(e, tr\('Could not change the main source'\)\) \}\);/, 'a refusal is said in the server\'s English');
  assert.match(code('components/SourcesSheet.tsx'), /makeMain=\{adminAccount && mayMakeMain\(s\) \? \{/, 'Make main is offered where mayMakeMain says no');
});
