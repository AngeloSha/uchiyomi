// "Verify chapter files" (lib/verifyFiles.ts): the repair for a database restored without its chapter files.
//
// A backup never holds the chapter files, so a database-only restore leaves every lib_books row claiming
// bytes that are gone: the scan only ever upserts what it finds, and the sweep's have-set trusts the rows,
// so those chapters read "up to date" forever. The task marks such rows pruned with reason 'missing', and
// that reason is what makes the sweep fetch them again while a cleanup tombstone stays held.
//
// The tests that matter are the ways this could destroy something: a hard DELETE of the row (which takes
// everyone's reading history with it -- the first draft of this feature, PR #53, did exactly that at boot),
// marking a whole root "missing" because the volume was not mounted at the time (or because one stray file
// or one empty folder made it look mounted), and marking a READ-LIBRARY row, whose re-fetch cannot land on
// the same row and so strands the tombstone and the reading history beside a duplicate.
//
// The route is driven for real at the end (mounted admin routes): the task is detached, and "answers
// started, the panel shows the run, a restart keeps it" is a claim about the wiring, not the library.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat, readdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-vf-${process.pid}`);
const ROOT = join(TMP, 'lib');
const DL = join(TMP, 'dl');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '300';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let verifyChapterFiles: () => Promise<any>;
let runVerify: (log?: any) => Promise<any> | false;
let tombstoneBooks: (ids: string[], reason?: any) => Promise<void>;
let updateSeries: (id: string, maxNew?: number, opts?: any) => Promise<any>;
let persistScan: () => Promise<any>;
let verifyState: any;
let app: any, adminTok: string;

const SRC = 'T!vf';
const S = 's_vf_series';       // the series with files present, and one chapter file gone
const T = 's_vf_gone';         // a series whose whole folder went
const FOLDER_S = 'T!vf/Present';
const FOLDER_T = 'T!vf/Gone';
const B = { one: 'b_vf_1', two: 'b_vf_2', three: 'b_vf_3', lib: 'b_vf_lib', t1: 'b_vf_t1', t2: 'b_vf_t2' };
const R = 's_vf_read';         // a series that lives in the READ library, one chapter file gone
const FOLDER_R = 'T!vf/Read';
const LIB = 'lib_vf';
const ADMIN = 'vf-admin';
const SRC_ID = 'vf-src';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const png = () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
/** Which chapter ids the fake source was asked pages for: what the sweep actually tried to fetch. */
const asked: number[] = [];

const exists = (p: string) => stat(p).then(() => true).catch(() => false);
const pruned = async (id: string) =>
  (await q<{ pruned_at: string | null; pruned_reason: string | null }>('SELECT pruned_at, pruned_reason FROM lib_books WHERE id = $1', [id]))[0];
const rowCount = async () => (await q<{ n: number }>(`SELECT count(*)::int n FROM lib_books WHERE source = $1`, [SRC]))[0].n;

async function file(abs: string) {
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, 'bytes');
}

const book = (id: string, series: string, n: number, rel: string, root: string) =>
  q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, page_dims)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,'[[1,1]]'::jsonb)`, [id, series, SRC, rel, n, `Chapter ${n}`, root]);

/**
 * S: chapters 1 and 2 on disk under the download dir, chapter 3's row with no file (its folder is there),
 * chapter 4 on disk under the read library. T: two rows whose folder does not exist at all.
 */
async function seed(opts: { files?: boolean } = { files: true }) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,$2,'Present',$3,4,$4,$5,'p-1',true)`, [S, SRC, FOLDER_S, LIB, SRC_ID]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,$2,'Gone',$3,2,$4)`, [T, SRC, FOLDER_T, LIB]);
  if (opts.files) {
    await file(join(DL, FOLDER_S, 'Chapter 1.cbz'));
    await file(join(DL, FOLDER_S, 'Chapter 2.cbz'));
    await file(join(ROOT, FOLDER_S, 'Chapter 4.cbz'));
  }
  await book(B.one, S, 1, `${FOLDER_S}/Chapter 1.cbz`, DL);
  await book(B.two, S, 2, `${FOLDER_S}/Chapter 2.cbz`, DL);
  await book(B.three, S, 3, `${FOLDER_S}/Chapter 3.cbz`, DL);
  await book(B.lib, S, 4, `${FOLDER_S}/Chapter 4.cbz`, ROOT);
  await book(B.t1, T, 1, `${FOLDER_T}/Chapter 1.cbz`, DL);
  await book(B.t2, T, 2, `${FOLDER_T}/Chapter 2.cbz`, DL);
  // The cover is set after the books exist: fk_lib_series_cover_book_id rejects a book that is not there yet.
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, B.three]);
}

async function wipe() {
  // The WHOLE table, not just this file's rows: the walk enumerates every root any un-pruned row names, so
  // a row another test file left behind (scanLayouts' /tmp/uchiyomi-layouts-<pid>, whose files that file
  // removed on its way out) reads as a root that "looked unmounted" and every `unmounted: []` assertion
  // below fails -- only in the full suite, never with this file run alone, which is how it slipped past the
  // build. Safe because the suite runs with --test-concurrency=1 (imageBearer.int.test.ts:52 does the same).
  await q(`DELETE FROM read_progress`).catch(() => {});
  await q(`DELETE FROM lib_books`).catch(() => {});
  await q(`DELETE FROM lib_series`).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
  asked.length = 0;
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ verifyChapterFiles, runVerify, verifyState } = (await import('../src/lib/verifyFiles')) as any);
  ({ tombstoneBooks } = await import('../src/lib/chapterCleanup'));
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  ({ persistScan } = (await import('../src/lib/library')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Verify',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  // The Tasks panel's button and row are driven through the real admin routes, as chapterCleanup.int.test.ts
  // does: the detached run and the persisted result are claims about the wiring.
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  const adminId = (await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'admin','x','password') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
  registerAdapter({
    id: SRC_ID, name: SRC_ID,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_ID, title: sid }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `c${n}` })); },
    async getPageUrls(chId: string) { asked.push(Number(chId.slice(1))); return ['https://example.invalid/page.png']; },
    async latest() { return []; },
  } as any);
});

beforeEach(async () => { if (DSN) await wipe(); });

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_ID]).catch(() => {});
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM audit_log WHERE event = 'library.verify' OR (event = 'task.run' AND detail->>'task' = 'verify')`).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await q('UPDATE server_settings SET verify_last_run = NULL, verify_last_result = NULL WHERE id = 1').catch(() => {});
  await app?.close().catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

test('a missing row is tombstoned with reason missing, never deleted', { skip }, async () => {
  // The row IS everyone's reading history of that chapter (read_progress.book_id is ON DELETE RESTRICT),
  // and it is what the re-fetched file lands back on. Reintroduce by replacing tombstoneBooks in
  // verifyChapterFiles with `DELETE FROM lib_books WHERE id = ANY($1)`: the row count below drops.
  await seed();
  const before1 = await rowCount();

  const r = await verifyChapterFiles();

  assert.equal(await rowCount(), before1, 'a row was deleted instead of marked');
  assert.equal(r.missing, 3, `chapter 3 of Present and both of Gone are missing; got ${JSON.stringify(r)}`);
  assert.equal(r.checked, 6, 'every un-pruned row under a present root was looked for');
  assert.equal(r.readLibraryMissing, 0, 'the read library\'s one row is present');
  assert.deepEqual(r.unmounted, [], 'nothing looked unmounted: both roots have files in them');
  const three = await pruned(B.three);
  assert.ok(three.pruned_at, 'the missing chapter was not marked');
  assert.equal(three.pruned_reason, 'missing', 'the mark must say WHY, or the sweep cannot tell it from a cleanup');
  for (const id of [B.one, B.two, B.lib]) assert.equal((await pruned(id)).pruned_at, null, `${id} is on disk and was marked anyway`);
  assert.ok(await exists(join(DL, FOLDER_S, 'Chapter 1.cbz')), 'verify must never touch a file');
  // Derived measurements go with the mark, the same as a cleanup: a re-fetched file is measured afresh.
  assert.equal((await q('SELECT page_dims FROM lib_books WHERE id = $1', [B.three]))[0].page_dims, null);
  // The cover was the missing chapter; every thumbnail falls back to the cover's first page, so it moves.
  assert.equal((await q('SELECT cover_book_id FROM lib_series WHERE id = $1', [S]))[0].cover_book_id, B.one, 'the cover still points at a chapter with no pages');
});

test('a removed folder among present ones is marked, not mistaken for a missing volume', { skip }, async () => {
  // Gone's folder is not there at all while Present's is: that is a series whose files went (Delete files,
  // or a hand), and its rows are honestly marked. Reintroduce by reporting a root as unmounted when ANY
  // folder is missing: Gone's rows stay unmarked and the download root is listed as unmounted.
  await seed();
  const r = await verifyChapterFiles();
  assert.deepEqual(r.unmounted, []);
  assert.equal((await pruned(B.t1)).pruned_reason, 'missing');
  assert.equal((await pruned(B.t2)).pruned_reason, 'missing');
});

test('an empty mount point marks nothing', { skip }, async () => {
  // ⚠️ A share that is not mounted leaves an empty, readable directory behind, and so does the image
  // (Dockerfile.aio creates /library and /library-dl). No file present is what that looks like, and it is
  // also what an empty disk looks like; neither is evidence about a chapter.
  // Reintroduce by marking rows regardless of the others (drop the whole-batch decision): every
  // download-root row below is marked and the root is not reported.
  await seed({ files: false });
  await file(join(ROOT, FOLDER_S, 'Chapter 4.cbz')); // the read library IS there, so that root is checked

  const r = await verifyChapterFiles();

  assert.deepEqual(r.unmounted, [DL], 'the empty download root must be reported, not marked');
  for (const id of [B.one, B.two, B.three, B.t1, B.t2]) {
    assert.equal((await pruned(id)).pruned_at, null, `${id} was marked missing on an empty mount point`);
  }
  assert.equal(r.missing, 0);
  assert.equal(r.checked, 1, 'the read library was still verified: its one row, present');
});

test('an empty folder a sweep left on a bare mount point is not proof the volume is there', { skip }, async () => {
  // ⚠️ The downloader mkdir -p's the series folder before every write (lib/downloader.ts), so a sweep that
  // ran while the NAS was unmounted leaves empty series folders in the bare mount point. The first cut
  // took "any folder present" as proof of a mount and marked the other 29 rows here 'missing' -- the
  // brief's "every file missing = delete everything" in slow motion, plus a page-hash re-decode of the lot
  // when the share came back. Only a present FILE proves a mount. Reintroduce by counting a present folder
  // as proof (`if (l.present || l.folder) anyPresent = true`): 30 rows below are marked.
  const ids = ['s_vf_sa', 's_vf_sb', 's_vf_sc'];
  for (const s of ids) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,$2,$1,$3,10,$4)`, [s, SRC, `T!vf/${s}`, LIB]);
    for (let n = 1; n <= 10; n++) await book(`${s}_b${n}`, s, n, `T!vf/${s}/Chapter ${n}.cbz`, DL);
  }
  await mkdir(join(DL, `T!vf/${ids[0]}`), { recursive: true });

  const r = await verifyChapterFiles();

  const marked = (await q<{ n: number }>(`SELECT count(*)::int n FROM lib_books WHERE series_id = ANY($1::text[]) AND pruned_at IS NOT NULL`, [ids]))[0].n;
  // (The 90 % rule below is a second net over the same hole -- with this rule gone it still refuses the
  // root, but as "100 % missing" instead of the plain unmounted report the docs describe.)
  assert.deepEqual(r.unmounted, [DL], `the bare root must be reported unmounted as itself; got ${JSON.stringify(r.unmounted)} with ${marked} of 30 rows marked missing`);
  assert.equal(marked, 0);
  assert.equal(r.missing, 0);
});

test('a root with almost every file missing is refused, with the share of it in the reason', { skip }, async () => {
  // One stray download that landed in the overlay while the share was down is one present file -- and
  // with the whole-batch rule alone that one file turns "unmounted" into "mark the other 19". More than
  // nine rows in ten missing is the admin's call, not the task's: the root is reported with the
  // percentage and nothing under it is marked. Exactly nine in ten is still an honest mark (the second
  // half). Reintroduce by dropping the REFUSE_ABOVE test in verifyChapterFiles: 19 rows are marked and
  // the root is not listed.
  const s = 's_vf_ninety';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,$2,$1,$3,20,$4)`, [s, SRC, `T!vf/${s}`, LIB]);
  for (let n = 1; n <= 20; n++) await book(`${s}_b${n}`, s, n, `T!vf/${s}/Chapter ${n}.cbz`, DL);
  await file(join(DL, `T!vf/${s}`, 'Chapter 1.cbz'));

  const r = await verifyChapterFiles();

  const marked = async () => (await q<{ n: number }>(`SELECT count(*)::int n FROM lib_books WHERE series_id = $1 AND pruned_at IS NOT NULL`, [s]))[0].n;
  assert.equal(r.unmounted.length, 1, `the root must be refused: ${JSON.stringify(r)}`);
  assert.ok(r.unmounted[0].startsWith(DL), 'the entry names the root');
  assert.match(r.unmounted[0], /95 % of 20 chapter files missing/, 'the share of missing files is in the entry, so the admin can judge it');
  assert.equal(await marked(), 0, 'nothing under a refused root is marked');
  assert.equal(r.missing, 0);
  assert.equal(r.checked, 0, 'a refused root counts as not checked, like an unmounted one');

  // The boundary: nine of ten missing is not MORE than 90 %, and that library is honestly marked.
  await q('DELETE FROM lib_books WHERE series_id = $1 AND number > 10', [s]);
  const r2 = await verifyChapterFiles();
  assert.deepEqual(r2.unmounted, [], 'nine in ten is still a library with a present file, marked honestly');
  assert.equal(r2.missing, 9);
  assert.equal(await marked(), 9);
});

test('a read-library row whose file is gone is counted, never marked', { skip }, async () => {
  // ⚠️ The downloader writes to DL_ROOT/<folder>/Chapter N.cbz and persistScan keys rows on (root, file),
  // so a /library row marked 'missing' would be "fetched again" into a NEW row: the tombstone never
  // clears, the series page lists the number twice, the reading history stays on the dead row, and the
  // USAGE promise "onto the same rows, so nobody's reading history moves" is false. Reintroduce by
  // dropping the `root !== DL_ROOT` branch in verifyChapterFiles: the row below is pruned, Fetch newest
  // queues chapter 3, and the scan mints a second row for it.
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,$2,'Read',$3,3,$4,$5,'p-2',true)`, [R, SRC, FOLDER_R, LIB, SRC_ID]);
  await file(join(ROOT, FOLDER_R, 'Ch. 001.cbz'));
  await file(join(ROOT, FOLDER_R, 'Ch. 002.cbz'));
  await book('b_vf_r1', R, 1, `${FOLDER_R}/Ch. 001.cbz`, ROOT);
  await book('b_vf_r2', R, 2, `${FOLDER_R}/Ch. 002.cbz`, ROOT);
  await book('b_vf_r3', R, 3, `${FOLDER_R}/Ch. 003.cbz`, ROOT);
  const uid = (await q<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [ADMIN]))[0].id;
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_vf_r3',$2,0,true)`, [uid, R]);

  const v = await verifyChapterFiles();

  assert.equal(v.readLibraryMissing, 1, `the gone read-library file is counted: ${JSON.stringify(v)}`);
  assert.equal(v.missing, 0, 'and not marked');
  assert.equal((await pruned('b_vf_r3')).pruned_at, null, 'a read-library row was tombstoned');
  assert.equal(v.checked, 3, 'the read library was still looked at');

  // Fetch newest holds the row (it is live), so nothing is fetched into the download root beside it.
  globalThis.fetch = (async () => png()) as typeof fetch;
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_ID]);
  const r = await updateSeries(R, 1, { newestOnly: true });
  assert.equal(r.newest?.state, 'up_to_date', JSON.stringify(r.newest));
  await persistScan();
  const rows = await q<{ id: string; root: string }>(`SELECT id, root FROM lib_books WHERE series_id = $1 AND number = 3`, [R]);
  assert.deepEqual(rows, [{ id: 'b_vf_r3', root: ROOT }], 'chapter 3 must stay ONE row, the one the reading history sits on');
  assert.equal((await q(`SELECT book_id FROM read_progress WHERE user_id = $1 AND series_id = $2`, [uid, R]))[0].book_id, 'b_vf_r3');
});

test('a root that cannot be read at all is reported the same way', { skip }, async () => {
  await seed();
  const absent = join(TMP, 'absent');
  await q('UPDATE lib_books SET root = $2 WHERE id = $1', [B.lib, absent]);
  const r = await verifyChapterFiles();
  assert.ok(r.unmounted.includes(absent), `an unreadable root is unmounted: ${JSON.stringify(r)}`);
  assert.equal((await pruned(B.lib)).pruned_at, null);
  assert.equal(r.missing, 3, 'the other roots were still verified');
});

test('a tombstone the cleanup already left keeps its reason', { skip }, async () => {
  // The cleanup's mark means "deleted on purpose, do not fetch again". A verify run over that library must
  // not relabel it 'missing' -- which would make the next sweep re-download every chapter the cleanup
  // freed. Reintroduce by dropping `pruned_at IS NULL` from the row query in verifyChapterFiles, or the
  // same guard from tombstoneBooks: the reason below reads 'missing'.
  await seed();
  await rm(join(DL, FOLDER_S, 'Chapter 2.cbz'));
  await tombstoneBooks([B.two]);
  const r = await verifyChapterFiles();
  const two = await pruned(B.two);
  assert.ok(two.pruned_at);
  assert.equal(two.pruned_reason, null, 'a cleanup tombstone was relabelled missing');
  assert.equal(r.checked, 5, 'a row already pruned is not looked for');
});

test('the sweep fetches a chapter the verify task marked missing', { skip }, async () => {
  // The whole point: after a database-only restore, "up to date" must become "fetch it again". The row is
  // the same one, so when the file lands at the same path the scan clears the mark and the history
  // reattaches. Reintroduce by dropping the heldBooks predicate from the have-set in lib/updater.ts (a plain
  // `SELECT number FROM lib_books WHERE series_id=$1`): the sweep asks for nothing.
  await seed();
  await verifyChapterFiles();
  assert.equal((await pruned(B.three)).pruned_reason, 'missing', 'precondition');
  globalThis.fetch = (async () => png()) as typeof fetch;
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_ID]);

  const r = await updateSeries(S, 5);

  assert.deepEqual(asked, [3], `chapter 3 alone is not held; asked for: ${asked}`);
  assert.equal(r.added, 1);
  assert.ok(await exists(join(DL, FOLDER_S, 'Chapter 3.cbz')), 'the missing chapter did not land');
});

test('a cleanup tombstone is still held, so the sweep does not fetch it back', { skip }, async () => {
  // A chapter the read-chapter cleanup deleted -- or Delete files removed -- was let go on purpose, and
  // the tombstone exists so the sweep does not fetch it back every night (the note on pruned_at in
  // lib/migrate.ts). Reintroduce by making heldBooks in lib/chapterCleanup.ts return `pruned_at IS NULL`:
  // chapter 2 is asked for below.
  await seed();
  await rm(join(DL, FOLDER_S, 'Chapter 2.cbz'));
  await tombstoneBooks([B.two]);                       // the cleanup's mark: reason NULL
  await rm(join(DL, FOLDER_S, 'Chapter 1.cbz'));
  await tombstoneBooks([B.one], 'deleted');            // Delete files' mark
  // With 1 and 2 let go, every un-pruned download row would be missing and the root would read as
  // unmounted (only a present FILE proves a mount); one of Gone's files is there so the walk really marks.
  await file(join(DL, FOLDER_T, 'Chapter 1.cbz'));
  await verifyChapterFiles();                          // chapter 3 -> missing
  globalThis.fetch = (async () => png()) as typeof fetch;
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_ID]);

  await updateSeries(S, 5);

  assert.deepEqual(asked, [3], `only the missing chapter is fetched; asked for: ${asked}`);
  assert.equal(await exists(join(DL, FOLDER_S, 'Chapter 2.cbz')), false, 'the cleanup\'s chapter came back');
  assert.equal(await exists(join(DL, FOLDER_S, 'Chapter 1.cbz')), false, 'the deleted chapter came back');
});

test('a second run on top of a first is refused, not raced', { skip }, async () => {
  await seed();
  const first = runVerify();
  assert.ok(first, 'the first run starts');
  assert.equal(runVerify(), false, 'a second click while the first walk is out must be refused');
  const r = await (first as Promise<any>);
  assert.equal(r.missing, 3);
  assert.ok(runVerify(), 'and once it is done a new run may start');
});

test('the verify button answers started and the panel shows the run', { skip }, async () => {
  // Detached, like the sweep: the first cut awaited the walk inside the request, which a reverse proxy
  // cuts at 60-120 s on a large library over a share -- the page toasted "Failed" while the rows kept
  // being marked. Reintroduce by awaiting `run` in the route and answering its counts: `started` is
  // missing from the answer below.
  await seed();
  const get = () => app.inject({ method: 'GET', url: '/api/admin/tasks', headers: { authorization: adminTok } });
  const run = () => app.inject({ method: 'POST', url: '/api/admin/tasks/verify/run', headers: { authorization: adminTok } });
  await q('UPDATE server_settings SET verify_last_run = NULL, verify_last_result = NULL WHERE id = 1');
  verifyState.finishedAt = null; verifyState.lastResult = null;

  const before1 = (await get()).json().content.find((x: any) => x.id === 'verify');
  assert.ok(before1, 'the task is always listed');
  assert.equal(before1.lastRun, null, 'not run yet');

  const started = await run();
  assert.equal(started.statusCode, 200, started.body);
  assert.deepEqual(started.json(), { ok: true, started: true });
  for (let i = 0; i < 100 && verifyState.running; i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(verifyState.running, false, 'the detached walk finished');

  const row = (await get()).json().content.find((x: any) => x.id === 'verify');
  assert.ok(row.lastRun, 'the panel shows the run');
  assert.equal(row.running, false);
  assert.equal(row.lastResult?.missing, 3, `the panel line carries the counts: ${JSON.stringify(row.lastResult)}`);
  assert.equal(row.lastResult?.checked, 6);
  assert.equal((await pruned(B.three)).pruned_reason, 'missing', 'the button ran the walk');
  // Audited with its counts, when the walk ends: a library-wide change must show who did it.
  const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'library.verify' ORDER BY at DESC LIMIT 1`);
  assert.equal(audit[0]?.detail?.missing, 3, 'the audit row carries what the run found');

  // A second press while a walk is out is refused, not raced. The flag is held by hand rather than by a
  // real walk: over this fixture a walk is over before the second inject lands, and a test that passes on
  // timing is not a test. `runVerify` takes the same flag synchronously (the lib-level test above).
  verifyState.running = true;
  try {
    const busy = await run();
    assert.deepEqual(busy.json(), { ok: false, error: 'busy' });
    assert.equal((await get()).json().content.find((x: any) => x.id === 'verify').running, true, 'the panel shows it running');
  } finally { verifyState.running = false; }
});

test('the last result survives a restart', { skip }, async () => {
  // The Tasks panel promises to keep the last run, and a restart is the very next thing after a restore
  // often enough. The other tasks persist theirs in server_settings; this one did not, so a deploy turned
  // "312 missing, marked" back into "not run yet". Reintroduce by dropping the UPDATE server_settings in
  // runVerify: the row below reads not run yet after the simulated restart.
  await seed();
  await (runVerify() as Promise<any>);
  assert.equal(verifyState.lastResult?.missing, 3, 'precondition');

  // A restart is a fresh process: the in-memory state is what it was at boot.
  verifyState.running = false; verifyState.startedAt = null; verifyState.finishedAt = null; verifyState.lastResult = null;

  const row = (await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: { authorization: adminTok } })).json()
    .content.find((x: any) => x.id === 'verify');
  assert.ok(row.lastRun, 'the last run is gone after a restart');
  assert.equal(row.lastResult?.missing, 3, `the last result is gone after a restart: ${JSON.stringify(row.lastResult)}`);
  assert.equal(row.lastResult?.checked, 6);
  assert.deepEqual(row.lastResult?.unmounted, []);
});

test('verify never runs at boot', { skip: false }, async () => {
  // The first draft of this feature (PR #53) ran at boot and after every scan, and with the volume not
  // yet mounted that is the "empty mount point" case on every start. The one caller is the admin's task
  // route. Reintroduce by calling runVerify from server.ts or persistScan: the file list below grows.
  const SRC_DIR = join(__dirname, '..', 'src');
  const callers: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.ts$/.test(e.name) && /\b(runVerify|verifyChapterFiles)\(/.test(await readFile(p, 'utf8'))) callers.push(p.slice(SRC_DIR.length + 1));
    }
  };
  await walk(SRC_DIR);
  assert.deepEqual(callers.sort(), ['lib/verifyFiles.ts', 'routes/admin.ts'], 'verify is called from somewhere new');
});
