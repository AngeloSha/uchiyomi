// The Continue Reading rail.
//
// This exists because of a real incident: the owner finished several chapters on their phone, opened the app
// on their PC, and the series had vanished from Continue Reading entirely. The rail only ever listed chapters
// you were part-way through, so finishing one removed the series and nothing put the next chapter in front of
// you — you had to remember what you were reading and go find it, which is the one job the rail has.
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

const S = 's_od_series';
const chapters = [1, 2, 3, 4];
const bookOf = (n: number) => `b_od_${n}`;

/** The rail's query, kept in step with catalog.ts. */
async function onDeck(userId: string, limit = 60): Promise<string[]> {
  const rows = await q<{ book_id: string }>(
    `WITH recent AS (
       SELECT series_id, max(updated_at) AS last_read
         FROM read_progress
        WHERE user_id = $1 AND updated_at > now() - interval '90 days'
        GROUP BY series_id
     ),
     pick AS (
       SELECT r.series_id, r.last_read,
              COALESCE(
                (SELECT p.book_id FROM read_progress p
                   WHERE p.user_id = $1 AND p.series_id = r.series_id AND p.completed = false
                   ORDER BY p.updated_at DESC LIMIT 1),
                (SELECT b.id FROM lib_books b
                   WHERE b.series_id = r.series_id
                     AND NOT EXISTS (
                       SELECT 1 FROM read_progress p2
                        WHERE p2.user_id = $1 AND p2.book_id = b.id AND p2.completed
                     )
                   ORDER BY b.number ASC, b.file ASC LIMIT 1)
              ) AS book_id
         FROM recent r
     )
     SELECT book_id FROM pick WHERE book_id IS NOT NULL ORDER BY last_read DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => r.book_id);
}

const read = (n: number, page: number, completed: boolean, ago = '1 minute') =>
  q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
     VALUES ($1,$2,$3,$4,$5, now() - $6::interval)
     ON CONFLICT (user_id, book_id) DO UPDATE SET page = $4, completed = $5, updated_at = now() - $6::interval`,
    [uid, bookOf(n), S, page, completed, ago],
  );

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q(`DELETE FROM users WHERE username = 'ondeck-test'`);
  const u = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ('On Deck','ondeck-test','user','x','password') RETURNING id`,
  );
  uid = u[0].id;
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!od','On Deck',$1,4)
     ON CONFLICT (id) DO NOTHING`,
    [S],
  );
  for (const n of chapters) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
       VALUES ($1,$2,'T!od',$3,$4,$5,'/library') ON CONFLICT (id) DO NOTHING`,
      [bookOf(n), S, `T!od/On Deck/ch${n}.cbz`, n, `Chapter ${n}`],
    );
  }
});

beforeEach(async () => { if (DSN) await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]); });

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'ondeck-test'`).catch(() => {});
});

test('a chapter you are part-way through is what you get offered', { skip }, async () => {
  await read(2, 7, false);
  assert.deepEqual(await onDeck(uid), [bookOf(2)]);
});

test('THE BUG: finishing a chapter offers you the next one', { skip }, async () => {
  // Previously this returned nothing at all and the series disappeared from the rail.
  await read(1, 20, true);
  assert.deepEqual(await onDeck(uid), [bookOf(2)], 'finishing chapter 1 should offer chapter 2');
});

test('finishing several in a row keeps walking forward', { skip }, async () => {
  await read(1, 20, true, '30 minutes');
  await read(2, 20, true, '20 minutes');
  await read(3, 20, true, '10 minutes');
  assert.deepEqual(await onDeck(uid), [bookOf(4)]);
});

test('a part-read chapter beats an unread one, even if it is earlier', { skip }, async () => {
  await read(1, 20, true, '30 minutes');
  await read(2, 5, false, '10 minutes'); // stopped in the middle of 2
  assert.deepEqual(await onDeck(uid), [bookOf(2)], 'should resume 2, not jump to 3');
});

test('a series you have finished entirely drops out', { skip }, async () => {
  for (const n of chapters) await read(n, 20, true);
  assert.deepEqual(await onDeck(uid), [], 'nothing left to read should mean nothing on the rail');
});

test('order is by when you last read, newest first', { skip }, async () => {
  const S2 = 's_od_other';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!od','Other',$1,1)
           ON CONFLICT (id) DO NOTHING`, [S2]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root)
           VALUES ('b_od_other',$1,'T!od','T!od/Other/ch1.cbz',1,'Chapter 1','/library')
           ON CONFLICT (id) DO NOTHING`, [S2]);
  try {
    await read(1, 3, false, '2 hours');
    await q(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
       VALUES ($1,'b_od_other',$2,4,false, now() - interval '1 minute')`,
      [uid, S2],
    );
    assert.deepEqual(await onDeck(uid), ['b_od_other', bookOf(1)]);
  } finally {
    await q(`DELETE FROM read_progress WHERE series_id = $1`, [S2]);
    await q(`DELETE FROM lib_books WHERE series_id = $1`, [S2]);
    await q(`DELETE FROM lib_series WHERE id = $1`, [S2]);
  }
});

test('a series you stopped reading months ago stays out of the way', { skip }, async () => {
  await read(1, 5, false, '120 days');
  assert.deepEqual(await onDeck(uid), [], 'the rail is for what you are reading now');
});

test('one entry per series, not one per chapter', { skip }, async () => {
  await read(1, 20, true, '30 minutes');
  await read(2, 3, false, '20 minutes');
  await read(3, 8, false, '10 minutes');
  const rail = await onDeck(uid);
  assert.equal(rail.length, 1, 'the rail listed the same series more than once');
  assert.equal(rail[0], bookOf(3), 'and it should be the most recently read of them');
});
