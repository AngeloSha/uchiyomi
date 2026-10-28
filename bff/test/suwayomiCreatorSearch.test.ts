import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
const load = () => import('../src/lib/sources/suwayomi/sources');
const remote = { id: '19', name: 'Fixture', lang: 'en' };

test('only explicit creator text filters declare supported roles and retain header/group positions', async () => {
  const { creatorFilterPaths, creatorFilterChange } = await import('../src/lib/sources/suwayomi/creatorFilters');
  const filters = [
    { __typename: 'HeaderFilter', name: 'Author' },
    { __typename: 'CheckBoxFilter', name: 'Artist' },
    { __typename: 'TextFilter', name: "Author's notes" },
    { __typename: 'TextFilter', name: 'Author ID' },
    { __typename: 'TextFilter', name: 'Author (Case-sensitive)' },
    { __typename: 'GroupFilter', filters: [{ __typename: 'SeparatorFilter' }, { __typename: 'TextFilter', name: 'Artists' }] },
  ];
  const paths = creatorFilterPaths(filters);
  assert.deepEqual([...paths], [['author', [4]], ['artist', [5, 1]]]);
  assert.deepEqual(creatorFilterChange(paths.get('artist')!, 'Name "as typed"'), { position: 5, groupChange: { position: 1, textState: 'Name "as typed"' } });
  assert.deepEqual([...creatorFilterPaths([{ __typename: 'TextFilter', name: 'Author / Artist' }]).keys()], ['author', 'artist']);
  assert.equal(creatorFilterPaths([{ __typename: 'TextFilter', name: 'Author' }, { __typename: 'TextFilter', name: 'Authors' }]).size, 0, 'ambiguous positions cannot be guessed');
  for (const bad of [null, {}, [null, 42, { name: 'Author' }, { __typename: 'TextFilter', name: 42 }]]) assert.equal(creatorFilterPaths(bad).size, 0);
});

test('creator queries send typed request filters, empty title query, requested page and case-preserved name', async () => {
  const { makeSuwayomiAdapter } = await load();
  const { supportsCreatorSearch } = await import('../src/lib/sources/types');
  const sent: Array<{ doc: string; vars: any }> = [];
  const run = (async (doc: string, vars: any) => {
    sent.push({ doc, vars });
    return { fetchSourceManga: { mangas: [{ id: 77, title: 'A different title', sourceId: '19' }] } };
  }) as never;
  const adapter = makeSuwayomiAdapter({ ...remote, filters: [{ __typename: 'SeparatorFilter' }, { __typename: 'TextFilter', name: 'Author (Case-sensitive)' }] }, run);
  assert.equal(supportsCreatorSearch(adapter, 'author'), true);
  assert.equal(supportsCreatorSearch(adapter, 'artist'), false);
  assert.deepEqual(await adapter.searchCreator!('Nobody', 'artist'), []);
  assert.deepEqual(await adapter.searchCreator!('  ', 'author'), []);
  assert.equal(sent.length, 0, 'unsupported/empty creator input is never a title fallback');
  const results = await adapter.searchCreator!('  Oda Eiichirou  ', 'author', 3);
  assert.equal(results[0].source, 'sw:19');
  assert.deepEqual(sent[0].vars, { source: '19', type: 'SEARCH', query: '', page: 3, filters: [{ position: 1, textState: 'Oda Eiichirou' }] });
  assert.match(sent[0].doc, /filters:\$filters/);
  assert.doesNotMatch(sent[0].doc, /updateSourcePreference|setSourceMeta/);
  await adapter.search('ordinary title');
  assert.deepEqual(sent[1].vars, { source: '19', type: 'SEARCH', query: 'ordinary title', page: 1 }, 'creator filters leaked into the next title search');
});

test('optional filter discovery enriches existing adapters without blocking ordinary search or sharing transports', async () => {
  const { makeSuwayomiAdapter, enrichCreatorSearch } = await load();
  const searchRun = (async () => ({ fetchSourceManga: { mangas: [] } })) as never;
  const adapter = makeSuwayomiAdapter(remote, searchRun);
  let release!: (data: any) => void;
  let calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const metadata = (async (_doc: string, _vars: unknown, timeout: number) => { calls++; assert.equal(timeout, 2500); return held; }) as never;
  const pending = enrichCreatorSearch([adapter], metadata);
  const also = enrichCreatorSearch([adapter], metadata);
  assert.equal(calls, 1, 'concurrent enrichment duplicated its read');
  assert.equal(adapter.searchCreator, undefined);
  assert.deepEqual(await adapter.search('still works'), []);
  release({ sources: { nodes: [{ id: '19', filters: [{ __typename: 'TextFilter', name: 'Artist' }] }] } });
  await Promise.all([pending, also]);
  assert.deepEqual(adapter.creatorFields, ['artist']);
  assert.equal(typeof adapter.searchCreator, 'function');
  const other = makeSuwayomiAdapter(remote, searchRun);
  await enrichCreatorSearch([other], (async () => { throw new Error('one extension cannot provide filters'); }) as never);
  assert.equal(other.searchCreator, undefined);
  assert.deepEqual(await other.search('works after metadata failure'), []);
});
