// The chapter preview's client (#91): what it asks for, and the two ways the first version broke its dialog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inOrder, neighbours, previewCountUrl, previewListUrl, previewPageUrl } from '../lib/preview';

test('a page is asked for by chapter number and index, never by a URL', () => {
  assert.equal(previewPageUrl('aqua', 'https://aquamanga.org/manga/x/', 12.5, 3),
    '/img/sources/preview?source=aqua&sourceId=https%3A%2F%2Faquamanga.org%2Fmanga%2Fx%2F&number=12.5&i=3');
  assert.equal(previewCountUrl('aqua', 'x', 12), '/api/sources/preview/pages?source=aqua&sourceId=x&number=12');
  assert.equal(previewListUrl('sw:8683', 'id 1'), '/api/sources/preview?source=sw%3A8683&sourceId=id%201');
});

test('chapters step in reading order', () => {
  const list = inOrder([{ number: 3, title: null, scanlator: null }, { number: 1, title: null, scanlator: null }, { number: 2.5, title: null, scanlator: null }]);
  assert.deepEqual(list.map((c) => c.number), [1, 2.5, 3]);
  assert.deepEqual(neighbours(list, 2.5), { prev: 1, next: 3 });
  assert.deepEqual(neighbours(list, 1), { prev: undefined, next: 2.5 });
  assert.deepEqual(neighbours(list, 9), {});
});

test('the viewer is portalled, takes Escape first, and never goes through the cover proxy', () => {
  const src = readFileSync(join(__dirname, '..', 'components/PreviewReader.tsx'), 'utf8');
  // Rendered in place, the add dialog's backdrop-filter made it the containing block for `fixed`: the
  // "full-screen" viewer was squeezed into the dialog. Reintroduce by returning the markup without the portal.
  assert.match(src, /return createPortal\(/);
  assert.match(src, /document\.body,\n  \);/);
  // The dialog closes on any Escape that reaches the document: the viewer listens in the capture phase and
  // stops it. Reintroduce by listening on `document` in the bubble phase: one Escape closes both.
  assert.match(src, /window\.addEventListener\('keydown', onKey, true\)/);
  assert.match(src, /e\.stopPropagation\(\);/);
  // The first version rendered pages through /img/sources/cover, which caches for a year and takes a URL.
  assert.doesNotMatch(src, /img\/sources\/cover/);
  assert.match(src, /retry: false/);
});
