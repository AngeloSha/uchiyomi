// Reading a Madara listing, across the theme variations these sites actually ship.
//
// The engine is a template pointed at whatever site an operator names, so "the markup" is not one thing.
// Getting the thumbnail wrong does not fail loudly: titles still parse, the wall still fills, and every card
// is simply blank. ManhuaPlus looked like that on a live install -- fifteen results, fifteen thumbnails in
// the HTML, none of them found, because its theme wraps them in `item-thumbnail` and the engine only knew
// stock Madara's `tab-thumb`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResults } from '../src/lib/sources/engines/madara';

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
