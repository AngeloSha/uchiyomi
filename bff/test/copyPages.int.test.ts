// The compare view's page list (copyPageList): only a copy the series' own listing holds is ever asked of a source.
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SRC = 'cp-src', S = 's_cp_series', LIB = 'lib_cp';
let q: any, copyPageList: any, isRefusal: any;
const asked: string[] = [];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ copyPageList, isRefusal } = (await import('../src/routes/sources')) as any);
  await migrate();
  registerAdapter({
    id: SRC, name: 'Copy Source',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: 'Cp' }; },
    async listChapters() { return []; },
    async latest() { return []; },
    async getPageUrls(cid: string) { asked.push(cid); return ['https://example.invalid/1.png', 'https://example.invalid/2.png']; },
  } as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Cp',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!cp','Cp','T!cp/Cp',0,$2)`, [S, LIB]);
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies) VALUES ($1, 5, $2, '{}'::jsonb, 'available', $3::jsonb)`,
    [S, SRC, JSON.stringify([{ source: SRC, sourceId: 'listed-5' }])]);
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('a copy the listing holds is answered with its page list', { skip }, async () => {
  const r = await copyPageList(S, SRC, 'listed-5');
  assert.equal(isRefusal(r), false, JSON.stringify(r));
  assert.equal(r.urls.length, 2);
});

test('a copy the listing does not hold is refused before the source is asked', { skip }, async () => {
  const r = await copyPageList(S, SRC, 'made-up-id');
  assert.equal(isRefusal(r), true);
  assert.equal(r.code, 404);
  assert.ok(!asked.includes('made-up-id'));
});

test('no source or no chapter is a bad request', { skip }, async () => {
  for (const [s, c] of [[undefined, 'listed-5'], [SRC, undefined], ['nope', 'listed-5'], [SRC, 'x'.repeat(3000)]] as const) {
    const r = await copyPageList(S, s, c);
    assert.equal(isRefusal(r) && r.code, 400);
  }
});
