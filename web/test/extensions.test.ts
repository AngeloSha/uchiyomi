// Admin → Extensions, redesigned (v0.53.0): the rules in lib/extensions.ts, and the shape of the tab that each answers.
//
// Discussion #121 is a real user on a 1,300-extension repository: the catalogue stopped at "Showing 400 of 570 matches
// -- narrow the search" and MangaFire could not be reached; "18+" read as a filter to adult extensions only; an
// extension's language select looked like it chose the language; "12 extensions" read as many more (sources); and
// extensions installed in the engine's own page stayed off with no way on but Remove and Add again. Each test names
// the edit that brings its fault back.
//
// Round 2 (the owner: "still too cluttered") is the second half of this file: a row with one state word and one key,
// no bars, groups only while something needs attention, Browse without its two chips and with its repositories in
// the count line, Settings closed, a language row with a line only for a problem, and a strip that says nothing more
// than its marks when all is well.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setActiveLocale } from '../lib/format';
import { Facts } from '../components/ExtensionBits';
import {
  BROWSE_PAGE, LOCAL_SOURCE_LANG, NO_FILTERS, browseCount, catalogQuery, engineLine, engineMeta, extLanguageName, extLanguagesText, helperLine,
  initialView, installedGroups, installedList, languageOptions, languageProblem, languagesOnText, nearSourceLimit, needsAttention, needsTurningOn,
  nextOffset, overLimitText, reasonLine, rowKey, rowWord, sourceHealth, sourcesOnText, versionText,
  type CatalogExt, type ExtSource,
} from '../lib/extensions';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

const ext = (pkgName: string, over: Partial<CatalogExt> = {}): CatalogExt => ({
  pkgName, name: pkgName, lang: 'en', versionName: '1.0', iconUrl: null, installed: true, hasUpdate: false, obsolete: false, nsfw: false, ...over,
});
const src = (id: string, pkgName: string | null, lang: string | null, enabled: boolean, used = 0): ExtSource => ({ id, name: id, lang, nsfw: false, enabled, pkgName, used });

setActiveLocale('en');

test('the installed list joins each extension to its sources, and leads with what waits', () => {
  const list = installedList([
    ext('zeta'), ext('alpha', { lang: 'all' }), ext('mid', { hasUpdate: true }), ext('none'), ext('browse-only', { installed: false }), ext('quiet'),
  ], [
    src('a-es', 'alpha', 'es', false, 2), src('a-en', 'alpha', 'en', true, 3), src('a-ja', 'alpha', 'ja', false),
    src('z', 'zeta', 'en', true), src('m', 'mid', 'en', true, 1), src('q', 'quiet', 'en', false),
    // The engine's built-in Local source rides along with the installed extensions' sources; it is nobody's language.
    src('0', 'eu.kanade.tachiyomi.source.local', LOCAL_SOURCE_LANG, false),
  ]);
  // Reintroduce `.sort((a, b) => a.name.localeCompare(b.name))` alone: the update and the extension with no source on
  // sink into the alphabet, and this fails.
  assert.deepEqual(list.map((e) => e.pkgName), ['mid', 'quiet', 'alpha', 'none', 'zeta'], 'an update first, then nothing on, then by name');
  const alpha = list.find((e) => e.pkgName === 'alpha')!;
  assert.deepEqual(alpha.sources.map((s) => s.id), ['a-en', 'a-ja', 'a-es'], 'its languages by name: English, Japanese, Spanish');
  assert.equal(alpha.on, 1);
  assert.equal(alpha.used, 5, 'the series from every one of its languages');
  assert.ok(!list.some((e) => e.pkgName === 'browse-only'), 'an extension that is not installed is listed');
  assert.ok(!list.some((e) => e.sources.some((s) => s.lang === LOCAL_SOURCE_LANG)), 'the Local source is listed as a language');
  // An extension the engine lists with no source keeps its row (its sheet says so), and is not one to turn on.
  const none = list.find((e) => e.pkgName === 'none')!;
  assert.deepEqual(none.sources, []);
  assert.equal(needsTurningOn(none), false);
  // Installed in the engine's own page: sources, none of them on. Reintroduce `e.on === 0` alone: an extension with no
  // source at all offers a "Turn on" that turns nothing on.
  assert.equal(needsTurningOn(list.find((e) => e.pkgName === 'quiet')!), true, 'an extension with every source off offers nothing');
  assert.equal(needsTurningOn(alpha), false);
});

test('Browse asks for a page at a time, and every page after it until the last', () => {
  // Reintroduce the old catalogue call (no offset, the first 400): "narrow the search" was the only way past them.
  assert.equal(catalogQuery(NO_FILTERS, 0), `offset=0&limit=${BROWSE_PAGE}`);
  assert.equal(catalogQuery({ q: ' Ember ', lang: 'es-419', installed: true, updates: true, adult: true }, 120, 60),
    'q=Ember&lang=es-419&installed=true&updates=true&nsfw=true&offset=120&limit=60');
  assert.equal(catalogQuery({ ...NO_FILTERS, lang: 'all' }, 0), `lang=all&offset=0&limit=${BROWSE_PAGE}`, 'the multi-language extensions are a filter of their own');
  // Walk a 1,118-extension catalogue: every page is asked for, and the walk ends.
  const seen: number[] = [];
  let at: number | undefined = 0;
  while (at !== undefined) {
    seen.push(at);
    const shown = Math.min(BROWSE_PAGE, 1118 - at);
    at = nextOffset({ offset: at, shown, matched: 1118 });
  }
  assert.equal(seen.length, Math.ceil(1118 / BROWSE_PAGE), 'a page is skipped or asked twice');
  assert.equal(seen.at(-1), Math.floor(1117 / BROWSE_PAGE) * BROWSE_PAGE, 'the last page is not reached');
  // An older server answers no offset and every match at once: that is the end, not a loop.
  assert.equal(nextOffset({ shown: 400, matched: 570 }), undefined);
  assert.equal(nextOffset({ offset: 600, shown: 0, matched: 1118 }), undefined, 'an empty page asks for another');
});

test('the language filter names languages, the multi-language extensions first, and never the Local source', () => {
  const opts = languageOptions(['ja', 'all', 'es-419', LOCAL_SOURCE_LANG, 'en']);
  assert.deepEqual(opts.map((o) => o.value), ['', 'all', 'en', 'ja', 'es-419'], 'by name: English, Japanese, Latin American Spanish');
  assert.deepEqual(opts.map((o) => o.label), ['All languages', 'Multiple languages', 'English', 'Japanese', 'Latin American Spanish'],
    'a bare code reaches the filter');
  assert.equal(extLanguageName('all'), 'Multiple languages', '"all" reads as "All languages" on an extension');
  assert.equal(extLanguageName(null), 'No language');
});

test('the strip says the engine\'s state and the Cloudflare helper\'s, and offers one action for a helper that is not connected', () => {
  // Round 2: "Ready" beside "Extension engine", the version on the muted line under it (engineMeta).
  assert.deepEqual(engineLine({ configured: true, reachable: true, version: 'v2.3.2243' }), { state: 'ready', tone: 'ok', label: 'Ready' });
  assert.equal(engineLine({ configured: true, reachable: false }).state, 'unreachable');
  assert.equal(engineLine({ configured: false, reachable: false, off: 'switch' }).tone, 'off');
  assert.equal(engineLine({ configured: false, reachable: false, off: 'unset' }).label, 'No extension engine is set up');
  const base = { supported: true, enabled: false, connectable: true };
  // Reintroduce `action: null` for `off`: the helper says it is off with no way to connect it.
  assert.deepEqual(helperLine({ ...base, wiring: 'off' })?.action, 'connect', 'a helper that is off offers no Connect');
  assert.equal(helperLine({ ...base, wiring: 'localhost' })?.action, 'connect', 'a helper pointed at localhost offers no Connect');
  assert.equal(helperLine({ ...base, wiring: 'off', connectable: false })?.action, 'set_url', 'Connect offered with no helper of Uchiyomi\'s to share');
  assert.equal(helperLine({ ...base, wiring: 'ok', enabled: true })?.state, 'connected');
  assert.equal(helperLine({ ...base, wiring: 'ok', enabled: true })?.action, null);
  assert.equal(helperLine({ ...base, wiring: 'other', enabled: true })?.tone, 'ok', 'a helper of the engine\'s own is a fault');
  assert.equal(helperLine({ ...base, supported: false, wiring: 'unsupported' })?.tone, 'off');
  assert.equal(helperLine(undefined), null, 'an engine whose settings could not be read is said to have no helper');
});

test('counts say their unit: sources against the limit, an extension\'s languages, the extensions installed', () => {
  // #121: "I added only 12 extensions", beside a count of sources. Reintroduce a bare number for either: these fail.
  assert.equal(sourcesOnText(18, 25), '18 of 25 sources on');
  assert.equal(sourcesOnText(1300, 2000), '1,300 of 2,000 sources on', 'a count in the thousands is not grouped');
  assert.equal(languagesOnText(2, 5), '2 of 5 on');
  assert.equal(overLimitText(0, 25), '', 'a limit nothing is over is said');
  assert.equal(overLimitText(1, 25), '1 enabled source is not registered — over the limit of 25.');
  // The strip's muted line: the version and the sources on. Reintroduce the extensions installed in it: this fails.
  assert.equal(engineMeta({ version: 'v2.3.2243', enabled: 5, cap: 25 }), 'v2.3.2243 · 5 of 25 sources on', 'the strip says more than its version and the sources on');
  assert.equal(engineMeta({ version: '2.3.2243', enabled: 27, cap: 25 }), 'v2.3.2243 · 27 of 25 sources on', 'an engine that sends no "v"');
  assert.equal(engineMeta({ enabled: 0, cap: 25 }), '0 of 25 sources on', 'an engine that sends no version');
  assert.equal(versionText('v1'), 'v1');
  const tabs = slice(code(read('components/ExtensionsPanel.tsx')), 'function ExtensionLists(', 'function ViewTabs(');
  assert.match(tabs, /<ViewTabs view=\{view\} onView=\{setView\} installed=\{inst\?\.installed\} /, 'the Installed tab counts something other than the extensions installed');
});

test('the Browse tab counts what Browse lists, and follows Show 18+ extensions', () => {
  // It said "Browse 1,304" over a list that ended at "1,118 of 1,118": the tab counted the 18+ extensions the list
  // leaves out. Reintroduce `total={inst?.total}`, or drop the subtraction: these fail.
  assert.equal(browseCount({ total: 1304, adultTotal: 186 }, false), 1118, 'the tab counts the 18+ extensions Browse leaves out');
  assert.equal(browseCount({ total: 1304, adultTotal: 186 }, true), 1304, 'with Show 18+ extensions on, the tab leaves them out');
  assert.equal(browseCount({ total: 40 }, false), 40, 'an older server, which does not count them, breaks the count');
  const lists = slice(code(read('components/ExtensionsPanel.tsx')), 'function ExtensionLists(', 'function ViewTabs(');
  assert.match(lists, /<ViewTabs [^>]*total=\{inst \? browseCount\(inst, adult\) : undefined\}/, 'the Browse tab counts something other than what Browse lists');
  assert.match(lists, /const \[adult, setAdult\] = useState\(false\);/);
  assert.match(lists, /<BrowseView [^>]*adult=\{adult\} onAdult=\{setAdult\}/, 'the switch Browse shows is not the one the tab counts by');
  const browse = slice(code(read('components/ExtensionsPanel.tsx')), 'function BrowseView(', 'function NothingFound(');
  assert.match(browse, /const f = useMemo<BrowseFilters>\(\(\) => \(\{ \.\.\.narrow, adult \}\), \[narrow, adult\]\);/, 'Browse asks with a switch of its own');
});

test('a language\'s health: off, over the source limit, or what Providers says of it', () => {
  const reg = new Map([['sw:1', { status: 'ok' as const }], ['sw:3', { status: 'blocked' as const }]]);
  assert.deepEqual(sourceHealth({ id: '1', enabled: false }, reg, null), { tone: 'off', label: 'Turned off', over: false });
  assert.deepEqual(sourceHealth({ id: '1', enabled: true }, reg, null), { tone: 'ok', label: 'Healthy', over: false });
  // On, and not in the registry search reaches: SUWAYOMI_MAX_SOURCES dropped it.
  assert.deepEqual(sourceHealth({ id: '2', enabled: true }, reg, null), { tone: 'warn', label: 'Over the source limit', over: true });
  assert.equal(sourceHealth({ id: '2', enabled: true }, null, null).over, false, 'a registry still loading reads as over the limit');
  assert.equal(sourceHealth({ id: '3', enabled: true }, reg, null).label, 'Blocked by the site');
  // #115: a confirmed failure outranks the public "ok", as on the Providers card.
  assert.equal(sourceHealth({ id: '1', enabled: true }, reg, new Map([['sw:1', { failing: [{ stage: 'search' }] }]])).label, 'Failing');
});

test('the view: as asked, else Installed with something installed and Browse on a first visit', () => {
  assert.equal(initialView('browse', 4), 'browse');
  assert.equal(initialView(null, 4), 'installed');
  assert.equal(initialView(null, 0), 'browse');
  assert.equal(initialView('nonsense', undefined), null, 'a view decided before the count is known');
});

test('Browse reaches every extension: pages as it scrolls, Show more under them, and no "narrow the search"', () => {
  const panel = code(read('components/ExtensionsPanel.tsx'));
  const browse = slice(panel, 'function BrowseView(', 'function NothingFound(');
  // Reintroduce the capped list: the old "Showing {shown} of {matched} matches — narrow the search to see the rest."
  assert.doesNotMatch(panel, /narrow the search/, 'the dead end is back');
  assert.match(browse, /queryFn: \(\{ pageParam \}\) => api<CatalogPage>\(`\/api\/admin\/extensions\/catalog\?\$\{catalogQuery\(f, pageParam\)\}`\)/, 'Browse does not ask for pages');
  assert.match(browse, /getNextPageParam: \(last\) => nextOffset\(last\)/);
  assert.match(browse, /if \(seen\[0\]\.isIntersecting && hasNextPage && !isFetchingNextPage\) void fetchNextPage\(\);/, 'the next page does not load as the list ends');
  assert.match(browse, /\{hasNextPage && \(\s*<button type="button" onClick=\{\(\) => void fetchNextPage\(\)\}/, 'no Show more for anyone who gets there first');
  // Installing an extension with a source per language opens it on its languages: the next choice.
  assert.match(browse, /if \(r && r\.sources > 1\) onOpen\(e\.pkgName\);/, 'an install of a multi-language extension leaves its languages unchosen');
});

test('the 18+ control says what it does, and off hides them', () => {
  // #121: a chip reading "18+" was read as "only 18+". Reintroduce the chip: the switch's words are gone.
  const browse = slice(code(read('components/ExtensionsPanel.tsx')), 'function BrowseView(', 'function NothingFound(');
  assert.match(browse, /<Switch on=\{f\.adult\} onChange=\{onAdult\} label=\{tr\('Show 18\+ extensions'\)\} \/>\s*<span>\{tr\('Show 18\+ extensions'\)\}<\/span>/,
    'the 18+ filter is not a switch saying "Show 18+ extensions"');
  assert.doesNotMatch(browse, />\s*18\+\s*</, 'a bare "18+" control is back');
  assert.deepEqual(NO_FILTERS.adult, false, '18+ extensions are shown by default');
  // Nothing found: the 18+ extensions the search would have found are offered, by the switch's own words.
  const none = slice(code(read('components/ExtensionsPanel.tsx')), 'function NothingFound(', 'function BrowseRow(');
  assert.match(none, /\{hiddenAdult > 0 && <button type="button" onClick=\{onAdult\} className="btn-key btn-key-primary">\{tr\('Show 18\+ extensions'\)\}<\/button>\}/);
});

test('an extension installed in the engine\'s own page shows as installed, with its sources one press away', () => {
  // #121: it showed as installed and stayed off, and Remove then Add was the only way on. Reintroduce by dropping the
  // row's key (or its `enable`): the assertions name it.
  const panel = code(read('components/ExtensionsPanel.tsx'));
  const row = slice(panel, 'function InstalledRow(', 'function BrowseView(');
  assert.match(row, /\{key === 'turn-on' \? \(\s*<button type="button" onClick=\{\(\) => void act\(e, 'enable'\)\}[^>]*data-ext-turn-on>/, 'the row does not offer to turn its sources on');
  assert.match(row, /: tr\('Turn on'\)\}/, 'the row\'s key does not say it turns its sources on');
  assert.match(row, /\{tr\('No source on'\)\}/, 'the row does not say none of its sources are on');
  const view = slice(panel, 'function InstalledView(', 'function InstalledRow(');
  assert.match(view, /for \(const e of off\) await act\(e, 'enable'\);/, 'several such extensions are turned on one by one by hand');
  const actions = slice(panel, 'export function useExtensionActions(', 'export type ExtActions');
  assert.match(actions, /api<\{ sources: number; on\?: number; hidden\?: number \}>\(`\/api\/admin\/extensions\/catalog\/\$\{encodeURIComponent\(e\.pkgName\)\}`, \{ json: \{ action \} \}\)/);
  const sheet = code(read('components/ExtensionSheet.tsx'));
  assert.match(sheet, /onClick=\{\(\) => void actions\.act\(ext, 'enable'\)\}/, 'the sheet does not offer to turn its sources on');
});

test('an extension\'s languages are switches, one source each, said to be just that', () => {
  const sheet = code(read('components/ExtensionSheet.tsx'));
  // By id through the bulk route: one reload, no smoke test. Reintroduce the per-source route (`/sources/${s.id}`): a
  // switch holds for most of a minute while the site is probed, and this fails.
  assert.match(sheet, /api\('\/api\/admin\/extensions\/sources\/bulk', \{ json: \{ ids: \[s\.id\], enabled: on \} \}\)/, 'a language switch is not that one source');
  assert.doesNotMatch(sheet, /extensions\/sources\/\$\{/, 'a switch waits on the smoke test');
  assert.match(sheet, /\{tr\('Each language is its own source; turn on the ones you read\.'\)\}/, 'the sheet does not say what a language switch is');
  assert.match(sheet, /<Switch on=\{s\.enabled\} disabled=\{switching === s\.id \|\| !!busy\} label=\{extLanguageName\(s\.lang\)\}/, 'a language has no switch, or one without its name');
  // The limit is said where a switch can cross it.
  assert.match(sheet, /const across = tr\('Across all extensions: \{n\} of \{max\} sources on\.', \{ n: status\.enabled \?\? 0, max: status\.cap \?\? 0 \}\);/);
  assert.match(sheet, /data-ext-sheet-cap>\s*\{across\}/, 'the source limit is not said beside the switches');
  // Remove asks first, inside the sheet (its footer since round 2), counting what stops updating.
  assert.match(sheet, /\{!removing \? \([\s\S]{0,700}?<button type="button" onClick=\{\(\) => setRemoving\(true\)\}[^>]*data-ext-remove>/, 'Remove does not ask first');
  assert.match(sheet, /role="alertdialog" aria-label=\{tr\('Remove \{name\}\?', \{ name \}\)\}/);
  assert.doesNotMatch(sheet, /<ConfirmDialog\b|<Modal\b/, 'Remove asks in a dialog the sheet would cover');
});

test('names keep their own direction, and a phone never scrolls sideways', () => {
  const panel = code(read('components/ExtensionsPanel.tsx'));
  // An extension's name is the site's own: in an Arabic page an English name's punctuation jumped to its start.
  assert.equal((panel.match(/<bdi dir="auto" className="truncate text-sm font-medium text-fog-100">\{e\.name\}<\/bdi>/g) ?? []).length, 2, 'a row\'s name is not isolated');
  assert.match(code(read('components/ExtensionBits.tsx')), /<span dir="ltr" className="[^"]*">18\+<\/span>/, 'the 18+ tag prints "+18" in Arabic');
  // Installed is one column at every width (round 2): a two-column grid of cards made rows of uneven height, and an
  // implicit grid column grows to a truncating name. Reintroduce the grid: this fails.
  assert.match(panel, /<ul className="card grad-border divide-y divide-ink-800\/70 overflow-hidden rounded-2xl" data-ext-list-installed>/, 'Installed is not one list in one card');
  assert.doesNotMatch(panel, /grid-cols-2/, 'Installed is a grid of cards again');
  // The tab switch slides only when motion is welcome.
  assert.match(panel, /transition=\{plain \|\| still \? \{ duration: 0 \} : \{ type: 'spring', stiffness: 520, damping: 40 \}\}/, 'the tab underline moves under Reduce effects');
});

test('a repository that does not answer stays said beside the check that found it, until one answers', () => {
  // A toast lasts seconds and the repository is still down after it. Reintroduce the bare `catch { toast(...) }`: the
  // line has nothing to show, and the first assertion fails.
  const panel = code(read('components/ExtensionsPanel.tsx'));
  const refresh = slice(panel, 'const refresh = async () => {', 'return { busy, act');
  assert.match(refresh, /setRefreshError\(null\);/, 'a check that answered leaves the old failure up');
  assert.match(refresh, /catch \(err\) \{\s*setRefreshError\(reasonLine\(msgOf\(err, ''\)\)\);/, 'a repository that did not answer is said only in a toast');
  // The reason is the engine's first line, never its stack trace. Reintroduce the bare message: twelve lines of frames.
  const engine = 'suwayomi: Exception while fetching data (/extensions) : repo.example: Name or service not known java.net.UnknownHostException: repo.example: Name or service not known at suwayomi.tachidesk.graphql.queries.ExtensionQuery.extensions(ExtensionQuery.kt:1) at kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(ContinuationImpl.kt:34)';
  assert.equal(reasonLine(engine), 'suwayomi: Exception while fetching data (/extensions) : repo.example: Name or service not known java.net.UnknownHostException: repo.example: Name or service not known');
  assert.equal(reasonLine('first line\r\n\r\nat x.y(Z.kt:1)'), 'first line');
  assert.equal(reasonLine('x'.repeat(300)).length, 240);
  assert.equal(reasonLine(null), '');
  const view = slice(panel, 'function InstalledView(', 'function InstalledRow(');
  assert.match(view, /\{actions\.refreshError !== null && \(\s*<p role="alert"[^>]*data-ext-refresh-error>\s*\{tr\('Could not reach the repositories to check for updates\.'\)\}/,
    'Installed does not say the repositories could not be reached');
  // The engine's own words, in their own direction.
  assert.match(view, /<span dir="auto"[^>]*>\{actions\.refreshError\}<\/span>/);
});

test('an action is done when the lists on screen have it, so an install opens its sheet on its languages', () => {
  // walk49 at 390: the installed list came back before its sources did, and the sheet an install opens said "This
  // extension provides no source." Reintroduce the bare `refreshAll();` (not waited for) in act(): this fails.
  const panel = code(read('components/ExtensionsPanel.tsx'));
  const actions = slice(panel, 'export function useExtensionActions(', 'export type ExtActions');
  assert.match(actions, /const refreshAll = \(\) => Promise\.all\(EXT_KEYS\.map\(\(queryKey\) => qc\.invalidateQueries\(\{ queryKey: \[\.\.\.queryKey\] \}\)\)\);/,
    'refreshAll does not resolve when the lists have answered');
  const act = slice(actions, 'const act = async (', 'const updateAll = async');
  assert.match(act, /toast\(leftOff \? `\$\{said\} · \$\{leftOff\}` : said, 'success'\);\s*await refreshAll\(\);\s*return r;/,
    'an action says it is done before the lists have it');
  // Browse opens the sheet only after that.
  const browse = slice(panel, 'function BrowseView(', 'function NothingFound(');
  assert.match(browse, /const r = await actions\.act\(e, 'install'\);\s*if \(r && r\.sources > 1\) onOpen\(e\.pkgName\);/);
  // A language switch is the list's own: it stays busy until the list has the change, never flipping back meanwhile.
  const sheet = code(read('components/ExtensionSheet.tsx'));
  assert.match(sheet, /enabled: on \} \}\);[\s\S]{0,120}?await actions\.refreshAll\(\);\s*\} catch[\s\S]{0,300}?setSwitching\(null\);/,
    'a language switch flips back until the list answers');
});

// ---- round 2: decluttered ---------------------------------------------------------------------------------------

const installedOf = (over: Partial<CatalogExt>, on: boolean[]) => installedList([ext('x', over)], on.map((v, i) => src(`x${i}`, 'x', ['en', 'es', 'fr'][i], v)))[0];

test('a row offers one key and says one state word: Turn on before Update, the update said in its words', () => {
  // Round 1 gave an extension with an update and nothing on two keys (Update, Turn on its sources) and two amber
  // lines. Reintroduce `{e.hasUpdate && (` / `{off && (` keys side by side in InstalledRow, or let rowKey answer the
  // update first: these fail.
  const both = installedOf({ hasUpdate: true }, [false, false]);
  assert.equal(rowKey(both), 'turn-on', 'an extension with nothing on and an update offers Update first');
  assert.equal(rowWord(both), 'update', 'its update is not said in its meta line');
  const update = installedOf({ hasUpdate: true }, [true]);
  assert.deepEqual([rowKey(update), rowWord(update)], ['update', 'update']);
  const off = installedOf({}, [false]);
  assert.deepEqual([rowKey(off), rowWord(off)], ['turn-on', 'off']);
  const quiet = installedOf({}, [true, false]);
  assert.deepEqual([rowKey(quiet), rowWord(quiet)], [null, null], 'a row with nothing waiting offers a key or says a state');
  const row = slice(code(read('components/ExtensionsPanel.tsx')), 'function InstalledRow(', 'function RowWord(');
  assert.match(row, /const key = rowKey\(e\);\s*const word = rowWord\(e\);/, 'the row decides its key and word on its own');
  assert.match(row, /\{key === 'turn-on' \? \([\s\S]*?\) : key === 'update' \? \([\s\S]*?\) : null\}/, 'the row\'s keys are not one choice');
  assert.equal((row.match(/data-ext-turn-on\b/g) ?? []).length, 1);
  assert.equal((row.match(/data-ext-update\b/g) ?? []).length, 1);
  assert.doesNotMatch(row, /\{(e\.hasUpdate|off) && \(\s*<button/, 'a row offers a key of its own beside the other');
  assert.match(row, /\{word && <RowWord word=\{word\} \/>\}/, 'the row says its state in more than one word');
  // "No source on" is grey with a hollow ring, never amber: amber is for an update waiting.
  const words = slice(code(read('components/ExtensionsPanel.tsx')), 'function RowWord(', 'function LanguagesOn(');
  assert.match(words, /\$\{line\} text-fog-400`\} data-ext-word="off"><StatusGlyph tone="info"/, '"No source on" is said in amber');
  assert.match(words, /\$\{line\} text-amber-300`\} data-ext-word="update"><StatusGlyph tone="warn"/);
  // On a phone the word is a line of its own, with no dot left dangling at the end of the line before it.
  assert.match(words, /const line = 'inline-flex basis-full items-center gap-1 sm:basis-auto';/, 'the state word shares the meta line on a phone');
  assert.match(words, /<span aria-hidden className="hidden sm:inline">·<\/span>/);
  // The key is the accent without its fill: a column of filled keys had no hierarchy. Only Connect is filled.
  assert.match(row, /className=\{`btn-key btn-key-accent relative [^`]*`\} data-ext-turn-on>/, 'Turn on is a filled key again');
});

test('no bars: Update all and Turn on all sit in the header of the group they act on', () => {
  // Round 1 put "1 extension is out of date" and "3 of your extensions have no source on yet" in two amber bars over the
  // list. Reintroduce either bar: the first assertion fails; move a key out of the group header: the rest do.
  const panel = code(read('components/ExtensionsPanel.tsx'));
  assert.doesNotMatch(panel, /data-ext-update-bar|data-ext-off-bar/, 'a bar is back over the list');
  assert.doesNotMatch(panel, /rounded-xl border border-amber-500\/30 bg-amber-500\/10/, 'an amber bar is back over the list');
  const view = slice(panel, 'function InstalledView(', 'function GroupHead(');
  const head = slice(view, '<GroupHead title=', '</GroupHead>');
  assert.match(head, /\{g\.key === 'attention' && updates > 0 && \(\s*<button type="button" onClick=\{updateAll\}[^>]*data-ext-update-all/, 'Update all is not in the group\'s header');
  assert.match(head, /\{g\.key === 'attention' && off\.length > 1 && \(\s*<button type="button" onClick=\{turnAllOn\}[^>]*data-ext-turn-on-all>/, 'Turn on all is not in the group\'s header');
  assert.match(head, /: tr\('Turn on all'\)\}/);
  assert.equal((view.match(/onClick=\{updateAll\}/g) ?? []).length, 1, 'Update all is offered twice');
  assert.equal((view.match(/onClick=\{turnAllOn\}/g) ?? []).length, 1, 'Turn on all is offered twice');
});

test('Installed is grouped only while something needs attention', () => {
  // One plain list while all is well; "Needs attention" first and "Ready" under it otherwise. Reintroduce the groups
  // for everyone (always two): the first assertion fails; draw a header for `all`: the last one does.
  const quiet = [installedOf({}, [true]), installedOf({}, [true, false])];
  assert.deepEqual(installedGroups(quiet).map((g) => [g.key, g.list.length]), [['all', 2]], 'a list with nothing waiting is grouped');
  const mixed = installedList([ext('upd', { hasUpdate: true }), ext('off'), ext('fine')], [src('u', 'upd', 'en', true), src('o', 'off', 'en', false), src('f', 'fine', 'en', true)]);
  assert.deepEqual(installedGroups(mixed).map((g) => [g.key, g.list.map((e) => e.pkgName)]), [['attention', ['upd', 'off']], ['ready', ['fine']]]);
  assert.deepEqual(installedGroups(mixed.slice(0, 2)).map((g) => g.key), ['attention'], 'an empty Ready group is drawn');
  assert.equal(needsAttention(mixed[2]), false);
  const view = slice(code(read('components/ExtensionsPanel.tsx')), 'function InstalledView(', 'function GroupHead(');
  assert.match(view, /installedGroups\(list\)\.map\(\(g\) => \(/, 'Installed is not drawn from its groups');
  assert.match(view, /\{g\.key !== 'all' && \(\s*<GroupHead title=/, 'a list with nothing waiting has group headers');
  // The counts in the header, one sentence per count.
  assert.match(view, /g\.list\.length === 1 \? tr\('Needs attention · 1'\) : tr\('Needs attention · \{n\}', \{ n: g\.list\.length \}\)/);
  assert.match(view, /g\.list\.length === 1 \? tr\('Ready · 1'\) : tr\('Ready · \{n\}', \{ n: g\.list\.length \}\)/);
});

test('Browse has no Installed or Has an update chips, and its repositories are a link in its count line', () => {
  // The Installed tab is the installed filter; the API keeps both parameters. Reintroduce a chip: the first assertion
  // fails; put the Repositories key back beside the switch: the link assertion does.
  const browse = slice(code(read('components/ExtensionsPanel.tsx')), 'function BrowseView(', 'function NothingFound(');
  assert.doesNotMatch(browse, /data-ext-filter|tr\('Has an update'\)|set\(\{ (installed|updates):/, 'Browse has its Installed or Has an update chip again');
  assert.doesNotMatch(browse, /className=\{?`?"?chip\b/, 'Browse has a chip again');
  const line = slice(browse, 'data-ext-count-line>', '</label>');
  assert.match(line, /data-ext-count>\s*\{first\.matched === 1 \? tr\('1 extension matches'\) : tr\('\{n\} extensions match', \{ n: numberText\(first\.matched\) \}\)\}/, 'the count is not in the line');
  assert.match(line, /<button type="button" onClick=\{onRepos\} className="text-accent hover:underline" data-ext-repos>\s*\{!repos \? tr\('Repositories'\) : repos\.length === 1 \? tr\('1 repository'\) : tr\('\{n\} repositories', \{ n: numberText\(repos\.length\) \}\)\}/,
    'the repositories are not a link in the count line');
  assert.match(line, /<Switch on=\{f\.adult\} onChange=\{onAdult\}/, 'Show 18+ extensions is not on the count line');
  assert.doesNotMatch(browse, /className="btn-key[^"]*" data-ext-repos/, 'the repositories are a key again');
  // The API still takes both.
  assert.match(catalogQuery({ ...NO_FILTERS, installed: true, updates: true }, 0), /installed=true&updates=true/);
});

test('an extension\'s Settings are closed until asked for', () => {
  // Open, they were most of the sheet under its languages. Reintroduce `useState(true)`, or the body without its
  // disclosure: these fail.
  const sheet = code(read('components/ExtensionSheet.tsx'));
  assert.match(sheet, /const \[settingsOpen, setSettingsOpen\] = useState\(false\);/, 'Settings opens open');
  assert.match(sheet, /aria-expanded=\{settingsOpen\} aria-controls="ext-sheet-settings-body"/, 'the disclosure does not say whether it is open');
  assert.match(sheet, /\{settingsOpen && \(\s*<div id="ext-sheet-settings-body"[^>]*>\s*<ExtensionSettingsBody sourceId=\{settingsOf\}/, 'the settings show while the disclosure is closed');
  assert.equal((sheet.match(/<ExtensionSettingsBody\b/g) ?? []).length, 1, 'the settings are drawn outside their disclosure');
  // With several languages the closed row says whose settings it opens on.
  assert.match(sheet, /tr\('for \{language\}', \{ language: extLanguageName\(settingsLang\) \}\)/);
  // The chevron turns at once: round 2 adds no motion.
  const toggle = slice(sheet, 'data-ext-settings-toggle', '</button>');
  assert.doesNotMatch(toggle, /transition|duration-|animate-/, 'the disclosure animates');
});

test('a language in the sheet says a problem only, never "Turned off" or "Healthy"', () => {
  // The switch says on or off; a line under every row repeated it. Reintroduce the mark for every row (`h.label`), or
  // let languageProblem pass "ok" and "off" through: these fail.
  const reg = new Map([['sw:1', { status: 'ok' as const }], ['sw:3', { status: 'blocked' as const }]]);
  assert.equal(languageProblem(sourceHealth({ id: '1', enabled: false }, reg, null)), null, '"Turned off" is said under its switch');
  assert.equal(languageProblem(sourceHealth({ id: '1', enabled: true }, reg, null)), null, '"Healthy" is said under its switch');
  assert.equal(languageProblem(sourceHealth({ id: '2', enabled: true }, reg, null))?.label, 'Over the source limit');
  assert.equal(languageProblem(sourceHealth({ id: '3', enabled: true }, reg, null))?.label, 'Blocked by the site');
  assert.equal(languageProblem(sourceHealth({ id: '1', enabled: true }, reg, new Map([['sw:1', { failing: [{ stage: 'search' }] }]])))?.label, 'Failing');
  const sheet = code(read('components/ExtensionSheet.tsx'));
  assert.match(sheet, /const problem = languageProblem\(sourceHealth\(s, reg, rows\)\);/, 'a language\'s row reads its health unfiltered');
  assert.match(sheet, /\{\(problem \|\| hidden\) && \(\s*<p [^>]*data-ext-lang-problem>/, 'a language\'s row has a line with no problem to say');
  assert.doesNotMatch(sheet, /\{!!s\.used && /, 'a language\'s row counts its series again');
  // Hidden in every extension is a link to the Languages sheet; the footer's link to it is gone.
  assert.match(sheet, /\{hidden && <button type="button" onClick=\{onLanguages\}[^>]*data-ext-lang-hidden>\{tr\('Hidden in every extension'\)\}<\/button>\}/);
  assert.doesNotMatch(sheet, /tr\('Languages hidden in every extension'\)/, 'the sheet keeps its own link to the hidden languages');
  // No amber box for "none on": the Languages header offers Turn on its sources.
  assert.doesNotMatch(sheet, /data-ext-sheet-off|tr\('None of its sources are on'\)/, 'the amber "None of its sources are on" box is back');
  const langs = slice(sheet, '<section aria-labelledby="ext-sheet-langs">', '</ul>');
  assert.match(langs, /\{off && \(\s*<button type="button" onClick=\{\(\) => void actions\.act\(ext, 'enable'\)\}[^>]*className=\{`btn-key btn-key-primary [^`]*`\} data-ext-turn-on>/, 'Turn on its sources is not in the Languages header');
  // A tag never wraps (round 1's PT-BR did).
  assert.match(langs, /<span aria-hidden className=\{`w-12 shrink-0 whitespace-nowrap /, 'a language\'s tag wraps');
});

test('the limit across all extensions is said from 80 % of it, or once something is over it', () => {
  // Under every extension's languages it was one more sentence nobody needed. Reintroduce the bare paragraph: the
  // source assertion fails; a threshold of the limit itself: the 20-of-25 one does.
  assert.equal(nearSourceLimit({ enabled: 5, cap: 25 }), false);
  assert.equal(nearSourceLimit({ enabled: 19, cap: 25 }), false);
  assert.equal(nearSourceLimit({ enabled: 20, cap: 25 }), true, '20 of 25 is not near the limit');
  assert.equal(nearSourceLimit({ enabled: 3, cap: 25, skipped: 1 }), true, 'something over the limit is not said');
  assert.equal(nearSourceLimit({ enabled: 0, cap: 0 }), false);
  const sheet = code(read('components/ExtensionSheet.tsx'));
  assert.match(sheet, /\{nearSourceLimit\(status\) && \(\s*<p [^>]*data-ext-sheet-cap>/, 'the limit is said under every extension');
});

test('the strip says no more than its marks when all is well', () => {
  // Round 1 had a paragraph under each half, the installed count, an amber edge and Turning it off as a link. Now a
  // connected helper is its mark alone. Reintroduce a detail for `ok` (or `other`) in helperLine: the first two fail.
  const base = { supported: true, enabled: true, connectable: true };
  assert.equal(helperLine({ ...base, wiring: 'ok' })?.detail, null, 'a connected helper has a sentence under its mark');
  assert.equal(helperLine({ ...base, wiring: 'other' })?.detail, null, 'a helper of the engine\'s own has a sentence under its mark');
  assert.equal(helperLine({ ...base, wiring: 'off', enabled: false })?.detail, 'Needed for sites behind Cloudflare.');
  assert.equal(helperLine({ ...base, wiring: 'localhost' })?.detail, 'Needed for sites behind Cloudflare.');
  const ready = slice(code(read('components/EngineSetup.tsx')), 'export function EngineReady(', 'function EngineOffSheet(');
  assert.match(ready, /: helper \? helper\.detail : tr\('This engine has no Cloudflare helper setting\.'\);/, 'the helper\'s line is not its detail');
  assert.match(ready, /<p role="status" className=\{`[^`]*empty:hidden[^`]*`\}>\s*\{line\}\s*<\/p>/, 'an empty line keeps its room');
  assert.doesNotMatch(ready, /<StatusEdge\b/, 'the strip has an edge again');
  assert.doesNotMatch(ready, /extensionsInstalledText|installed=/, 'the strip counts the extensions installed again');
  assert.match(ready, /data-engine-counts>\{engineMeta\(status\)\}<\/p>/);
  // One filled key: Connect.
  assert.equal((ready.match(/btn-key-primary/g) ?? []).length, 1, 'the strip has a filled key besides Connect');
  // Turning it off is behind the engine's ⋯, a menu the keyboard reaches; desktop has none.
  assert.match(ready, /useContextMenu\(\(\) => \(desktop \? \[\] : \[\{ label: tr\('Turning it off'\), onSelect: \(\) => setShowOff\(true\) \}\]\), \{ label: tr\('Extension engine'\) \}\)/,
    'Turning it off is not in the engine\'s ⋯ menu');
  assert.match(ready, /\{!desktop && \(\s*<button type="button" onClick=\{\(e\) => menu\.openFrom\(e\.currentTarget\)\} aria-label=\{tr\('More'\)\}[^>]*aria-haspopup="menu" aria-expanded=\{menu\.open\}/);
  assert.match(ready, /\{menu\.element\}/);
  // Over the limit: the line turns amber and the way under it is said under the strip.
  assert.match(ready, /className=\{`mt-1 [^`]*\$\{over \? 'text-amber-300' : 'text-fog-500'\}`\} data-engine-counts>/);
});

test('Installed\'s tools sit at the end of the views\' row, as icons on a phone, with no hint line over the list', () => {
  // Reintroduce the hint line, or the tools above the list: these fail.
  const panel = code(read('components/ExtensionsPanel.tsx'));
  assert.doesNotMatch(panel, /tr\('Open an extension for its languages and settings\.'\)/, 'the hint line is back');
  const lists = slice(panel, 'function ExtensionLists(', 'function ViewTabs(');
  assert.match(lists, /<ViewTabs [^\n]*\/>\s*\{view === 'installed' && <InstalledTools actions=\{actions\} onLanguages=\{\(\) => setSheet\('langs'\)\} \/>\}\s*<\/div>/, 'the tools are not in the views\' row');
  // Russian's "Установленные" at 390 pushed the tools 7 px past the row: longer words and counts wrap the tools to a
  // line of their own instead. Reintroduce the row without `flex-wrap`: this fails.
  assert.match(lists, /<div className="flex flex-wrap items-end justify-between gap-x-3 border-b border-ink-800\/80">\s*<ViewTabs /, 'the views\' row overflows rather than wraps');
  assert.match(slice(panel, 'function InstalledTools(', 'const AMBER_KEY'), /<div className="ms-auto flex shrink-0 /, 'wrapped tools do not keep to the end of the row');
  const tools = slice(panel, 'function InstalledTools(', 'const AMBER_KEY');
  for (const hook of ['data-ext-languages', 'data-ext-refresh']) {
    const key = new RegExp(`<button [^>]*aria-label=\\{[^}]+\\} title=\\{[^}]+\\}\\s*className=\\{?[\`"]btn-key w-8 px-0 sm:w-auto sm:px-3[^>]*${hook}>`);
    assert.match(tools, key, `${hook} is not a named icon key on a phone`);
  }
  assert.equal((tools.match(/<span className="hidden sm:inline">/g) ?? []).length, 3, 'a tool\'s words show on a phone');
  // The Installed tab's amber mark only while Installed is not the open view: its group says it there.
  assert.match(slice(panel, 'function ViewTabs(', 'function InstalledTools('), /\{v === 'installed' && !on && updates > 0 && <span aria-hidden className="h-1\.5 w-1\.5 rounded-full bg-amber-400" \/>\}/,
    'the Installed tab marks an update while Installed is open, beside the group that says it');
});

test('a row is one opener with its key beside it, never a button in a button', () => {
  // The whole row opens the sheet (its ::after covers the row) and a key sits over it, a sibling. Reintroduce the key
  // inside the opener: the nesting assertion fails.
  const panel = code(read('components/ExtensionsPanel.tsx'));
  assert.match(panel, /const OPENER = '[^']*after:absolute after:inset-0[^']*focus-visible:after:ring-2[^']*';/, 'the row is not one hit area with a focus ring');
  for (const [name, from, to] of [['InstalledRow', 'function InstalledRow(', 'function RowWord('], ['BrowseRow', 'function BrowseRow(', '']] as const) {
    const row = slice(panel, from, to);
    const opener = slice(row, 'className={OPENER} data-ext-open>', '</button>');
    assert.doesNotMatch(opener, /<button\b/, `${name}: a key inside the opener`);
    assert.match(row, /<li data-ext-(row|item)=\{e\.pkgName\}[^>]*className=\{`\$\{ROW\} /, `${name}: the row is not the opener's positioned box`);
  }
  // No transition on a row: round 2 adds no motion.
  assert.doesNotMatch(slice(panel, 'const ROW = ', ';'), /transition/);
  // An installed extension in Browse is its row, "Already installed" and a chevron: Manage was a key for the same.
  const browseRow = slice(panel, 'function BrowseRow(', '');
  assert.doesNotMatch(browseRow, /data-ext-manage|tr\('Manage'\)/, 'an installed extension in Browse has a Manage key again');
  assert.match(browseRow, /\{e\.installed \? \(\s*<button type="button" onClick=\{onOpen\} className=\{OPENER\} data-ext-open>/, 'an installed extension in Browse does not open its sheet');
});

test('an extension\'s sheet: its icon and facts on top, Update there when one waits, Remove and Providers in its footer', () => {
  const sheet = code(read('components/ExtensionSheet.tsx'));
  assert.match(sheet, /lead=\{<ExtIcon url=\{ext\.iconUrl\} name=\{ext\.name\} size=\{52\} \/>\}/);
  assert.match(sheet, /const facts = \[ext\.versionName \? `v\$\{ext\.versionName\}` : null, extLanguagesText\(ext\), ext\.used > 0 \? seriesText\(ext\.used\) : null\]/);
  assert.match(sheet, /action=\{ext\.hasUpdate \? \(\s*<button type="button" onClick=\{\(\) => void actions\.act\(ext, 'update'\)\}/, 'Update is not at the top of the sheet');
  const foot = slice(sheet, 'footer={', '}>\n');
  assert.match(foot, /onClick=\{onProviders\}/, 'the way to test the sources is not in the footer');
  assert.match(foot, /className="btn-key btn-key-danger text-rose-300" data-ext-remove>/, 'Remove extension is not a quiet danger key in the footer');
  // What an extension reads in: its one language, or how many.
  assert.equal(extLanguagesText({ lang: 'all', sources: [src('1', 'p', 'en', true), src('2', 'p', 'ja', false)] }), '2 languages');
  assert.equal(extLanguagesText({ lang: 'all', sources: [src('1', 'p', 'en', true)] }), 'English');
  assert.equal(extLanguagesText({ lang: 'all', sources: [] }), 'Multiple languages');
});

test('a line of facts isolates each one, so a version never takes an Arabic count\'s number', () => {
  // "v1.4.79 · 6 لغات" read "6 · v1.4.79 لغات" in Arabic: a number after a Latin run joins it. Reintroduce the joined
  // string (`.filter(Boolean).join(' · ')`) in the sheet: the source assertion fails; drop the <bdi>: the render does.
  (globalThis as { React?: unknown }).React = React;
  const html = renderToStaticMarkup(createElement(Facts, { items: ['v1.4.79', null, '6 لغات', false] }));
  assert.equal(html, '<bdi>v1.4.79</bdi> · <bdi>6 لغات</bdi>');
  const sheet = code(read('components/ExtensionSheet.tsx'));
  assert.match(sheet, /subtitle=\{<><span><Facts items=\{facts\} \/><\/span><ExtTags e=\{ext\} \/><\/>\}/, 'the sheet\'s facts are one string');
  const panel = code(read('components/ExtensionsPanel.tsx'));
  assert.equal((panel.match(/<Facts items=\{\[/g) ?? []).length, 2, 'a row\'s facts are one string');
  assert.doesNotMatch(panel + sheet, /\.filter\(Boolean\)\.join\(' · '\)/, 'facts are joined into one string again');
});
