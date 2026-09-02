// Which images on a chapter page are actually the chapter.
//
// The extraction matched the reader block and then fell back to `|| h` -- the WHOLE page -- when the match
// failed. These sites carry a sidebar of other series, so the fallback quietly turned covers into pages.
// Measured live on chapter 35 of "Act Like a Boss Monster, Mr. Swallow!": 96 "pages" whose last entry was
// `/thumb/the-proper-way-to-perform-a-sacrifice.webp`, a cover for an unrelated title.
//
// That is worse than cosmetic. `expected` is the number of page URLs, so junk entries inflate it, and a
// chapter that fetched every real page still measures as short and is refused -- and a large enough
// shortfall reports the SOURCE as failing. A parsing slip was being charged to the site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeManganato } from '../src/lib/sources/engines/manganato';

const BASE = 'https://example.test';
const cfg = { id: 'test-pages', name: 'Test Pages', base: BASE };
const CDN = 'https://imgs-2.cdn.test/zin/a-series/35';
const THUMBS = 'https://img-r1.cdn.test/thumb';

function stubSolver(html: string) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: 'ok', solution: { url: `${BASE}/x`, status: 200, response: html, cookies: [], userAgent: 'UA' } }),
      { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

const page = (n: number) => `<img src="${CDN}/${n}.webp">`;
const sidebar = [
  `<img src="${THUMBS}/the-proper-way-to-perform-a-sacrifice.webp">`,
  `<img src="${THUMBS}/some-other-series.webp">`,
  `<img src="${THUMBS}/a-third-thing.webp">`,
].join('');

test('only the chapter’s own images are returned', async () => {
  stubSolver(`<html><body>
    <div class="container-chapter-reader">${[0, 1, 2, 3].map(page).join('')}</div>
    <div class="container-sidebar">${sidebar}</div>
  </body></html>`);
  const urls = await makeManganato(cfg as any).getPageUrls(`${BASE}/manga/a-series/chapter-35`);
  assert.deepEqual(urls, [0, 1, 2, 3].map((n) => `${CDN}/${n}.webp`));
});

/**
 * The case that actually bit: the reader block does not match, so the old code scanned the whole document.
 * Reintroduce by restoring `|| h` together with the unfiltered return, and this fails with the sidebar
 * covers appended to the chapter.
 */
test('THE SIDEBAR: a failed block match must not turn covers into pages', async () => {
  stubSolver(`<html><body>
    <div class="reader-area-renamed">${[0, 1, 2, 3, 4].map(page).join('')}</div>
    <div class="sidebar">${sidebar}</div>
  </body></html>`);
  const urls = await makeManganato(cfg as any).getPageUrls(`${BASE}/manga/a-series/chapter-35`);
  assert.equal(urls.length, 5, `expected the 5 real pages, got ${urls.length}: ${urls.join(' ')}`);
  assert.ok(!urls.some((u) => u.includes('/thumb/')), 'no cover may be counted as a page');
  assert.deepEqual(urls, [0, 1, 2, 3, 4].map((n) => `${CDN}/${n}.webp`));
});

test('a genuinely single-page chapter still works', async () => {
  stubSolver(`<html><body><div class="container-chapter-reader">${page(0)}</div></body></html>`);
  const urls = await makeManganato(cfg as any).getPageUrls(`${BASE}/manga/a-series/chapter-35`);
  assert.deepEqual(urls, [`${CDN}/0.webp`]);
});

test('pages stay in document order, not sorted', async () => {
  stubSolver(`<html><body><div class="container-chapter-reader">
    ${page(0)}${page(10)}${page(2)}
  </div></body></html>`);
  const urls = await makeManganato(cfg as any).getPageUrls(`${BASE}/manga/a-series/chapter-35`);
  assert.deepEqual(urls, [`${CDN}/0.webp`, `${CDN}/10.webp`, `${CDN}/2.webp`]);
});
