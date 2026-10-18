// Adapters built from a Suwayomi extension server's GraphQL responses.
//
// The responses below are real shapes captured from Suwayomi-Server v2.2.2100 by introspecting and calling
// it, then written here as code rather than committed as blobs, so a schema change surfaces as a failing
// expectation instead of a mystery. The GraphQL client is injected, so nothing here touches the network. Since the
// engine upgrade the series and its chapters come through fetchMangaAndChapters (operations.ts), and the payloads
// below are keyed the way it answers.
//
// What these pin: the id namespacing that keeps lib_series.source_id routable, the capability reporting the
// loader duck-types, and -- most importantly -- that a malformed or empty response yields NOTHING rather
// than garbage entries, because an adapter that invents series and chapters would quietly poison a library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';

process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';

const load = () => import('../src/lib/sources/suwayomi/sources');

const LOCAL = { id: '0', name: 'Local source', displayName: 'Local source', lang: 'en', supportsLatest: true };

/** A fake `gql` that answers from a map of operation-name -> payload. */
const fakeGql = (answers: Record<string, unknown>, seen: string[] = []) =>
  (async (query: string, variables: Record<string, unknown> = {}) => {
    const op = /fetchSourceManga/.test(query) ? 'fetchSourceManga'
      : /fetchChapters:true/.test(query) ? 'fetchChapters'
      : /fetchChapterPages/.test(query) ? 'fetchChapterPages'
      : /fetchManga:true/.test(query) ? 'fetchManga'
      : 'sources';
    seen.push(`${op}:${JSON.stringify(variables)}`);
    if (!(op in answers)) throw new Error(`unexpected operation ${op}`);
    return answers[op];
  }) as never;

test('search maps a source manga list onto series', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchSourceManga: { fetchSourceManga: { mangas: [
      { id: 1, title: 'Bridge Test Manga', thumbnailUrl: '/api/v1/manga/1/thumbnail', realUrl: null, url: '/manga/bridge-test',
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
  // The extension-relative url is what a Mihon backup stores for the manga, and the import review's
  // same-source proof compares it (routes/sources.ts resolveCandidate); without it every backup entry
  // silently falls back to title matching and nothing else in the suite notices.
  // Reintroduce by dropping `path: m.url || undefined` from toSeries.
  assert.equal(s.path, '/manga/bridge-test');
  assert.equal(s.url, undefined, 'realUrl is the web link and stays separate from the path');
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

test('chapters come back ascending, every copy of a number, with dates and groups', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchChapters: { fetchMangaAndChapters: { chapters: [
      { id: 33, chapterNumber: 3, name: 'Chapter 3', pageCount: -1, uploadDate: '1787177865027', scanlator: '   ' },
      { id: 1, chapterNumber: 1, name: 'Chapter 1', pageCount: 3, uploadDate: '1787177840210' },
      { id: 2, chapterNumber: 2, name: 'Chapter 2', pageCount: 3, uploadDate: '1787177840269', scanlator: 'Main Team' },
      { id: 99, chapterNumber: 2, name: 'Chapter 2 (dupe scanlation)', pageCount: 3, scanlator: ' Dupe Team ' },
    ] } },
  }));
  const cs = await a.listChapters('1');
  // The second scanlation of chapter 2 used to be dropped here, first-listed wins. It is a real copy by a
  // real group, and which one the reader wants is the chooser's call, not the adapter's -- the adapter
  // cannot know the series' preference. Reintroduce by restoring the `seen` number filter in listChapters:
  // the length assertion fails (3, not 4) and 'Dupe Team' is gone.
  assert.equal(cs.length, 4);
  assert.deepEqual(cs.map((c) => c.number), [1, 2, 2, 3]);
  assert.deepEqual(cs.map((c) => c.sourceId), ['1', '2', '99', '33'], 'ascending, and the engine\'s order within a number');
  // Mihon's scanlator column is free text; blank is "unknown", and unknown must be absent, not '' -- the
  // chooser never blocks a copy with no group, but it would try to match a group named ''. Reintroduce by
  // copying `c.scanlator` without the trim-or-undefined: this deepEqual fails with ' Dupe Team ' and '   '.
  assert.deepEqual(cs.map((c) => c.scanlator), [undefined, 'Main Team', 'Dupe Team', undefined]);
  // pageCount -1 means "not counted yet" and must not be reported as a real page count
  assert.equal(cs[3].pages, undefined);
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
    fetchChapters: { fetchMangaAndChapters: { chapters: [
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
    fetchSourceManga: {}, fetchChapters: { fetchMangaAndChapters: {} }, fetchChapterPages: { fetchChapterPages: { pages: null } },
    fetchManga: { fetchMangaAndChapters: { manga: null } },
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

test('popular is offered by every extension, unlike latest', async () => {
  const { makeSuwayomiAdapter } = await load();
  // The asymmetry is the point and looks like a bug otherwise. In the Mihon source model popular is the
  // MANDATORY listing every catalogue implements, and latest is the optional extra -- which is exactly why
  // the server reports `supportsLatest` and has no `supportsPopular` to report.
  //
  // Reintroduce by gating popular on `supportsLatest`: the second assertion fails and every source that
  // cannot do latest would silently vanish from Popular too.
  assert.equal(typeof makeSuwayomiAdapter(LOCAL, fakeGql({})).popular, 'function');
  assert.equal(typeof makeSuwayomiAdapter({ ...LOCAL, supportsLatest: false }, fakeGql({})).popular, 'function');
});

test('popular asks for POPULAR, and asks for the page it was given', async () => {
  const { makeSuwayomiAdapter } = await load();
  const seen: string[] = [];
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({ fetchSourceManga: { fetchSourceManga: { mangas: [] } } }, seen));
  await a.popular!(2);
  assert.ok(seen[0].includes('"type":"POPULAR"'), seen[0]);
  assert.ok(seen[0].includes('"page":2'), seen[0]);
  // A query must NOT be sent for a browse listing; some extensions treat a stray empty query as a search.
  assert.ok(!seen[0].includes('"query":"'), seen[0]);
});

test('the extension icon is carried onto the adapter', async () => {
  const { makeSuwayomiAdapter } = await load();
  // The sources query has always selected iconUrl and the adapter used to drop it, so every extension source
  // showed a blank square. Reintroduce by removing the assignment.
  const a = makeSuwayomiAdapter({ ...LOCAL, iconUrl: '/api/v1/source/0/icon' }, fakeGql({}));
  assert.equal(a.iconUrl, '/api/v1/source/0/icon');
  assert.equal(makeSuwayomiAdapter(LOCAL, fakeGql({})).iconUrl, undefined, 'no icon means no field, not an empty one');
});

// ---- #116: posting order and url -----------------------------------------------------------------------------

/** Answer the chapter list with only the fields the query selected, as the engine does. */
const selecting = (rows: Array<Record<string, unknown>>, seen: string[] = [], refuse?: (q: string) => Error | null) =>
  (async (query: string) => {
    seen.push(query);
    const err = refuse?.(query);
    if (err) throw err;
    const fields = /chapters\s*\{([^}]*)\}/.exec(query)![1].trim().split(/\s+/);
    return { fetchMangaAndChapters: { chapters: rows.map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]]))) } };
  }) as never;

// Webtoons-shaped, as the engine answers: sourceOrder ascending (1 = the oldest post), every post numbered 1.
const PARTS = [
  { id: 71, chapterNumber: 1, name: 'Episode 1 - Page1  (ch. 1)', uploadDate: '1570184580000', pageCount: -1, sourceOrder: 1, url: '/episode?titleNo=344018&episodeNo=1' },
  { id: 72, chapterNumber: 1, name: 'Episode 1 - Page 2 (ch. 1)', uploadDate: '1570496478000', pageCount: -1, sourceOrder: 2, url: '/episode?titleNo=344018&episodeNo=2' },
  { id: 90, chapterNumber: 2, name: 'E2 - 54-56 (ch. 2)', uploadDate: '1576000000000', pageCount: -1, sourceOrder: 3, url: '/episode?titleNo=344018&episodeNo=23' },
  { id: 73, chapterNumber: 1, name: 'Episode 1 - Page 3 (ch. 1)', uploadDate: '1571142111000', pageCount: -1, sourceOrder: 4, url: '/episode?titleNo=344018&episodeNo=3' },
];

test('chapters carry the engine\'s posting order and url, and the number stays raw', async () => {
  // Reintroduce by dropping `sourceOrder url` from operations.ts CHAPTER_FIELDS: the engine then sends neither, `url` is
  // undefined and the first deepEqual fails (and `order` falls back to the answer's positions).
  const { makeSuwayomiAdapter } = await load();
  const seen: string[] = [];
  const a = makeSuwayomiAdapter(LOCAL, selecting(PARTS, seen));
  const cs = await a.listChapters('7');
  assert.match(seen[0], /\bsourceOrder\b/);
  assert.deepEqual(cs.map((c) => [c.sourceId, c.url]), [
    ['71', '/episode?titleNo=344018&episodeNo=1'], ['72', '/episode?titleNo=344018&episodeNo=2'],
    ['73', '/episode?titleNo=344018&episodeNo=3'], ['90', '/episode?titleNo=344018&episodeNo=23'],
  ]);
  assert.deepEqual(cs.map((c) => c.order), [1, 2, 4, 3], 'the engine\'s sourceOrder, carried past the sort by number');
  // Still the extension's number: 'Episode 1 - Page 2 (ch. 1)' is 1. Renumbering is the listing layer's call.
  assert.deepEqual(cs.map((c) => c.number), [1, 1, 1, 2]);
  assert.equal(cs[1].title, 'Episode 1 - Page 2 (ch. 1)');
  assert.equal(cs[1].sourceNumber, undefined, 'the adapter never renumbers, so it never sets sourceNumber');
  // A row the engine gave no usable order takes its place in the answer; a blank url is no url.
  const odd = await makeSuwayomiAdapter(LOCAL, selecting([{ ...PARTS[0], sourceOrder: 0, url: '  ' }, { ...PARTS[1], sourceOrder: null }])).listChapters('7');
  assert.deepEqual(odd.map((c) => [c.order, c.url]), [[1, undefined], [2, '/episode?titleNo=344018&episodeNo=2']]);
});

/** The engine's own words for a field it does not have, as client.ts rethrows them (an EngineRefusedError). */
const fieldUndefined = (q: string) => /\bsourceOrder\b/.test(q)
  ? new Error("suwayomi: Validation error (FieldUndefined@[fetchMangaAndChapters/chapters/sourceOrder]) : Field 'sourceOrder' in type 'ChapterType' is undefined")
  : null;

test('an engine that refuses a field is not asked another way: the refusal is the answer', async () => {
  // Until the engine upgrade an engine refusing `sourceOrder url` was asked again with the v0.48 query, and the
  // refusal was hidden. Such an engine predates OLDEST_ENGINE and lacks fetchMangaAndChapters too, so the fallback is
  // retired (sources.ts): the refusal reaches the caller, and Health says "Not compatible". Reintroduce a fallback
  // (retry without the fields on a refusal): two queries are sent and the call resolves.
  const { makeSuwayomiAdapter } = await load();
  const seen: string[] = [];
  const a = makeSuwayomiAdapter(LOCAL, selecting(PARTS, seen, fieldUndefined));
  await assert.rejects(a.listChapters('7'), /Validation error \(FieldUndefined@\[fetchMangaAndChapters\/chapters\/sourceOrder\]\)/);
  assert.equal(seen.length, 1, 'asked once, and never another way');
});

test('against the pinned engine: Istrevelia arrives with its posting order, its urls and its raw numbers', async () => {
  // The strict fake refuses any field v2.3.2243 does not have, so this is the query itself meeting the schema.
  const { startFakeSuwayomi, SOURCE_IDS } = await import('./fixtures/fakeSuwayomi');
  const { makeSuwayomiAdapter } = await load();
  const { detectSharedNumbering, postingSequence, displayTitle } = await import('../src/lib/postingOrder');
  const fake = await startFakeSuwayomi();
  try {
    const run = (async (query: string, variables: Record<string, unknown> = {}) => {
      const r = await fake.query(query, variables);
      if (r.errors?.length) throw new Error(`suwayomi: ${r.errors[0].message}`);
      return r.data;
    }) as never;
    const a = makeSuwayomiAdapter({ id: SOURCE_IDS.webtoons, name: 'Webtoons.com', lang: 'en' }, run);
    const cs = await a.listChapters(String(fake.manga('Istrevelia').id));
    assert.equal(cs.length, 226);
    assert.deepEqual(fake.calls.filter((c) => c.status === 'rejected' || c.status === 'unimplemented'), []);
    assert.deepEqual([...cs.map((c) => c.order!)].sort((x, y) => x - y), Array.from({ length: 226 }, (_, i) => i + 1));
    assert.ok(cs.every((c) => typeof c.url === 'string' && c.url.includes('/viewer')), 'every post carries its path');
    assert.equal(new Set(cs.map((c) => c.number)).size, 13, 'the extension\'s shared numbers, raw');
    const first = postingSequence(cs)[0];
    assert.deepEqual([first.number, displayTitle(first.title)], [1, 'Episode 1 - Page1']);
    assert.equal(detectSharedNumbering(cs).verdict, 'strong');
  } finally {
    await fake.close();
  }
});

test('chapters with no usable number are counted on the answer, not silently lost (#115)', async () => {
  // Reintroduce by dropping the Object.defineProperty(out, UNNUMBERED, ...) in listChapters: the count reads 0 and
  // the smoke test calls an extension that numbers nothing "lists no chapters" (sourceProbe.test.ts).
  const { makeSuwayomiAdapter } = await load();
  const { UNNUMBERED, unnumberedOf } = await import('../src/lib/sources/types');
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchChapters: { fetchMangaAndChapters: { chapters: [
      { id: 1, chapterNumber: -1, name: 'Prologue' }, { id: 2, chapterNumber: -1, name: 'Notice' }, { id: 3, chapterNumber: null, name: 'Extra' },
    ] } },
  }));
  const list = await a.listChapters('7');
  assert.deepEqual([...list], []);
  assert.equal((list as any)[UNNUMBERED], 3);
  assert.equal(unnumberedOf(list), 3);
  assert.deepEqual(Object.keys(list), [], 'non-enumerable: spreads and JSON never see it');
  assert.equal(JSON.stringify(list), '[]');
  // A normal list carries nothing.
  const b = makeSuwayomiAdapter(LOCAL, fakeGql({ fetchChapters: { fetchMangaAndChapters: { chapters: [{ id: 1, chapterNumber: 1, name: 'One' }] } } }));
  assert.equal(unnumberedOf(await b.listChapters('7')), 0);
});

// ---- the engine upgrade: contentWarning and dates --------------------------------------------------------------

test('a MIXED source is adult, and so is one whose warning is missing or unknown: a capped account cannot open it', async () => {
  // `contentWarning` replaced `isNsfw`, and the engine's own isNsfw is contentWarning >= MIXED -- a legacy store's 18+
  // extension is MIXED (measured on v2.3.2243 and v2.4.2366). Reintroduce `adultOf = (w) => w === 'NSFW'`: the MIXED
  // source is allowed to a 13+ account. Reintroduce `w !== undefined && w !== 'SAFE'`: the one with no warning is.
  const { listRemoteSources, makeSuwayomiAdapter, adultOf } = await load();
  const { sourceAllowedFor } = await import('../src/lib/visibility');
  const nodes = [
    { ...LOCAL, id: '1', contentWarning: 'SAFE' }, { ...LOCAL, id: '2', contentWarning: 'MIXED' },
    { ...LOCAL, id: '3', contentWarning: 'NSFW' }, { ...LOCAL, id: '4' }, { ...LOCAL, id: '5', contentWarning: 'SOMETHING_NEW' },
  ];
  const remote = await listRemoteSources((async () => ({ sources: { nodes } })) as never);
  assert.deepEqual(remote.map((s) => [s.id, s.isNsfw]), [['1', false], ['2', true], ['3', true], ['4', true], ['5', true]]);
  const capped = (id: string) => sourceAllowedFor(makeSuwayomiAdapter(remote.find((s) => s.id === id)!, fakeGql({})), 13);
  assert.equal(capped('1'), true, 'a SAFE source is open to a capped account');
  assert.equal(capped('2'), false, 'a MIXED source is adult');
  assert.equal(capped('4'), false, 'no warning fails closed');
  assert.equal(adultOf('SAFE'), false);
});

test('a date in seconds is read as one; milliseconds are unchanged; junk is no date', async () => {
  // v2.3.2243 stamps a new chapter its extension gave no date with the current time in SECONDS (measured:
  // "1791984615"), which read as milliseconds is 1970-01-21. Reintroduce by dropping `if (ms < 1e11) ms *= 1000`: the
  // first assertion finds no date (the 2000 floor drops the misread one; without it, 1970-01-21).
  const { uploadedAt, makeSuwayomiAdapter } = await load();
  assert.equal(uploadedAt('1791984615'), '2026-10-14T13:30:15.000Z', 'seconds');
  assert.equal(uploadedAt('1704067200000'), '2024-01-01T00:00:00.000Z', 'milliseconds, unchanged');
  assert.equal(uploadedAt(1704067200000), '2024-01-01T00:00:00.000Z', 'a number too');
  // No date at all, or one before 2000 in either unit: never a date the radar would show.
  for (const junk of ['0', '', '-5', 'abc', null, undefined, '946684799', '946684799999', 'Infinity', 'NaN']) {
    assert.equal(uploadedAt(junk), undefined, String(junk));
  }
  // And through the adapter: the dateless chapter dated, the dated one as it was.
  const a = makeSuwayomiAdapter(LOCAL, fakeGql({ fetchChapters: { fetchMangaAndChapters: { chapters: [
    { id: 1, chapterNumber: 1, name: 'One', uploadDate: '1791984615' },
    { id: 2, chapterNumber: 2, name: 'Two', uploadDate: '1704067200000' },
  ] } } }));
  assert.deepEqual((await a.listChapters('7')).map((c) => c.publishedAt), ['2026-10-14T13:30:15.000Z', '2024-01-01T00:00:00.000Z']);
});

// The pinned v2.4.2366 stamps such a chapter in milliseconds; v2.3.2243 -- still supported (OLDEST_ENGINE), and what an
// install that has not moved its engine yet runs -- in seconds, so both are held here. Reintroduce by dropping
// uploadedAt's `* 1000`: the v2.3.2243 run's chapter has no date (the 2000 floor drops the misread one; without it,
// 1970-01-21).
for (const [engine, schemaFile] of [
  ['the pinned engine', undefined],
  ['v2.3.2243, the oldest supported', join(__dirname, 'fixtures', 'suwayomi-v2.3.2243-schema.json')],
] as const) test(`against ${engine}: a chapter the extension gave no date arrives dated now, not 1970`, async () => {
  const { startFakeSuwayomi, SOURCE_IDS } = await import('./fixtures/fakeSuwayomi');
  const { makeSuwayomiAdapter } = await load();
  const fake = await startFakeSuwayomi({ schemaFile });
  try {
    let stamped: string | undefined; // chapter 5's date as the engine sent it
    const run = (async (query: string, variables: Record<string, unknown> = {}) => {
      const r = await fake.query(query, variables);
      if (r.errors?.length) throw new Error(`suwayomi: ${r.errors[0].message}`);
      const rows: any[] = (r.data as any)?.fetchMangaAndChapters?.chapters ?? [];
      stamped = rows.find((c) => Number(c.chapterNumber) === 5)?.uploadDate ?? stamped;
      return r.data;
    }) as never;
    const ball = fake.manga('Ball Runner');
    const a = makeSuwayomiAdapter({ id: SOURCE_IDS.mangaBall, name: 'Manga Ball', lang: 'en' }, run);
    await a.listChapters(String(ball.id));
    ball.chapters.unshift({ name: 'Chapter 5', url: '/title/ball-runner/5', chapterNumber: 5, scanlator: 'Ball Team', uploadDate: 0 });
    const t0 = Date.now() - 1000;
    const five = (await a.listChapters(String(ball.id))).find((c) => c.number === 5)!;
    assert.equal(Number(stamped) < 1e11, schemaFile !== undefined, `PREMISE: ${engine} stamps it in ${schemaFile ? 'seconds' : 'milliseconds'} (${stamped})`);
    assert.ok(Date.parse(five.publishedAt!) >= t0 && Date.parse(five.publishedAt!) <= Date.now() + 1000, `dated now: ${five.publishedAt}`);
  } finally {
    await fake.close();
  }
});

test("a manga of another source is not this source's: no series, no chapters", async () => {
  // The engine's manga ids are global across extensions, and the age cap and the source switches are judged on the
  // source a request names. Without the check an adult extension's manga resolved through a safe one. Reintroduce by
  // dropping ownManga in getSeries/listChapters: the foreign manga comes back with its chapters.
  const { makeSuwayomiAdapter } = await load();
  const foreign = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchManga: { fetchMangaAndChapters: { manga: { id: 7, title: 'Another Source Manga', sourceId: '987654321' } } },
    fetchChapters: { fetchMangaAndChapters: { manga: { sourceId: '987654321' }, chapters: [
      { id: 70, chapterNumber: 1, name: 'Ch 1', scanlator: null, uploadDate: '0', pageCount: 3, sourceOrder: 1, url: '/c/1' },
    ] } },
  }));
  assert.equal(await foreign.getSeries('7'), null);
  assert.deepEqual(await foreign.listChapters('7'), []);
  const own = makeSuwayomiAdapter(LOCAL, fakeGql({
    fetchManga: { fetchMangaAndChapters: { manga: { id: 8, title: 'Own Manga', sourceId: String(LOCAL.id) } } },
  }));
  assert.equal((await own.getSeries('8'))?.title, 'Own Manga');
});

// Unnumbered galleries.
test('a single unnumbered gallery is chapter 1, and an NSFW source numbers its parts oldest first', async () => {
  // Reintroduce by deleting the galleryChapters branch in listChapters: single-gallery titles list nothing.
  const { makeSuwayomiAdapter } = await load();
  const { unnumberedOf } = await import('../src/lib/sources/types');
  const one = makeSuwayomiAdapter({ ...LOCAL, isNsfw: false }, fakeGql({
    fetchChapters: { fetchMangaAndChapters: { manga: { sourceId: String(LOCAL.id) }, chapters: [{ id: 9, chapterNumber: -1, name: 'Chapter', uploadDate: '1700000000000', pageCount: 24 }] } },
  }));
  const g = await one.listChapters('5');
  assert.deepEqual(g.map((c) => [c.sourceId, c.number, c.title, c.pages]), [['9', 1, 'Chapter', 24]]);
  assert.equal(unnumberedOf(g), 0);
  const parts = makeSuwayomiAdapter({ ...LOCAL, isNsfw: true }, fakeGql({
    // newest first, as an engine that counts from the top answers
    fetchChapters: { fetchMangaAndChapters: { manga: { sourceId: String(LOCAL.id) }, chapters: [
      { id: 3, chapterNumber: -1, name: 'Part 3', sourceOrder: 1, uploadDate: '1700000300000' },
      { id: 2, chapterNumber: -1, name: 'Part 2', sourceOrder: 2, uploadDate: '1700000200000' },
      { id: 1, chapterNumber: -1, name: 'Part 1', sourceOrder: 3, uploadDate: '1700000100000' },
    ] } },
  }));
  assert.deepEqual((await parts.listChapters('5')).map((c) => [c.title, c.number]), [['Part 1', 1], ['Part 2', 2], ['Part 3', 3]]);
});

test('gallery numbering preserves existing handling: a numbered list, and a multi-row SFW list, still drop unnumbered rows', async () => {
  const { makeSuwayomiAdapter } = await load();
  const mixed = makeSuwayomiAdapter({ ...LOCAL, isNsfw: true }, fakeGql({
    fetchChapters: { fetchMangaAndChapters: { manga: { sourceId: String(LOCAL.id) }, chapters: [{ id: 1, chapterNumber: 1, name: 'One' }, { id: 2, chapterNumber: -1, name: 'Notice' }] } },
  }));
  assert.deepEqual((await mixed.listChapters('5')).map((c) => c.number), [1]);
  const sfw = makeSuwayomiAdapter({ ...LOCAL, isNsfw: false }, fakeGql({
    fetchChapters: { fetchMangaAndChapters: { manga: { sourceId: String(LOCAL.id) }, chapters: [{ id: 1, chapterNumber: -1, name: 'Prologue' }, { id: 2, chapterNumber: -1, name: 'Notice' }] } },
  }));
  assert.deepEqual(await sfw.listChapters('5'), []);
});

test('gallery numbering keeps engine order without dates and preserves chapter metadata', async () => {
  const { makeSuwayomiAdapter } = await load();
  const a = makeSuwayomiAdapter({ ...LOCAL, isNsfw: true }, fakeGql({
    fetchChapters: { fetchMangaAndChapters: { manga: { sourceId: String(LOCAL.id) }, chapters: [
      { id: 2, chapterNumber: -1, name: 'Second', sourceOrder: 2, scanlator: 'Team', url: '/part/2', pageCount: 8 },
      { id: 1, chapterNumber: -1, name: 'First', sourceOrder: 1, pageCount: 12 },
    ] } },
  }));
  const rows = await a.listChapters('5');
  assert.deepEqual(rows.map((c) => [c.sourceId, c.number, c.order]), [['1', 1, 1], ['2', 2, 2]]);
  assert.deepEqual([rows[1].scanlator, rows[1].url, rows[1].pages], ['Team', '/part/2', 8]);
});

test('gallery numbering ignores rows without ids and does not cross source ownership', async () => {
  const { makeSuwayomiAdapter } = await load();
  const { unnumberedOf } = await import('../src/lib/sources/types');
  const response = (sourceId: string, chapters: unknown[]) => fakeGql({
    fetchChapters: { fetchMangaAndChapters: { manga: { sourceId }, chapters } },
  });
  const chapters = [{ chapterNumber: -1, name: 'Junk' }, { id: 3, chapterNumber: -1, name: 'Gallery' }];
  const own = makeSuwayomiAdapter(LOCAL, response(String(LOCAL.id), chapters));
  const rows = await own.listChapters('5');
  assert.deepEqual(rows.map((c) => [c.sourceId, c.number]), [['3', 1]]);
  assert.equal(unnumberedOf(rows), 0);
  const foreign = makeSuwayomiAdapter({ ...LOCAL, isNsfw: true }, response('another-source', chapters));
  assert.deepEqual(await foreign.listChapters('5'), []);
  assert.deepEqual(await makeSuwayomiAdapter(LOCAL, response(String(LOCAL.id), [])).listChapters('5'), []);
});
