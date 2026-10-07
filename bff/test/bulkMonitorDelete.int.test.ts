// The library select bar's Monitor / Unmonitor and Delete chapters, and the admin's "Show deleted chapters as ghosts",
// driven through the real routes against real files on a scratch disk.
//
// What can go wrong here is data and downloads: a bulk delete that reaches a read-library file or the cover chapter,
// one that deletes under a running download, an unmonitored series that an unattended run still fetches for, and a
// display switch that leaks into what Mihon is told. Each is pinned below.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '', LIB_ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-bmd-'));
  DL = join(ROOT, 'dl');
  LIB_ROOT = join(ROOT, 'lib');
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = LIB_ROOT;
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_bmd';
const A = 's_bmd_a', B = 's_bmd_b', C = 's_bmd_c', BUSY = 's_bmd_busy';
const FOLDER = (s: string) => `T!bmd/${s}`;
const ADMIN = 'bmd-admin';
let q: any, app: any, updateSeries: any, busyFolders: Set<string>, issueApiToken: any;
let jobBusy: (folder: string) => boolean;
let setDeleteHooks: (hooks: any) => void, closeInterrupted: () => Promise<number>;
let adminTok: string, adminId: string, apiKey: string;
let savedGhosts: boolean | undefined;

const file = (root: string, rel: string) => { const abs = join(root, rel); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, 'x'); return abs; };

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  ({ busyFolders } = (await import('../src/lib/bulkNewest')) as any);
  ({ jobBusy } = (await import('../src/routes/sources')) as any);
  ({ setBulkChapterDeleteTestHooks: setDeleteHooks, closeInterruptedBulkChapterDeleteRuns: closeInterrupted } =
    (await import('../src/lib/bulkChapterDelete')) as any);
  ({ issueApiToken } = (await import('../src/lib/auth')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  await migrate();
  savedGhosts = (await q('SELECT komga_ghost_chapters AS g FROM server_settings WHERE id = 1'))[0]?.g;
  await q('UPDATE server_settings SET komga_ghost_chapters = false, deleted_as_ghosts = false WHERE id = 1');

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Bmd',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[A, B, C, BUSY]]);
  for (const s of [A, B, C, BUSY]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, auto_update) VALUES ($1,'T!bmd',$1,$2,3,$3,true)`, [s, FOLDER(s), LIB]);
  }
  const book = async (id: string, s: string, n: number, root: string) => {
    const rel = `${FOLDER(s)}/Chapter ${n}.cbz`;
    file(root, rel);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ($1,$2,'T!bmd',$3,$4,$5,1,$6)`,
      [id, s, rel, n, `Chapter ${n}`, root]);
  };
  // A: 1 (the cover), 2, 3 (bookmarked) downloaded; 4 in the read library.
  await book('b_bmd_a1', A, 1, DL); await book('b_bmd_a2', A, 2, DL); await book('b_bmd_a3', A, 3, DL); await book('b_bmd_a4', A, 4, LIB_ROOT);
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [A, 'b_bmd_a1']);
  // B: only its cover chapter. C: two chapters, no cover set (the lowest is kept), and a tombstone Verify marked missing.
  await book('b_bmd_b1', B, 1, DL);
  await book('b_bmd_c1', C, 1, DL); await book('b_bmd_c2', C, 2, DL); await book('b_bmd_c3', C, 3, DL);
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'missing' WHERE id = 'b_bmd_c3'`);
  await book('b_bmd_busy1', BUSY, 1, DL); await book('b_bmd_busy2', BUSY, 2, DL);

  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  await q('INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,1)', [adminId, 'b_bmd_a3', A]);
  await q('INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,true)', [adminId, 'b_bmd_a2', A]);

  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(rateLimit, { global: false });
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/komgaCompat')).default);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
  apiKey = (await issueApiToken(adminId, 'bmd', ['read'], null)).token;
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  setDeleteHooks?.({});
  await q('UPDATE server_settings SET komga_ghost_chapters = $1, deleted_as_ghosts = false WHERE id = 1', [savedGhosts ?? false]).catch(() => {});
  await q(`DELETE FROM admin_bulk_delete_runs r
            WHERE r.started_by = $1 OR EXISTS (SELECT 1 FROM unnest(r.series_ids) id WHERE id LIKE 's_bmd_%')`, [adminId]).catch(() => {});
  await q(`DELETE FROM bookmarks WHERE series_id LIKE 's_bmd_%'`).catch(() => {});
  await q(`DELETE FROM read_progress WHERE series_id LIKE 's_bmd_%'`).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_bmd_%'`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_bmd_%'`).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
});

const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: { authorization: adminTok }, payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: adminTok } });
const monitored = async (id: string) => (await q('SELECT auto_update FROM lib_series WHERE id = $1', [id]))[0].auto_update;
const pruned = async (id: string) => !!(await q('SELECT pruned_at FROM lib_books WHERE id = $1', [id]))[0].pruned_at;
const until = async (f: () => Promise<any> | any, label: string, tries = 300) => {
  for (let i = 0; i < tries; i++) { const value = await f(); if (value) return value; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${label}`);
};
const runState = async (id: string) => (await get(`/api/admin/series/bulk/chapters/delete?runId=${id}`)).json().run;
const finishedRun = async (id: string) => until(async () => {
  const run = await runState(id);
  return run?.status !== 'running' ? run : null;
}, `bulk delete ${id}`);
const seedSeries = async (id: string, chapters = 2) => {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, auto_update)
           VALUES ($1,'T!bmd',$1,$2,$3,$4,true)`, [id, FOLDER(id), chapters, LIB]);
  for (let n = 1; n <= chapters; n++) {
    const bookId = `b_${id}_${n}`;
    const rel = `${FOLDER(id)}/Chapter ${n}.cbz`;
    file(DL, rel);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root)
             VALUES ($1,$2,'T!bmd',$3,$4,$5,1,$6)`, [bookId, id, rel, n, `Chapter ${n}`, DL]);
  }
};

test('Unmonitor and Monitor set auto_update for the selection, skip what is gone, and audit each', { skip }, async () => {
  const r = await post('/api/admin/series/bulk/auto-update', { seriesIds: [A, B, A, 's_bmd_nope'], autoUpdate: false });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().applied, 2, 'a duplicate id counts once');
  assert.deepEqual(r.json().skipped, [{ id: 's_bmd_nope', reason: 'not_found' }]);
  assert.equal(await monitored(A), false);
  assert.equal(await monitored(B), false);
  const audit = await q(`SELECT detail FROM audit_log WHERE event = 'series.settings' AND detail->>'id' = ANY($1) AND detail->>'via' = 'bulk'`, [[A, B]]);
  assert.ok(audit.length >= 2, 'one series.settings row per series');
  assert.equal((await post('/api/admin/series/bulk/auto-update', { seriesIds: [] , autoUpdate: true })).statusCode, 400);
});

test('an unmonitored series answers `paused` to an unattended run, before any source is asked', { skip }, async () => {
  // Reintroduce by dropping the `opts.unattended` check in visitSeries: the run goes on and answers `unrouted`.
  const r = await updateSeries(A, 10, { unattended: true });
  assert.equal(r.outcome, 'paused');
  assert.equal(r.asked, false);
  // An unattended listing refresh is still network work and stays paused; a run a person started goes ahead.
  assert.equal((await updateSeries(A, 0, { unattended: true })).outcome, 'paused');
  assert.notEqual((await updateSeries(A, 10)).outcome, 'paused');
  const back = await post('/api/admin/series/bulk/auto-update', { seriesIds: [A, B], autoUpdate: true });
  assert.equal(back.json().applied, 2);
  assert.equal(await monitored(A), true);
  assert.notEqual((await updateSeries(A, 10, { unattended: true })).outcome, 'paused', 'monitored again, it runs');
});

test('Delete chapters takes downloads only, keeps the cover chapter and bookmarks, and unmonitors by default', { skip }, async () => {
  busyFolders.add(FOLDER(BUSY));
  let run: any;
  try {
    const r = await post('/api/admin/series/bulk/chapters/delete', { seriesIds: [A, B, BUSY, 's_bmd_nope'] });
    assert.equal(r.statusCode, 202, r.body);
    assert.equal(r.json().total, 4);
    run = await finishedRun(r.json().runId);
    assert.equal(run.status, 'done');
    assert.equal(run.summary.chapters, 1, 'only chapter 2 of A goes');
    assert.equal(run.summary.applied, 1);
    assert.equal(run.summary.paused, 1);
    assert.equal(run.summary.chapterSkips.bookmarked, 1, 'chapter-level guards are retained in the run result');
    const reasons = Object.fromEntries(run.results.filter((s: any) => s.outcome === 'skipped').map((s: any) => [s.id, s.reason]));
    assert.deepEqual(reasons, { [B]: 'nothing_to_delete', [BUSY]: 'busy', s_bmd_nope: 'not_found' });
  } finally { busyFolders.delete(FOLDER(BUSY)); }
  // The cover chapter, the bookmarked one and the read library's are all still there; chapter 2 is a tombstone.
  assert.equal(existsSync(join(DL, FOLDER(A), 'Chapter 1.cbz')), true, 'the cover chapter was deleted');
  assert.equal(existsSync(join(DL, FOLDER(A), 'Chapter 3.cbz')), true, 'a bookmarked chapter was deleted');
  assert.equal(existsSync(join(LIB_ROOT, FOLDER(A), 'Chapter 4.cbz')), true, 'a read-library file was deleted');
  assert.equal(existsSync(join(DL, FOLDER(A), 'Chapter 2.cbz')), false);
  assert.equal(await pruned('b_bmd_a2'), true);
  const kept = await q('SELECT completed FROM read_progress WHERE book_id = $1', ['b_bmd_a2']);
  assert.deepEqual(kept.map((x: any) => x.completed), [true], 'reading history went with the file');
  assert.equal(await monitored(A), false, '"Also stop updates" is the default');
  assert.equal(await monitored(B), true, 'a series nothing was deleted from is not unmonitored');
  assert.equal(await monitored(BUSY), true);
  assert.equal(existsSync(join(DL, FOLDER(BUSY), 'Chapter 2.cbz')), true, 'deleted under a running download');
});

test('Delete chapters with pause off leaves the series monitored, and keeps the lowest chapter when none is the cover', { skip }, async () => {
  const r = await post('/api/admin/series/bulk/chapters/delete', { seriesIds: [C], pause: false });
  assert.equal(r.statusCode, 202, r.body);
  const run = await finishedRun(r.json().runId);
  assert.equal(run.summary.chapters, 1);
  assert.equal(run.summary.paused, 0);
  assert.equal(await monitored(C), true);
  assert.equal(await pruned('b_bmd_c1'), false, 'the lowest live chapter is the cover and stays');
  assert.equal(await pruned('b_bmd_c2'), true);
});

test('the run claims the shared writer lock before an await, pauses under it, rejects another run, and cancels between series', { skip }, async () => {
  const RACE = 's_bmd_race', LATER = 's_bmd_later';
  await seedSeries(RACE);
  await seedSeries(LATER);
  let claimed!: () => void, release!: () => void;
  const claim = new Promise<void>((resolve) => { claimed = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let pauseObserved = false;
  setDeleteHooks({
    afterClaim: async (s: any) => {
      if (s.id !== RACE) return;
      assert.equal(jobBusy(s.folder), true, 'another writer sees the folder as busy immediately after the check');
      claimed();
      await hold;
    },
    afterPause: async (s: any) => {
      if (s.id !== RACE) return;
      assert.equal(busyFolders.has(s.folder), true, 'the pause and audit happen before releasing the writer lock');
      assert.equal(await monitored(RACE), false);
      pauseObserved = true;
    },
  });
  try {
    const started = await post('/api/admin/series/bulk/chapters/delete', { seriesIds: [RACE, LATER] });
    assert.equal(started.statusCode, 202, started.body);
    await claim;
    const other = await post('/api/admin/series/bulk/chapters/delete', { seriesIds: [B] });
    assert.equal(other.statusCode, 409, other.body);
    assert.equal(other.json().error, 'bulk_delete_busy');
    const cancel = await post('/api/admin/series/bulk/chapters/delete/cancel', { runId: started.json().runId });
    assert.equal(cancel.statusCode, 200, cancel.body);
    release();
    const run = await finishedRun(started.json().runId);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.done, 2);
    assert.equal(run.results[0].id, RACE);
    assert.equal(run.results[0].outcome, 'applied');
    assert.equal(run.results[1].id, LATER);
    assert.equal(run.results[1].reason, 'cancelled');
    assert.equal(await pruned(`b_${LATER}_2`), false, 'cancellation is observed before the next series');
    assert.equal(pauseObserved, true);
    assert.equal(busyFolders.has(FOLDER(RACE)), false, 'the claim is always released');
  } finally {
    release?.();
    setDeleteHooks({});
  }
});

test('hidden, all-bookmarked and unlink-failed series retain precise persisted reasons', { skip }, async () => {
  const HIDDEN = 's_bmd_hidden', MARKED = 's_bmd_marked', UNLINK = 's_bmd_unlink';
  await seedSeries(HIDDEN);
  await seedSeries(MARKED, 3);
  await seedSeries(UNLINK);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [HIDDEN]);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,1),($1,$4,$3,1)`,
    [adminId, `b_${MARKED}_2`, MARKED, `b_${MARKED}_3`]);
  const unlinkFolder = join(DL, FOLDER(UNLINK));
  chmodSync(unlinkFolder, 0o555);
  try {
    const started = await post('/api/admin/series/bulk/chapters/delete', { seriesIds: [HIDDEN, MARKED, UNLINK] });
    assert.equal(started.statusCode, 202, started.body);
    // The POST has already returned; a separate request can recover the durable run and its eventual result.
    assert.ok((await runState(started.json().runId)).startedAt);
    const run = await finishedRun(started.json().runId);
    const byId = new Map(run.results.map((r: any) => [r.id, r]));
    assert.equal(byId.get(HIDDEN).reason, 'hidden');
    assert.equal(byId.get(MARKED).reason, 'nothing_to_delete');
    assert.deepEqual(byId.get(MARKED).chapterSkips, { bookmarked: 2 });
    assert.equal(run.summary.chapterSkips.bookmarked, 2);
    assert.equal(byId.get(UNLINK).reason, 'nothing_to_delete');
    assert.deepEqual(byId.get(UNLINK).chapterSkips, { unlink_failed: 1 });
    assert.equal(run.summary.chapterSkips.unlink_failed, 1);
    assert.equal(existsSync(join(unlinkFolder, 'Chapter 2.cbz')), true, 'a failed unlink is never tombstoned');
    assert.equal(await pruned(`b_${UNLINK}_2`), false);
  } finally {
    chmodSync(unlinkFolder, 0o755);
  }
});

test('a run left by another process becomes interrupted and its partial result stays retrievable', { skip }, async () => {
  const stale = (await q(
    `INSERT INTO admin_bulk_delete_runs
       (worker_id, pause, series_ids, total, done, summary, results)
     VALUES (gen_random_uuid(), true, ARRAY['s_bmd_restart'], 2, 1,
       '{"applied":1,"chapters":1,"bytes":1,"kept":1,"paused":1,"skipped":0,"failed":0,"chapterSkips":{}}'::jsonb,
       '[{"id":"s_bmd_restart","outcome":"applied","chapters":1,"bytes":1,"kept":1,"paused":true,"chapterSkips":{}}]'::jsonb)
     RETURNING id`,
  ))[0].id;
  assert.equal(await closeInterrupted(), 1);
  const response = await get(`/api/admin/series/bulk/chapters/delete?runId=${stale}`);
  assert.equal(response.statusCode, 200, response.body);
  const run = response.json().run;
  assert.equal(run.status, 'interrupted');
  assert.equal(run.done, 1);
  assert.equal(run.results[0].chapters, 1);
  assert.match(run.error, /server stopped/i);
});

test('Show deleted chapters as ghosts: off by default, told to every viewer, and listed "not downloaded" to Mihon', { skip }, async () => {
  const listing = async () => (await app.inject({ method: 'GET', url: `/api/series/${C}/listing`, headers: { authorization: adminTok } })).json();
  const mihon = async () => (await app.inject({
    method: 'GET', url: `/api/v1/series/${C}/books?unpaged=true&media_status=READY&deleted=false`, headers: { 'x-api-key': apiKey },
  })).json();
  assert.equal((await listing()).deletedAsGhosts, false, 'it must ship off');
  assert.deepEqual((await mihon()).content.map((b: any) => b.number), [1], 'off, tombstones stay out of the Mihon list');

  const p = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { authorization: adminTok }, payload: { deletedAsGhosts: true } });
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(p.json().deleted_as_ghosts, true);
  assert.equal((await listing()).deletedAsGhosts, true);
  // Chapter 2 was deleted on purpose: listed, "not downloaded", no pages. Chapter 3's file went missing (Verify), and
  // the sweep fetches those back: it is not one.
  const rows = (await mihon()).content;
  assert.deepEqual(rows.map((b: any) => b.number), [1, 2]);
  const two = rows.find((b: any) => b.number === 2);
  assert.equal(two.size, 'not downloaded');
  assert.equal(two.media.status, 'READY');
  assert.equal(two.media.pagesCount, 0);
  assert.notEqual(rows.find((b: any) => b.number === 1).size, 'not downloaded', 'a chapter with its file is not absent');
  // Display only: the tombstone is still a tombstone.
  assert.equal(await pruned('b_bmd_c2'), true);
  await q('UPDATE server_settings SET deleted_as_ghosts = false WHERE id = 1');
});
