// A block or unblock changes every cached series page at once: the server applies it to the stored listing before it
// answers (bff lib/seriesListing.ts reapplyBlocklist), and the page's queries must refetch to show it. Reintroduce by
// dropping the invalidation: a series page already open keeps the chapters only the blocked group released.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

test('the global Scanlators save refetches every series page\'s rows, versions and groups', () => {
  const src = read('components/AdminSettings.tsx');
  assert.match(src, /if \(body\.scanlatorPrefs !== undefined\) \{\s*for \(const k of \['series-listing', 'series-versions', 'series-groups', 'series-scanlators'\]\) void qc\.invalidateQueries\(\{ queryKey: \[k\] \}\);/);
});

test('a series\' own Block refetches its rows, versions and groups', () => {
  const src = read('components/SourcesSheet.tsx');
  assert.match(src, /for \(const k of \['series-scanlators', 'series-groups', 'series-listing', 'series-versions'\]\) qc\.invalidateQueries\(\{ queryKey: \[k, id\] \}\);/);
});
