// Reader settings pinned to a SOURCE: global default < source default < this series.
//
// The store is the per-series memory's sibling and rides the same settings blob, so the ways it can go wrong
// are the ways two maps sharing one localStorage can: a source default collected as if it were a series
// override (the per-series collector scans by key prefix), a forgotten default that is still pushed up, and a
// default saved on another device that never arrives here. These tests drive the real module against a
// stubbed server and read the PUT bodies it sends.
import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_API_BASE = '';

// Both stubs go in BEFORE the dynamic imports below: the module returns defaults without touching storage when
// there is no `window`, and `api.ts` seeds itself from localStorage at load.
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  get length() { return mem.size; },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
(globalThis as any).window = globalThis;

/** What the stubbed server answers a GET with, and every PUT body it was sent. */
let serverBlob: Record<string, unknown> = {};
const putBodies: any[] = [];
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (method === 'PUT') {
    putBodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify(serverBlob), { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

let prefs: typeof import('../lib/readerPrefs');
before(async () => {
  prefs = await import('../lib/readerPrefs');
  // The push loads `api.ts` lazily; load it here so a flush below is not racing the first import.
  await import('../lib/api');
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Fire the 1.5 s debounce and wait for its PUT to reach the stub. */
async function flush() {
  const before = putBodies.length;
  mock.timers.tick(1500);
  for (let i = 0; i < 200 && putBodies.length === before; i++) await settle();
  await settle();
}

test('a source default is pushed as readerSource, never as a series override', async (t) => {
  // `allSeriesPrefs()` collects every key under the per-series prefix and pushes it as `readerSeries[id]`. A
  // source default stored under that prefix would arrive on every other device as a SERIES override keyed by
  // a source id -- inert at best, and the source default itself would never sync.
  // Reintroduce by setting SOURCE_KEY to 'yomi_rs_' in lib/readerPrefs.ts.
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); mem.clear(); putBodies.length = 0; });
  mem.clear(); putBodies.length = 0;

  prefs.saveSourcePrefs('webtoon-src', { mode: 'vertical', theme: 'gray' });
  prefs.saveSeriesPrefs('series-1', { zoom: 1.5 });
  assert.deepEqual(prefs.loadSourcePrefs('webtoon-src'), { mode: 'vertical', theme: 'gray' });
  await flush();

  assert.equal(putBodies.length, 1, 'the two writes were not debounced into one push');
  const body = putBodies[0];
  assert.deepEqual(body.readerSource, { 'webtoon-src': { mode: 'vertical', theme: 'gray' } }, 'the source default was not pushed');
  assert.deepEqual(Object.keys(body.readerSeries), ['series-1'], 'a source default leaked into the per-series map');
});

test('forgetting a source default removes it locally and from the next push', async (t) => {
  // The server merges the blob per top-level key, so the next push replaces `readerSource` whole: dropping
  // the entry here is what removes it from the account.
  // Reintroduce by making clearSourcePrefs a no-op.
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); mem.clear(); putBodies.length = 0; });
  mem.clear(); putBodies.length = 0;

  prefs.saveSourcePrefs('manga-src', { mode: 'paged' });
  prefs.saveSourcePrefs('webtoon-src', { mode: 'vertical' });
  await flush();
  prefs.clearSourcePrefs('manga-src');
  await flush();

  assert.deepEqual(prefs.loadSourcePrefs('manga-src'), {}, 'the forgotten default is still stored locally');
  assert.deepEqual(putBodies.at(-1).readerSource, { 'webtoon-src': { mode: 'vertical' } }, 'the forgotten default was pushed again');
});

test('a pull adopts source defaults saved on another device', async (t) => {
  // Reintroduce by deleting the `s?.readerSource` block in syncPrefsFromServer.
  t.after(() => { mem.clear(); putBodies.length = 0; });
  mem.clear(); putBodies.length = 0;
  serverBlob = { reader: { theme: 'amoled' }, readerSource: { 'manga-src': { mode: 'paged', spread: true } } };

  await prefs.syncPrefsFromServer();
  assert.deepEqual(prefs.loadSourcePrefs('manga-src'), { mode: 'paged', spread: true });
  assert.deepEqual(prefs.loadSeriesPrefs('manga-src'), {}, 'a source default was adopted as a series override');
});

test("a change made in the reader never makes a title's look the global default", () => {
  // The reader's live prefs are the global default with the source's and the series' settings laid over it.
  // Saving them wholesale made one source's paged mode everyone's default -- even on a brightness change.
  const inSeries = prefs.globalPrefsChange({ mode: 'paged', theme: 'sepia', spread: true, pagedDirection: 'rtl', brightness: 80 } as any, true);
  assert.deepEqual(inSeries, { brightness: 80 }, 'only the non-look change reaches the global default');
  assert.deepEqual(prefs.globalPrefsChange({ mode: 'paged' }, true), {}, 'a look change alone writes nothing global');
  // Outside a title (the profile's reader defaults) everything is the global default, as before.
  assert.deepEqual(prefs.globalPrefsChange({ mode: 'paged', theme: 'sepia' }, false), { mode: 'paged', theme: 'sepia' });
});

test("the series' source is remembered for opening it offline, and junk reads back as nothing", () => {
  // Downloaded chapters name no source, so the per-source default is keyed by the series' source, which the
  // reader learns online and keeps here.
  prefs.rememberSeriesSource('series-1', { id: '8683375824843625513', name: 'Aqua Manga' });
  assert.deepEqual(prefs.seriesSourceOf('series-1'), { id: '8683375824843625513', name: 'Aqua Manga' });
  assert.equal(prefs.seriesSourceOf('series-never-opened'), null);
  localStorage.setItem('yomi_srcof_series-2', '{not json');
  assert.equal(prefs.seriesSourceOf('series-2'), null);
  localStorage.setItem('yomi_srcof_series-3', JSON.stringify({ id: '', name: 'x' }));
  assert.equal(prefs.seriesSourceOf('series-3'), null, 'an empty id is no source');
});

test('the reading direction is part of a series\' and a source\'s remembered look', () => {
  prefs.saveSourcePrefs('src-manga', { mode: 'paged', pagedDirection: 'rtl' });
  assert.equal(prefs.loadSourcePrefs('src-manga').pagedDirection, 'rtl');
  prefs.saveSeriesPrefs('series-9', { pagedDirection: 'ltr' });
  assert.equal(prefs.loadSeriesPrefs('series-9').pagedDirection, 'ltr');
  assert.ok(prefs.LOOK_KEYS.includes('pagedDirection'));
});

// ---- #102: the profile's reading direction has to reach a title someone has adjusted ----
//
// v0.46.0 pinned the direction in force into a title's memory on EVERY change of mode, theme or spread. The
// direction in force is usually `series`, inherited from the profile, so a manga switched to paged or to sepia
// was frozen at "Series default" from then on and Profile → Settings → Reading direction never reached it.

test('a change to the look does not pin the direction', () => {
  // Reintroduce by adding `pagedDirection: n.pagedDirection` to seriesPinChange's look.
  const n = { ...prefs.DEFAULT_PREFS, mode: 'paged' as const, theme: 'sepia' as const, pagedDirection: 'series' as const };
  assert.deepEqual(prefs.seriesPinChange({ theme: 'sepia' }, n), { mode: 'paged', theme: 'sepia', spread: false },
    'a theme change pinned the inherited direction too');
  assert.deepEqual(prefs.seriesPinChange({ mode: 'paged' }, n), { mode: 'paged', theme: 'sepia', spread: false });
  assert.deepEqual(prefs.seriesPinChange({ spread: true }, { ...n, spread: true }), { mode: 'paged', theme: 'sepia', spread: true });
  // A change to the direction IS a choice, and says so.
  assert.deepEqual(prefs.seriesPinChange({ pagedDirection: 'rtl' }, { ...n, pagedDirection: 'rtl' }),
    { mode: 'paged', theme: 'sepia', spread: false, pagedDirection: 'rtl', directionChosen: true });
  // Nothing about the look changed: nothing is pinned.
  assert.equal(prefs.seriesPinChange({ brightness: 0.5 }, n), null);
  assert.equal(prefs.seriesPinChange({ gap: 4 }, n), null);
});

test("the profile's direction reaches a title whose look was changed in the reader", async (t) => {
  // The whole chain the reader runs: the sheet's change goes through setPref's rule into the title's memory,
  // the profile then changes, and the reader lays the title's memory over the (new) default.
  // (Mock timers and a flush so the save's debounced push does not outlive the test: a pull yields to a
  // pending push, and a later test's pull would silently adopt nothing.)
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); mem.clear(); putBodies.length = 0; });
  mem.clear(); putBodies.length = 0;
  // The profile said Left to right when the title was adjusted -- an inherited value normaliseSeriesPrefs
  // cannot tell from a choice, so only seriesPinChange keeps it out of the title's memory.
  const before = { ...prefs.DEFAULT_PREFS, pagedDirection: 'ltr' as const };
  const shown = { ...before, mode: 'paged' as const, theme: 'sepia' as const };
  prefs.saveSeriesPrefs('manga-1', prefs.seriesPinChange({ mode: 'paged', theme: 'sepia' }, shown)!);

  const profile = { ...prefs.DEFAULT_PREFS, pagedDirection: 'rtl' as const };
  const look = prefs.withTitleLook(profile, prefs.loadSeriesPrefs('manga-1'));
  assert.equal(look.pagedDirection, 'rtl', 'the profile\'s Right to left did not reach the adjusted title');
  assert.equal(look.mode, 'paged', 'the title lost its own mode');
  assert.equal(look.theme, 'sepia', 'the title lost its own theme');
  await flush();
  assert.equal(putBodies.at(-1).readerSeries['manga-1'].pagedDirection, undefined, 'the inherited direction was pushed as a pin');
});

test('a stored Series default pin from before v0.48 no longer hides the profile\'s direction', async (t) => {
  // What v0.46.0/v0.47.0 left in every adjusted title's memory, locally and in the account's settings row.
  // Reintroduce by returning `raw` unchanged from normaliseSeriesPrefs.
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); mem.clear(); putBodies.length = 0; });
  mem.clear(); putBodies.length = 0;
  mem.set('yomi_rs_manga-2', JSON.stringify({ mode: 'paged', theme: 'sepia', spread: false, pagedDirection: 'series', zoom: 1.2 }));

  assert.deepEqual(prefs.loadSeriesPrefs('manga-2'), { mode: 'paged', theme: 'sepia', spread: false, zoom: 1.2 });
  const profile = { ...prefs.DEFAULT_PREFS, mode: 'paged' as const, pagedDirection: 'rtl' as const };
  assert.equal(prefs.withTitleLook(profile, prefs.loadSeriesPrefs('manga-2')).pagedDirection, 'rtl');

  // The same pin arriving from the account (another device, or this one before an update) is read the same way.
  serverBlob = { readerSeries: { 'manga-3': { mode: 'paged', pagedDirection: 'series' } } };
  await prefs.syncPrefsFromServer();
  assert.deepEqual(prefs.loadSeriesPrefs('manga-3'), { mode: 'paged' });

  // And the cleaned memory is what goes back up, so the account's row stops carrying it.
  prefs.saveSeriesPrefs('manga-2', { zoom: 1.5 });
  await flush();
  assert.deepEqual(putBodies.at(-1).readerSeries['manga-2'], { mode: 'paged', theme: 'sepia', spread: false, zoom: 1.5 });
  assert.equal(putBodies.at(-1).readerSeries['manga-3'].pagedDirection, undefined);
});

test('a direction chosen for one title is kept, Series default included', async (t) => {
  // The mark is what separates "Series default, chosen for this title while the profile says Right to left"
  // from the inherited pin above; without it the choice would be dropped on the next read.
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); mem.clear(); putBodies.length = 0; });
  mem.clear(); putBodies.length = 0;
  const n = { ...prefs.DEFAULT_PREFS, mode: 'paged' as const, pagedDirection: 'series' as const };
  prefs.saveSeriesPrefs('webtoon-1', prefs.seriesPinChange({ pagedDirection: 'series' }, n)!);
  assert.equal(prefs.loadSeriesPrefs('webtoon-1').pagedDirection, 'series');
  const profile = { ...prefs.DEFAULT_PREFS, pagedDirection: 'rtl' as const };
  assert.equal(prefs.withTitleLook(profile, prefs.loadSeriesPrefs('webtoon-1')).pagedDirection, 'series');

  // A later look change leaves the chosen direction where it was.
  prefs.saveSeriesPrefs('webtoon-1', prefs.seriesPinChange({ theme: 'gray' }, { ...n, theme: 'gray' })!);
  assert.equal(prefs.loadSeriesPrefs('webtoon-1').pagedDirection, 'series');

  // Right to left or left to right stored by those builds is kept: it is what choosing one for a title wrote,
  // the very workaround #102 describes, and a choice is not ours to throw away.
  mem.set('yomi_rs_manga-4', JSON.stringify({ mode: 'paged', pagedDirection: 'rtl' }));
  assert.equal(prefs.loadSeriesPrefs('manga-4').pagedDirection, 'rtl');
  // Junk in storage reads as nothing rather than throwing.
  mem.set('yomi_rs_manga-5', JSON.stringify(['x']));
  assert.deepEqual(prefs.loadSeriesPrefs('manga-5'), {});
  // The mark travels with the pin to the account, so another device keeps the choice too.
  await flush();
  assert.deepEqual(putBodies.at(-1).readerSeries['webtoon-1'],
    { mode: 'paged', theme: 'gray', spread: false, pagedDirection: 'series', directionChosen: true });
});

test("the series' type is remembered for opening it offline, and junk reads back as nothing (v0.61.0)", () => {
  // The automatic mode reads `seriesType`, which only the server knows; offline it reads what this device last saw.
  // Reintroduce by keying it under `yomi_rs_`: the push below would carry it as a series override.
  prefs.rememberSeriesType('series-1', 'manhwa');
  assert.equal(prefs.seriesTypeOf('series-1'), 'manhwa');
  assert.equal(prefs.seriesTypeOf('series-never-opened'), null);
  prefs.rememberSeriesType('series-2', 'novel' as any);
  assert.equal(prefs.seriesTypeOf('series-2'), null, 'an unknown type was kept');
  localStorage.setItem('yomi_stype_series-3', 'scroll');
  assert.equal(prefs.seriesTypeOf('series-3'), null, 'junk in storage reads as a type');
  assert.ok(![...mem.keys()].some((k) => k.startsWith('yomi_rs_') || k.startsWith('yomi_rp_')), 'the type was stored where the account sync collects');
  mem.clear();
});

test('a library\'s reading defaults sit under the source\'s and the series\' own (#235)', async () => {
  const { titleLook, DEFAULT_PREFS } = prefs;
  const lib = { mode: 'paged' as const, spread: true, pagedDirection: 'rtl' as const };
  // The reader hands titleLook the library look with the source's laid over it.
  const l = titleLook({ ...DEFAULT_PREFS, theme: 'sepia' }, { ...lib }, {});
  assert.deepEqual([l.prefs.mode, l.prefs.spread, l.prefs.pagedDirection], ['paged', true, 'rtl']);
  assert.equal(l.prefs.theme, 'sepia', "the reader's own theme stands: a library holds none");
  const s = titleLook({ ...DEFAULT_PREFS }, { ...lib, ...{ mode: 'vertical' as const } }, {});
  assert.equal(s.prefs.mode, 'vertical', "the source's mode beats the library's");
  assert.equal(s.prefs.spread, true, 'and the rest still comes from the library');
  const own = titleLook({ ...DEFAULT_PREFS }, { ...lib }, { mode: 'vertical' });
  assert.equal(own.prefs.mode, 'vertical', "the series' own mode beats the library's");
  // A theme in a stored or served look is dropped, like any key a library may not hold.
  assert.deepEqual(prefs.cleanLibraryLook({ mode: 'paged', theme: 'sepia', zoom: 2 }), { mode: 'paged' });
  assert.equal(prefs.cleanLibraryLook({ theme: 'gray' }), null);
  // The reader does that merge (and asks an admin's sheet for the library's name) -- reintroduce by dropping the library look.
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  assert.match(src, /\{ \.\.\.\(libLook \?\? \{\}\), \.\.\.\(src \? loadSourcePrefs\(src\.id\) : \{\}\) \}/);
  assert.match(src, /libraryName=\{seriesLibrary\?\.name\}/);
  // What the admin's key saves: the content's look, never the theme.
  assert.match(src, /const look: LibraryLook = \{ mode: prefs\.mode, spread: prefs\.spread, pagedDirection: prefs\.pagedDirection \};/,
    'the library key saves something other than mode, pages per view and direction');
});

test("offline, the library's defaults the device last saw (#235)", async () => {
  // Online, the reader remembers what the series answered; offline (the series request fails) it reads that back.
  prefs.rememberLibraryLook('series-lib', { mode: 'paged', spread: true, theme: 'sepia' });
  assert.deepEqual(prefs.libraryLookOf('series-lib'), { mode: 'paged', spread: true });
  // A library whose defaults were cleared clears the memory, so the old look does not linger offline.
  prefs.rememberLibraryLook('series-lib', null);
  assert.equal(prefs.libraryLookOf('series-lib'), null);
  localStorage.setItem('yomi_liblook_series-junk', '{"mode":"sideways"');
  assert.equal(prefs.libraryLookOf('series-junk'), null, 'junk in storage reads as a look');
  prefs.rememberLibraryLook('series-lib', { pagedDirection: 'rtl' });
  assert.ok(![...mem.keys()].some((k) => k.startsWith('yomi_rs_') || k.startsWith('yomi_rp_')), 'the look was stored where the account sync collects');
  mem.clear();
  // Wired: remembered from the series' answer, read back in the offline branch.
  // Reintroduce by dropping either line: the matching assertion fails.
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  assert.match(src, /libLook = s\?\.libraryReader \?\? null;\s*rememberLibraryLook\(first\.seriesId, libLook\);/, 'the answer is not remembered');
  assert.match(src, /libLook = libraryLookOf\(first\.seriesId\);/, 'offline does not read the remembered look');
});

test('the library key asks first: it changes the look for every account (#235)', async () => {
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const sheet = readFileSync(join(__dirname, '..', 'components/ReaderSettings.tsx'), 'utf8');
  const row = sheet.slice(sheet.indexOf("<Row label={tr('This library')}>"), sheet.indexOf("<Row label={tr('This source')}>"));
  assert.ok(row.length > 0, 'the library row is gone');
  // Reintroduce the one-tap save (`onClick={onLibraryDefault}` on the first key): the first assertion fails.
  assert.match(row, /<button onClick=\{\(\) => setAskLibrary\(true\)\}[^>]*data-library-default>/, 'the first tap saves instead of asking');
  assert.equal((row.match(/onLibraryDefault\(\)/g) ?? []).length, 1, 'something other than the confirming key saves');
  assert.match(row, /setAskLibrary\(false\); onLibraryDefault\(\);[^>]*data-library-default-save/, 'the confirming key does not save');
});
