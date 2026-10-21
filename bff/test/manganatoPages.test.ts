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

/**
 * The night that never changed (v0.97.0): on natomanga and mangakakalot some chapters' <img> tags all named
 * imgs-2.2xstorage.com, which answers 404 "File with such name does not exist" (and 429 among them, so the failure read
 * as rate limiting), while the page's own script -- what its reader and its image-server keys build pages from -- named
 * img-r2.2xstorage.com. Shapes as the site serves them, slashes escaped. Reintroduce by reading the tags alone: the
 * first assertion reads the dead server.
 */
const script = (cdns: string, images: string[]) =>
  `<script> var cdns = ${cdns}; var backupImage = []; var chapterImages = ${JSON.stringify(images).replace(/\//g, '\\/')}; </script>`;
const LIVE = 'https://img-r2.cdn.test/';

test("the page's own image list wins over tags that name another server", async () => {
  stubSolver(`<html><body>
    <div class="container-chapter-reader">${[0, 1, 2].map(page).join('')}</div>
    ${script(JSON.stringify([LIVE]).replace(/\//g, '\\/'), ['a-series/35/0.webp', 'a-series/35/1.webp', 'a-series/35/2.webp'])}
  </body></html>`);
  const urls = await makeManganato(cfg as any).getPageUrls(`${BASE}/manga/a-series/chapter-35`);
  assert.deepEqual(urls, [0, 1, 2].map((n) => `${LIVE}a-series/35/${n}.webp`));
});

test('a page without its own list, or with an empty one, is read from its tags as before', async () => {
  for (const extra of ['', script('[]', ['a-series/35/0.webp']), script(JSON.stringify([LIVE]), [])]) {
    stubSolver(`<html><body><div class="container-chapter-reader">${[0, 1].map(page).join('')}</div>${extra}</body></html>`);
    const urls = await makeManganato(cfg as any).getPageUrls(`${BASE}/manga/a-series/chapter-35`);
    assert.deepEqual(urls, [0, 1].map((n) => `${CDN}/${n}.webp`), extra || 'no script');
  }
});
