// The smoke test behind the Test button and the daily check, against scripted adapters (#115).
//
// Health now shows WHICH stage failed, so the stage had better be right. Every case below is one of the ways
// the old smoke test failed a working source, or took four searches to learn one fact: it judged by the first
// search hit, asked pages of the OLDEST chapter, called unnumbered chapters "none found", checked its deadline
// only between stages, and kept trying search terms after the extension had already answered with its own error.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SourceAdapter, SourceChapter } from '../src/lib/sources/types';

// The probe's import graph reaches env and the db module; nothing here runs a query.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
const load = () => import('../src/lib/sourceProbe');
const types = () => import('../src/lib/sources/types');

const ENGINE_ERR = 'suwayomi: Exception while fetching data (/fetchSourceManga) : java.lang.Exception';
const ch = (n: number): SourceChapter => ({ sourceId: `c${n}`, number: n, title: `Chapter ${n}` });

function adapter(over: Partial<SourceAdapter> = {}): SourceAdapter & { calls: string[] } {
  const calls: string[] = [];
  const a: any = {
    id: 'probe-fake', name: 'Probe Fake', calls,
    search: async (t: string) => { calls.push(`search:${t}`); return [{ sourceId: 'A', source: 'probe-fake', title: 'A' }, { sourceId: 'B', source: 'probe-fake', title: 'B' }]; },
    getSeries: async (id: string) => { calls.push(`series:${id}`); return { sourceId: id, source: 'probe-fake', title: `Title ${id}` }; },
    listChapters: async (id: string) => { calls.push(`chapters:${id}`); return [ch(1), ch(2)]; },
    getPageUrls: async (id: string) => { calls.push(`pages:${id}`); return ['p1', 'p2']; },
  };
  for (const [k, v] of Object.entries(over)) a[k] = typeof v === 'function' ? (...args: any[]) => (v as any).apply(a, args) : v;
  return a;
}

test('one dud search hit does not fail the source', async () => {
  // Reintroduce by asking chapters of results[0] only: Chapters reads "none found" and the state is 'fail'.
  const { smokeTest } = await load();
  const a = adapter({ listChapters: async function (this: any, id: string) { this.calls.push(`chapters:${id}`); return id === 'A' ? [] : [ch(1), ch(2), ch(3)]; } });
  const r = await smokeTest(a, { timeoutMs: 5000 });
  assert.equal(r.state, 'pass', JSON.stringify(r.checks));
  assert.equal(r.ok, true);
  assert.deepEqual(r.passed, ['search', 'chapters', 'pages']);
  assert.match(r.checks.find((c) => c.name === 'Chapters')!.detail, /3 chapter\(s\) \(search hit 2\)/);
});

test('pages are asked of the newest chapter first', async () => {
  // Reintroduce by asking chapters[0] (the list is ascending, so the oldest): the first page call is chapter 1,
  // which this site has taken down, and the source "fails".
  const { smokeTest } = await load();
  const a = adapter({
    listChapters: async () => Array.from({ length: 50 }, (_, i) => ch(i + 1)),
    getPageUrls: async function (this: any, id: string) { this.calls.push(`pages:${id}`); if (id === 'c1') throw new Error('licensed'); return ['p']; },
  });
  const r = await smokeTest(a, { timeoutMs: 5000 });
  const pages = a.calls.filter((c) => c.startsWith('pages:'));
  assert.equal(pages[0], 'pages:c50', `asked first: ${pages[0]}`);
  assert.equal(r.state, 'pass');
  assert.match(r.checks.find((c) => c.name === 'Pages')!.detail, /chapter 50/);
});

test('pages fall back to the middle and the oldest, and name the error when all three fail', async () => {
  const { smokeTest, pageCandidates } = await load();
  assert.deepEqual(pageCandidates([ch(1), ch(2), ch(2), ch(3), ch(9)]).map((c) => c.number), [9, 2, 1], 'newest, middle, oldest; one copy per number');
  assert.deepEqual(pageCandidates([ch(4)]).map((c) => c.number), [4], 'one chapter is asked once');
  const a = adapter({ getPageUrls: async function (this: any, id: string) { this.calls.push(`pages:${id}`); throw new Error(`HTTP error 404 on ${id}`); } });
  const r = await smokeTest(a, { timeoutMs: 5000 });
  assert.deepEqual(a.calls.filter((c) => c.startsWith('pages:')), ['pages:c2', 'pages:c1']);
  assert.equal(r.state, 'fail');
  assert.deepEqual(r.failure, { stage: 'pages', kind: 'error', error: 'HTTP error 404 on c2' });
  assert.deepEqual(r.passed, ['search', 'chapters']);
});

test('an engine-answered search error stops the term loop', async () => {
  // Reintroduce by going back to `if (classify(e)) break;`: the extension's exception classifies as nothing, so
  // all four terms are searched (Manga Ball paid for four) before the same answer is reported.
  const { smokeTest } = await load();
  const a = adapter({ search: async function (this: any, t: string) { this.calls.push(`search:${t}`); throw new Error(ENGINE_ERR); } });
  const r = await smokeTest(a, { timeoutMs: 5000 });
  assert.equal(a.calls.filter((c) => c.startsWith('search:')).length, 1, a.calls.join());
  assert.deepEqual(r.failure, { stage: 'search', kind: 'error', error: ENGINE_ERR });
  assert.equal(r.state, 'fail');
  assert.equal(r.checks[0].error, ENGINE_ERR, 'the engine message is carried whole (up to 300), not only the 80-character detail');
});

test('an empty search tries the next term, and four empties are markup, not an error', async () => {
  const { smokeTest } = await load();
  const a = adapter({ search: async function (this: any, t: string) { this.calls.push(`search:${t}`); return []; } });
  const r = await smokeTest(a, { timeoutMs: 5000 });
  assert.equal(a.calls.length, 4);
  assert.equal(r.failure?.kind, 'empty');
  assert.match(r.checks[0].detail, /^no results/);
});

test('a call that outlives the wall is cut off and reads inconclusive', { timeout: 5000 }, async () => {
  // Reintroduce by removing the per-call withTimeout (checking the deadline only between stages): the search
  // never resolves and this test times out.
  const { smokeTest } = await load();
  const a = adapter({ search: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await smokeTest(a, { timeoutMs: 200 });
  assert.ok(Date.now() - t0 < 1000, `returned after ${Date.now() - t0} ms`);
  assert.equal(r.state, 'inconclusive');
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.failure, { stage: 'search', kind: 'timeout' });
});

test('unnumbered chapters are named, not called missing', async () => {
  // Reintroduce by dropping the UNNUMBERED write in suwayomi/sources.ts listChapters (the adapter half is pinned in
  // suwayomiAdapter.test.ts), or by ignoring it here: the kind is 'empty' and the fix points at markup.
  const { smokeTest } = await load();
  const { UNNUMBERED } = await types();
  const a = adapter({ listChapters: async () => Object.defineProperty([], UNNUMBERED, { value: 12 }) as SourceChapter[] });
  const r = await smokeTest(a, { timeoutMs: 5000 });
  assert.equal(r.failure?.kind, 'unnumbered');
  assert.equal(r.failure?.stage, 'chapters');
  assert.match(r.checks.find((c) => c.name === 'Chapters')!.detail, /^none with a usable number \(24 without\)$/, 'both hits tried, 12 each');
});

test('every search hit throwing at the series page is a chapters-stage error, with the first error', async () => {
  const { smokeTest } = await load();
  const a = adapter({ getSeries: async (id: string) => { throw new Error(`suwayomi: gone ${id}`); } });
  const r = await smokeTest(a, { timeoutMs: 5000 });
  assert.deepEqual(r.failure, { stage: 'chapters', kind: 'error', error: 'suwayomi: gone A' });
  assert.equal(r.checks.at(-1)!.name, 'Series / chapters');
});

test('buildProbe carries the failure, and only when there is one', async () => {
  const { buildProbe } = await load();
  assert.deepEqual(buildProbe(undefined, { ok: false, failure: { stage: 'search', kind: 'error', error: 'x' } }, {}),
    { adapterOk: false, needsSolver: false, failure: { stage: 'search', kind: 'error', error: 'x' } });
  assert.equal('failure' in buildProbe(undefined, { ok: true }, {}), false);
});
