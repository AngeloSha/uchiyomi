// The library's two source filters (lib/ownedCatalog.ts condSql `mainSource` / `anySource`). Pure: the
// translator only builds SQL and pushes params. The rows it selects are the database's business; what is
// pinned here is the shape -- correlated on the listing's `sv` alias, the follower table consulted only by
// `anySource`, one param shared by both halves.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _condSql: condSql, UnsupportedFilter } = require('../src/lib/ownedCatalog') as typeof import('../src/lib/ownedCatalog');

test('mainSource reads the primary only, correlated on sv.id', () => {
  const params: unknown[] = ['viewer-param'];
  const sql = condSql({ mainSource: { operator: 'is', value: 'sw:123' } }, params);
  assert.deepEqual(params, ['viewer-param', 'sw:123'], 'the value is pushed after what was already there');
  assert.match(sql, /src_s\.id = sv\.id AND src_s\.source_id = \$2/);
  // Reintroduce by consulting series_sources here: a follower would count as the main source.
  assert.doesNotMatch(sql, /series_sources/);
});

test('anySource is the primary OR a follower, with one param used twice', () => {
  const params: unknown[] = [];
  const sql = condSql({ anySource: { operator: 'is', value: 'mangadex' } }, params);
  assert.deepEqual(params, ['mangadex']);
  assert.match(sql, /src_s\.source_id = \$1/);
  assert.match(sql, /series_sources src_f WHERE src_f\.series_id = sv\.id AND src_f\.source_id = \$1/);
  assert.match(sql, /\)\s+OR EXISTS/);
});

test('both combine with the other filters, isNot negates, and an unknown key still refuses', () => {
  const params: unknown[] = [];
  const sql = condSql({ allOf: [{ status: { operator: 'is', value: 'ONGOING' } }, { mainSource: { operator: 'isNot', value: 'a' } }, { anySource: { operator: 'is', value: 'b' } }] }, params);
  assert.deepEqual(params, ['ONGOING', 'a', 'b']);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM lib_series src_s WHERE src_s\.id = sv\.id AND src_s\.source_id = \$2\)/);
  assert.match(sql, /src_f\.source_id = \$3/);
  assert.throws(() => condSql({ sourceName: { operator: 'is', value: 'x' } }, []), UnsupportedFilter);
});
