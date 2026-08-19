// Adapters built from a Suwayomi extension server's GraphQL responses.
//
// The responses below are real shapes captured from Suwayomi-Server v2.2.2100 by introspecting and calling
// it, then written here as code rather than committed as blobs, so a schema change surfaces as a failing
// expectation instead of a mystery. The GraphQL client is injected, so nothing here touches the network.
//
// What these pin: the id namespacing that keeps lib_series.source_id routable, the capability reporting the
// loader duck-types, and -- most importantly -- that a malformed or empty response yields NOTHING rather
// than garbage entries, because an adapter that invents series and chapters would quietly poison a library.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';

const load = () => import('../src/lib/sources/suwayomi/sources');

const LOCAL = { id: '0', name: 'Local source', displayName: 'Local source', lang: 'en', supportsLatest: true };

/** A fake `gql` that answers from a map of operation-name -> payload. */
const fakeGql = (answers: Record<string, unknown>, seen: string[] = []) =>
  (async (query: string, variables: Record<string, unknown> = {}) => {
    const op = /fetchSourceManga/.test(query) ? 'fetchSourceManga'
      : /fetchChapters/.test(query) ? 'fetchChapters'
      : /fetchChapterPages/.test(query) ? 'fetchChapterPages'
      : /fetchManga/.test(query) ? 'fetchManga'
      : 'sources';
    seen.push(`${op}:${JSON.stringify(variables)}`);
    if (!(op in answers)) throw new Error(`unexpected operation ${op}`);
    return answers[op];
  }) as never;

test('search maps a source manga list onto series', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchSourceManga: { fetchSourceManga: { mangas: [
      { id: 1, title: 'Bridge Test Manga', thumbnailUrl: '/api/v1/manga/1/thumbnail', realUrl: null,
        description: 'A fixture.', author: 'Someone', genre: ['Action', 'Drama'], status: 'ONGOING' },
    ] } },
  }));
  const [s] = await a.search('bridge');
  assert.equal(s.sourceId, '1');            // Suwayomi's own manga id — what listChapters needs back
  assert.equal(s.source, 'sw:0');
  assert.equal(s.title, 'Bridge Test Manga');
  assert.equal(s.author, 'Someone');
  assert.deepEqual(s.genres, ['Action', 'Drama']);
  assert.equal(s.status, 'Ongoing');
  // covers come back server-relative and must be absolute for the image proxy to fetch them
  assert.equal(s.coverUrl, 'http://suwayomi.test:4567/api/v1/manga/1/thumbnail');
});

test('adapter ids are namespaced so they can never collide with a built-in or custom site', async () => {
  const { makeSuwayomiAdapter, swAdapterId, isSwAdapterId } = await load();
  assert.equal(swAdapterId('0'), 'sw:0');
  assert.equal(isSwAdapterId('sw:0'), true);
  assert.equal(isSwAdapterId('mangadex'), false);
  assert.equal(makeSuwayomiAdapter({ id: '9999', name: 'X' }, fakeGql({})).id, 'sw:9999');
});

test('the adapter satisfies what the loader requires', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({})) as unknown as Record<string, unknown>;
  // mirrors loader.ts's isAdapter predicate
  assert.equal(typeof a.id, 'string');
  assert.equal(typeof a.name, 'string');
  for (const m of ['search', 'getSeries', 'listChapters', 'getPageUrls']) {
    assert.equal(typeof a[m], 'function', `missing ${m}`);
  }
});

test('latest is claimed only when the extension supports it', async () => {
  const { makeSuwayomiAdapter } = await load();
  // the loader duck-types this, and GET /api/sources reports the capability from the method's presence
  assert.equal(typeof makeSuwayomiAdapter(LOCAL, fakeGql({})).latest, 'function');
  assert.equal(makeSuwayomiAdapter({ ...LOCAL, supportsLatest: false }, fakeGql({})).latest, undefined);
});

test('chapters come back ascending, deduped, with dates', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchChapters: { fetchChapters: { chapters: [
      { id: 33, chapterNumber: 3, name: 'Chapter 3', pageCount: -1, uploadDate: '1787177865027' },
      { id: 1, chapterNumber: 1, name: 'Chapter 1', pageCount: 3, uploadDate: '1787177840210' },
      { id: 2, chapterNumber: 2, name: 'Chapter 2', pageCount: 3, uploadDate: '1787177840269' },
      { id: 99, chapterNumber: 2, name: 'Chapter 2 (dupe scanlation)', pageCount: 3 },
    ] } },
  }));
  const cs = await a.listChapters('1');
  assert.deepEqual(cs.map((c) => c.number), [1, 2, 3]);
  assert.equal(cs[0].sourceId, '1');
  // pageCount -1 means "not counted yet" and must not be reported as a real page count
  assert.equal(cs[2].pages, undefined);
  assert.equal(cs[0].pages, 3);
  assert.equal(cs[0].publishedAt, new Date(1787177840210).toISOString());
});

test('page urls are made absolute against the extension server', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchChapterPages: { fetchChapterPages: { pages: [
      '/api/v1/manga/1/chapter/1/page/0', '/api/v1/manga/1/chapter/1/page/1',
    ] } },
  }));
  assert.deepEqual(await a.getPageUrls('1'), [
    'http://suwayomi.test:4567/api/v1/manga/1/chapter/1/page/0',
    'http://suwayomi.test:4567/api/v1/manga/1/chapter/1/page/1',
  ]);
});

test('an absolute page url is left alone', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchChapterPages: { fetchChapterPages: { pages: ['https://cdn.example.org/p/1.jpg'] } },
  }));
  assert.deepEqual(await a.getPageUrls('1'), ['https://cdn.example.org/p/1.jpg']);
});

test('junk in a response produces nothing, never invented entries', async () => {
  const { makeSuwayomiAdapter } = await load();
  // a series with no title, or a chapter with no usable number, cannot be acted on. Dropping them is the
  // only safe answer: a fabricated "Chapter 0" would collide with a real one and corrupt the library.
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchSourceManga: { fetchSourceManga: { mangas: [
      { id: 1, title: '   ' }, { id: 2 }, { title: 'no id' }, null,
    ] } },
    fetchChapters: { fetchChapters: { chapters: [
      { id: 1, chapterNumber: null }, { id: 2, chapterNumber: NaN }, { chapterNumber: 4 },
      { id: 3, chapterNumber: -1 }, null,
    ] } },
    fetchChapterPages: { fetchChapterPages: { pages: ['', '   ', null, 42] } },
  }));
  assert.deepEqual(await a.search('x'), []);
  assert.deepEqual(await a.listChapters('1'), []);
  assert.deepEqual(await a.getPageUrls('1'), []);
});

test('a response missing its payload entirely is survivable', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchSourceManga: {}, fetchChapters: { fetchChapters: {} }, fetchChapterPages: { fetchChapterPages: { pages: null } },
    fetchManga: { fetchManga: { manga: null } },
  }));
  assert.deepEqual(await a.search('x'), []);
  assert.deepEqual(await a.listChapters('1'), []);
  assert.deepEqual(await a.getPageUrls('1'), []);
  assert.equal(await a.getSeries('1'), null);
});

test('search and latest ask for the right thing', async () => {
  const { makeSuwayomiAdapter } = await load();
  const seen: string[] = [];
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({ fetchSourceManga: { fetchSourceManga: { mangas: [] } } }, seen));
  await a.search('hello');
  await a.latest!(3);
  assert.match(seen[0], /"type":"SEARCH".*"query":"hello".*"page":1|"source":"0"/);
  assert.ok(seen[0].includes('"query":"hello"'), seen[0]);
  assert.ok(seen[1].includes('"type":"LATEST"'), seen[1]);
  assert.ok(seen[1].includes('"page":3'), seen[1]);
});

test('listRemoteSources tolerates a shapeless answer', async () => {
  const { listRemoteSources } = await load();
  assert.deepEqual(await listRemoteSources((async () => ({})) as never), []);
  assert.deepEqual(await listRemoteSources((async () => ({ sources: {} })) as never), []);
  const ok = await listRemoteSources((async () => ({ sources: { nodes: [LOCAL, null, { name: 'no id' }] } })) as never);
  assert.deepEqual(ok.map((s) => s.id), ['0']);
});
