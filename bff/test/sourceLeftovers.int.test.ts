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
let realError = false;
let listHook: (() => Promise<void>) | null = null;
let realCalls = 0;
let realUnnumbered = 0;

const ch = (n: number) => ({ sourceId: `c/${n}`, number: n, title: `Chapter ${n}` });
function fake(id: string, name: string, nums: () => number[]) {
  return {
    id, name,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: 'Left Series' }; },
    async listChapters() {
      if (id === REAL) { realCalls++; if (listHook) await listHook(); if (realError) throw new Error('source unavailable'); }
      const chapters = nums().map(ch);
      if (id === REAL && realUnnumbered) Object.defineProperty(chapters, Symbol.for('uchiyomi.unnumbered'), { value: realUnnumbered });
      return chapters;
    },
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
  assert.equal(real.error, 'primary_source', 'make another source main before cleaning up the current main');
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

test('an old client detaches without deleting files, rows or progress', { skip }, async () => {
  const before = await numbersOf(S);
  const r = await app.inject({ method: 'DELETE', url: `/api/admin/series/${S}/sources/${WRONG}`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().purged, undefined);
  assert.deepEqual(await numbersOf(S), before);
  assert.ok(existsSync(join(DL, file(FOLDER, 8))));
  assert.equal((await q('SELECT 1 FROM read_progress WHERE series_id = $1', [S])).length, 1);
  const { runsInside } = await import('../src/lib/updater');
  for (let i = 0; runsInside(S) && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1,$2,'wrong-s','Left Series')`, [S, WRONG]);
  await updateSeries(S, 0);
});

const preview = async () => {
  const r = await app.inject({ method: 'GET', url: `/api/admin/series/${S}/sources/${WRONG}/leftovers`, headers: auth });
  return r;
};
const cleanup = (confirmation?: string) => app.inject({ method: 'POST', url: `/api/admin/series/${S}/sources/${WRONG}/cleanup`, headers: auth, payload: confirmation ? { confirmation } : {} });

test('cleanup requires an explicit preview acknowledgement and never accepts an arbitrary token', { skip }, async () => {
  assert.equal((await cleanup()).statusCode, 400);
  assert.equal((await cleanup('not-a-preview')).statusCode, 409);
  assert.ok(existsSync(join(DL, file(FOLDER, 8))));
});

test('confirmation is account-bound and cannot be edited', { skip }, async () => {
  const confirmation = (await preview()).json().confirmation;
  assert.equal(typeof confirmation, 'string');
  const other = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
    VALUES ('left-other-admin','Other','x','admin','password') RETURNING id`))[0].id;
  try {
    const r = await app.inject({ method: 'POST', url: `/api/admin/series/${S}/sources/${WRONG}/cleanup`,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: other, role: 'admin' })}` }, payload: { confirmation } });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal((await cleanup(confirmation.slice(0, -1) + (confirmation.endsWith('a') ? 'b' : 'a'))).statusCode, 409);
    assert.ok(existsSync(join(DL, file(FOLDER, 8))));
  } finally { await q('DELETE FROM users WHERE id = $1', [other]); }
});

test('an unavailable, empty or shorter remaining listing never authorizes cleanup', { skip }, async () => {
  const beforePreview = await preview();
  assert.equal(beforePreview.statusCode, 200, beforePreview.body);
  const confirmation = beforePreview.json().confirmation;
  const before = realList;
  try {
    realError = true;
    assert.equal((await cleanup(confirmation)).statusCode, 409);
    realError = false;
    realList = [];
    assert.equal((await cleanup(confirmation)).statusCode, 409);
    realList = [1, 2];
    assert.equal((await cleanup(confirmation)).statusCode, 409);
    realList = before;
    await q('UPDATE lib_series SET source_series_id = NULL WHERE id = $1', [S]);
    assert.equal((await cleanup(confirmation)).statusCode, 409, 'a missing remaining-source identity cannot authorize deletion');
    assert.ok(existsSync(join(DL, file(FOLDER, 8))));
  } finally { realError = false; realList = before; await q("UPDATE lib_series SET source_series_id = 'real-s' WHERE id = $1", [S]); }
});

test('a changed source identity or chapter set requires a new preview', { skip }, async () => {
  const confirmation = (await preview()).json().confirmation;
  await q("UPDATE lib_series SET source_series_id = 'different-series' WHERE id = $1", [S]);
  try { assert.equal((await cleanup(confirmation)).statusCode, 409); }
  finally { await q("UPDATE lib_series SET source_series_id = 'real-s' WHERE id = $1", [S]); }
  const id = await book(S, FOLDER, 6.5, WRONG);
  try {
    assert.equal((await cleanup(confirmation)).statusCode, 409);
    assert.ok(existsSync(join(DL, file(FOLDER, 8))));
  } finally { await q('DELETE FROM lib_books WHERE id = $1', [id]); rmSync(join(DL, file(FOLDER, 6.5))); }
});

test('writer claim is acquired before requesting or reading any cleanup eligibility', { skip }, async () => {
  const { claimWriterFolders } = await import('../src/lib/bulkNewest');
  const claim = claimWriterFolders([FOLDER]);
  assert.ok(claim);
  const calls = realCalls;
  try { assert.equal((await preview()).statusCode, 409); assert.equal(realCalls, calls); }
  finally { claim.release(); }
});

test('a source changed during the fresh listing cannot authorize deletion under the new source set', { skip }, async () => {
  const confirmation = (await preview()).json().confirmation;
  listHook = async () => {
    listHook = null;
    await q("UPDATE lib_series SET source_series_id = 'changed-during-listing' WHERE id = $1", [S]);
  };
  try {
    const r = await cleanup(confirmation);
    assert.equal(r.statusCode, 409, r.body);
    assert.ok(existsSync(join(DL, file(FOLDER, 8))));
  } finally { listHook = null; await q("UPDATE lib_series SET source_series_id = 'real-s' WHERE id = $1", [S]); }
});

test('removing the wrong source takes its chapters, files and read marks, as though never fetched', { skip }, async () => {
  // The audit log outlives a run on a reused database: only this run's line is counted.
  const since = (await q('SELECT COALESCE(max(id), 0)::bigint AS id FROM audit_log'))[0].id;
  const ranged = await book(S, FOLDER, 20, WRONG);
  await q('UPDATE lib_books SET number_end = 22 WHERE id = $1', [ranged]);
  await q('INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1,$2,21.5)', [uid, S]);
  const confirmation = (await preview()).json().confirmation;
  const r = await cleanup(confirmation);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.purged.removed, 4);
  assert.deepEqual(body.purged.left, []);
  assert.deepEqual(await numbersOf(S), [1, 2, 3, 4, 5, 10], 'the shared number 4 and the hand-added 10 stay');
  for (const n of [6, 8, 20]) assert.equal(existsSync(join(DL, file(FOLDER, n))), false, `chapter ${n}'s file is gone`);
  assert.equal(existsSync(join(DL, file(FOLDER, 4))), true);
  assert.equal((await q('SELECT 1 FROM read_progress WHERE series_id = $1', [S])).length, 0);
  assert.equal((await q('SELECT 1 FROM bookmarks WHERE series_id = $1', [S])).length, 0);
  const marks = (await q('SELECT number::float8 AS n FROM listing_progress WHERE series_id = $1', [S])).map((x: any) => Number(x.n));
  assert.deepEqual(marks, [4], 'ghost 9 and the interior range mark 21.5 went; shared chapter 4 stayed');
  assert.equal((await q('SELECT books_count FROM lib_series WHERE id = $1', [S]))[0].books_count, 6);
  const audit = await q(
    `SELECT detail FROM audit_log WHERE event = 'series.source_leftovers' AND detail->>'id' = $1 AND id > $2`, [S, since]);
  assert.equal(audit.length, 1);
  assert.equal((await q('SELECT 1 FROM series_sources WHERE series_id = $1 AND source_id = $2', [S, WRONG])).length, 0, 'cleanup detached before releasing its writer');
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
  const cannotDelete = await app.inject({ method: 'POST', url: `/api/admin/series/${LONE}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: pre.confirmation } });
  assert.equal(cannotDelete.statusCode, 409);
  const r = await app.inject({ method: 'DELETE', url: `/api/admin/series/${LONE}/sources/${WRONG}`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().purged, undefined);
  assert.deepEqual(await numbersOf(LONE), [1]);
  assert.equal(existsSync(join(DL, file(LONE_FOLDER, 1))), true);
});


test('an unsafe file path keeps the row, range progress and source attached', { skip }, async () => {
  const id = 's_left_unsafe', bid = 'b_left_unsafe';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Unsafe Left','T!left/Unsafe',1,$2,$3,'real-s')`, [id, LIB, REAL]);
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1,$2,'wrong-s','Unsafe Left')`, [id, WRONG]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, number_end, root, source_id)
      VALUES ($1,$2,'T!left','../outside.cbz',20,22,$3,$4)`, [bid, id, DL, WRONG]);
    await q('INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1,$2,21.5)', [uid, id]);
    const p = await app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    assert.equal(p.statusCode, 200, p.body);
    const r = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: p.json().confirmation } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().ok, false);
    assert.deepEqual(r.json().purged.left, [{ id: bid, reason: 'outside_root' }]);
    assert.equal((await q('SELECT 1 FROM series_sources WHERE series_id = $1 AND source_id = $2', [id, WRONG])).length, 1);
    assert.equal((await q('SELECT 1 FROM lib_books WHERE id = $1', [bid])).length, 1);
    assert.equal((await q('SELECT 1 FROM listing_progress WHERE series_id = $1 AND number = 21.5', [id])).length, 1);
  } finally { await q('DELETE FROM lib_series WHERE id = $1', [id]); }
});

test('a concurrent old-client detach waits for the confirmed cleanup to finish', { skip }, async (t) => {
  const id = 's_left_concurrent', folder = 'T!left/Concurrent';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Concurrent Left',$2,1,$3,$4,'real-s')`, [id, folder, LIB, REAL]);
  let release = () => {};
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1,$2,'wrong-s','Concurrent Left')`, [id, WRONG]);
    await book(id, folder, 20, WRONG);
    const p = await app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    assert.equal(p.statusCode, 200, p.body);
    const fs = require('fs/promises');
    const stat = fs.stat;
    let entered!: () => void;
    const arrived = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let held = false;
    t.mock.method(fs, 'stat', function(path: any, ...args: any[]) {
      if (path === DL && !held) { held = true; entered(); return gate.then(() => stat(path, ...args)); }
      return stat(path, ...args);
    });
    const cleaning = app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: p.json().confirmation } });
    await Promise.race([arrived, cleaning.then(() => { throw new Error('cleanup finished before the filesystem hold'); })]);
    let detached = false;
    const removing = app.inject({ method: 'DELETE', url: `/api/admin/series/${id}/sources/${WRONG}`, headers: auth }).then((r: any) => { detached = true; return r; });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(detached, false, 'the child row is protected while cleanup changes files');
    release();
    const result = await cleaning;
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().purged.removed, 1);
    assert.equal((await removing).statusCode, 404, 'cleanup already unfollowed atomically');
    assert.equal(existsSync(join(DL, file(folder, 20))), false);
  } finally { release(); await q('DELETE FROM lib_series WHERE id = $1', [id]); }
});

test('a tombstone never removes a refetch backup through a symlink outside the download root', { skip }, async () => {
  const { symlinkSync, readFileSync } = await import('node:fs');
  const { REFETCH_BAK } = await import('../src/lib/fsAtomic');
  const id = 's_left_tombstone_link', folder = 'T!left/Tombstone Link';
  const outside = join(ROOT, 'outside-backups');
  const target = join(outside, `Chapter 20.cbz${REFETCH_BAK}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(target, 'must stay outside');
  mkdirSync(join(DL, 'T!left'), { recursive: true });
  symlinkSync(outside, join(DL, folder), 'dir');
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Tombstone Link',$2,1,$3,$4,'real-s')`, [id, folder, LIB, REAL]);
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'wrong-s')`, [id, WRONG]);
    const bid = await book(id, folder, 20, WRONG, { pruned: true });
    const pre = await app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    assert.equal(pre.statusCode, 200, pre.body);
    const result = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: pre.json().confirmation } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().ok, false);
    assert.deepEqual(result.json().purged.left, [{ id: bid, reason: 'outside_root' }]);
    assert.equal(readFileSync(target, 'utf8'), 'must stay outside');
    assert.equal((await q('SELECT 1 FROM lib_books WHERE id = $1', [bid])).length, 1);
    assert.equal((await q('SELECT 1 FROM series_sources WHERE series_id = $1 AND source_id = $2', [id, WRONG])).length, 1);
  } finally { await q('DELETE FROM lib_series WHERE id = $1', [id]); rmSync(join(DL, folder)); }
});

test('a refetch backup that cannot be removed keeps its original, row, progress and source', { skip }, async () => {
  const { REFETCH_BAK } = await import('../src/lib/fsAtomic');
  const id = 's_left_backup_failure', folder = 'T!left/Backup Failure';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Backup Failure',$2,1,$3,$4,'real-s')`, [id, folder, LIB, REAL]);
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'wrong-s')`, [id, WRONG]);
    const bid = await book(id, folder, 20, WRONG);
    // A stale directory at the backup name deterministically refuses a non-recursive unlink on every platform.
    mkdirSync(join(DL, file(folder, 20) + REFETCH_BAK));
    await q('INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1,$2,20)', [uid, id]);
    const pre = await app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    assert.equal(pre.statusCode, 200, pre.body);
    const result = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: pre.json().confirmation } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().ok, false);
    assert.deepEqual(result.json().purged.left, [{ id: bid, reason: 'unlink_failed' }]);
    assert.equal(existsSync(join(DL, file(folder, 20))), true, 'backup failure must be found before deleting the original');
    assert.equal((await q('SELECT 1 FROM lib_books WHERE id = $1', [bid])).length, 1);
    assert.equal((await q('SELECT 1 FROM listing_progress WHERE series_id = $1 AND number = 20', [id])).length, 1);
    assert.equal((await q('SELECT 1 FROM series_sources WHERE series_id = $1 AND source_id = $2', [id, WRONG])).length, 1);
  } finally { await q('DELETE FROM lib_series WHERE id = $1', [id]); }
});

test('book metadata and new read marks serialize with cleanup eligibility and deletion', { skip }, async (t) => {
  const id = 's_left_book_locks', folder = 'T!left/Book Locks';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Book Locks',$2,1,$3,$4,'real-s')`, [id, folder, LIB, REAL]);
  let release = () => {};
  let cleaning: Promise<any> | undefined;
  let editing: Promise<any> | undefined;
  let marking: Promise<any> | undefined;
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'wrong-s')`, [id, WRONG]);
    const bid = await book(id, folder, 20, WRONG);
    await q('INSERT INTO book_overrides (book_id, number) VALUES ($1,21)', [bid]);
    const pre = await app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    assert.equal(pre.statusCode, 200, pre.body);
    const fs = require('fs/promises');
    const originalStat = fs.stat;
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    t.mock.method(fs, 'stat', function(path: any, ...args: any[]) {
      if (path === DL && !held) { held = true; entered(); return gate.then(() => originalStat(path, ...args)); }
      return originalStat(path, ...args);
    });
    cleaning = app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: pre.json().confirmation } });
    await Promise.race([arrived, cleaning.then(() => { throw new Error('cleanup finished before the filesystem gate'); })]);
    // This is the existing override UPDATE path, which does not claim the folder writer. Number1 would protect the
    // book if it committed after eligibility was read; a new progress row could also make the final DELETE fail its FK.
    editing = q('UPDATE book_overrides SET number = 1 WHERE book_id = $1 RETURNING book_id /* cleanup-override-race */', [bid]);
    marking = q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
      VALUES ($1,$2,$3,1,false) /* cleanup-progress-race */`, [uid, bid, id]).then(() => 'inserted', (e: any) => e.code);
    const locked = async (marker: string) => {
      for (let tries = 0; tries < 100; tries++) {
        const rows = await q("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query LIKE $1 AND wait_event_type = 'Lock'", [`%${marker}%`]);
        if (rows.length) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`the concurrent ${marker} never waited for cleanup`);
    };
    assert.equal(await Promise.race([locked('cleanup-override-race'), editing.then(() => false)]), true, 'an override changed while its chapter was being deleted');
    assert.equal(await Promise.race([locked('cleanup-progress-race'), marking.then(() => false)]), true, 'new progress was inserted during file deletion');
    release();
    const result = await cleaning;
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().purged.removed, 1);
    assert.deepEqual(await editing, [], 'the override update cannot commit on a deleted chapter');
    assert.equal(await marking, '23503', 'progress must not land after its chapter was deleted');
    assert.equal(existsSync(join(DL, file(folder, 20))), false);
  } finally {
    release();
    await Promise.allSettled([cleaning, editing, marking].filter(Boolean));
    await q('DELETE FROM lib_series WHERE id = $1', [id]);
  }
});

test('dropped unnumbered posts and malformed number rows never authorize deletion', { skip }, async () => {
  const id = 's_left_incomplete', folder = 'T!left/Incomplete';
  const before = realList;
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Incomplete',$2,1,$3,$4,'real-s')`, [id, folder, LIB, REAL]);
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'wrong-s')`, [id, WRONG]);
    const bid = await book(id, folder, 20, WRONG);
    const pre = await app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    assert.equal(pre.statusCode, 200, pre.body);
    for (const invalid of ['unnumbered', NaN, Infinity, -1, null, '21']) {
      realUnnumbered = invalid === 'unnumbered' ? 1 : 0;
      realList = invalid === 'unnumbered' ? before : [...before, invalid as any];
      const result = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: pre.json().confirmation } });
      assert.equal(result.statusCode, 409, String(invalid) + ': ' + result.body);
      assert.equal(result.json().error, 'listing_unavailable');
      assert.equal(existsSync(join(DL, file(folder, 20))), true);
      assert.equal((await q('SELECT 1 FROM lib_books WHERE id = $1', [bid])).length, 1);
    }
  } finally { realList = before; realUnnumbered = 0; await q('DELETE FROM lib_series WHERE id = $1', [id]); }
});

test('a kept raw range protects its archive and every raw/overridden read mark', { skip }, async () => {
  const id = 's_left_raw_range', folder = 'T!left/Raw Range';
  const before = realList;
  realList = [...before, 21];
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Raw Range',$2,2,$3,$4,'real-s')`, [id, folder, LIB, REAL]);
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'wrong-s')`, [id, WRONG]);
    const kept = await book(id, folder, 20, WRONG);
    await q('UPDATE lib_books SET number_end = 22 WHERE id = $1', [kept]);
    await q('INSERT INTO book_overrides (book_id, number) VALUES ($1,77)', [kept]);
    const gone = await book(id, folder, 99, WRONG);
    for (const n of [20, 21, 22]) await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, copies)
      VALUES ($1,$2,$3,'{}'::jsonb,'[]'::jsonb)`, [id, n, WRONG]);
    for (const n of [20, 21, 22, 77, 99]) await q('INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1,$2,$3)', [uid, id, n]);
    const pre = await app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    assert.equal(pre.statusCode, 200, pre.body);
    assert.equal(pre.json().chapters, 1, 'remaining source chapter21 protects the 20–22 archive despite override77');
    assert.deepEqual(pre.json().numbers, [99], 'kept raw and overridden marks are not deletion candidates');
    const result = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: pre.json().confirmation } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().purged.removed, 1);
    assert.equal(existsSync(join(DL, file(folder, 20))), true);
    assert.equal((await q('SELECT 1 FROM lib_books WHERE id = $1', [gone])).length, 0);
    assert.deepEqual((await q('SELECT number::float8 AS n FROM listing_progress WHERE series_id = $1 ORDER BY number', [id])).map((r: any) => r.n), [20, 21, 22, 77]);
  } finally { realList = before; await q('DELETE FROM lib_series WHERE id = $1', [id]); }
});

test('deleting an exclusive overridden range removes raw/interior/override marks together', { skip }, async () => {
  const id = 's_left_removed_range', folder = 'T!left/Removed Range';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Removed Range',$2,1,$3,$4,'real-s')`, [id, folder, LIB, REAL]);
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'wrong-s')`, [id, WRONG]);
    const bid = await book(id, folder, 20, WRONG);
    await q('UPDATE lib_books SET number_end = 22 WHERE id = $1', [bid]);
    await q('INSERT INTO book_overrides (book_id, number) VALUES ($1,77)', [bid]);
    for (const n of [20, 21.5, 22, 77]) await q('INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1,$2,$3)', [uid, id, n]);
    const pre = await app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    assert.equal(pre.statusCode, 200, pre.body);
    assert.deepEqual(pre.json().numbers, [20, 21.5, 22, 77]);
    const result = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: pre.json().confirmation } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().purged.removed, 1);
    assert.equal((await q('SELECT 1 FROM listing_progress WHERE series_id = $1', [id])).length, 0);
  } finally { await q('DELETE FROM lib_series WHERE id = $1', [id]); }
});

test('cleanup checks viewer visibility again under its row lock after a fresh listing', { skip }, async () => {
  const id = 's_left_visibility', folder = 'T!left/Visibility';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
    VALUES ($1,'T!left','Visibility',$2,1,$3,$4,'real-s')`, [id, folder, LIB, REAL]);
  try {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'wrong-s')`, [id, WRONG]);
    const bid = await book(id, folder, 20, WRONG);
    await q('INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,false)', [uid, bid, id]);
    await q('INSERT INTO bookmarks (user_id, book_id, series_id, page, note) VALUES ($1,$2,$3,1,\'Keep this mark\')', [uid, bid, id]);
    const preview = () => app.inject({ method: 'GET', url: `/api/admin/series/${id}/sources/${WRONG}/leftovers`, headers: auth });
    await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [id]);
    const calls = realCalls;
    assert.equal((await preview()).statusCode, 404, 'a hidden series is not previewed');
    assert.equal(realCalls, calls, 'the hidden series is refused before asking its source');
    await q('UPDATE lib_series SET deleted_at = NULL WHERE id = $1', [id]);
    for (const state of ['hidden', 'merged']) {
      const pre = await preview();
      assert.equal(pre.statusCode, 200, pre.body);
      listHook = async () => {
        listHook = null;
        if (state === 'hidden') await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [id]);
        else await q('UPDATE lib_series SET merged_into = $2 WHERE id = $1', [id, S]);
      };
      const result = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources/${WRONG}/cleanup`, headers: auth, payload: { confirmation: pre.json().confirmation } });
      assert.equal(result.statusCode, 404, state + ': ' + result.body);
      assert.equal(existsSync(join(DL, file(folder, 20))), true, 'the file was not removed');
      assert.equal((await q('SELECT 1 FROM lib_books WHERE id = $1', [bid])).length, 1);
      assert.equal((await q('SELECT page FROM read_progress WHERE book_id = $1', [bid]))[0].page, 1);
      assert.equal((await q('SELECT note FROM bookmarks WHERE book_id = $1', [bid]))[0].note, 'Keep this mark');
      assert.equal((await q('SELECT 1 FROM series_sources WHERE series_id = $1 AND source_id = $2', [id, WRONG])).length, 1);
      await q('UPDATE lib_series SET deleted_at = NULL, merged_into = NULL WHERE id = $1', [id]);
    }
    assert.equal((await preview()).statusCode, 200, 'refusals release the writer claim for a later request');
  } finally {
    listHook = null;
    await q('DELETE FROM read_progress WHERE series_id = $1', [id]);
    await q('DELETE FROM bookmarks WHERE series_id = $1', [id]);
    await q('DELETE FROM lib_series WHERE id = $1', [id]);
  }
});
