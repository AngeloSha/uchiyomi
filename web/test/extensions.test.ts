// Admin → Extensions, redesigned (v0.53.0): the rules in lib/extensions.ts, and the shape of the tab that each answers.
//
// Discussion #121 is a real user on a 1,300-extension repository: the catalogue stopped at "Showing 400 of 570 matches
// -- narrow the search" and MangaFire could not be reached; "18+" read as a filter to adult extensions only; an
// extension's language select looked like it chose the language; "12 extensions" read as many more (sources); and
// extensions installed in the engine's own page stayed off with no way on but Remove and Add again. Each test names
// the edit that brings its fault back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setActiveLocale } from '../lib/format';
import {
  BROWSE_PAGE, LOCAL_SOURCE_LANG, NO_FILTERS, browseCount, catalogQuery, engineLine, extLanguageName, helperLine, initialView, installedList,
  languageOptions, languagesOnText, needsTurningOn, nextOffset, overLimitText, reasonLine, sourceHealth, sourcesOnText,
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

test('the header says the engine\'s state and the Cloudflare helper\'s, and offers one action for a helper that is not connected', () => {
  assert.deepEqual(engineLine({ configured: true, reachable: true, version: 'v2.3.2243' }), { state: 'ready', tone: 'ok', label: 'Engine ready · v2.3.2243' });
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
  assert.match(row, /\{off && \(\s*<button type="button" onClick=\{\(\) => void act\(e, 'enable'\)\}[^>]*data-ext-turn-on>/, 'the row does not offer to turn its sources on');
  assert.match(row, /: tr\('Turn on its sources'\)\}/, 'the row\'s key does not say it turns its sources on');
  assert.match(row, /\{tr\('None of its sources are on'\)\}/, 'the row does not say none of its sources are on');
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
  assert.match(sheet, /\{tr\('Across all extensions: \{n\} of \{max\} sources on\.', \{ n: status\.enabled \?\? 0, max: status\.cap \?\? 0 \}\)\}/, 'the source limit is not said beside the switches');
  // Remove asks first, inside the sheet, counting what stops updating.
  assert.match(sheet, /\{!removing \? \(\s*<button type="button" onClick=\{\(\) => setRemoving\(true\)\}/, 'Remove does not ask first');
  assert.match(sheet, /role="alertdialog" aria-label=\{tr\('Remove \{name\}\?', \{ name \}\)\}/);
  assert.doesNotMatch(sheet, /<ConfirmDialog\b|<Modal\b/, 'Remove asks in a dialog the sheet would cover');
});

test('names keep their own direction, and a phone never scrolls sideways', () => {
  const panel = code(read('components/ExtensionsPanel.tsx'));
  // An extension's name is the site's own: in an Arabic page an English name's punctuation jumped to its start.
  assert.equal((panel.match(/<bdi dir="auto" className="truncate text-sm font-medium text-fog-100">\{e\.name\}<\/bdi>/g) ?? []).length, 2, 'a row\'s name is not isolated');
  assert.match(code(read('components/ExtensionBits.tsx')), /<span dir="ltr" className="[^"]*">18\+<\/span>/, 'the 18+ tag prints "+18" in Arabic');
  // A grid of rows holding truncating names is one column wide below xl (an implicit column grows to the name).
  assert.match(panel, /<ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">/, 'the installed rows\' grid has no explicit column');
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
