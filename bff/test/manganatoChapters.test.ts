// Reading a Manganato-family chapter list, all of it.
//
// The engine scraped the manga page and took the chapter links out of the HTML. That page only ever renders
// the newest FIFTY, and it says so nowhere: no pagination control, no "load more", no "showing 50 of 145" —
// just a list that stops. So every series added from a site on this engine arrived truncated, and the
// updater could not repair it because it kept asking the same page and kept getting the same fifty.
//
// On the install this was written against that was 7 of the 10 series from the two manganato-family sources,
// roughly 528 chapters, and what finally surfaced it was a reader opening a series and finding chapter 93
// was the first one in it.
//
// The page names the endpoint that has the rest, in `data-api-url` on #chapter-list-container:
// `/api/manga/<slug>/chapters`, answering {data:{chapters:[…],pagination:{total,limit,offset,has_more}}}.
// It is also strictly better than the scrape: a real `chapter_num` instead of a number parsed out of a URL,
// and an `updated_at` these sites otherwise never give us.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeManganato } from '../src/lib/sources/engines/manganato';

const BASE = 'https://example.test';
const SLUG = 'a-series';
const cfg = { id: 'test-nato', name: 'Test Nato', base: BASE };

/** One page of the real API shape. */
function apiPage(from: number, to: number, total: number, hasMore: boolean) {
  const chapters = [];
  for (let n = to; n >= from; n--) {
    chapters.push({
      chapter_name: `Chapter ${n}`, chapter_slug: `chapter-${n}`, chapter_num: n,
      updated_at: '2026-08-28T16:39:29.000000Z', view: 1,
    });
  }
  return JSON.stringify({ success: true, data: { chapters, pagination: { total, limit: 200, offset: 0, has_more: hasMore } } });
}

/** The solver returns a browser's view of the JSON, so the body arrives inside <pre>, entity-escaped. */
const wrap = (json: string) =>
  `<html><head></head><body><pre>${json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</pre></body></html>`;

/** Stubs the FlareSolverr HTTP boundary, which is the only place these adapters touch the network. */
function stubSolver(handler: (url: string) => string | null) {
  const calls: string[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    const { url } = JSON.parse(init.body);
    calls.push(url);
    const res = handler(url);
    if (res === null) return new Response(JSON.stringify({ status: 'error', message: 'not found' }), { status: 200 });
    return new Response(JSON.stringify({
      status: 'ok',
      solution: { url, status: 200, response: res, cookies: [], userAgent: 'test' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return calls;
}

test('THE TRUNCATION: every page of the chapter list is followed, not just the first', async () => {
  const calls = stubSolver((url) => {
    if (!url.includes('/api/manga/')) return null;
    const offset = Number(new URL(url).searchParams.get('offset') || 0);
    if (offset === 0) return wrap(apiPage(96, 145, 145, true));
    if (offset === 50) return wrap(apiPage(46, 95, 145, true));
    if (offset === 100) return wrap(apiPage(1, 45, 145, false));
    return wrap(apiPage(0, -1, 145, false));
  });

  const ch = await makeManganato(cfg).listChapters(`${BASE}/manga/${SLUG}`);
  assert.equal(ch.length, 145, 'the whole list, not the fifty the page renders');
  assert.equal(ch[0].number, 1, 'sorted ascending, oldest first');
  assert.equal(ch[ch.length - 1].number, 145);
  assert.ok(calls.filter((u) => u.includes('/api/manga/')).length >= 3, 'it paged rather than asking once');
});

test('it stops when the server says there is no more, rather than looping', async () => {
  const calls = stubSolver((url) =>
    url.includes('/api/manga/') ? wrap(apiPage(1, 20, 20, false)) : null);
  const ch = await makeManganato(cfg).listChapters(`${BASE}/manga/${SLUG}`);
  assert.equal(ch.length, 20);
  assert.equal(calls.filter((u) => u.includes('/api/manga/')).length, 1, 'has_more:false ends it after one call');
});

test('the release date the API carries is kept', async () => {
  stubSolver((url) => (url.includes('/api/manga/') ? wrap(apiPage(1, 3, 3, false)) : null));
  const ch = await makeManganato(cfg).listChapters(`${BASE}/manga/${SLUG}`);
  assert.ok(ch.every((c) => c.publishedAt), 'every chapter should carry publishedAt');
  assert.equal(ch[0].publishedAt, '2026-08-28T16:39:29.000Z');
});

test('a site without the API still works, by scraping the page as before', async () => {
  // Older Manganato-family sites do not serve /api/manga/<slug>/chapters. The fallback must be intact:
  // returning nothing there would have taken working sites down in exchange for fixing the truncated ones.
  const html = `
    <ul>
      <li class="a-h"><a href="${BASE}/manga/${SLUG}/chapter-2">Chapter 2</a>
        <span class="chapter-time" title="Jul 01,2026 12:00">Jul 01,2026</span></li>
      <li class="a-h"><a href="${BASE}/manga/${SLUG}/chapter-1">Chapter 1</a>
        <span class="chapter-time" title="Jun 01,2026 12:00">Jun 01,2026</span></li>
    </ul>`;
  stubSolver((url) => (url.includes('/api/manga/') ? null : html));
  const ch = await makeManganato(cfg).listChapters(`${BASE}/manga/${SLUG}`);
  assert.deepEqual(ch.map((c) => c.number), [1, 2], 'the HTML scrape is still the fallback');
});

test('a chapter belonging to a different series is not harvested', async () => {
  // The sidebar links other titles' chapters. This guard predates the API path and must survive it.
  stubSolver((url) => (url.includes('/api/manga/') ? null : `
    <a href="${BASE}/manga/${SLUG}/chapter-5">ours</a>
    <a href="${BASE}/manga/some-other-series/chapter-99">theirs</a>`));
  const ch = await makeManganato(cfg).listChapters(`${BASE}/manga/${SLUG}`);
  assert.deepEqual(ch.map((c) => c.number), [5], 'only this series own chapters');
});
