// Reading a Madara listing, across the theme variations these sites actually ship.
//
// The engine is a template pointed at whatever site an operator names, so "the markup" is not one thing.
// Getting the thumbnail wrong does not fail loudly: titles still parse, the wall still fills, and every card
// is simply blank. ManhuaPlus looked like that on a live install -- fifteen results, fifteen thumbnails in
// the HTML, none of them found, because its theme wraps them in `item-thumbnail` and the engine only knew
// stock Madara's `tab-thumb`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResults, isListingPage } from '../src/lib/sources/engines/madara';

// Verbatim shape from manhuaplus.org.
const ITEM_THUMB = `
<article class="pbt-12 grid gtc-3c bb-1pxsf" role="article">
  <div class="item-thumbnail">
    <a href="https://manhuaplus.org/manga/demon-magic-emperor">
      <img class="lazy" alt="Magic Emperor" src="https://manhuaplus.org/uploads/covers/demon-magic-emperor.jpg?1697626580"
           data-src="https://manhuaplus.org/uploads/covers/demon-magic-emperor.jpg?1697626580">
    </a>
  </div>
  <div class="relative">
    <h3 class="post-title m-0 fs-15 clamp toe oh">
      <a href="https://manhuaplus.org/manga/demon-magic-emperor"> Magic Emperor </a>
    </h3>
  </div>
</article>`;

// Stock Madara, which must keep working.
const TAB_THUMB = `
<div class="row c-tabs-item__content">
  <div class="tab-thumb c-image-hover">
    <a href="https://example.org/manga/some-series" title="Some Series">
      <img data-src="https://example.org/wp-content/uploads/some-series-193x278.webp" src="/placeholder.gif" alt="Some Series">
    </a>
  </div>
  <div class="post-title"><h3><a href="https://example.org/manga/some-series">Some Series</a></h3></div>
</div>`;

test('THE BLANK WALL: a theme using item-thumbnail still yields covers', () => {
  // Reintroduce by narrowing the cover matcher back to `tab-thumb` alone: coverUrl becomes undefined, the
  // card renders empty, and nothing anywhere reports a problem -- which is exactly how this reached a live
  // wall and stayed there.
  const out = parseResults(ITEM_THUMB, 'manhuaplus');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Magic Emperor');
  assert.match(out[0].coverUrl || '', /demon-magic-emperor\.jpg/, 'the thumbnail was in the html and was not found');
  assert.equal(out[0].source, 'manhuaplus');
});

test('stock Madara markup keeps working', () => {
  // Widening the matcher must not cost the convention it was written for. Reintroduce by REPLACING
  // `tab-thumb` with `item-thumb` instead of accepting both.
  const out = parseResults(TAB_THUMB, 'example');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Some Series');
  assert.match(out[0].coverUrl || '', /some-series-193x278\.webp/);
});

test('a lazy-loading theme gives the real image, not the placeholder', () => {
  // `src` holds a spacer until JS runs; `data-src` holds the actual cover. Preferring `src` shows every
  // card as the same grey pixel.
  const out = parseResults(TAB_THUMB, 'example');
  assert.doesNotMatch(out[0].coverUrl || '', /placeholder/, 'the placeholder was taken instead of the cover');
});

test('a card with no thumbnail anywhere still returns the series', () => {
  const html = '<div class="post-title"><h3><a href="https://example.org/manga/no-art">No Art</a></h3></div>';
  const out = parseResults(html, 'example');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'No Art');
  assert.equal(out[0].coverUrl, undefined, 'a missing cover must not become a broken url');
});

test('a theme with thumbnails but no readable heading still yields series', () => {
  // Some Madara themes do not put a `post-title` element where the heading pass can find it. The card
  // thumbnail is one per card and carries the name in `alt`, which is enough. Reintroduce by deleting the
  // second pass in parseResults.
  const html = `
    <div class="item-thumbnail">
      <a href="https://example.org/manga/only-a-thumb">
        <img alt="Only A Thumb" data-src="https://example.org/covers/only-a-thumb.webp">
      </a>
    </div>`;
  const out = parseResults(html, 'example');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Only A Thumb');
  assert.match(out[0].coverUrl || '', /only-a-thumb\.webp/);
});

test('the second pass never reaches past the cards into sidebars', () => {
  // Unbounded it returned sixty-three entries for a six-series listing, filling the wall with whatever the
  // site considers perennially popular. Reintroduce by dropping the thumbnail-wrapper requirement.
  const html = `
    <div class="item-thumbnail"><a href="https://example.org/manga/real-card"><img alt="Real Card" src="/a.webp"></a></div>
    <aside class="widget popular">
      <a href="https://example.org/manga/sidebar-one"><img alt="Sidebar One" src="/b.webp"></a>
      <a href="https://example.org/manga/sidebar-two"><img alt="Sidebar Two" src="/c.webp"></a>
    </aside>`;
  const titles = parseResults(html, 'example').map((o) => o.title);
  assert.deepEqual(titles, ['Real Card'], `sidebar entries leaked in: ${titles.join(', ')}`);
});

test('one series with three recent chapters is one result, not three', () => {
  // Measured on manhuaplus: fifteen cards, six series. Collapsing them is correct, and a wall that showed
  // the same title three times would be the bug.
  const card = (slug: string) =>
    `<div class="item-thumbnail"><a href="https://example.org/manga/${slug}"><img alt="${slug}" src="/x.webp"></a></div>`;
  const out = parseResults(card('a') + card('a') + card('a') + card('b'), 'example');
  assert.deepEqual(out.map((o) => o.title), ['a', 'b']);
});

// ---------------------------------------------------------------------------------------------------
// THE TRAILING SLASH.
//
// Every fixture above writes `https://example.org/manga/some-series`. Real Madara sites write
// `…/some-series/`, and that one character was the whole of the second MangaRead cover bug: the heading
// pass and the cover map key on the href as written, while the thumbnail-fallback pattern ends
// `[^"/?#]+)\/?"` with the `/?` OUTSIDE the capture, so it keys on the href with the slash stripped. The
// sets never met. Twelve series parsed as twenty-four, the twelve extra titled from their `<img alt>` and
// carrying no cover -- and because `latestPage` dedupes by sourceId (which differed) and then takes 24,
// half of the source's Discover feed was a copy of the other half.
//
// ⚠️ BOTH ORDERS ARE ASSERTED, for the same reason imgAttr.test.ts asserts both attribute orders: a site
// can write the slash in either place, and a test that pins only one is passed by the bug.

/** A stock Madara card, with the slash on whichever hrefs the caller asks for. */
const slashCard = (slug: string, where: 'both' | 'thumb' | 'title' | 'neither') => {
  const t = where === 'both' || where === 'thumb' ? '/' : '';
  const h = where === 'both' || where === 'title' ? '/' : '';
  return `
    <div class="page-item-detail">
      <div class="item-thumb">
        <a href="https://example.org/manga/${slug}${t}"><img alt="Read ${slug}" src="https://cdn/${slug}.jpg"></a>
      </div>
      <div class="post-title"><h3><a href="https://example.org/manga/${slug}${h}">${slug}</a></h3></div>
    </div>`;
};

test('THE DOUBLED LISTING: a site that writes trailing slashes yields one entry per series', () => {
  // Reintroduce by keying `covers`/`seen` on `norm(...)` instead of `key(...)`: this returns six entries for
  // three series, and the three extra ones are titled "Read a" and have no cover at all.
  const html = ['a', 'b', 'c'].map((s) => slashCard(s, 'both')).join('');
  const out = parseResults(html, 'example');
  assert.deepEqual(out.map((o) => o.title), ['a', 'b', 'c'], 'one entry per series, titled from the heading');
  assert.deepEqual(out.map((o) => o.coverUrl), ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg']);
});

test('the url a series is stored under keeps the slash the site wrote', () => {
  // ⚠️ The KEY is normalised, never the identity. `sourceId` is how a series is stored, and series already
  // in a library carry the slashed form -- rewriting it here would orphan every one of them.
  // Reintroduce by emitting `key(m[1])` as the url: every existing MangaRead series stops matching.
  const [only] = parseResults(slashCard('blue-lock', 'both'), 'example');
  assert.equal(only.url, 'https://example.org/manga/blue-lock/');
  assert.equal(only.sourceId, 'https://example.org/manga/blue-lock/');
});

test('THE MIRROR CASE: a bare thumbnail href and a slashed heading href still find each other', () => {
  // The same disagreement the other way round. Nobody has reported this one, because it needs a theme that
  // writes the slash in its heading and not in its thumbnail -- but it loses EVERY cover, not half of them.
  // Reintroduce by dropping the key normalisation: coverUrl is undefined on all three.
  const html = ['a', 'b', 'c'].map((s) => slashCard(s, 'title')).join('');
  const out = parseResults(html, 'example');
  assert.deepEqual(out.map((o) => o.title), ['a', 'b', 'c']);
  assert.deepEqual(out.map((o) => o.coverUrl), ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'],
    'the heading pass must find the cover the thumbnail pass stored');
});

test('and the reverse mirror, plus the no-slash shape the older fixtures use', () => {
  for (const where of ['thumb', 'neither'] as const) {
    const out = parseResults(['a', 'b'].map((s) => slashCard(s, where)).join(''), 'example');
    assert.deepEqual(out.map((o) => o.title), ['a', 'b'], `${where}: one entry per series`);
    assert.deepEqual(out.map((o) => o.coverUrl), ['https://cdn/a.jpg', 'https://cdn/b.jpg'], `${where}: covers found`);
  }
});

test('the alt-titled fallback still works when there is genuinely no heading', () => {
  // The doubling fix must not disarm the pass it came from: a theme with thumbnails and no `post-title`
  // still has to yield its series, slash or no slash.
  // Reintroduce by deleting the fallback pass: this returns nothing at all.
  const card = (slug: string) =>
    `<div class="item-thumb"><a href="https://example.org/manga/${slug}/"><img alt="${slug}" src="/x.webp"></a></div>`;
  const out = parseResults(card('only-a-thumb') + card('another'), 'example');
  assert.deepEqual(out.map((o) => o.title), ['only-a-thumb', 'another']);
  assert.deepEqual(out.map((o) => o.coverUrl), ['/x.webp', '/x.webp']);

  // ⚠️ This pass emits the url WITHOUT the trailing slash, because its own pattern ends `[^"/?#]+)\/?"` and
  // the `/?` is outside the capture. That is left exactly as it was, deliberately: for a theme with no
  // headings this pass is the ONLY source of the url, so it is also the sourceId every series from that
  // site was stored under. Making it faithful to the markup would orphan all of them for a cosmetic gain.
  // The bug was never the shape -- it was the two shapes being compared to each other.
  assert.equal(out[0].url, 'https://example.org/manga/only-a-thumb');
});

// ---- v0.60.0: a page that is not a listing --------------------------------------------------------------------------
// The body tags as the sites send them (2026-10-11): MangaRead's and ManhuaUS's search, Newest and Popular pages, and
// what ManhuaPlus now answers a search with -- its /home, no longer Madara.
const SEARCH_BODY = '<body class="archive search search-results post-type-archive post-type-archive-wp-manga wp-embed-responsive wp-manga-page page header-style-1 is-sidebar text-ui-dark">';
const MANHUAPLUS_HOME = `<html><head><title>Manhuaplus - Read Manga Fastest and highest quality updates</title></head><body id='modeSwitch'>${ITEM_THUMB}${ITEM_THUMB}</body></html>`;

test('a listing page is a search or the manga archive, by what WordPress marks its body', () => {
  assert.equal(isListingPage(`<html>${SEARCH_BODY}<div class="c-tabs-item__content"></div></body></html>`), true, 'a Madara search page');
  assert.equal(isListingPage('<body class="archive post-type-archive post-type-archive-wp-manga">'), true,
    'the manga archive an empty search can redirect to');
  assert.equal(isListingPage('<body class="search search-no-results">'), true, 'a search that found nothing is still a listing');
  assert.equal(isListingPage(MANHUAPLUS_HOME), false, "ManhuaPlus's /home: no class at all");
  assert.equal(isListingPage('<body class="home page-template-default page">'), false, "a WordPress site's front page");
  assert.equal(isListingPage('<body class="researchers">'), false, 'a class that only contains the word');
  assert.equal(isListingPage(ITEM_THUMB), true, 'no <body> to judge by: left to the parser, as before');
  // PREMISE: the homepage's widgets do parse as results -- which is exactly what reached the wall and the search.
  assert.ok(parseResults(MANHUAPLUS_HOME, 'manhuaplus').length > 0, 'PREMISE: the widgets parse');
});
