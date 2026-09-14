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
import { mkdir, rm, writeFile, stat } from 'fs/promises';
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

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let runCleanupOnce: () => Promise<any>;
let dueCount: (days: number) => Promise<number>;

const S = 's_cc_series';
const FOLDER = 'T!cc/Berserk';
/** Chapter 1 is the series cover and is therefore never eligible; the tests use 2 and 3. */
const IDS = { cover: 'b_cc_1', two: 'b_cc_2', three: 'b_cc_3', lib: 'b_cc_lib' };
const USERS = ['cc-alice', 'cc-bob'];

const exists = (p: string) => stat(p).then(() => true).catch(() => false);

/** Turn the job on with a given grace period. Off is the default, so every test has to say so. */
const enable = (days: number) =>
  q('UPDATE server_settings SET cleanup_read = true, cleanup_read_days = $1 WHERE id = 1', [days]);

async function seed() {
  await mkdir(join(DL, FOLDER), { recursive: true });
  await mkdir(join(ROOT, FOLDER), { recursive: true });
  for (const f of ['ch1.cbz', 'ch2.cbz', 'ch3.cbz']) await writeFile(join(DL, FOLDER, f), 'x'.repeat(100));
  await writeFile(join(ROOT, FOLDER, 'own.cbz'), 'x'.repeat(100));

  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, cover_book_id) VALUES ($1,'T!cc','Berserk',$2,4,$3)`,
    [S, FOLDER, IDS.cover],
  );
  const book = (id: string, n: number, file: string, root: string) =>
    q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
       VALUES ($1,$2,'T!cc',$3,$4,$5,$6)`,
      [id, S, file, n, `Chapter ${n}`, root],
    );
  await book(IDS.cover, 1, `${FOLDER}/ch1.cbz`, DL);
  await book(IDS.two, 2, `${FOLDER}/ch2.cbz`, DL);
  await book(IDS.three, 3, `${FOLDER}/ch3.cbz`, DL);
  await book(IDS.lib, 4, `${FOLDER}/own.cbz`, ROOT);
}

/** One reader's state for one chapter, backdated by `agoDays`. */
async function progress(username: string, bookId: string, completed: boolean, agoDays = 0) {
  const u = await q<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
     VALUES ($1,$2,$3,10,$4, now() - make_interval(days => $5))
     ON CONFLICT (user_id, book_id) DO UPDATE SET completed = EXCLUDED.completed, updated_at = EXCLUDED.updated_at`,
    [u[0].id, bookId, S, completed, agoDays],
  );
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const cc = await import('../src/lib/chapterCleanup');
  runCleanupOnce = cc.runCleanupOnce;
  dueCount = cc.dueCount;
  await migrate();
  for (const username of USERS) {
    await q('DELETE FROM users WHERE username = $1', [username]).catch(() => {});
    await q(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
       VALUES ($1,$1,'user','x','password')`,
      [username],
    );
  }
});

beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM bookmarks WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('UPDATE server_settings SET cleanup_read = false, cleanup_read_days = 30 WHERE id = 1').catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
  await seed();
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  for (const username of USERS) await q('DELETE FROM users WHERE username = $1', [username]).catch(() => {});
  await q('UPDATE server_settings SET cleanup_read = false, cleanup_read_days = 30 WHERE id = 1').catch(() => {});
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
