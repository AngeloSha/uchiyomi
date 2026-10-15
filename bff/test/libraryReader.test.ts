import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLibraryReader } from '../src/lib/libraryReader';

test('keeps only valid look keys', () => {
  assert.deepEqual(cleanLibraryReader({ mode: 'paged', theme: 'sepia', spread: true, pagedDirection: 'rtl', zoom: 3 }),
    { mode: 'paged', theme: 'sepia', spread: true, pagedDirection: 'rtl' });
  assert.deepEqual(cleanLibraryReader({ mode: 'sideways', theme: 'neon', spread: 'yes' }), null);
  assert.equal(cleanLibraryReader(null), null);
  assert.equal(cleanLibraryReader({}), null);
  assert.deepEqual(cleanLibraryReader({ spread: false }), { spread: false });
});
