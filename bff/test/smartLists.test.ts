// A smart list's query is the Library's own URL (v0.61.0, lib/smartLists.ts), so the server's reading of it has to be
// the Library's, word for word: the same condition tree in the same order, the same orders in the same directions.
//
// The condition fixtures are web/test/fixtures/smartQueries.json, which the web's own test (web/test/v610Lists.test.ts)
// holds conditionFrom and queryOfParams to as well: one file, read by both sides, so neither can drift alone. And the
// Library's order table is read from web/lib/librarySort.ts itself, so an order the Library gains without its smart
// twin here fails.
//
// Pure: no database. The env is set only because lib/smartLists imports the backend, which reads it at load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
process.env.LIBRARY_BACKEND ||= 'owned';

const REPO = join(__dirname, '..', '..');
const fixtures = JSON.parse(readFileSync(join(REPO, 'web', 'test', 'fixtures', 'smartQueries.json'), 'utf8')) as Array<{
  name: string; params: string; query: Record<string, unknown>; condition: unknown;
}>;

test('conditionOf builds the Library\'s condition tree, in its order', async () => {
  const { conditionOf, smartQuery } = await import('../src/lib/smartLists');
  assert.ok(fixtures.length >= 4, 'the shared fixtures are read');
  for (const f of fixtures) {
    const q = smartQuery.parse(f.query);
    // Reintroduce by pushing `read` before `lib` in conditionOf: "every filter, in the Library's own order" fails.
    assert.deepEqual(conditionOf(q) ?? null, f.condition, f.name);
  }
});

test('sortOf names the field the server sorts by, in the order\'s own direction unless the query turns it', async () => {
  const { sortOf, SMART_SORTS } = await import('../src/lib/smartLists');
  assert.equal(sortOf({ v: 1, sort: 'popular' }), 'popularity,desc');
  assert.equal(sortOf({ v: 1, sort: 'popular', dir: 'asc' }), 'popularity,asc');
  assert.equal(sortOf({ v: 1, sort: 'az' }), 'metadata.titleSort,asc');
  assert.equal(sortOf({ v: 1, sort: 'az', dir: 'desc' }), 'metadata.titleSort,desc');
  assert.equal(sortOf({ v: 1, sort: 'read' }), 'lastRead,desc');
  assert.equal(sortOf({ v: 1, sort: 'new' }), 'createdDate,desc');
  for (const key of Object.keys(SMART_SORTS) as Array<keyof typeof SMART_SORTS>) {
    assert.match(sortOf({ v: 1, sort: key }), /^[\w.]+,(asc|desc)$/, key);
  }
});

test('a query the Library could not have written is refused', async () => {
  const { smartQuery } = await import('../src/lib/smartLists');
  const ok = { v: 1, sort: 'az' };
  assert.ok(smartQuery.safeParse(ok).success);
  const refusals: Array<[string, unknown]> = [
    ['an unknown key', { ...ok, condition: { allOf: [] } }],
    ['another version', { ...ok, v: 2 }],
    ['no order', { v: 1 }],
    ['an order the Library does not have', { ...ok, sort: 'random' }],
    ['a direction that is neither', { ...ok, dir: 'sideways' }],
    ['a reading state that is not one', { ...ok, read: 'HALF' }],
    ['an empty search', { ...ok, q: '   ' }],
    ['a search past 200', { ...ok, q: 'x'.repeat(201) }],
    ['a status past 40', { ...ok, status: 'x'.repeat(41) }],
    ['more than 20 genres', { ...ok, genres: Array.from({ length: 21 }, (_, i) => `g${i}`) }],
    ['a genre past 60', { ...ok, genres: ['x'.repeat(61)] }],
    ['a library id past 120', { ...ok, lib: 'x'.repeat(121) }],
    ['a source id past 120', { ...ok, src: 'x'.repeat(121) }],
    ['an any-source id past 120', { ...ok, anysrc: 'x'.repeat(121) }],
    ['not an object', 'sort=az'],
  ];
  for (const [why, raw] of refusals) assert.equal(smartQuery.safeParse(raw).success, false, why);
});

test('every Library order has its smart twin, with the same sort string, and no other', async () => {
  // Reintroduce by adding an order to web/lib/librarySort.ts SORTS without one in SMART_SORTS: this fails by name, and a
  // list saved under that order would be refused by the server.
  const { SMART_SORTS } = await import('../src/lib/smartLists');
  const src = readFileSync(join(REPO, 'web', 'lib', 'librarySort.ts'), 'utf8');
  const table = src.slice(src.indexOf('export const SORTS'), src.indexOf('];', src.indexOf('export const SORTS')));
  const library = new Map([...table.matchAll(/\{\s*key:\s*'([^']+)'[^}]*?\bsort:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.ok(library.size >= 9, `the Library's orders are read (${library.size})`);
  assert.deepEqual(new Map(Object.entries(SMART_SORTS)), library);
});

test('a stored query that no longer reads is nothing, not everything', async () => {
  const { parseQuery } = await import('../src/lib/smartLists');
  assert.equal(parseQuery(null), null);
  assert.equal(parseQuery({ v: 1, sort: 'gone' }), null);
  assert.deepEqual(parseQuery({ v: 1, sort: 'az' }), { v: 1, sort: 'az' });
});
