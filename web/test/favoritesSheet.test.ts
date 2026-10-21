// Home's Favourites sheet (v0.97.0): the owner's "we need a better system to reorder favorites". The order and the
// endpoint are held by bff/test/favoritesOrder.int.test.ts; this holds the wiring a static export can be read for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source with comments stripped, so a key in a comment cannot satisfy an assertion. */
const code = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

test("Home's favourites rail opens the sheet from Manage, not Profile", () => {
  // Reintroduce the link to /profile: Manage goes to a page with nothing for favourites.
  const home = code(read('app/page.tsx'));
  assert.match(home, /<SectionTitle action=\{<FavoritesManage \/>\}>\{tr\('Your favorites'\)\}<\/SectionTitle>/);
  assert.doesNotMatch(home, /<Link href="\/profile"[^>]*>\{tr\('Manage'\)\}/);
});

test('the sheet drags, moves a step and removes, and saves the whole order to the server', () => {
  // Reintroduce a save of the moved row alone, or drop the drag hook: the order no longer reaches every device.
  const src = code(read('components/FavoritesSheet.tsx'));
  assert.match(src, /useDragReorder\(\{ count: items\.length, layout: 'column', onMove: \(from, to\) => reorder\(moveTo\(items, from, to\)\) \}\)/);
  assert.match(src, /api\('\/api\/favorites\/order', \{ method: 'PUT', json: \{ seriesIds: want \} \}\)/);
  assert.match(src, /const reorder = \(next: Series\[\]\) => \{ setShown\(next\); save\(next\.map\(\(s\) => s\.id\)\); \};/);
  assert.match(src, /onMove=\{\(by\) => reorder\(moveTo\(items, i, i \+ by\)\)\}/, 'the arrows do not move a step');
  assert.match(src, /api\(`\/api\/favorites\/\$\{encodeURIComponent\(s\.id\)\}`, \{ method: 'DELETE' \}\)/, 'no way to take one off');
  // Every key names its series for a screen reader, as Customize Home's do.
  assert.equal((src.match(/aria-describedby=\{id\}/g) ?? []).length, 3);
});

test("the sheet's one new sentence is in every language", () => {
  for (const lang of ['ar', 'de', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh']) {
    const d = JSON.parse(read(`public/locales/${lang}.json`));
    const k = 'Home shows your favorites in this order. Drag one into place, or move it with its arrows.';
    assert.ok(d[k] && d[k] !== k, `${lang} lacks the sheet's sentence`);
  }
});
