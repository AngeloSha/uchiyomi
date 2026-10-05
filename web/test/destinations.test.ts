// The search palette finds pages and settings (v0.55.4): lib/destinations.ts, the palette, the phone search page, and
// the `?section=` each one lands on.
//
// The owner: "settings are buried too much". Every admin tab, Admin → Settings' sections, the profile's tabs and cards,
// the import page and the settings people ask for by name are destinations now. What can rot is the address: a tab
// renamed, a section's id dropped, a card moved to another tab -- the row would still be listed and land on the wrong
// screen, or on the top of the right one. So every address is held to the source it names, and what a query finds, for
// whom, is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DESTINATIONS, arrival, findDestinations, fold, whereText } from '../lib/destinations';
import { DESKTOP_HIDDEN } from '../lib/desktop';
import { CHECK_TITLES } from '../lib/healthCopy';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- comments here quote the code they describe. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};
const keysOf = (src: string): string[] => [...src.matchAll(/tabs: keys\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
const ADMIN_TABS = keysOf(read('app/admin/page.tsx'));
const PROFILE_TABS = keysOf(read('app/profile/page.tsx'));
/** Where each console tab's cards are drawn: the files whose `id="…"` a `?section=` on that tab may name. */
const TAB_FILES: Record<string, string[]> = {
  '/admin/ Settings': ['components/AdminSettings.tsx', 'components/AdminNotifications.tsx', 'components/ArchiveSettings.tsx'],
  '/profile/ You': ['components/ProfileYou.tsx'],
  '/profile/ Settings': ['components/ProfileSettings.tsx'],
  '/profile/ Connections': ['components/ProfileConnections.tsx'],
  '/profile/ Account': ['components/ProfileAccount.tsx'],
};
const sectionIds = (files: string[]): Set<string> =>
  new Set(files.flatMap((f) => [...code(read(f)).matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1])));
const viewer = { admin: true, desktop: false, label: (k: string) => k };

test('every destination lands where it says: a real page, one of its tabs, and a card that tab draws', () => {
  // Reintroduce a section without its id (drop `id="notice-chapters"` from AdminSettings.tsx), or a tab that is gone
  // (`?tab=Providers`): the destination is named here by its key.
  assert.ok(ADMIN_TABS.length === 10 && PROFILE_TABS.length === 4, 'the console tab lists were not read');
  for (const d of DESTINATIONS) {
    const u = new URL(d.href, 'http://x');
    assert.ok(['/admin/', '/profile/', '/admin/import/'].includes(u.pathname), `${d.key}: ${u.pathname} is not a page this lists`);
    assert.ok(existsSync(join(ROOT, `app${u.pathname}page.tsx`)), `${d.key}: no page at ${u.pathname}`);
    const tab = u.searchParams.get('tab');
    const tabs = u.pathname === '/admin/' ? ADMIN_TABS : u.pathname === '/profile/' ? PROFILE_TABS : [];
    if (tab) assert.ok(tabs.includes(tab), `${d.key}: ?tab=${tab} is not a tab of ${u.pathname}`);
    const section = u.searchParams.get('section');
    if (!section) continue;
    const at = `${u.pathname} ${tab ?? tabs[0]}`;
    if (at === '/admin/ Health') {
      // Health's cards are `check-<the check's id>`, a check the server sends (the web's own list of them).
      assert.match(section, /^check-/, `${d.key}: a Health card is not addressed by its check`);
      assert.ok(section.slice(6) in CHECK_TITLES, `${d.key}: there is no ${section.slice(6)} check`);
      continue;
    }
    assert.ok(TAB_FILES[at], `${d.key}: nothing says where ${at} draws its cards`);
    assert.ok(sectionIds(TAB_FILES[at]).has(section), `${d.key}: no card with id="${section}" on ${at}`);
  }
  assert.match(code(read('app/admin/page.tsx')), /<div key=\{c\.id\} id=\{`check-\$\{c\.id\}`\} data-health-check=\{c\.id\}/, 'Health\'s cards have no id to land on');
  assert.equal(new Set(DESTINATIONS.map((d) => d.key)).size, DESTINATIONS.length, 'two destinations share a key');
});

test('it covers every admin tab, every section of Admin → Settings, the profile, the import and the settings asked for by name', () => {
  // Reintroduce a section with no id (`<Section title={tr('Scanlators')}`): "a section of Admin → Settings has no id"
  // fails; drop a tab's entry: it is named.
  for (const tab of ADMIN_TABS) {
    assert.ok(DESTINATIONS.some((d) => d.href === (tab === 'Overview' ? '/admin/' : `/admin/?tab=${tab}`)), `the admin tab ${tab} is not a destination`);
  }
  for (const tab of PROFILE_TABS) {
    assert.ok(DESTINATIONS.some((d) => d.href === (tab === 'You' ? '/profile/' : `/profile/?tab=${tab}`)), `the profile tab ${tab} is not a destination`);
  }
  const files = TAB_FILES['/admin/ Settings'].map((f) => code(read(f)));
  const sections = files.flatMap((src) => [...src.matchAll(/<Section\b[^>]*?>/gs)].map((m) => m[0]));
  assert.ok(sections.length >= 9, `only ${sections.length} sections found on Admin → Settings`);
  for (const s of sections) {
    const id = /\bid="([a-z0-9-]+)"/.exec(s)?.[1];
    assert.ok(id, `a section of Admin → Settings has no id: ${s.slice(0, 80)}`);
    assert.ok(DESTINATIONS.some((d) => d.href === `/admin/?tab=Settings&section=${id}`), `the section ${id} is not a destination`);
  }
  assert.ok(DESTINATIONS.some((d) => d.href === '/admin/import/' && d.label === 'Import a list'), 'the import page is not a destination');
  for (const name of ['Check for updates', 'Notice chapters', '18+ filter', 'Source order', 'Slow archive', 'Backup time', 'Delete read chapters',
    'Scanlators', 'Cloudflare solver', 'Version']) {
    assert.ok(DESTINATIONS.some((d) => d.label === name), `"${name}" is not found by name`);
  }
});

test('admins only where the page is theirs, and nothing Uchiyomi Desktop does not have', () => {
  // Reintroduce `admin: false` on an admin page, or forget `desktopHidden` on Members: named here. Reintroduce the
  // filter without the admin check: "a member is shown the admin's settings" fails.
  for (const d of DESTINATIONS) {
    assert.equal(!!d.admin, d.href.startsWith('/admin/'), `${d.key}: admin-only is wrong for ${d.href}`);
    const u = new URL(d.href, 'http://x');
    const tab = u.searchParams.get('tab') ?? '';
    const hiddenTabs: readonly string[] = u.pathname === '/admin/' ? DESKTOP_HIDDEN.adminTabs : u.pathname === '/profile/' ? DESKTOP_HIDDEN.profileTabs : [];
    if (hiddenTabs.includes(tab)) assert.ok(d.desktopHidden, `${d.key}: ${tab} is not on Desktop, and neither may its destination be`);
  }
  // Desktop hides these settings and cards too (lib/desktop.ts, ProfileSettings, ProfileConnections, AdminSettings).
  for (const key of ['registration', 'mihon-missing', 'offline-downloads', 'this-device', 'chapter-alerts', 'opds', 'api-tokens']) {
    assert.ok(DESTINATIONS.find((d) => d.key === key)?.desktopHidden, `${key} shows on Desktop, which has no such thing`);
  }
  const member = (q: string) => findDestinations(q, { ...viewer, admin: false, limit: 50 }).map((d) => d.key);
  assert.deepEqual(member('settings'), ['profile-settings'], 'a member is shown the admin\'s settings');
  assert.deepEqual(member('import'), [], 'a member is shown the import');
  assert.ok(findDestinations('settings', { ...viewer, limit: 50 }).some((d) => d.key === 'admin-settings'), 'an admin is not shown Admin → Settings');
  const desk = (q: string) => findDestinations(q, { ...viewer, desktop: true, limit: 50 }).map((d) => d.key);
  assert.ok(!desk('members').includes('admin-members'), 'Desktop is offered Members');
  assert.ok(!desk('api').includes('api-tokens'), 'Desktop is offered API tokens');
  assert.ok(desk('notice').includes('settings-notice'), 'Desktop loses what it does have');
});

test('a query finds by the label in the reader\'s language or in English, then by its words, best first', () => {
  // Reintroduce matching on the English label alone (drop `fold(label(d.label))`): "the label in the reader's language"
  // fails; match anywhere from two characters: "two letters inside a word" fails.
  const keysFor = (q: string, o: Partial<typeof viewer> = {}) => findDestinations(q, { ...viewer, ...o }).map((d) => d.key);
  assert.equal(keysFor('notice')[0], 'settings-notice');
  assert.equal(keysFor('import')[0], 'import');
  assert.equal(keysFor('Version')[0], 'version');
  assert.ok(keysFor('flaresolverr').includes('solver'), 'a word someone types for it does not find it');
  assert.ok(keysFor('mihon').includes('import'));
  assert.ok(keysFor('2fa').includes('two-factor'));
  assert.ok(keysFor('slow arch').includes('slow-archive'), 'two words at the start of two words');
  // In the reader's language: the row's own words find it, and so does English.
  const de: Record<string, string> = { 'Notice chapters': 'Hinweis-Kapitel', Settings: 'Einstellungen', Appearance: 'Erscheinungsbild' };
  const label = (k: string) => de[k] ?? k;
  assert.equal(keysFor('kapitel', { label })[0], 'settings-notice', 'the label in the reader\'s language does not find it');
  assert.equal(keysFor('notice', { label })[0], 'settings-notice', 'English stops finding it in another language');
  assert.ok(keysFor('einstellungen', { label }).includes('profile-settings'));
  // Accents and case do not matter.
  assert.equal(fold('Paramètres'), 'parametres');
  assert.ok(keysFor('parametres', { label: (k) => (k === 'Settings' ? 'Paramètres' : k) }).includes('admin-settings'));
  // Nothing below two characters; nothing inside a word below three.
  assert.deepEqual(keysFor('n'), []);
  assert.deepEqual(keysFor('  '), []);
  assert.deepEqual(keysFor('pd'), [], 'two letters inside a word');  // "Updates", "Check for updates", "OPDS"
  // …except where words are not spaced: two characters inside a Japanese or Chinese label find it.
  assert.equal(keysFor('知ら', { label: (k) => (k === 'Notice chapters' ? 'お知らせの話' : k) })[0], 'settings-notice', 'a Japanese label is not found from its middle');
  assert.equal(keysFor('设置', { label: (k) => (k === 'Settings' ? '服务器设置' : k) })[0], 'admin-settings');
  assert.ok(keysFor('chedul').includes('settings-schedules'), 'three letters inside a word do not find it');
  // At most six, unless the caller asks for more.
  assert.ok(keysFor('s').length === 0 && findDestinations('se', viewer).length <= 6);
  assert.ok(findDestinations('se', { ...viewer, limit: 50 }).length > 6, 'the limit is the only thing holding the list at six');
});

test('where a row says it is reads the way the page does', () => {
  const notice = DESTINATIONS.find((d) => d.key === 'settings-notice')!;
  assert.equal(whereText(notice, false), 'Admin → Settings');
  // Arabic writes these paths with "←" (its own translations of "Admin → Sources" do).
  assert.equal(whereText(notice, true), 'Admin ← Settings');
});

test('getting there: another page is a push, another tab of this page a whole load, a card already here a scroll', () => {
  // ⚠️ The console reads ?tab= once (lib/useTabParam.ts), so a client-side push to another tab of the page that is open
  // changes the address and nothing on screen. Reintroduce `return 'push'` for every destination: "another tab of this
  // page is a whole page load" fails.
  const none = () => false;
  const all = () => true;
  const set = '/admin/?tab=Settings&section=notice-chapters';
  assert.equal(arrival(set, { pathname: '/library/', search: '' }, none), 'push', 'another page is not a client-side navigation');
  assert.equal(arrival(set, { pathname: '/admin/import/', search: '' }, none), 'push');
  assert.equal(arrival(set, { pathname: '/admin/', search: '' }, none), 'load', 'another tab of this page is a whole page load');
  assert.equal(arrival(set, { pathname: '/admin', search: '?tab=Health' }, none), 'load', 'a path without its slash is another page');
  assert.equal(arrival(set, { pathname: '/admin/', search: '?tab=Settings' }, all), 'scroll', 'a card already on screen is reloaded');
  assert.equal(arrival(set, { pathname: '/admin/', search: '?tab=Settings' }, none), 'load', 'a card not drawn yet is waited for nowhere');
  assert.equal(arrival('/admin/', { pathname: '/admin/', search: '?tab=Overview' }, none), 'none', 'the first tab is not this tab');
  assert.equal(arrival('/admin/?tab=Tasks', { pathname: '/admin/', search: '?tab=Tasks&card=x' }, none), 'none');
  assert.equal(arrival('/profile/?tab=Settings', { pathname: '/profile/', search: '' }, none), 'load');
  assert.equal(arrival('/profile/?section=badges', { pathname: '/profile/', search: '' }, all), 'scroll');
});

test('the palette lists them after the series under their own heading, and goes there the way arrival() says', () => {
  // Reintroduce the palette without destinations, or `router.push` for every row: these fail by name.
  const pal = code(read('components/CommandPalette.tsx'));
  assert.match(pal, /const places = useMemo\(\(\) => findDestinations\(q, \{ admin: isAdmin, desktop: isDesktop\(\) \}\), \[q, isAdmin\]\);/, 'the palette does not ask for destinations');
  assert.match(pal, /\.\.\.results\.map\(\(s\) => \(\{ kind: 'series' as const, series: s \}\)\),\s*\.\.\.places\.map\(\(p\) => \(\{ kind: 'place' as const, place: p \}\)\),\s*\.\.\.shownActions\.map/,
    'the destinations are not between the series and the actions');
  assert.match(pal, /\{rows\[i - 1\]\?\.kind !== 'place' && <p [^>]*>\{tr\('Pages and settings'\)\}<\/p>\}/, 'the destinations have no heading of their own');
  assert.match(pal, /\{rows\[i - 1\]\?\.kind !== 'action' && <p [^>]*>\{tr\('Actions'\)\}<\/p>\}/, 'the Actions heading is placed by the series count alone');
  assert.match(pal, /else if \(r\.kind === 'place'\) goTo\(r\.place\.href\);/, 'a destination is not opened');
  const goTo = slice(pal, 'const goTo = useCallback(', '}, [onClose, router]);');
  assert.match(goTo, /const how = arrival\(href, window\.location, \(id\) => !!document\.getElementById\(id\)\);/);
  assert.match(goTo, /if \(how === 'push'\) router\.push\(href\);\s*else if \(how === 'load'\) window\.location\.assign\(href\);/, 'another tab of this page is pushed, which does nothing');
  // "No series match" in the reader's language, the query isolated inside it.
  assert.match(pal, /\{tr\('No series match “\{query\}”\.', \{ query: `\\u2068\$\{q\.trim\(\)\}\\u2069` \}\)\}/, '"No series match" is English in every language');
  assert.doesNotMatch(pal, /\{r\.series\.booksCount\} chapters/, 'a series row says "chapters" in English');
});

test('the phone search page lists the same destinations under its series', () => {
  // Reintroduce the page without them: "the phone cannot find a setting" fails.
  const page = code(read('app/search/page.tsx'));
  assert.match(page, /const places = useMemo\(\(\) => findDestinations\(debounced, \{ admin: isAdmin, desktop: isDesktop\(\), limit: 8 \}\), \[debounced, isAdmin\]\);/, 'the phone cannot find a setting');
  assert.match(page, /\{places\.length > 0 && \(\s*<section data-search-places [^>]*>[\s\S]*?\{tr\('Pages and settings'\)\}[\s\S]*?\{places\.map\(\(p\) => <PlaceRow key=\{p\.key\} place=\{p\} href=\{p\.href\} \/>\)\}/,
    'the destinations are not listed under the series');
  assert.ok(page.indexOf('data-search-places') > page.indexOf('<SeriesTile'), 'the destinations come before the series');
  assert.match(page, /\{tr\('No series match “\{query\}”\.', \{ query: `\\u2068\$\{debounced\}\\u2069` \}\)\}/);
});

test('a destination\'s card is scrolled to once it has loaded, on both consoles, without touching the tab hook', () => {
  // Reintroduce the scroll on mount (no wait for the card): the "Loading…" of Admin → Settings has no card yet, so it
  // never lands -- "the arrival does not wait for its card" fails. useTabParam stays as settingsConsole.test.ts pins it.
  const hook = code(read('lib/useSectionArrival.ts'));
  assert.match(hook, /const \[id\] = useState<string \| null>\(\(\) => params\.get\('section'\)\);/, 'the section is not read once, on arrival');
  assert.match(hook, /const mo = new MutationObserver|mo = new MutationObserver\(settle\);/, 'the arrival does not wait for its card');
  assert.match(hook, /if \(!document\.getElementById\(id\)\) return;/, 'the arrival does not wait for its card');
  assert.match(hook, /el\.scrollIntoView\(\{ block: 'start', behavior: still \? 'auto' : 'smooth' \}\);/);
  assert.match(hook, /u\.searchParams\.delete\('section'\);\s*window\.history\.replaceState\(null, '', /, 'a remount (a language change) scrolls again');
  for (const ev of ['wheel', 'touchmove', 'keydown']) assert.ok(hook.includes(`'${ev}'`), `a ${ev} before the scroll does not leave the person where they went`);
  for (const page of ['app/admin/page.tsx', 'app/profile/page.tsx']) {
    assert.match(code(read(page)), /\n\s*useSectionArrival\(\);\n/, `${page} does not land on its section`);
  }
  // Sections clear the desktop's sticky top bar when scrolled to.
  assert.match(code(read('components/settings.tsx')), /className=\{`card grad-border min-w-0 p-4 scroll-mt-4 lg:scroll-mt-20 \$\{className \?\? ''\}`\}/);
});
