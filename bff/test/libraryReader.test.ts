import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLibraryReader } from '../src/lib/libraryReader';

test('keeps only the content\'s look: mode, pages per view and direction', () => {
  // A theme is a reader's own comfort, never a library's: it is dropped like an unknown key.
  assert.deepEqual(cleanLibraryReader({ mode: 'paged', theme: 'sepia', spread: true, pagedDirection: 'rtl', zoom: 3 }),
    { mode: 'paged', spread: true, pagedDirection: 'rtl' });
  assert.equal(cleanLibraryReader({ theme: 'sepia' }), null, 'a library holding only a theme holds nothing');
  assert.deepEqual(cleanLibraryReader({ mode: 'sideways', theme: 'neon', spread: 'yes' }), null);
  assert.equal(cleanLibraryReader(null), null);
  assert.equal(cleanLibraryReader({}), null);
  assert.equal(cleanLibraryReader(['paged']), null);
  assert.deepEqual(cleanLibraryReader({ spread: false }), { spread: false });
});
