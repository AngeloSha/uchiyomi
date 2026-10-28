import test from 'node:test';
import assert from 'node:assert/strict';
import { creatorSearchBudget, supportsCreatorSearch } from '../lib/sourceGroups';

test('creator source choices and pagination use the actual role, while browsing/title retain every source', () => {
  const pool = [
    { id: 'title-only' }, { id: 'both', creatorSearch: true },
    { id: 'author', creatorSearch: true, creatorFields: ['author'] as const },
    { id: 'artist', creatorSearch: true, creatorFields: ['artist'] as const },
    { id: 'none', creatorSearch: true, creatorFields: [] },
  ];
  assert.equal(creatorSearchBudget(pool, 'newest', 'author'), pool, 'creator field limited ordinary browsing');
  assert.equal(creatorSearchBudget(pool, 'search', 'title'), pool, 'title search dropped a source');
  assert.deepEqual(creatorSearchBudget(pool, 'search', 'author').map((s) => s.id), ['both', 'author']);
  assert.deepEqual(creatorSearchBudget(pool, 'search', 'artist').map((s) => s.id), ['both', 'artist']);
  assert.equal(supportsCreatorSearch(pool[2], 'artist'), false);
  assert.equal(supportsCreatorSearch(undefined, 'author'), false);
});
