import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateTerms, attachButtons, sourcesParam } from '../lib/migrateSource';

test('terms: the title first, other names once each, spacing and case ignored', () => {
  assert.deepEqual(migrateTerms('  One  Piece ', ['one piece', 'ワンピース', '', 'ONE PIECE']), ['One Piece', 'ワンピース']);
});

test('terms: capped', () => {
  assert.equal(migrateTerms('a', ['b', 'c', 'd', 'e', 'f', 'g', 'h']).length, 6);
});

test('a series with a main source can follow or move; one without can only take it as main', () => {
  assert.deepEqual(attachButtons('sw:1'), { follower: true, main: true });
  assert.deepEqual(attachButtons(null), { follower: false, main: true });
});

test('sources param: a partial pick is sent, everything or nothing is not', () => {
  const all = ['sw:1', 'sw:2', 'sw:3'];
  assert.equal(sourcesParam(['sw:1', 'sw:3'], all), 'sw:1,sw:3');
  assert.equal(sourcesParam(['sw:1', 'sw:2', 'sw:3'], all), null);
  assert.equal(sourcesParam([], all), null);
  assert.equal(sourcesParam(null, all), null);
  assert.equal(sourcesParam(['sw:9', 'sw:2'], all), 'sw:2');
});

test('the source filter in Add or move source is listed A to Z', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../components/MigrateSourceSheet.tsx', import.meta.url), 'utf8');
  // Reintroduce by mapping `srcs.data?.content` straight into the list, which is install order.
  assert.match(src, /const allSources = useMemo\([\s\S]*?\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name/, 'allSources is not sorted by name');
});

test('the Sources sheet offers Add more sources, and the main source detaches after asking', async () => {
  const { readFileSync } = await import('node:fs');
  const sheet = readFileSync(new URL('../components/SourcesSheet.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /<MigrateSourceSheet id=\{id\} title=\{seriesTitle\}/);
  assert.match(sheet, /data-add-more-sources/);
  assert.match(sheet, /s\.primary \? \(\) => setDetachAsk\(true\) : \(\) => unfollow\(s\)/, 'the main row asks before it detaches');
  assert.match(sheet, /data-detach-confirm/);
  const mig = readFileSync(new URL('../components/MigrateSourceSheet.tsx', import.meta.url), 'utf8');
  assert.match(mig, /\/attach-source/);
  assert.match(mig, /search-all\?groupBy=source/);
});

test('the server is asked to check the pick: no title of ours is sent, and Attach anyway answers title_differs', async () => {
  const { readFileSync } = await import('node:fs');
  const mig = readFileSync(new URL('../components/MigrateSourceSheet.tsx', import.meta.url), 'utf8');
  // The source's own title is what the server stores (bff lib/manualAttach.ts); the route refuses a body that names one.
  // Reintroduce `title: pick.title` in the body: the first assertion fails (and the server answers 400).
  assert.match(mig, /json: \{ source: pick\.source, sourceSeriesId: pick\.sourceId, as,/, 'the body is not the checked shape');
  assert.doesNotMatch(mig, /title: pick\.title/, 'the sheet sends its own title for the pick');
  // Only a title_differs refusal offers Attach anyway, and it repeats the refused action with force.
  assert.match(mig, /errorCode\(e\) === 'title_differs'\) setDiffers\(as\)/);
  assert.match(mig, /onClick=\{\(\) => act\(differs, true\)\}[^>]*data-migrate-anyway/);
  assert.match(mig, /\.\.\.\(force \? \{ force: true \} : \{\}\)/);
});
