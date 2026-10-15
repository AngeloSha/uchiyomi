// Remove a chapter from the library, and the way back. Read from source, like seriesPage.test.ts: neither has a unit
// to call, and each is the kind of thing a later tidy-up drops without a behavioural test noticing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const page = read('app/series/page.tsx');

test('a chapter row and a grey row offer Remove from library, behind a confirmation', () => {
  assert.equal((page.match(/tr\('Remove from library'\)/g) || []).length, 2, 'the chapter row and the grey row');
  assert.match(page, /\/chapters\/remove/);
  assert.match(page, /tr\('Remove this chapter from the library\?'\)/);
});

test('the select bar removes the picked numbers, behind a confirmation', () => {
  assert.match(page, /data-remove-from-series/);
  assert.match(page, /what: 'purge'/);
  assert.match(page, /tr\('Remove \{n\} chapters from the series\?'/);
});

test('the series page has a Removed chapters item for admins, with a count, that opens the list with a Restore', () => {
  const acts = read('lib/seriesActions.ts');
  assert.match(acts, /hook: 'removed-open'/);
  assert.match(acts, /tr\('Removed chapters \(\{n\}\)…', \{ n: x\.removedCount \?\? 0 \}\)/);
  assert.match(page, /case 'removed': setShowRemoved\(true\)/);
  assert.match(page, /<RemovedChaptersDialog id=\{id\}/);
  const shared = read('components/RemovedChapters.tsx');
  assert.match(shared, /\/chapters\/removed/);
  assert.match(shared, /\/chapters\/restore/);
  assert.match(shared, /tr\('Restore all'\)/);
});
