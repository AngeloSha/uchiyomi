// Reading a Manganato-family listing page, whichever markup the site is serving this month.
//
// Both sites on the install this was written against silently stopped working: `/genre-all` began answering
// 200 with a 20 KB stub containing no series at all, and the listing moved to `/manga-list/latest-manga`
// with rebranded markup. Nothing threw, so nothing was recorded, and Mangakakalot had been dead for nearly
// two months while still reporting healthy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseListing } from '../src/lib/sources/engines/manganato';

// Current markup, copied from mangakakalot.gg. The name is in the anchor's `title`, not its text.
const CURRENT = `
<div class="list-comic-item-wrap">
  <a data-id="94396" class="list-story-item bookmark_check cover"
     href="https://www.mangakakalot.gg/manga/mage-of-the-wind" title="Mage of the Wind">
    <img alt="Mage of the Wind" class="lazy" src="https://img-r1.2xstorage.com/thumb/mage-of-the-wind.webp">
  </a>
</div>
<div class="list-comic-item-wrap">
  <a class="list-story-item cover" href="https://www.mangakakalot.gg/manga/a-married-killer" title="A Married Killer">
    <img alt="A Married Killer" src="https://img-r1.2xstorage.com/thumb/a-married-killer.webp">
  </a>
</div>`;

// The older Manganato markup, which sites that have not been rebranded still serve.
const LEGACY = `
<div class="genres-item-name">
  <a href="https://old.example/manga/some-slug">Some Older Series</a>
</div>`;

// What /genre-all serves now: a page that is fine by every measure except containing anything.
const STUB = '<html><body><div class="container"><p>Nothing here</p></div></body></html>';

test('the current listing markup is read, titles and covers included', () => {
  const out = parseListing(CURRENT, 'mangakakalot');
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Mage of the Wind');
  assert.match(out[0].url!, /\/manga\/mage-of-the-wind$/);
  assert.match(out[0].coverUrl!, /mage-of-the-wind\.webp$/);
  assert.equal(out[0].source, 'mangakakalot');
});

test('THE REGRESSION: latest() must ask for the listing path that exists', () => {
  // This is the actual bug, and it took a wrong turn first. The parsing was never broken -- the pre-existing
  // alt-text fallback reads the current markup perfectly well (verified against 141 KB of real
  // mangakakalot.gg HTML: 24 series). What broke is that `/genre-all`, the only path the engine ever asked
  // for, now answers 200 with a stub containing no series at all. An empty page throws nothing, so the
  // source recorded no failure and simply went quiet for months.
  //
  // A static check on the call site, because the invariant is about which URL is requested and the fetch is
  // a direct import. Reintroduce by removing `/manga-list/latest-manga` from `paths`.
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'sources', 'engines', 'manganato.ts'), 'utf8');
  const at = src.indexOf('const paths = [');
  assert.ok(at > 0, 'latest() no longer offers a list of candidate paths');
  const block = src.slice(at, src.indexOf('];', at));
  assert.match(block, /manga-list\/latest-manga/, 'the current listing path is not among those tried');
  assert.match(block, /genre-all/, 'the older path must stay as a fallback for sites still serving it');
});

test('sites still on the old markup keep working', () => {
  // Patterns are tried in order and the first that matches wins, so adding support for the new layout must
  // not cost the old one. Reintroduce by replacing the fallbacks instead of appending to them.
  const out = parseListing(LEGACY, 'natomanga');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Some Older Series');
});

test('a page with no series parses to nothing rather than to junk', () => {
  assert.deepEqual(parseListing(STUB, 'x'), []);
  assert.deepEqual(parseListing('', 'x'), []);
});

test('the same series linked twice is returned once', () => {
  // Listing pages also link series from a sidebar and a "hot" carousel, so duplicates are normal.
  const out = parseListing(CURRENT + CURRENT, 'x');
  assert.equal(out.length, 2, 'duplicate urls should collapse');
});

// Real markup: a listing page shows each series WITH its latest chapters, and both live under /manga/.
const WITH_CHAPTERS = `
<div class="list-comic-item-wrap">
  <a class="list-story-item cover" href="https://www.natomanga.com/manga/dog-eat-dog" title="Dog Eat Dog">
    <img alt="Dog Eat Dog" src="https://imgs-2.2xstorage.com/thumb/dog-eat-dog.webp">
  </a>
  <a href="https://www.natomanga.com/manga/dog-eat-dog/chapter-2" title="Chapter 2">Chapter 2</a>
  <a href="https://www.natomanga.com/manga/dog-eat-dog/chapter-1" title="Chapter 1">Chapter 1</a>
</div>`;

test('THE REGRESSION: a chapter link is not a series', () => {
  // Shipped in v0.9.8 and found on the live wall. Matching any anchor whose href contains /manga/ harvested
  // every chapter link on the page: natomanga returned twenty-four "series", of which twelve were called
  // things like "Chapter 156" and had no cover, because a chapter page has no cover to find. Half the wall
  // was junk.
  //
  // Reintroduce by dropping the isSeriesUrl guard: the count goes to 3 and the titles become chapters.
  const out = parseListing(WITH_CHAPTERS, 'natomanga');
  assert.equal(out.length, 1, `expected only the series, got ${out.map((o) => o.title).join(', ')}`);
  assert.equal(out[0].title, 'Dog Eat Dog');
  assert.doesNotMatch(out[0].sourceId, /chapter/i);
  assert.match(out[0].coverUrl || '', /dog-eat-dog\.webp$/, 'the series cover should survive the filter');
});

test('every returned item is a series url, never a chapter one', () => {
  for (const item of parseListing(WITH_CHAPTERS + CURRENT, 'x')) {
    assert.doesNotMatch(item.sourceId, /\/chapter/i, `${item.title} is a chapter, not a series`);
    assert.match(item.sourceId, /\/manga\/[^/]+\/?$/, `${item.sourceId} is not a series url`);
  }
});

test('THE MISSING COVERS: sidebar links must not crowd out the listing', () => {
  // A listing page also carries "popular" and "recommended" widgets. Their links have a `title` attribute
  // but no thumbnail beside them, and they appear EARLY in the document -- so parsing the whole page fed
  // the wall sidebar entries with no artwork and pushed real results past the item budget. Measured on
  // natomanga: thirteen of twenty-four entries arrived with no cover.
  //
  // Reintroduce by parsing `h` instead of the card scope: the sidebar entry comes back and it has no cover.
  const html = `
    <aside class="widget">
      <a href="https://www.natomanga.com/manga/sidebar-favourite" title="Sidebar Favourite">Sidebar Favourite</a>
    </aside>
    <div class="list-comic-item-wrap">
      <a class="list-story-item cover" href="https://www.natomanga.com/manga/real-listing" title="Real Listing">
        <img alt="Real Listing" src="https://imgs-2.2xstorage.com/thumb/real-listing.webp">
      </a>
    </div>`;
  const out = parseListing(html, 'natomanga');
  assert.deepEqual(out.map((o) => o.title), ['Real Listing'], 'a sidebar entry reached the wall');
  assert.ok(out[0].coverUrl, 'the listing entry should carry its cover');
});

test('a theme with no card wrapper still parses the whole page', () => {
  // The scoping must not break sites that lay their listing out differently; those fall back to the old
  // behaviour of reading the document. Reintroduce by scoping unconditionally: this returns nothing.
  const out = parseListing(LEGACY, 'other');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Some Older Series');
});
