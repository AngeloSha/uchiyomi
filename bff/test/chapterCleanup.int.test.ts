// The read-chapter cleanup against a real database and a real filesystem.
//
// This is the only scheduled job in the product that destroys data, so what is tested here is mostly what it
// must NOT do. The three that would be worst to get wrong, in order:
//
//   1. deleting a chapter somebody else is partway through. The whole feature is "delete what has been
//      read", and read_progress holds one row per reader -- getting the aggregate the wrong way round
//      deletes a chapter out from under the only person still reading it.
//   2. taking reading history with it. read_progress.book_id is ON DELETE RESTRICT precisely so a chapter
//      row cannot silently erase what someone read of it, and that loss syncs outward to AniList.
//   3. deleting from the read library. Those files are somebody's own collection; we did not put them there.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-cc-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-ccdl-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let runCleanupOnce: () => Promise<any>;
let runChapterCleanup: (log?: any) => Promise<any> | false;
let dueCount: (days: number) => Promise<number>;
let runtime: any;
let app: any, adminTok: string;

const S = 's_cc_series';
const FOLDER = 'T!cc/Berserk';
/** Chapter 1 is the series cover and is therefore never eligible; the tests use 2 and 3. */
const IDS = { cover: 'b_cc_1', two: 'b_cc_2', three: 'b_cc_3', lib: 'b_cc_lib' };
const USERS = ['cc-alice', 'cc-bob'];
const ADMIN = 'cc-admin';
/**
 * The seeded files "landed" ten days ago. A realistic mtime, not the column's 1970 default: the job compares
 * the last read against the file's mtime, and a default of 0 made that clause vacuously true in every test
 * here -- a comparison against the wrong column or in the wrong unit would still have passed them all.
 */
const LANDED_AT = Date.now() - 10 * 86_400_000;

const exists = (p: string) => stat(p).then(() => true).catch(() => false);

/** Turn the job on with a given grace period. Off is the default, so every test has to say so. */
const enable = (days: number) =>
  q('UPDATE server_settings SET cleanup_read = true, cleanup_read_days = $1 WHERE id = 1', [days]);

async function seed() {
  await mkdir(join(DL, FOLDER), { recursive: true });
  await mkdir(join(ROOT, FOLDER), { recursive: true });
  for (const f of ['ch1.cbz', 'ch2.cbz', 'ch3.cbz']) await writeFile(join(DL, FOLDER, f), 'x'.repeat(100));
  await writeFile(join(ROOT, FOLDER, 'own.cbz'), 'x'.repeat(100));

  // The series is inserted WITHOUT its cover, and the cover set once the books exist: cover_book_id is a
  // foreign key onto lib_books (fk_lib_series_cover_book_id, NOT VALID for old rows but enforced on every
  // new one), so naming a book that is not there yet fails the insert and, with it, every test in this file.
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!cc','Berserk',$2,4)`,
    [S, FOLDER],
  );
  const book = (id: string, n: number, file: string, root: string) =>
    q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root, mtime)
       VALUES ($1,$2,'T!cc',$3,$4,$5,$6,$7)`,
      [id, S, file, n, `Chapter ${n}`, root, LANDED_AT],
    );
  await book(IDS.cover, 1, `${FOLDER}/ch1.cbz`, DL);
  await book(IDS.two, 2, `${FOLDER}/ch2.cbz`, DL);
  await book(IDS.three, 3, `${FOLDER}/ch3.cbz`, DL);
  await book(IDS.lib, 4, `${FOLDER}/own.cbz`, ROOT);
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, IDS.cover]);
}

/** One reader's state for one chapter, backdated by `agoDays`; `page` as the reader left it (10 by default). */
async function progress(username: string, bookId: string, completed: boolean, agoDays = 0, page = 10) {
  const u = await q<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
     VALUES ($1,$2,$3,$6,$4, now() - make_interval(days => $5))
     ON CONFLICT (user_id, book_id) DO UPDATE SET completed = EXCLUDED.completed, updated_at = EXCLUDED.updated_at, page = EXCLUDED.page`,
    [u[0].id, bookId, S, completed, agoDays, page],
  );
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const cc = await import('../src/lib/chapterCleanup');
  runCleanupOnce = cc.runCleanupOnce;
  runChapterCleanup = cc.runChapterCleanup;
  dueCount = cc.dueCount;
  ({ runtime } = await import('../src/lib/runtime'));
  await migrate();
  for (const username of USERS) {
    await q('DELETE FROM users WHERE username = $1', [username]).catch(() => {});
    await q(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
       VALUES ($1,$1,'user','x','password')`,
      [username],
    );
  }
  // The admin surface -- the Run now button, the task row, the due count on the settings page -- is driven
  // through the real routes, as chapterActions.int.test.ts does.
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
});

beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM bookmarks WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('UPDATE server_settings SET cleanup_read = false, cleanup_read_days = 30 WHERE id = 1').catch(() => {});
  await chmod(DL, 0o755).catch(() => {}); // the read-only test leaves it 555
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
  await seed();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  for (const username of [...USERS, ADMIN]) await q('DELETE FROM users WHERE username = $1', [username]).catch(() => {});
  await q('UPDATE server_settings SET cleanup_read = false, cleanup_read_days = 30, cleanup_read_last_run = NULL, cleanup_read_last_result = NULL WHERE id = 1').catch(() => {});
  await chmod(DL, 0o755).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
});

// ---- the off switch ----

test('switched off, it deletes nothing and does not even look', { skip }, async () => {
  await progress('cc-alice', IDS.two, true, 99);
  const r = await runCleanupOnce();
  assert.equal(r.skipped, 'disabled');
  assert.equal(r.deleted, 0);
  assert.ok(await exists(join(DL, FOLDER, 'ch2.cbz')));
});

// ---- the rule ----

test('a chapter every reader finished, long enough ago, is deleted', { skip }, async () => {
  await enable(7);
  await progress('cc-alice', IDS.two, true, 30);
  await progress('cc-bob', IDS.two, true, 10);
  const r = await runCleanupOnce();
  assert.equal(r.deleted, 1);
  assert.equal(r.bytes, 100, 'the reclaimed bytes should be measured, not guessed');
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false);
  assert.equal(await exists(join(DL, FOLDER, 'ch3.cbz')), true, 'nothing else may go with it');
});

test('THE RULE: one reader partway through vetoes the chapter for everybody', { skip }, async () => {
  // Alice finished it a year ago; Bob is on page ten. This is the case the feature exists to get right.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 365);
  await progress('cc-bob', IDS.two, false, 365);
  const r = await runCleanupOnce();
  assert.equal(r.deleted, 0);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), true);
});

test('a chapter nobody has opened is not this job\'s business', { skip }, async () => {
  await enable(0);
  const r = await runCleanupOnce();
  assert.equal(r.deleted, 0, 'no read_progress row means nobody read it, not that everybody finished it');
  assert.equal(await exists(join(DL, FOLDER, 'ch3.cbz')), true);
});

test('the grace period runs from the LAST reader to finish', { skip }, async () => {
  // Alice finished a fortnight ago, Bob yesterday. With ten days of grace the chapter stays: the wait is
  // per chapter and the last person to close it starts it again.
  await enable(10);
  await progress('cc-alice', IDS.two, true, 14);
  await progress('cc-bob', IDS.two, true, 1);
  assert.equal(await dueCount(10), 0);
  assert.equal((await runCleanupOnce()).deleted, 0);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), true);
});

test('zero days deletes on the very next run', { skip }, async () => {
  await enable(0);
  await progress('cc-alice', IDS.two, true, 0);
  assert.equal((await runCleanupOnce()).deleted, 1);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false);
});

// ---- what survives ----

test('THE RULE: the chapter and everyone\'s reading history survive the file', { skip }, async () => {
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  await runCleanupOnce();
  const rows = await q('SELECT pruned_at FROM lib_books WHERE id = $1', [IDS.two]);
  assert.equal(rows.length, 1, 'the chapter row was destroyed');
  assert.ok(rows[0].pruned_at, 'the row must be marked, or the reader offers pages that are not there');
  assert.equal(
    (await q('SELECT 1 FROM read_progress WHERE book_id = $1', [IDS.two])).length,
    1,
    'reading progress was destroyed',
  );
});

test('the tombstone stops the updater re-downloading what was just deleted', { skip }, async () => {
  // updateSeries builds its have-set from lib_books rows, so the row surviving IS the mechanism. Asserted
  // as the updater asks the question, because that is the query that would loop.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  await runCleanupOnce();
  const have = await q<{ number: number }>('SELECT number FROM lib_books WHERE series_id = $1', [S]);
  assert.ok(have.some((h) => Number(h.number) === 2), 'chapter 2 must still read as "we have it"');
});

test('a file in the read library is never touched, however thoroughly it was read', { skip }, async () => {
  await enable(0);
  await progress('cc-alice', IDS.lib, true, 365);
  await progress('cc-bob', IDS.lib, true, 365);
  assert.equal((await runCleanupOnce()).deleted, 0);
  assert.equal(await exists(join(ROOT, FOLDER, 'own.cbz')), true);
});

test('the chapter the series draws its artwork from is left alone', { skip }, async () => {
  await enable(0);
  await progress('cc-alice', IDS.cover, true, 365);
  assert.equal((await runCleanupOnce()).deleted, 0);
  assert.equal(await exists(join(DL, FOLDER, 'ch1.cbz')), true);
});

test('a bookmarked chapter is left alone', { skip }, async () => {
  await enable(0);
  await progress('cc-alice', IDS.two, true, 365);
  const u = await q<{ id: string }>('SELECT id FROM users WHERE username = $1', ['cc-alice']);
  await q('INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,4)', [u[0].id, IDS.two, S]);
  assert.equal((await runCleanupOnce()).deleted, 0);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), true);
});

// ---- second run ----

test('a second run finds nothing left to do', { skip }, async () => {
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  assert.equal((await runCleanupOnce()).deleted, 1);
  const again = await runCleanupOnce();
  assert.equal(again.deleted, 0, 'pruned_at must take the chapter out of consideration for good');
  assert.equal(again.remaining, 0);
});

test('a chapter fetched again after a prune is kept until someone finishes the new copy', { skip }, async () => {
  // Alice finished chapter 2 forty days ago and the job deleted it. It comes back -- an admin fetched it
  // again, a restore, a re-copy -- and the scan gives it a fresh mtime. Alice's row still says `completed`,
  // forty days ago, of a file that no longer exists: that read must not count against the new file, or the
  // very next run deletes it again and the two of them go round forever.
  // Reintroduce by deleting the `done.done_at >= to_timestamp(b.mtime / 1000.0)` clause from dueSql: the
  // middle run deletes 1.
  await enable(0);
  // The seeded file landed ten days ago; this one has been here for sixty, so a read forty days ago is a
  // read of it.
  await q('UPDATE lib_books SET mtime = $2 WHERE id = $1', [IDS.two, Date.now() - 60 * 86_400_000]);
  await progress('cc-alice', IDS.two, true, 40);
  assert.equal((await runCleanupOnce()).deleted, 1);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false);

  await writeFile(join(DL, FOLDER, 'ch2.cbz'), 'x'.repeat(100));
  const { persistScan } = await import('../src/lib/library');
  await persistScan();
  const [row] = await q<{ pruned_at: string | null; mtime: string }>('SELECT pruned_at, mtime FROM lib_books WHERE id = $1', [IDS.two]);
  assert.equal(row.pruned_at, null, 'the scan must clear the mark');
  assert.ok(Number(row.mtime) > 0, 'the scan must stamp the new file\'s mtime');

  const again = await runCleanupOnce();
  assert.equal(again.deleted, 0, 'a read of the OLD copy was counted against the new one');
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), true);

  // Alice reads the new copy to the end: now it is due.
  await progress('cc-alice', IDS.two, true, 0);
  assert.equal((await runCleanupOnce()).deleted, 1);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false);
});

test('a tombstone forgets what it knew about the bytes; hand-marked pages survive', { skip }, async () => {
  // page_dims, the fingerprint and the size describe the file that was deleted. Left on the row, a chapter
  // fetched again from another group -- different page count, different pages -- would be laid out by the
  // reader to the OLD measurements. Computed page hashes go too; a page a person marked by hand is a
  // decision, not a measurement, and stays.
  // Reintroduce by putting the bare `UPDATE lib_books SET pruned_at = now()` back in runCleanupOnce.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  await q(
    `UPDATE lib_books SET page_dims = '[{"name":"001.jpg","width":800,"height":1200}]'::jsonb,
            fingerprint = 'zip:deadbeef', fp_kind = 'zip', fp_at = now(), size = 100
      WHERE id = $1`,
    [IDS.two],
  );
  await q(
    `INSERT INTO page_hashes (book_id, page, hash, override) VALUES ($1, 0, 'abc', NULL), ($1, 1, 'def', true)`,
    [IDS.two],
  );

  assert.equal((await runCleanupOnce()).deleted, 1);

  const [row] = await q('SELECT pruned_at, page_dims, fingerprint, fp_kind, fp_at, size FROM lib_books WHERE id = $1', [IDS.two]);
  assert.ok(row.pruned_at, 'the row must still be marked');
  assert.equal(row.page_dims, null, 'page_dims outlived the pages');
  assert.equal(row.fingerprint, null, 'the fingerprint outlived the bytes');
  assert.equal(row.fp_kind, null);
  assert.equal(row.fp_at, null, 'fp_at must clear, or the backfill never re-measures a file that comes back');
  assert.equal(row.size, null);
  const hashes = await q<{ page: number; override: boolean | null }>('SELECT page, override FROM page_hashes WHERE book_id = $1 ORDER BY page', [IDS.two]);
  assert.deepEqual(hashes.map((h) => [h.page, h.override]), [[1, true]], 'the computed hash must go and the hand-marked page must stay');
});

test('a scan that finds the file again clears the mark', { skip }, async () => {
  // Restored from a backup, re-copied by hand: the row's claim that the bytes are gone is now false, and a
  // stale mark would leave a readable chapter showing as deleted forever.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  await runCleanupOnce();
  await writeFile(join(DL, FOLDER, 'ch2.cbz'), 'x'.repeat(100));
  const { persistScan } = await import('../src/lib/library');
  await persistScan();
  const rows = await q('SELECT pruned_at FROM lib_books WHERE id = $1', [IDS.two]);
  assert.equal(rows[0]?.pruned_at, null);
});

// ---- who counts as finished ----

test('a reader re-reading a chapter they finished keeps it', { skip }, async () => {
  // Alice finished chapter 2 last year; today she has it open again on page 3 of 40. Her row reads
  // completed (a page ping never un-completes one), updated just now -- and at zero days of grace the
  // restart of the clock is no protection. Only her page is: it is not at the end, so she is partway.
  // Reintroduce by reducing dueSql's HAVING to `bool_and(rp.completed)`: the file is deleted under her.
  await enable(0);
  await q('UPDATE lib_books SET pages = 40 WHERE id = $1', [IDS.two]);
  await progress('cc-alice', IDS.two, true, 0, 3);
  assert.equal(await dueCount(0), 0, 'a completed row on page 3 of 40 is somebody re-reading');
  assert.equal((await runCleanupOnce()).deleted, 0);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), true, 'the file was deleted out from under a reader');

  // She reaches the last page: now she has finished it, and it is due.
  await progress('cc-alice', IDS.two, true, 0, 39);
  assert.equal((await runCleanupOnce()).deleted, 1, 'page 39 of 40 is the end (reachedEnd in lib/progressRules.ts)');
});

test('"Mark read" writes the page count itself, and still counts as finished', { skip }, async () => {
  // The Mark read action stores page = pages, one past the last index; reachedEnd is `>=`, so it qualifies.
  await enable(0);
  await q('UPDATE lib_books SET pages = 40 WHERE id = $1', [IDS.two]);
  await progress('cc-alice', IDS.two, true, 0, 40);
  assert.equal((await runCleanupOnce()).deleted, 1);
});

test('a chapter whose page count is unknown keeps the plain rule', { skip }, async () => {
  // pages = 0 is a file the scanner has not measured; there is no end to compare against, so `completed`
  // alone decides, as it did before the page rule existed.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 0, 3);
  assert.equal((await runCleanupOnce()).deleted, 1);
});

// ---- which copy they read ----

test('a chapter finished AFTER it landed is due; one finished BEFORE the file landed is not', { skip }, async () => {
  // The seeded files landed ten days ago. Alice finished chapter 2 five days ago -- a read of this copy.
  // Bob finished chapter 3 twenty days ago -- of a copy this file replaced (a restore, a re-copy); the
  // clause that keeps a re-fetched chapter from going round forever is the one that says so, and it is
  // exercised here against a real mtime rather than the column's 1970 default.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 5);
  await progress('cc-bob', IDS.three, true, 20);
  const r = await runCleanupOnce();
  assert.equal(r.deleted, 1);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false, 'read after it landed: due');
  assert.equal(await exists(join(DL, FOLDER, 'ch3.cbz')), true, 'read before it landed: a read of another copy');
});

// ---- the volume ----

test('a missing download folder stops the run instead of marking chapters deleted', { skip }, async () => {
  // The share is not mounted: the mount point (DL) exists and is writable, so the preflight passes, and
  // EVERY due chapter's file AND folder are missing. Marking on that would tombstone the lot -- hidden from
  // every reader, their measurements thrown away -- while the files sit intact on the unmounted disk.
  // Reintroduce by marking rows whose folder is missing regardless of the rest of the batch: pruned_at is set.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  await progress('cc-alice', IDS.three, true, 1);
  await rm(join(DL, FOLDER), { recursive: true, force: true });
  const r = await runCleanupOnce();
  assert.equal(r.deleted, 0, 'nothing may be marked on the evidence of a missing folder');
  assert.equal(r.stopped, 'unmounted');
  assert.equal(r.failed, 0, 'an unmounted volume is not a failed unlink');
  assert.equal(r.remaining, 2, 'both wait for the next run, counted once');
  const rows = await q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE id = ANY($1)', [[IDS.two, IDS.three]]);
  assert.deepEqual(rows.map((x) => x.pruned_at), [null, null]);
});

test('a removed series does not wedge the cleanup', { skip }, async () => {
  // The product's own way of dropping a series: hide it, then Delete files -- every file AND the folder go,
  // the rows stay (read_progress is ON DELETE RESTRICT). Its read chapters are due, are the oldest-finished
  // and so sort FIRST; the first version of the unmounted guard stopped at that row and every hourly run
  // after it did the same, deleting nothing for any live series ever again. Now a hidden series is not
  // examined at all, and a folder missing while OTHER folders are present is marked as gone, not treated
  // as an unmounted volume. Reintroduce by stopping at the first missing folder: the live chapter stays.
  await enable(0);
  const GONE = 's_cc_gone';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!cc','Gone',$2,1)`, [GONE, 'T!cc/Gone']);
  // Landed 500 days ago and finished 400 days ago (the mtime rule wants the read AFTER the landing), long
  // before the live chapter: it sorts first, which is exactly what wedged the first version.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, mtime) VALUES ('b_cc_gone', $1, 'T!cc', 'T!cc/Gone/ch1.cbz', 1, 'Chapter 1', $2, $3)`, [GONE, DL, Date.now() - 500 * 86_400_000]);
  await progress('cc-alice', 'b_cc_gone', true, 400);
  await progress('cc-alice', IDS.two, true, 1);
  try {
    // 1. hidden, files gone (no folder was ever made): not examined, so it cannot block the queue
    await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [GONE]);
    let r = await runCleanupOnce();
    assert.equal(r.stopped, undefined, 'a hidden series must not read as an unmounted volume');
    assert.equal(r.deleted, 1, 'the live chapter is deleted');
    assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false);
    assert.equal((await q('SELECT pruned_at FROM lib_books WHERE id = $1', ['b_cc_gone']))[0].pruned_at, null, 'a hidden series is left alone');
    // 2. not hidden, folder deleted by hand while other folders exist: marked as gone, the run goes on
    await q('UPDATE lib_series SET deleted_at = NULL WHERE id = $1', [GONE]);
    await progress('cc-alice', IDS.three, true, 1);
    r = await runCleanupOnce();
    assert.equal(r.stopped, undefined, 'one missing folder among present ones is not an unmounted volume');
    assert.equal(r.deleted, 2, 'the folder-less row is marked and the live chapter deleted');
    assert.ok((await q('SELECT pruned_at FROM lib_books WHERE id = $1', ['b_cc_gone']))[0].pruned_at, 'the row was claiming bytes that do not exist');
    assert.equal(await exists(join(DL, FOLDER, 'ch3.cbz')), false);
  } finally {
    await q('DELETE FROM read_progress WHERE book_id = $1', ['b_cc_gone']);
    await q('DELETE FROM lib_books WHERE id = $1', ['b_cc_gone']);
    await q('DELETE FROM lib_series WHERE id = $1', [GONE]);
  }
});

test('a file that alone is gone, its folder still there, is marked', { skip }, async () => {
  // The contrast: the folder is present, so the volume is; the file was removed by hand. The row was
  // claiming bytes that do not exist, and leaving it unmarked means re-examining it every run forever.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  await rm(join(DL, FOLDER, 'ch2.cbz'));
  const r = await runCleanupOnce();
  assert.equal(r.deleted, 1);
  assert.equal(r.stopped, undefined);
  assert.ok((await q('SELECT pruned_at FROM lib_books WHERE id = $1', [IDS.two]))[0].pruned_at);
});

test('the download root itself is never the file', { skip }, async () => {
  // containedPath accepts the root (it is "inside" trivially) and the rm is recursive: a row whose file
  // resolves to `.` -- a hand-edited row, nothing in the product writes one -- would take the whole download
  // directory. Reintroduce by dropping the `abs === root` check in runCleanupOnce: DL is gone.
  await enable(0);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, mtime) VALUES ('b_cc_root', $1, 'T!cc', '.', 99, 'Root', $2, $3)`, [S, DL, LANDED_AT]);
  await progress('cc-alice', 'b_cc_root', true, 1);
  const r = await runCleanupOnce();
  assert.equal(r.deleted, 0);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), true, 'the download directory was removed');
  assert.equal((await q('SELECT pruned_at FROM lib_books WHERE id = $1', ['b_cc_root']))[0].pruned_at, null, 'and not marked either: it is not a chapter');
});

test('a set-aside copy from an interrupted refetch goes with the file', { skip }, async () => {
  // `ch2.cbz.refetch-bak` beside a landed ch2.cbz is a refetch whose tidy-up was lost; the boot-time reaper
  // leaves that pair alone. Delete only the file, and at the next boot the reaper sees a bak with no
  // original, puts it back, and the chapter this job deleted is on disk again -- to be deleted once more
  // an hour later. Reintroduce by dropping the `rm(abs + REFETCH_BAK)` in runCleanupOnce.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  await writeFile(join(DL, FOLDER, 'ch2.cbz.refetch-bak'), 'old copy');
  assert.equal((await runCleanupOnce()).deleted, 1);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false);
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz.refetch-bak')), false, 'the bak outlived the delete');
});

// ---- the schedule wrapper and the admin surface ----
//
// ⚠️ No `t.test` subtests in these two: the file's beforeEach re-seeds before every subtest as well as every
// test (node:test hooks are inherited), so a premise set up before the first subtest is gone by the second.

test('the scheduled wrapper: one at a time, a disabled tick unrecorded, an enabled run persisted', { skip }, async () => {
  await q('UPDATE server_settings SET cleanup_read_last_run = NULL, cleanup_read_last_result = NULL WHERE id = 1');
  runtime.lastCleanup = 0;
  runtime.lastCleanupResult = null;
  const last = async () => (await q('SELECT cleanup_read_last_run AS run, cleanup_read_last_result AS result FROM server_settings WHERE id = 1'))[0];

  // A second run on top of a first is refused, not queued. Off, but the flag is held across the awaits
  // either way. Reintroduce by dropping the `runtime.cleaning` check in runChapterCleanup: the second call
  // returns a promise.
  const first = runChapterCleanup();
  assert.ok(first, 'the first call runs');
  assert.equal(runChapterCleanup(), false, 'the second, while the first is in flight, is refused');
  await first;
  assert.equal(runtime.cleaning, false, 'and the flag is released after');

  // A disabled tick records nothing. Reintroduce by dropping the `r.skipped !== 'disabled'` guard:
  // cleanup_read_last_run is set.
  const r0 = await (runChapterCleanup() as Promise<any>);
  assert.equal(r0.skipped, 'disabled');
  assert.equal((await last()).run, null, 'a tick that did not look is not a run');
  assert.equal(runtime.lastCleanup, 0);

  // An enabled run persists what it did, with the days it used.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  const r1 = await (runChapterCleanup() as Promise<any>);
  assert.equal(r1.deleted, 1);
  const l = await last();
  assert.ok(l.run, 'the last run is stamped');
  assert.deepEqual({ deleted: l.result.deleted, days: l.result.days }, { deleted: 1, days: 0 });
  assert.equal(runtime.lastCleanupResult?.deleted, 1);
});

test('the Run now button, the task row and the due count', { skip }, async () => {
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: adminTok } });
  const run = () => app.inject({ method: 'POST', url: '/api/admin/tasks/cleanup/run', headers: { authorization: adminTok } });
  // Five days: a grace period no other test uses, so dueCountCached's memo (keyed on the day count, warmed
  // by every run above with its own figure) cannot answer this one from an earlier test.
  await progress('cc-alice', IDS.two, true, 6);

  // While off: the button refuses and the task is not listed. Reintroduce by dropping the
  // `cleanupSettings()` check in the run route: the button answers started.
  const off = await run();
  assert.equal(off.statusCode, 200, off.body);
  assert.deepEqual(off.json(), { ok: false, error: 'not_enabled' });
  assert.ok(!(await get('/api/admin/tasks')).json().content.some((x: any) => x.id === 'cleanup'), 'a Run now button beside a job nobody consented to');
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), true);

  // The settings page counts what a run would delete, before the switch is on.
  await q('UPDATE server_settings SET cleanup_read_days = 5 WHERE id = 1');
  const s = (await get('/api/admin/settings')).json();
  assert.equal(s.cleanup_read_due, await dueCount(5));
  assert.equal(s.cleanup_read_due, 1, 'chapter 2, finished six days ago, at five days of grace');

  // While on: the task is listed with the due count, and the button deletes.
  await enable(5);
  const task = (await get('/api/admin/tasks')).json().content.find((x: any) => x.id === 'cleanup');
  assert.ok(task, 'listed once it is on');
  assert.equal(task.remaining, 1);
  assert.match(task.schedule, /5 days/);
  const on = await run();
  assert.deepEqual(on.json(), { ok: true, started: true });
  for (let i = 0; i < 50 && runtime.cleaning; i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false, 'the button ran the job');
  const again = (await get('/api/admin/tasks')).json().content.find((x: any) => x.id === 'cleanup');
  assert.equal(again.lastResult?.deleted, 1);
  assert.equal(again.remaining, 0, 'the memo was warmed with what the run measured');
});

test('a download folder this process cannot write to is reported, not silently skipped', { skip: skip || (asRoot && 'root ignores mode bits') }, async () => {
  // The preflight actually creates a directory rather than trusting access(); 555 on DL makes that fail.
  // Reintroduce by dropping the `allWritable` check in runCleanupOnce: the unlink fails instead, and the
  // result says `failed: 1` with no reason.
  await enable(0);
  await progress('cc-alice', IDS.two, true, 1);
  await chmod(DL, 0o555);
  try {
    const r = await runCleanupOnce();
    assert.equal(r.skipped, 'read_only');
    assert.equal(r.deleted, 0);
  } finally {
    await chmod(DL, 0o755);
  }
  assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), true);
});
