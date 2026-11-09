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
  // The × asks the server what would go first (lib/sourceLeftovers.ts); the main source then always asks before it detaches.
  assert.match(sheet, /onUnfollow=\{isAdmin \? \(\) => void askUnfollow\(s\)/);
  assert.match(sheet, /if \(s\.primary\) \{[^\n]*setDetachAsk\(true\); return; \}/, 'the main row asks before it detaches');
  assert.match(sheet, /data-detach-confirm/);
  const mig = readFileSync(new URL('../components/MigrateSourceSheet.tsx', import.meta.url), 'utf8');
  assert.match(mig, /\/attach-source/);
  assert.match(mig, /search-all\?groupBy=source/);
});

test('the source sheet leaves adult=1 to api(), once', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['components/MigrateSourceSheet.tsx', 'components/SourceSearchPages.tsx', 'components/ImportMatchSheet.tsx', 'app/admin/import/page.tsx']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    // api() already appends adult=1; withAdult here makes it adult=1&adult=1, which hideAdult reads as an array, not '1'.
    assert.doesNotMatch(src, /withAdult\(/, `${f} adds adult=1 on top of api()`);
  }
});

test("the admin's source tools ask every source the account may use, whatever Show 18+ says (#405, #412)", async () => {
  // Reintroduce the plain URLs: with Show 18+ off, Add more sources and the import's Change leave out every source an
  // extension calls adult -- on many servers nearly all of them -- and "No one has anything by that name".
  const { readFileSync } = await import('node:fs');
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const mig = src('components/MigrateSourceSheet.tsx');
  assert.match(mig, /api<\{ content: Src\[\] \}>\(revealed\('\/api\/sources'\)\)/);
  assert.match(mig, /revealed\(`\/api\/sources\/search-all\?groupBy=source/);
  assert.match(mig, /revealed\(`\/api\/sources\/detail\?source=/);
  assert.match(src('components/SourceSearchPages.tsx'), /const url = revealed\(`\/api\/sources\/search\?source=/);
  const imp = src('components/ImportMatchSheet.tsx');
  assert.match(imp, /revealed\(`\/api\/sources\/search-all\?groupBy=source/);
  for (const f of ['components/ImportMatchSheet.tsx', 'app/admin/import/page.tsx']) {
    // Under its own key: a revealed list must never be the one Discover reads from ['sources'].
    assert.match(src(f), /queryKey: \['sources', 'all'\],\s*queryFn: \(\) => api<\{ content: Src\[\] \}>\(revealed\('\/api\/sources'\)\)/, f);
  }
});

test('revealed() and withAdult() add adult=1 exactly once', async () => {
  // Reintroduce the unconditional append in revealed or withAdult: a URL that already asks arrives twice, as an array.
  const { revealed, withAdult } = await import('../lib/adult');
  assert.equal(revealed('/api/sources'), '/api/sources?adult=1');
  assert.equal(revealed('/api/sources/search?q=x'), '/api/sources/search?q=x&adult=1');
  assert.equal(revealed('/api/sources?adult=1'), '/api/sources?adult=1');
  assert.equal(revealed('/api/x?q=a&adult=1&page=2'), '/api/x?q=a&adult=1&page=2');
  const g = globalThis as { document?: unknown };
  const had = g.document;
  g.document = { cookie: 'yomi_adult=1' };
  try {
    assert.equal(withAdult('/api/sources'), '/api/sources?adult=1', 'PREMISE: the reveal is on');
    assert.equal(withAdult(revealed('/api/sources')), '/api/sources?adult=1', 'api() doubled a revealed URL');
  } finally { g.document = had; }
  assert.equal(withAdult('/api/sources'), '/api/sources', 'the reveal off leaves a URL as it was');
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
