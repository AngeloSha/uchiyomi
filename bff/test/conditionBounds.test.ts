// The library search's condition tree is bounded before it becomes SQL (lib/ownedCatalog.ts condSql).
//
// The tree comes from the member: POST /api/series/search and the Komga API take it as JSON. Unbounded, a 1.9 MB
// body of 40,000 genre leaves compiled to a 3 MB SQL string with 40,000 parameters that held a pooled connection
// for seconds, twice per search, and a deep allOf chain overflowed the compiler's recursion into a 500. A tree over
// the bound is refused as UnsupportedFilter, which every route already answers with a 400.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _condSql: condSql, UnsupportedFilter, MAX_COND_NODES, MAX_COND_DEPTH } = require('../src/lib/ownedCatalog') as typeof import('../src/lib/ownedCatalog');

const genre = (g: string) => ({ genre: { operator: 'is', value: g } });

test('the Library\'s own trees still compile: a flat allOf, and an anyOf nested in it', () => {
  const params: unknown[] = [];
  const sql = condSql({ allOf: [
    { libraryId: { operator: 'is', value: 'lib' } },
    { anyOf: ['Action', 'Drama', 'Romance'].map(genre) },
    ...Array.from({ length: 30 }, (_, i) => genre(`g${i}`)),
  ] }, params);
  assert.equal(params.length, 34);
  assert.match(sql, /^\(/);
});

test('a flood of leaves is refused before any SQL is built', () => {
  // Reintroduce by removing assertCondBounded from condSql: this compiles 40,000 parameters instead of throwing.
  const params: unknown[] = [];
  assert.throws(() => condSql({ anyOf: Array.from({ length: 40_000 }, (_, i) => genre(`g${i}`)) }, params), UnsupportedFilter);
  assert.equal(params.length, 0, 'nothing was pushed: the bound runs first');
  // exactly at the bound is fine, one over is not
  assert.doesNotThrow(() => condSql({ anyOf: Array.from({ length: MAX_COND_NODES - 1 }, (_, i) => genre(`g${i}`)) }, []));
  assert.throws(() => condSql({ anyOf: Array.from({ length: MAX_COND_NODES }, (_, i) => genre(`g${i}`)) }, []), UnsupportedFilter);
});

test('a deep chain is a 400-shaped refusal, not a stack overflow', () => {
  let deep: any = genre('x');
  for (let i = 0; i < 2000; i++) deep = { allOf: [deep] };
  assert.throws(() => condSql(deep, []), (e: unknown) => e instanceof UnsupportedFilter);
  let ok: any = genre('x');
  for (let i = 0; i < MAX_COND_DEPTH; i++) ok = { allOf: [ok] };
  assert.doesNotThrow(() => condSql(ok, []));
});
