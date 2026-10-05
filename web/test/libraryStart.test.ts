// "Import your library" where a new owner starts (v0.55.4, #158).
//
// DannyDynamite39: "I have found the import, god damn it's way too buried, it should be the first thing that gets
// recommended when the server is set up." It was Admin → Sources → Add sources → Import a list, while a new server
// opened on a Library that said "Your library is empty." and nothing else, and a Home whose one key, "Browse library",
// led to that page. No browser walk ever sees an empty library (test/e2e/up.sh seeds one), so the wiring is read from
// source here, and who is offered what is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DISCOVER_HREF, IMPORT_HREF, startKeys } from '../lib/libraryStart';

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

test('the import for admins, Discover for whoever may add series, in that order, and nothing for anyone else', () => {
  // Reintroduce the import for everyone (`out.push('import')` without `if (isAdmin)`): a member is handed a key to a page
  // that says "Admins only." -- "a member is handed the admin-only import" fails.
  assert.deepEqual(startKeys({ isAdmin: true, mayDownload: true }), ['import', 'discover'], 'not the import first, then Discover');
  assert.deepEqual(startKeys({ isAdmin: false, mayDownload: true }), ['discover'], 'a member is handed the admin-only import');
  assert.deepEqual(startKeys({ isAdmin: false, mayDownload: false }), [], 'someone who may add nothing is handed a key');
  // The addresses are real pages; the import's trailing slash is load-bearing in the static export.
  assert.equal(IMPORT_HREF, '/admin/import/');
  assert.ok(existsSync(join(ROOT, 'app/admin/import/page.tsx')) && existsSync(join(ROOT, 'app/discover/page.tsx')));
  assert.equal(DISCOVER_HREF, '/discover/');
});

test('the empty Library says how to fill it, and only when it is empty for this viewer with nothing filtered', () => {
  // Reintroduce the plain "Your library is empty." paragraph: "the empty library offers no way to fill it" fails; test
  // `!items.length` where `total === 0` is: an answer that failed would claim the library is empty.
  const lib = code(read('app/library/page.tsx'));
  assert.match(lib, /\{!isLoading && total === 0 && !activeCount && \(\s*<EmptyState art=\{ART\.emptyLibrary\} title=\{tr\('Your library is empty\.'\)\}>\s*<LibraryStart \/>\s*<\/EmptyState>/,
    'the empty library offers no way to fill it');
  assert.equal((lib.match(/tr\('Your library is empty\.'\)/g) ?? []).length, 1, 'a second, bare "Your library is empty." is back');
  assert.match(lib, /\{!isLoading && !items\.length && activeCount > 0 && \(\s*<p [^>]*>\{tr\('Nothing matches those filters\.'\)\}<\/p>/, 'a filtered empty grid no longer says so');
  // The keys themselves: who may, from the auth context, through the pure rule above.
  const start = code(read('components/LibraryStart.tsx'));
  assert.match(start, /const keys = startKeys\(\{ isAdmin, mayDownload: status === 'authed' && canDownload\(user\) \}\);/, 'the keys are not decided by who is looking');
  // The import's line right under the import key (at its width), not under whichever key happens to wrap last.
  assert.match(start, /<Link href=\{IMPORT_HREF\} className=\{`\$\{cls\} whitespace-nowrap`\}[^>]*>\s*<IcImport [^>]*\/>\{tr\('Import your library'\)\}\s*<\/Link>\s*<p [^>]*>\s*\{tr\('From a Mihon or Tachiyomi backup, a MangaDex list, your AniList, MyAnimeList or Kitsu list, or pasted titles'\)\}/,
    'the import does not say what it takes');
  assert.match(start, /<Link key=\{k\} href=\{DISCOVER_HREF\}[^>]*>\s*<IcPlus [^>]*\/>\{tr\('Find series in Discover'\)\}/);
  assert.match(start, /if \(!keys\.length\) \{\s*return <p [^>]*>\{tr\('Ask whoever runs this server to add some series\.'\)\}<\/p>;/, 'someone who may add nothing is not told who can');
  // A key never wider than its row: the Russian Discover key ran off a 320 px Home, clipped by the hero.
  assert.match(start, /const cls = `btn-key h-auto min-h-10 max-w-full [^`]*`;/, 'a long key can run off a narrow screen');
  // Keys, not capsules ("no more pills").
  assert.doesNotMatch(start, /btn-accent|btn-ghost|\bchip\b|rounded-full/, 'a pill-shaped key is back');
});

test('the Library header has the import for admins, beside where Add lives', () => {
  // Reintroduce the header without it: "the Library has no import entry for admins" fails. A double-quoted JSX href, and
  // never in admin/page.tsx or SourcesPanel.tsx, whose one door importBatch.test.ts counts.
  const lib = code(read('app/library/page.tsx'));
  const header = slice(lib, '<header className="safe-top sticky top-0 z-30', '{mayDownload && <ViewSwitch');
  const doors = [...header.matchAll(/\{isAdmin && \(\s*<Link href="\/admin\/import\/" data-library-import ([^>]*)>/g)].map((m) => m[1]);
  assert.equal(doors.length, 2, 'the Library has no import entry for admins');
  assert.match(doors[0], /className="btn-key hidden lg:inline-flex"/, 'the wide screen does not get the labelled key');
  assert.match(doors[1], /aria-label=\{tr\('Import a list'\)\}[\s\S]*lg:hidden/, 'the phone does not get the round key, or it has no name');
  assert.ok(header.indexOf('data-library-import title=') < header.indexOf('href="/discover"'), 'the phone\'s import is not beside Add');
  // With a fourth round key the row was 25-29 px wider than a 320 px screen in French and Russian: the title gives way.
  assert.match(header, /<h1 className="min-w-0 truncate [^"]*">\{tr\('Library'\)\}<\/h1>\s*<div className="flex shrink-0 items-center gap-2">/,
    'the header row can be pushed past a narrow screen');
});

test('Home\'s welcome offers the same keys, and is never shown for the second before the carousel arrives', () => {
  // Reintroduce "Browse library" in the welcome: "Home's welcome does not offer the import" fails; drop
  // `|| featuredPending`: a full library's admin sees "Import your library" flash before its carousel -- "the welcome
  // shows while /api/featured is on its way" fails.
  const home = code(read('app/page.tsx'));
  const hero = slice(home, '{(featured?.content?.length ?? 0) > 0 ? (', '<div className="flex items-center justify-between gap-3 px-5 pt-6 lg:px-0">');
  assert.match(hero, /\) : isLoading \|\| featuredPending \? \(\s*<div className="skeleton/, 'the welcome shows while /api/featured is on its way');
  assert.match(home, /const \{ data: featured, isPending: featuredPending \} = useQuery\(\{ queryKey: \['featured'\]/);
  const welcome = slice(hero, "{tr('Welcome to Uchiyomi')}", '</div>');
  assert.match(welcome, /<LibraryStart align="start" \/>/, 'Home\'s welcome does not offer the import');
  assert.doesNotMatch(welcome, /Browse library/, 'the welcome still sends people to the empty Library');
});
