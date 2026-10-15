import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
let narrowTo: typeof import('../src/lib/searchAll').narrowTo;
before(async () => { ({ narrowTo } = await import('../src/lib/searchAll')); });

test('narrowTo: a comma list of ids, trimmed; nothing named is no list', () => {
  assert.deepEqual([...(narrowTo('a, b ,,c') ?? [])], ['a', 'b', 'c']);
  assert.equal(narrowTo(''), null);
  assert.equal(narrowTo(' , '), null);
  assert.equal(narrowTo(undefined), null);
  assert.equal(narrowTo(['a']), null);
});

test('narrowTo: at most 200 ids', () => {
  const many = Array.from({ length: 500 }, (_, i) => `s${i}`).join(',');
  assert.equal(narrowTo(many)?.size, 200);
});
