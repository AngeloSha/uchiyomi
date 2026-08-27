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
