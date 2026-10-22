// Removing a source takes the chapters only it lists with it (lib/sourceLeftovers.ts), driven through the real routes.
//
// The case it is for: a follower that was the WRONG series on its site, with more chapters than the real one. Its
// chapters past the real series' end were fetched, deleted, read. Taking the source off must leave no row, file or
// read mark behind for those numbers, or the sweep counts the real series' next chapter as held and never fetches it.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-left-'));
  DL = join(ROOT, 'dl');
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '300';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_left';
const S = 's_left', FOLDER = 'T!left/Left Series';
const LONE = 's_left_lone', LONE_FOLDER = 'T!left/Lone Series';
const REAL = 'left-real', WRONG = 'left-wrong';
const USER = 'left-admin';
let q: any, app: any, auth: Record<string, string>, uid: string, updateSeries: any;
let realList = [1, 2, 3, 4, 5];

const ch = (n: number) => ({ sourceId: `c/${n}`, number: n, title: `Chapter ${n}` });
function fake(id: string, name: string, nums: () => number[]) {
  return {
    id, name,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: 'Left Series' }; },
    async listChapters() { return nums().map(ch); },
    async getPageUrls() { return []; },
    async latest() { return []; },
  };
}

const file = (folder: string, n: number) => `${folder}/Chapter ${n}.cbz`;
async function book(series: string, folder: string, n: number, source: string | null, o: { pruned?: boolean } = {}) {
  const id = `b_left_${series}_${n}`;
  if (!o.pruned) {
    mkdirSync(join(DL, folder), { recursive: true });
    writeFileSync(join(DL, file(folder, n)), 'cbz');
  }
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, source_id, pruned_at, pruned_reason)
           VALUES ($1,$2,'T!left',$3,$4,$5,$6,$7,$8,$9)`,
    [id, series, file(folder, n), n, `Chapter ${n}`, DL, source, o.pruned ? new Date() : null, o.pruned ? 'deleted' : null]);
  return id;
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  await migrate();

  registerAdapter(fake(REAL, 'Real Source', () => realList) as any);
  // The wrong series: the same first five numbers by accident, and four more.
  registerAdapter(fake(WRONG, 'Wrong Source', () => [1, 2, 3, 4, 5, 6, 7, 8, 9]) as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[REAL, WRONG]]);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Left',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [[S, LONE]]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
           VALUES ($1,'T!left','Left Series',$2,0,$3,$4,'real-s'), ($5,'T!left','Lone Series',$6,0,$3,$7,'wrong-lone')`,
    [S, FOLDER, LIB, REAL, LONE, LONE_FOLDER, WRONG]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1,$2,'wrong-s','Left Series')`, [S, WRONG]);

  await q('DELETE FROM users WHERE username = $1', [USER]);
  uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                  VALUES ($1,$1,'x','admin','password') RETURNING id`, [USER]))[0].id;

  for (const n of [1, 2, 3, 5]) await book(S, FOLDER, n, REAL);
  await book(S, FOLDER, 4, WRONG);                     // the wrong source's copy of a number the real one lists: stays
  await book(S, FOLDER, 6, WRONG);                     // only the wrong source lists it: goes
  await book(S, FOLDER, 7, WRONG, { pruned: true });   // deleted already, its tombstone still blocking 7: goes
  const eight = await book(S, FOLDER, 8, WRONG);       // read and bookmarked: goes, with both
  await book(S, FOLDER, 10, null);                     // arrived some other way, nobody lists it: stays, unlisted
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,5,true)`, [uid, eight, S]);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,2)`, [uid, eight, S]);
  // A read mark on a ghost only the wrong source lists.
  await q(`INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1,$2,9)`, [uid, S]);
  // And one on a number the real source lists, which must stay.
  await q(`INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1,$2,4)`, [uid, S]);

  await book(LONE, LONE_FOLDER, 1, WRONG);

  await updateSeries(S, 0);
  await updateSeries(LONE, 0);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [[S, LONE]]).catch(() => {});
  await q('DELETE FROM bookmarks WHERE series_id = ANY($1)', [[S, LONE]]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, LONE]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[REAL, WRONG]]).catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
});

const numbersOf = async (series: string) =>
  (await q('SELECT number::float8 AS n FROM lib_books WHERE series_id = $1 ORDER BY number', [series])).map((r: any) => Number(r.n));

test('the preview names the chapters only the removed source lists, and who read them', { skip }, async () => {
  const r = await app.inject({ method: 'GET', url: `/api/admin/series/${S}/sources/${WRONG}/leftovers`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.chapters, 3, 'chapters 6, 7 (a tombstone) and 8');
  assert.deepEqual(body.numbers, [6, 7, 8, 9]);
  assert.equal(body.readers, 1);
  assert.equal(body.lastSource, false);
  // The real source: everything it supplied the wrong one lists too, so nothing would go.
  const real = (await app.inject({ method: 'GET', url: `/api/admin/series/${S}/sources/${REAL}/leftovers`, headers: auth })).json();
  assert.equal(real.chapters, 0);
  const none = await app.inject({ method: 'GET', url: `/api/admin/series/${S}/sources/not-here/leftovers`, headers: auth });
  assert.equal(none.statusCode, 404);
});

test('a chapter no followed source lists is named for the delete warning', { skip }, async () => {
  const r = await app.inject({
    method: 'POST', url: `/api/admin/series/${S}/chapters/unlisted`, headers: auth,
    payload: { bookIds: [`b_left_${S}_1`, `b_left_${S}_10`] },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().unlisted, [`b_left_${S}_10`]);
});

test('removing the wrong source takes its chapters, files and read marks, as though never fetched', { skip }, async () => {
  // The audit log outlives a run on a reused database: only this run's line is counted.
  const since = (await q('SELECT COALESCE(max(id), 0)::bigint AS id FROM audit_log'))[0].id;
  const r = await app.inject({ method: 'DELETE', url: `/api/admin/series/${S}/sources/${WRONG}`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.purged.removed, 3);
  assert.deepEqual(body.purged.left, []);
  assert.deepEqual(await numbersOf(S), [1, 2, 3, 4, 5, 10], 'the shared number 4 and the hand-added 10 stay');
  for (const n of [6, 8]) assert.equal(existsSync(join(DL, file(FOLDER, n))), false, `chapter ${n}'s file is gone`);
  assert.equal(existsSync(join(DL, file(FOLDER, 4))), true);
  assert.equal((await q('SELECT 1 FROM read_progress WHERE series_id = $1', [S])).length, 0);
  assert.equal((await q('SELECT 1 FROM bookmarks WHERE series_id = $1', [S])).length, 0);
  const marks = (await q('SELECT number::float8 AS n FROM listing_progress WHERE series_id = $1', [S])).map((x: any) => Number(x.n));
  assert.deepEqual(marks, [4], 'the mark on 9 went, the one on 4 stayed');
  assert.equal((await q('SELECT books_count FROM lib_series WHERE id = $1', [S]))[0].books_count, 6);
  const audit = await q(
    `SELECT detail FROM audit_log WHERE event = 'series.source_leftovers' AND detail->>'id' = $1 AND id > $2`, [S, since]);
  assert.equal(audit.length, 1);
});

test('the real series\' own next chapters are not held by anything the wrong source left', { skip }, async () => {
  realList = [1, 2, 3, 4, 5, 6, 7, 8];
  const held = await q(
    `SELECT number::float8 AS n FROM lib_books WHERE series_id = $1 AND number = ANY($2::real[])`, [S, [6, 7, 8]]);
  assert.deepEqual(held, [], 'no row, live or tombstone, holds 6-8: the sweep sees them missing');
});

test('the series\' last source keeps its chapters', { skip }, async () => {
  const pre = (await app.inject({ method: 'GET', url: `/api/admin/series/${LONE}/sources/${WRONG}/leftovers`, headers: auth })).json();
  assert.equal(pre.lastSource, true);
  assert.equal(pre.chapters, 0);
  const r = await app.inject({ method: 'DELETE', url: `/api/admin/series/${LONE}/sources/${WRONG}`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().purged, undefined);
  assert.deepEqual(await numbersOf(LONE), [1]);
  assert.equal(existsSync(join(DL, file(LONE_FOLDER, 1))), true);
});
