// What the import review's Change sheet shows about a pick (#353): status, genres and the description, from the
// GET /api/sources/detail it already asked for the chapter count, so two similarly named titles can be told apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchPreview } from '../lib/matchPreview';

test('a pick reads its status in words, its first genres on one line, and its description', () => {
  const p = matchPreview({ status: 'ONGOING', genres: ['Romance', 'Comedy', 'School', 'Drama', 'Slice of Life'], summary: '  Two delinquents in Shonan.  ' });
  assert.equal(p.facts, 'Ongoing · Romance · Comedy · School · Drama', 'status, then the first four genres');
  assert.equal(p.summary, 'Two delinquents in Shonan.');
});

test('a pick with nothing to say shows nothing, and an older server answer still reads', () => {
  assert.deepEqual(matchPreview({ status: '', genres: [], summary: '' }), { facts: '', summary: '' });
  assert.deepEqual(matchPreview({}), { facts: '', summary: '' });
  assert.deepEqual(matchPreview(undefined), { facts: '', summary: '' });
  assert.equal(matchPreview({ genres: [' Action ', '', 'Action'] }).facts, 'Action', 'blank and repeated genres are dropped');
  assert.equal(matchPreview({ status: 'completed' }).facts, 'Completed');
});

test('the Change sheet shows the preview on both picks it compares', () => {
  // Reintroduce by dropping `preview` from a MiniCard: that pick shows only its title and chapter count again.
  const src = readFileSync(join(__dirname, '..', 'components', 'ImportMatchSheet.tsx'), 'utf8');
  assert.match(src, /preview=\{matchPreview\(currentDetail\.data\)\}/, 'the current pick has no preview');
  assert.match(src, /preview=\{matchPreview\(pendingDetail\.data\)\}/, 'the new pick has no preview');
});
