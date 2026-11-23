// A listing the adapter marked GALLERY is added as posting order (#294): its 1..n are a position, not a number
// the source chose, so they belong in series_post_numbers where a deleted part leaves a hole instead of
// renumbering every later chapter. Pure: no database, no network.
//
// env.ts validates DATABASE_URL on load (lib/numbering.ts imports it), so the module is imported after the
// environment is set -- a static import is hoisted above these assignments. Nothing here connects.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GALLERY, galleryOf, type SourceChapter } from '../src/lib/sources/types';

let numberingFor: typeof import('../src/lib/numbering').numberingFor;
test.before(async () => { ({ numberingFor } = await import('../src/lib/numbering')); });

const row = (sourceId: string, number: number, order: number): SourceChapter =>
  ({ sourceId, number, order, title: `Chapter ${number}`, pages: 4 });

const gallery = (rows: SourceChapter[]): SourceChapter[] =>
  Object.defineProperty(rows, GALLERY, { value: true }) as SourceChapter[];

test('a gallery is added by posting order, so its numbers are stored and a deleted part leaves a hole', () => {
  const raw = gallery([row('c', 3, 3), row('a', 1, 1), row('b', 2, 2)]);
  assert.equal(galleryOf(raw), true);
  const n = numberingFor(raw, 'auto');
  assert.equal(n.applied, 'posting_order');
  assert.deepEqual(n.chapters.map((c) => [c.sourceId, c.number]), [['a', 1], ['b', 2], ['c', 3]]);
  assert.deepEqual(n.assignment?.rows.map((r) => [r.postId, r.number]), [['a', 1], ['b', 2], ['c', 3]]);
  // The same listing without the mark is the source's numbers, untouched.
  const plain = numberingFor([row('c', 3, 3), row('a', 1, 1), row('b', 2, 2)], 'auto');
  assert.equal(plain.applied, 'source');
  assert.deepEqual(plain.chapters.map((c) => c.number), [3, 1, 2]);
});

test('the gallery mark survives only on a non-empty listing, and an asked-for numbering still wins', () => {
  assert.equal(numberingFor(gallery([]), 'auto').applied, 'source');
  assert.equal(numberingFor(gallery([row('a', 1, 1)]), 'posting_order').applied, 'posting_order');
  // An admin asking for the source's numbers gets them, gallery or not.
  assert.equal(numberingFor(gallery([row('a', 1, 1), row('b', 2, 2)]), 'source').applied, 'source');
});
