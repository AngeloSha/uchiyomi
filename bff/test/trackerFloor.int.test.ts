// Progress pushed to a tracker must never go backwards on its own.
//
// AniList accepts a LOWER progress and rewrites the list entry, and there is no undo from this side. So
// anything that reduces `MAX(number) FILTER (completed)` walks someone's real account backwards without
// asking: merging two series, renumbering a chapter, a bulk mark-unread. seriesProgressFor already refuses
// to rewind within a reading session (it reports the maximum completed chapter, not the last one finished),
// but nothing stopped that maximum itself from dropping.
//
// tracker_progress records what was actually accepted. A push below it is refused and the reason is written
// where the user can see it, and clearTrackerFloor is the deliberate escape hatch for when the lower number
// is the correct one.
//
// These tests never call AniList: they exercise seriesProgressFor and the floor table directly, which is the
// same split the existing tracker tests use.
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
let seriesProgressFor: typeof import('../src/lib/trackers')['seriesProgressFor'];
let clearTrackerFloor: typeof import('../src/lib/trackers')['clearTrackerFloor'];

const S = 's_tf_series';
let uid: string;

const book = (n: number) => `b_tf_${n}`;

const floorOf = async (): Promise<number | null> => {
  const r = await q<{ chapters: number }>(
    `SELECT chapters FROM tracker_progress WHERE user_id = $1 AND series_id = $2 AND provider = 'anilist'`,
    [uid, S],
  );
  return r.length ? r[0].chapters : null;
};

const setFloor = (n: number) =>
  q(
    `INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',$3)
     ON CONFLICT (user_id, series_id, provider) DO UPDATE SET chapters = EXCLUDED.chapters`,
    [uid, S, n],
  );

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ seriesProgressFor, clearTrackerFloor } = await import('../src/lib/trackers'));
  await migrate();

  await q(`DELETE FROM users WHERE username = 'tf-test'`);
  const u = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ('Floor','tf-test','user','x','password') RETURNING id`,
  );
  uid = u[0].id;
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!tf','Floor Test',$1,3)
     ON CONFLICT (id) DO NOTHING`,
    [S],
  );
  for (const n of [1, 2, 3]) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
       VALUES ($1,$2,'T!tf',$3,$4,$5,'/library') ON CONFLICT (id) DO NOTHING`,
      [book(n), S, `T!tf/Floor/ch${n}.cbz`, n, `Chapter ${n}`],
    );
  }
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM tracker_progress WHERE user_id = $1`, [uid]);
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM tracker_progress WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'tf-test'`).catch(() => {});
});

const complete = (n: number) =>
  q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,20,true)
     ON CONFLICT (user_id, book_id) DO UPDATE SET completed = true`,
    [uid, book(n), S],
  );

test('progress is the highest completed chapter', { skip }, async () => {
  await complete(1);
  await complete(3);
  assert.equal((await seriesProgressFor(uid, S)).chapters, 3);
});

test('finished is only true when every chapter is complete', { skip }, async () => {
  await complete(1);
  assert.equal((await seriesProgressFor(uid, S)).finished, false);
  await complete(2);
  await complete(3);
  assert.equal((await seriesProgressFor(uid, S)).finished, true);
});

test('THE RISK: the computed number can drop below what was already sent', { skip }, async () => {
  // This is the situation the floor exists for. It is not hypothetical: renumbering a chapter, merging two
  // series, or marking a batch unread all reduce MAX(number) FILTER (completed).
  await complete(3);
  assert.equal((await seriesProgressFor(uid, S)).chapters, 3);
  await setFloor(3);

  await q(`DELETE FROM read_progress WHERE user_id = $1 AND book_id = $2`, [uid, book(3)]);
  await complete(1);
  assert.equal((await seriesProgressFor(uid, S)).chapters, 1, 'the computed value should genuinely drop');
  assert.equal(await floorOf(), 3, 'the floor must not follow it down');
});

test('the floor is what a push compares against, and it survives the drop', { skip }, async () => {
  await setFloor(42);
  await complete(1);
  const { chapters } = await seriesProgressFor(uid, S);
  assert.ok(chapters < 42, 'setup: the computed value should be below the floor');
  assert.equal(await floorOf(), 42, 'the floor changed on its own');
});

test('a resync clears the floor so a genuine correction can go through', { skip }, async () => {
  await setFloor(42);
  await clearTrackerFloor(uid, S);
  assert.equal(await floorOf(), null, 'the floor survived an explicit resync');
});

test('clearing one series does not clear another', { skip }, async () => {
  const OTHER = 's_tf_other';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!tf','Other',$1,1)
           ON CONFLICT (id) DO NOTHING`, [OTHER]);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',9)
           ON CONFLICT DO NOTHING`, [uid, OTHER]);
  try {
    await setFloor(5);
    await clearTrackerFloor(uid, S);
    const other = await q(`SELECT chapters FROM tracker_progress WHERE user_id = $1 AND series_id = $2`, [uid, OTHER]);
    assert.equal(other.length, 1, 'resyncing one series wiped another series\' floor');
  } finally {
    await q(`DELETE FROM tracker_progress WHERE series_id = $1`, [OTHER]).catch(() => {});
    await q(`DELETE FROM lib_series WHERE id = $1`, [OTHER]).catch(() => {});
  }
});

test('the floor is per user: one household member cannot hold another back', { skip }, async () => {
  await q(`DELETE FROM users WHERE username = 'tf-other'`);
  const u2 = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ('Other','tf-other','user','x','password') RETURNING id`,
  );
  try {
    await setFloor(50);
    const mine = await q(`SELECT chapters FROM tracker_progress WHERE user_id = $1 AND series_id = $2`, [u2[0].id, S]);
    assert.equal(mine.length, 0, 'a floor leaked across users');
  } finally {
    await q(`DELETE FROM tracker_progress WHERE user_id = $1`, [u2[0].id]).catch(() => {});
    await q(`DELETE FROM users WHERE username = 'tf-other'`).catch(() => {});
  }
});
