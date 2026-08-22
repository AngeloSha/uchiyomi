// Bulk actions across many series.
//
// The subtle parts are all about not damaging things that look unrelated:
//
//  * reading_events must not be written. It records chapters actually read in the app, and it feeds streaks,
//    the household leaderboard and Wrapped. Marking a 200-chapter backlog read would otherwise hand someone
//    a fake record week. This is the same rule the `silent` flag enforces in lib/progress.ts.
//  * marking a series read must not rewind a chapter someone is part-way through, hence GREATEST on page.
//  * marking unread deletes the row rather than setting completed = false, because a leftover page pointer
//    makes an unread series show as in-progress.
//  * a stale id in the list is skipped and reported, not a reason to reject the other 49.
//
// These call the lib layer through the same SQL the routes use, so they test the statements rather than the
// HTTP plumbing.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let uid: string;

const A = 's_bk_a', B = 's_bk_b', HIDDEN = 's_bk_hidden';
const ALL = [A, B, HIDDEN];

/** The mark-read statement from the bulk route, verbatim. */
const bulkRead = (ids: string[]) =>
  q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
     SELECT $1, b.id, b.series_id, COALESCE(b.pages, 0), true
       FROM lib_books b WHERE b.series_id = ANY($2)
     ON CONFLICT (user_id, book_id) DO UPDATE
       SET completed = true, page = GREATEST(read_progress.page, EXCLUDED.page), updated_at = now()`,
    [uid, ids],
  );

const bulkUnread = (ids: string[]) =>
  q(`DELETE FROM read_progress WHERE user_id = $1 AND series_id = ANY($2)`, [uid, ids]);

const live = async (ids: string[]) =>
  (await q<{ id: string }>(
    `SELECT id FROM lib_series WHERE id = ANY($1) AND deleted_at IS NULL AND merged_into IS NULL`, [ids],
  )).map((r) => r.id);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q(`DELETE FROM users WHERE username = 'bk-test'`);
  const u = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ('Bk','bk-test','user','x','password') RETURNING id`,
  );
  uid = u[0].id;
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM reading_events WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [ALL]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]);
  for (const id of ALL) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!bk',$1,$1,2)`, [id],
    );
    for (const n of [1, 2]) {
      await q(
        `INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root)
         VALUES ($1,$2,'T!bk',$3,$4,$5,20,'/library')`,
        [`b_${id}_${n}`, id, `T!bk/${id}/ch${n}.cbz`, n, `Chapter ${n}`],
      );
    }
  }
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [HIDDEN]);
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'bk-test'`).catch(() => {});
});

const doneCount = async () =>
  (await q<{ n: number }>(`SELECT count(*)::int n FROM read_progress WHERE user_id = $1 AND completed`, [uid]))[0].n;

test('marking several series read completes every chapter in them', { skip }, async () => {
  await bulkRead([A, B]);
  assert.equal(await doneCount(), 4);
});

test('THE RULE: bulk marking writes no reading_events', { skip }, async () => {
  // Otherwise a 200-chapter backlog becomes a fake record week on the household leaderboard.
  await bulkRead([A, B]);
  const ev = await q(`SELECT 1 FROM reading_events WHERE user_id = $1`, [uid]);
  assert.equal(ev.length, 0, 'bulk marking inflated the reading stats');
});

test('it does not rewind a chapter you are part-way through', { skip }, async () => {
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,45,false)`,
    [uid, `b_${A}_1`, A],
  );
  await bulkRead([A]);
  const row = await q<{ page: number; completed: boolean }>(
    `SELECT page, completed FROM read_progress WHERE user_id = $1 AND book_id = $2`, [uid, `b_${A}_1`],
  );
  assert.equal(row[0].completed, true);
  assert.equal(row[0].page, 45, 'the page pointer was rewound to the chapter length');
});

test('marking unread deletes the row rather than leaving a page pointer', { skip }, async () => {
  await bulkRead([A]);
  await bulkUnread([A]);
  const rows = await q(`SELECT 1 FROM read_progress WHERE user_id = $1 AND series_id = $2`, [uid, A]);
  assert.equal(rows.length, 0, 'an unread series would still look in-progress');
});

test('marking unread leaves reading history alone', { skip }, async () => {
  await q(
    `INSERT INTO reading_events (user_id, series_id, book_id, page, completed) VALUES ($1,$2,$3,20,true)`,
    [uid, A, `b_${A}_1`],
  );
  await bulkUnread([A]);
  const ev = await q(`SELECT 1 FROM reading_events WHERE user_id = $1 AND series_id = $2`, [uid, A]);
  assert.equal(ev.length, 1, 'marking unread destroyed a record of something that actually happened');
});

test('a hidden series is not touched', { skip }, async () => {
  const ids = await live([A, HIDDEN]);
  assert.deepEqual(ids, [A]);
  await bulkRead(ids);
  const hidden = await q(`SELECT 1 FROM read_progress WHERE user_id = $1 AND series_id = $2`, [uid, HIDDEN]);
  assert.equal(hidden.length, 0, 'a deleted series was marked read');
});

test('a stale id is skipped, and the valid ones still apply', { skip }, async () => {
  const asked = [A, 's_bk_gone', B];
  const ids = await live(asked);
  assert.deepEqual(ids.sort(), [A, B]);
  await bulkRead(ids);
  assert.equal(await doneCount(), 4, 'one stale id should not cost the other two');
  const skipped = asked.filter((x) => !ids.includes(x));
  assert.deepEqual(skipped, ['s_bk_gone']);
});

test('running it twice is idempotent', { skip }, async () => {
  await bulkRead([A]);
  await bulkRead([A]);
  assert.equal(await doneCount(), 2, 'the second pass duplicated progress rows');
});
