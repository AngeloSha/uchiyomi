// A series is asked for at the click that opens it (lib/seriesPrefetch.ts, "make it faster", 2026-10-15). The next page
// only mounts once the last has faded (260 ms), so its queries used to start a whole fade after the click. Every guard
// names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { seriesBooksQuery, seriesClicked, seriesQuery } from '../lib/seriesPrefetch';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const ORIGIN = 'https://manga.example';

/** A click on an element inside a link to `href` (null: no link around it). */
const click = (href: string | null, mods: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => {
  const a = href == null ? null : { getAttribute: (n: string) => (n === 'href' ? href : null) };
  const target = { closest: (sel: string) => (sel === 'a[href]' ? a : null) } as unknown as EventTarget;
  return { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods, target };
};

test('a plain click on a link to a series names that series', () => {
  assert.equal(seriesClicked(click('/series/?id=s_abc'), ORIGIN), 's_abc');
  assert.equal(seriesClicked(click('/series?id=s_abc&ch=12'), ORIGIN), 's_abc');
  assert.equal(seriesClicked(click(`${ORIGIN}/series/?id=s_abc`), ORIGIN), 's_abc');
});

test('anything else asks for nothing', () => {
  // A new tab or window (and a right or middle click) opens nothing here: that page asks for itself.
  for (const mods of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }])
    assert.equal(seriesClicked(click('/series/?id=s_abc', mods), ORIGIN), null, JSON.stringify(mods));
  assert.equal(seriesClicked(click(null), ORIGIN), null, 'not on a link');
  assert.equal(seriesClicked(click('/library/'), ORIGIN), null, 'another page');
  assert.equal(seriesClicked(click('/series/'), ORIGIN), null, 'no series named');
  assert.equal(seriesClicked(click('/reader/?id=b_1'), ORIGIN), null, 'the reader');
  assert.equal(seriesClicked(click('https://anilist.co/series/?id=1'), ORIGIN), null, 'another site');
  assert.equal(seriesClicked({ ...click(null), target: null }, ORIGIN), null);
});

test('the prefetch and the page ask the cache the same two questions', () => {
  // The keys every invalidation in the app uses (app/series/page.tsx, SeriesEditor, FindMissingDialog...).
  assert.deepEqual(seriesQuery('s1').queryKey, ['series', 's1']);
  assert.deepEqual(seriesBooksQuery('s1').queryKey, ['series-books', 's1']);
  const lib = read('lib/seriesPrefetch.ts');
  assert.match(lib, /queryFn: \(\) => api<Series>\(`\/api\/series\/\$\{id\}`\)/);
  assert.match(lib, /queryFn: \(\) => fetchAllBooks\(id\)/, 'the chapters must come through fetchAllBooks, past the first 1000');
  const page = read('app/series/page.tsx');
  assert.match(page, /useQuery\(\{ \.\.\.seriesQuery\(id\), enabled: !!id \}\)/,
    'the series page asks for the series itself again: a prefetched answer and the page\'s own can drift apart');
  assert.match(page, /useQuery\(\{ \.\.\.seriesBooksQuery\(id\), enabled: !!id \}\)/);
  assert.doesNotMatch(page, /queryKey: \['series(-books)?', id\],\s*queryFn/, 'a second definition of the same query');
});

test('it listens for clicks, before the link navigates, wherever someone is signed in', () => {
  const lib = read('lib/seriesPrefetch.ts');
  // A click, never a press: a press can start a scroll, and a phone would ask for every series a thumb went past.
  assert.match(lib, /document\.addEventListener\('click', on, true\);/);
  assert.doesNotMatch(lib, /addEventListener\('(pointerdown|mousedown|touchstart)'/);
  assert.match(lib, /document\.removeEventListener\('click', on, true\);/);
  const shell = read('components/AppShell.tsx');
  const hook = shell.indexOf("usePrefetchSeriesOnClick(status === 'authed');");
  assert.ok(hook > 0, 'AppShell no longer turns the prefetch on');
  assert.ok(hook < shell.indexOf("if (status === 'loading') return"), 'a hook below an early return breaks the hook order');
});
