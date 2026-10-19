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
import { CHECK_TITLES } from '../lib/healthCopy';
import { PROFILE_SETTINGS } from '../lib/settingsIndex.profile';
import { ADMIN_SETTINGS } from '../lib/settingsIndex.admin';

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
/** Each console's pages, in its list's order (v0.88.0: one list each, from its registry, lib/settingsIndex*.ts). */
const PAGES_OF: Record<string, readonly string[]> = {
  '/admin/': ADMIN_SETTINGS.categories.map((c) => c.id),
  '/profile/': PROFILE_SETTINGS.categories.map((c) => c.id),
};
/** A console's settings rows, by page: the registry's, which settingsIndex.test.ts holds to the rows in the source. */
const ROWS_OF: Record<string, Set<string>> = Object.fromEntries([ADMIN_SETTINGS, PROFILE_SETTINGS].flatMap((index) =>
  index.categories.map((c) => [`/${index.page}/ ${c.id}`, new Set(index.entries.filter((e) => e.cat === c.id).map((e) => e.id))])));
/** Where the other pages' cards are drawn: the files whose `id="…"` a `?section=` on that page may name. */
const PAGE_FILES: Record<string, string[]> = {
  // Maintenance's Run now, under its settings (what was the Tasks tab).
  '/admin/ maintenance': ['app/admin/page.tsx'],
  // The card's weekly goal is drawn by the page itself (v0.86.0: its one home).
  '/profile/ you': ['components/ProfileYou.tsx', 'app/profile/page.tsx'],
  '/profile/ connections': ['components/ProfileConnections.tsx'],
  '/profile/ account': ['components/ProfileAccount.tsx'],
};
const sectionIds = (files: string[]): Set<string> =>
  new Set(files.flatMap((f) => [...code(read(f)).matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1])));
const viewer = { admin: true, desktop: false, label: (k: string) => k };
/** The ids of the tasks the server lists on Admin → Maintenance (bff routes/admin.ts GET /api/admin/tasks). */
const TASK_IDS = (() => {
  const route = readFileSync(join(ROOT, '../bff/src/routes/admin.ts'), 'utf8');
  return [...slice(route, "app.get('/api/admin/tasks',", "app.post('/api/admin/tasks/:id/run'").matchAll(/\bid: '([a-z]+)'/g)].map((m) => m[1]);
})();

test('every destination lands where it says: a real page, one of its pages, and a card that page draws', () => {
  // Reintroduce a section without its id (drop `id="notice-chapters"` from AdminSettings.tsx), or a page that is gone
  // (`?tab=providers`): the destination is named here by its key.
  assert.ok(PAGES_OF['/admin/'].length === 13 && PAGES_OF['/profile/'].length === 8, 'the consoles\' pages were not read');
  for (const d of DESTINATIONS) {
    const u = new URL(d.href, 'http://x');
    assert.ok(['/admin/', '/profile/', '/admin/import/'].includes(u.pathname), `${d.key}: ${u.pathname} is not a page this lists`);
    assert.ok(existsSync(join(ROOT, `app${u.pathname}page.tsx`)), `${d.key}: no page at ${u.pathname}`);
    const tab = u.searchParams.get('tab');
    const pages = PAGES_OF[u.pathname] ?? [];
    if (tab) assert.ok(pages.includes(tab), `${d.key}: ?tab=${tab} is not a page of ${u.pathname}`);
    const section = u.searchParams.get('section');
    if (!section) continue;
    const at = `${u.pathname} ${tab ?? pages[0]}`;
    if (at === '/admin/ health') {
      // Health's cards are `check-<the check's id>`, a check the server sends (the web's own list of them).
      assert.match(section, /^check-/, `${d.key}: a Health card is not addressed by its check`);
      assert.ok(section.slice(6) in CHECK_TITLES, `${d.key}: there is no ${section.slice(6)} check`);
      continue;
    }
    if (at === '/admin/ maintenance' && section.startsWith('task-')) {
      // Maintenance's tasks are `task-<the task's id>`, a task the server lists (v0.55.4: Rescan everything, the palette's).
      assert.ok(TASK_IDS.includes(section.slice(5)), `${d.key}: the server lists no ${section.slice(5)} task (it has ${TASK_IDS.join(', ')})`);
      continue;
    }
    if (ROWS_OF[at]?.has(section)) continue;
    assert.ok(PAGE_FILES[at], `${d.key}: nothing says where ${at} draws its cards`);
    assert.ok(sectionIds(PAGE_FILES[at]).has(section), `${d.key}: no card with id="${section}" on ${at}`);
  }
  assert.match(code(read('app/admin/page.tsx')), /<div key=\{c\.id\} id=\{`check-\$\{c\.id\}`\} data-health-check=\{c\.id\}/, 'Health\'s cards have no id to land on');
  // Reintroduce a task row without its id: "the tasks have no id to land on".
  assert.ok(TASK_IDS.length >= 9 && TASK_IDS.includes('rescan'), `the server's task list was not read: ${TASK_IDS.join(', ')}`);
  assert.match(code(read('app/admin/page.tsx')), /<div key=\{t\.id\} id=\{`task-\$\{t\.id\}`\} className="grid scroll-mt-4 /, 'the tasks have no id to land on');
  assert.equal(new Set(DESTINATIONS.map((d) => d.key)).size, DESTINATIONS.length, 'two destinations share a key');
});

test('it covers every page of both consoles, every setting, the profile\'s cards, the import and the names people use', () => {
  // v0.86.0: every row of the settings pages is a destination; v0.88.0 every page of the two lists too, all generated from
  // the registry (lib/settingsIndex*.ts; settingsIndex.test.ts holds the registry to the rows). The first page is the
  // console's bare address. Reintroduce by dropping the registry's destinations from DESTINATIONS: "a page is not a
  // destination" and "a setting is not a destination" fail, by name.
  for (const [index, path] of [[ADMIN_SETTINGS, '/admin/'], [PROFILE_SETTINGS, '/profile/']] as const) {
    const first = index.categories[0].id;
    for (const c of index.categories) {
      assert.ok(DESTINATIONS.some((d) => d.href === (c.id === first ? path : `${path}?tab=${c.id}`)), `a page is not a destination: ${path} ${c.id}`);
    }
    for (const e of index.entries) {
      assert.ok(DESTINATIONS.some((d) => d.href === `${path}?tab=${e.cat}&section=${e.id}`), `a setting is not a destination: ${path} ${e.id}`);
    }
  }
  assert.ok(DESTINATIONS.some((d) => d.href === '/admin/import/' && d.label === 'Import a list'), 'the import page is not a destination');
  for (const name of ['Check for updates', 'Notice chapters', '18+ filter', 'Source order', 'Slow archive', 'Nightly backup', 'Delete read chapters',
    'Scanlation groups', 'Cloudflare solver', 'Version', 'Rescan everything', 'Weekly goal', 'Translate pages', 'Tasks', 'Settings']) {
    assert.ok(DESTINATIONS.some((d) => d.label === name), `"${name}" is not found by name`);
  }
  // The names a section had before v0.86.0 still find where it went (lib/settingsIndex.admin.ts SETTINGS_NAME_ALIASES), and
  // the tab names before v0.88.0 the page they became. Reintroduce by dropping the aliases from the keywords: "an old name
  // finds nothing" fails.
  const keys = (q: string) => findDestinations(q, { ...viewer, limit: 50 }).map((d) => d.key);
  assert.ok(keys('scanlators').includes('admin-scanlators'), 'an old name finds nothing: Scanlators');
  assert.ok(keys('updates & schedules').includes('admin-cat-downloads'), 'an old name finds nothing: Updates & schedules');
  assert.ok(keys('library housekeeping').includes('admin-cat-maintenance'), 'an old name finds nothing: Library housekeeping');
  assert.ok(keys('backup time').includes('admin-nightly-backup'), 'the backup time is not found by its old name');
  const tasks = keys('tasks').slice(0, 2);
  assert.ok(tasks.includes('admin-cat-maintenance') && tasks.includes('admin-tasks'), `Tasks does not find Maintenance and its tasks first: ${tasks.join(', ')}`);
});

test('admins only where the page is theirs, and nothing Uchiyomi Desktop does not have', () => {
  // Reintroduce `admin: false` on an admin page, or forget `desktopHidden` on Members: named here. Reintroduce the
  // filter without the admin check: "a member is shown the admin's settings" fails.
  for (const d of DESTINATIONS) {
    assert.equal(!!d.admin, d.href.startsWith('/admin/'), `${d.key}: admin-only is wrong for ${d.href}`);
    const u = new URL(d.href, 'http://x');
    const tab = u.searchParams.get('tab') ?? '';
    // The pages Desktop has none of: their registry's `web` (lib/settingsIndex*.ts).
    const index = u.pathname === '/admin/' ? ADMIN_SETTINGS : u.pathname === '/profile/' ? PROFILE_SETTINGS : null;
    if (index?.categories.find((c) => c.id === tab)?.when?.includes('web')) {
      assert.ok(d.desktopHidden, `${d.key}: ${tab} is not on Desktop, and neither may its destination be`);
    }
  }
  // Desktop hides these settings and cards too (lib/desktop.ts, ProfileSettings, ProfileConnections, AdminSettings).
  for (const key of ['admin-registration', 'admin-mihon-missing', 'admin-install-count', 'admin-translate', 'profile-downloads', 'profile-cat-device',
    'profile-chapter-alerts', 'opds', 'api-tokens']) {
    assert.ok(DESTINATIONS.find((d) => d.key === key)?.desktopHidden, `${key} shows on Desktop, which has no such thing`);
  }
  const member = (q: string) => findDestinations(q, { ...viewer, admin: false, limit: 50 }).map((d) => d.key);
  assert.deepEqual(member('settings'), ['profile-settings'], 'a member is shown the admin\'s settings');
  assert.deepEqual(member('import'), [], 'a member is shown the import');
  assert.ok(findDestinations('settings', { ...viewer, limit: 50 }).some((d) => d.key === 'admin-settings'), 'an admin is not shown Admin → Settings');
  const desk = (q: string) => findDestinations(q, { ...viewer, desktop: true, limit: 50 }).map((d) => d.key);
  assert.ok(!desk('members').includes('admin-members'), 'Desktop is offered Members');
  assert.ok(!desk('api').includes('api-tokens'), 'Desktop is offered API tokens');
  assert.ok(desk('notice').includes('admin-notice-chapters'), 'Desktop loses what it does have');
});

test('a query finds by the label in the reader\'s language or in English, then by its words, best first', () => {
  // Reintroduce matching on the English label alone (drop `fold(label(d.label))`): "the label in the reader's language"
  // fails; match anywhere from two characters: "two letters inside a word" fails.
  const keysFor = (q: string, o: Partial<typeof viewer> = {}) => findDestinations(q, { ...viewer, ...o }).map((d) => d.key);
  assert.equal(keysFor('notice')[0], 'admin-notice-chapters');
  assert.equal(keysFor('import')[0], 'import');
  assert.equal(keysFor('Version')[0], 'version');
  // v0.55.4 (#150): Kedryn's words for it find Rescan everything.
  assert.equal(keysFor('rescan')[0], 'rescan');
  assert.ok(keysFor('deleted files').includes('rescan'), 'a word someone types for Rescan everything does not find it');
  assert.ok(keysFor('flaresolverr').includes('solver'), 'a word someone types for it does not find it');
  assert.ok(keysFor('mihon').includes('import'));
  assert.ok(keysFor('2fa').includes('two-factor'));
  assert.ok(keysFor('slow arch').includes('admin-slow-archive'), 'two words at the start of two words');
  // In the reader's language: the row's own words find it, and so does English.
  const de: Record<string, string> = { 'Notice chapters': 'Hinweis-Kapitel', Settings: 'Einstellungen', Appearance: 'Erscheinungsbild' };
  const label = (k: string) => de[k] ?? k;
  assert.equal(keysFor('kapitel', { label })[0], 'admin-notice-chapters', 'the label in the reader\'s language does not find it');
  assert.equal(keysFor('notice', { label })[0], 'admin-notice-chapters', 'English stops finding it in another language');
  assert.ok(keysFor('einstellungen', { label }).includes('profile-settings'));
  // Accents and case do not matter.
  assert.equal(fold('Paramètres'), 'parametres');
  assert.ok(keysFor('parametres', { label: (k) => (k === 'Settings' ? 'Paramètres' : k) }).includes('admin-settings'));
  // Nothing below two characters; nothing inside a word below three.
  assert.deepEqual(keysFor('n'), []);
  assert.deepEqual(keysFor('  '), []);
  assert.deepEqual(keysFor('pd'), [], 'two letters inside a word');  // "Updates", "Check for updates", "OPDS"
  // …except where words are not spaced: two characters inside a Japanese or Chinese label find it.
  assert.equal(keysFor('知ら', { label: (k) => (k === 'Notice chapters' ? 'お知らせの話' : k) })[0], 'admin-notice-chapters', 'a Japanese label is not found from its middle');
  assert.equal(keysFor('设置', { label: (k) => (k === 'Settings' ? '服务器设置' : k) })[0], 'admin-settings');
  assert.ok(keysFor('chedul').includes('admin-cat-downloads'), 'three letters inside a word do not find it');
  // At most six, unless the caller asks for more.
  assert.ok(keysFor('s').length === 0 && findDestinations('se', viewer).length <= 6);
  assert.ok(findDestinations('se', { ...viewer, limit: 50 }).length > 6, 'the limit is the only thing holding the list at six');
});

test('where a row says it is reads the way the page does', () => {
  // A setting says its category too since v0.86.0, as the page shows it.
  const notice = DESTINATIONS.find((d) => d.key === 'admin-notice-chapters')!;
  assert.equal(whereText(notice, false), 'Admin → Settings → Series & chapters');
  // Arabic writes these paths with "←" (its own translations of "Admin → Sources" do).
  assert.equal(whereText(notice, true), 'Admin ← Settings ← Series & chapters');
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
  // A page or a row of the console on screen is opened in place (v0.88.0, lib/consoleOnScreen.ts), first: its page may not
  // be the one on screen. Reintroduce the arrival alone: a setting on another page is a whole page load again.
  assert.match(goTo, /onClose\(\);\s*if \(openInConsole\(href\)\) return;\s*const how = arrival\(href, window\.location, \(id\) => !!document\.getElementById\(id\)\);/,
    'a page or a setting of the console on screen is not opened in place');
  assert.match(goTo, /if \(how === 'push'\) router\.push\(href\);\s*else if \(how === 'load'\) window\.location\.assign\(href\);/, 'another page of this console is pushed before it is drawn');
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

test('a destination\'s card is scrolled to once it has loaded, on both consoles', () => {
  // Reintroduce the scroll on mount (no wait for the card): the "Loading…" of a settings page has no card yet, so it
  // never lands -- "the arrival does not wait for its card" fails.
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
