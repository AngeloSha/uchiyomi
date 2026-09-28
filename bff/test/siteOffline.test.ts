// "The site says it is offline" (lib/sources/offline.ts, v0.49.1): the Madara and Manganato engines read a site's
// own maintenance notice as what it is, and throw a classified error, instead of parsing it to an empty list.
//
// Since 2026-09-23 aqua (Madara, the owner's main source) has answered every request with a small "Aqua Manga is
// temporarily offline" page -- HTTP 200, a card with a Discord link. The engine returned [] for it, the updater took
// that for an empty listing, and Health said "no results -- markup may not match this engine". The detection must
// stay conservative: a working site whose search found nothing, or whose page title happens to say "maintenance",
// is not offline. Driven at the FlareSolverr HTTP boundary, the only place these engines touch the network.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeMadara, MADARA_MARKUP } from '../src/lib/sources/engines/madara';
import { makeManganato, MANGANATO_MARKUP } from '../src/lib/sources/engines/manganato';
import { offlineNotice, isSiteOffline, OFFLINE_MAX_BYTES, SITE_OFFLINE } from '../src/lib/sources/offline';

const BASE = 'https://aquareader.test';

/** aqua's offline page, in its shape: small, a <title> that says so, a card with a Discord link, no theme at all. */
const AQUA_OFFLINE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aqua Manga is temporarily offline</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0b1220; color: #e2e8f0; font-family: system-ui, sans-serif; }
  .card { max-width: 440px; padding: 32px; border-radius: 16px; background: #111a2e; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.45); }
  .card h1 { font-size: 22px; margin: 0 0 12px; }
  .card p { margin: 0 0 20px; line-height: 1.5; color: #94a3b8; }
  .card a { display: inline-block; padding: 10px 18px; border-radius: 8px; background: #5865f2; color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <h1>We'll be back soon</h1>
    <p>Aqua Manga is temporarily offline while we work on the site. Join our Discord to hear when we are back.</p>
    <a href="https://discord.gg/aquamanga" target="_blank" rel="noopener">Join our Discord</a>
  </div>
</body>
</html>`;

/** A working Madara search page: the theme around it, and one result card. */
const MADARA_SEARCH = `<!DOCTYPE html><html><head><title>You searched for solo leveling - Aqua Manga</title>
<link rel="stylesheet" href="${BASE}/wp-content/plugins/madara-core/assets/css/wp-manga.css"></head>
<body class="search search-results wp-manga-template">
<div class="c-tabs-item">
 <div class="row c-tabs-item__content">
  <div class="tab-thumb c-image-hover"><a href="${BASE}/manga/solo-leveling/" title="Solo Leveling"><img src="${BASE}/wp-content/uploads/solo.webp" alt="Solo Leveling"></a></div>
  <div class="post-title"><h3 class="h4"><a href="${BASE}/manga/solo-leveling/">Solo Leveling</a></h3></div>
 </div>
</div></body></html>`;

/**
 * A working Madara search page with NO result, for a title that has "maintenance" in it: the words are in its
 * <title>, it parses to nothing -- and it is the site working, because the theme is all around it.
 */
const MADARA_NOTHING = `<!DOCTYPE html><html><head><title>You searched for maintenance - Aqua Manga</title>
<link rel="stylesheet" href="${BASE}/wp-content/plugins/madara-core/assets/css/wp-manga.css"></head>
<body class="search search-no-results wp-manga-template"><div class="c-page-content"><div class="search-wrap">
<h1 class="item-title h4">No matches found for "maintenance"</h1></div></div>
<ul class="main-menu"><li><a href="${BASE}/manga/">All manga</a></li></ul></body></html>`;

/** Stubs FlareSolverr's HTTP API: every solve answers `page(url)` with HTTP 200, as aqua does. */
function stubSolver(page: (url: string) => string) {
  const calls: string[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    const { url } = JSON.parse(init.body);
    calls.push(url);
    return new Response(JSON.stringify({ status: 'ok', solution: { url, status: 200, response: page(url), cookies: [], userAgent: 'test' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return calls;
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** The rejection an offline source's call must end in: the classified kind, and the site's own words. */
async function offline(p: Promise<unknown>, what: string) {
  await assert.rejects(p, (e: any) => {
    assert.equal(e?.kind, SITE_OFFLINE, `${what}: not the classified error (${e?.message})`);
    assert.ok(isSiteOffline(e?.message), `${what}: the message does not carry the prefix a stored error is read by`);
    assert.match(e.message, /Aqua Manga is temporarily offline/);
    return true;
  }, `${what} did not throw`);
}

test("aqua's offline page is read as the site saying it is offline, in its own words", () => {
  assert.ok(Buffer.byteLength(AQUA_OFFLINE) < OFFLINE_MAX_BYTES, 'the fixture is the small page it stands for');
  assert.equal(offlineNotice(AQUA_OFFLINE, MADARA_MARKUP), 'Aqua Manga is temporarily offline');
  assert.equal(offlineNotice(AQUA_OFFLINE, MANGANATO_MARKUP), 'Aqua Manga is temporarily offline');
});

test('every Madara call on the offline page throws the classified error instead of answering empty', async () => {
  stubSolver(() => AQUA_OFFLINE);
  const src = makeMadara({ id: 'aqua', name: 'Aqua Manga', base: BASE });
  // Reintroduce by returning parseResults straight from search (dropping `listing`'s check): it answers [].
  await offline(src.search('solo leveling'), 'search');
  await offline(src.latest!(1), 'latest');
  await offline(src.popular!(1), 'popular');
  // Before anything is read off the page: the notice's <h1> must never become a series called "We'll be back soon".
  await offline(src.getSeries(`${BASE}/manga/solo-leveling/`), 'getSeries');
  await offline(src.listChapters(`${BASE}/manga/solo-leveling/`), 'listChapters');
  await offline(src.getPageUrls(`${BASE}/manga/solo-leveling/chapter-1/`), 'getPageUrls');
});

test('a working Madara page is never offline: results, or no results inside the theme, whatever its title says', async () => {
  stubSolver((url) => (url.includes('?s=maintenance') ? MADARA_NOTHING : MADARA_SEARCH));
  const src = makeMadara({ id: 'aqua', name: 'Aqua Manga', base: BASE });
  const found = await src.search('solo leveling');
  assert.deepEqual(found.map((r) => r.title), ['Solo Leveling']);
  // Reintroduce by dropping the markup test from offlineNotice: this page's title says "maintenance", it is small,
  // it parses to nothing -- and it would throw.
  assert.deepEqual(await src.search('maintenance'), [], 'an empty answer from a working site stays an empty answer');
  assert.equal(offlineNotice(MADARA_NOTHING, MADARA_MARKUP), null);
});

test('a large page is never an offline notice, even one that says so and carries no theme', () => {
  // A site's real pages are far larger than a notice. Reintroduce by dropping the size bound: this reads offline.
  const big = AQUA_OFFLINE.replace('</body>', `<p>${'x'.repeat(OFFLINE_MAX_BYTES)}</p></body>`);
  assert.equal(offlineNotice(big, MADARA_MARKUP), null);
  // And the words must be in the title or the first heading: a notice elsewhere in the text is not enough.
  const quiet = '<html><head><title>Aqua Manga</title></head><body><p>Temporarily offline.</p></body></html>';
  assert.equal(offlineNotice(quiet, MADARA_MARKUP), null);
});

test('every Manganato call on an offline notice throws the classified error; a working page does not', async () => {
  stubSolver(() => AQUA_OFFLINE);
  const src = makeManganato({ id: 'nato', name: 'Nato', base: BASE });
  await offline(src.search('solo leveling'), 'search');
  // latest() and popular() swallow a failed path and try the next; a site answering every path with its notice
  // is the site down, and says so.
  await offline(src.latest!(1), 'latest');
  await offline(src.popular!(1), 'popular');
  await offline(src.getSeries(`${BASE}/manga/solo-leveling`), 'getSeries');
  await offline(src.listChapters(`${BASE}/manga/solo-leveling`), 'listChapters');
  await offline(src.getPageUrls(`${BASE}/manga/solo-leveling/chapter-1`), 'getPageUrls');

  // A working search with no result: the family's page, no card -- empty, not offline.
  stubSolver(() => `<html><head><title>Search results - Nato</title></head><body><div class="panel-search-story"></div>
    <a href="${BASE}/manga-list/latest-manga">Latest</a><div class="story_item"></div></body></html>`);
  assert.deepEqual(await src.search('nothing at all'), []);
});
