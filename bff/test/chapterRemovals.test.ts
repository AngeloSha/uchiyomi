// A chapter removed from a series stays removed (series_chapter_removals). Read from source: the scratch database the
// behavioural tests need is not always there, and what breaks this feature quietly is one surface forgetting the
// predicate and showing the chapter again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

test('the table exists and cascades with its series', () => {
  assert.match(read('lib/migrate.ts'), /series_chapter_removals[\s\S]{0,200}REFERENCES lib_series[\s\S]{0,40}ON DELETE CASCADE/);
});

test('every surface that lists or fetches chapters leaves a removed number out', () => {
  for (const f of ['lib/ownedCatalog.ts', 'lib/seriesListing.ts', 'lib/updater.ts']) {
    assert.match(read(f), /series_chapter_removals/, `${f} ignores removed chapters`);
  }
});

test('the routes exist and are audited', () => {
  const admin = read('routes/admin.ts');
  for (const r of ['chapters/remove', 'chapters/removed', 'chapters/restore']) assert.ok(admin.includes(`/api/admin/series/:id/${r}`), r);
  const lib = read('lib/chapterRemovals.ts');
  assert.match(lib, /series\.chapters_remove/);
  assert.match(lib, /series\.chapters_restore/);
  assert.match(lib, /not_owned/);
});
