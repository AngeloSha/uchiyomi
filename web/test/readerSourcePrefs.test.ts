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
