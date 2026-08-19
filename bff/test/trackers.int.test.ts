// What we report to an external tracker is computed in SQL, so it needs a real Postgres to verify.
//
// The rule under test is the one that's easy to get wrong and impossible to notice: progress is the highest
// COMPLETED chapter, not the last one touched. Get it backwards and re-reading an early chapter silently
// rewinds someone's AniList list by a few hundred chapters, which is the kind of damage people don't forgive.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}

const SERIES = 's_test_tracker';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { seriesProgressFor } = await import('../src/lib/trackers');
  await migrate();
  await q(`DELETE FROM users WHERE username = $1`, ['tracker-test']);
  await q(`DELETE FROM lib_series WHERE id = $1`, [SERIES]); // cascades to lib_books
  await q(
    `INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Tracker Test Series',$1)`,
    [SERIES],
  );
  const rows = await q(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'user') RETURNING id`,
    ['tracker-test', 'Tracker Test', 'x'],
  );
  return { q, seriesProgressFor, userId: rows[0].id as string };
}

test('tracker progress reflects the highest completed chapter', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { q, seriesProgressFor, userId } = await setup();

  // five chapters, numbered 1..5
  for (let n = 1; n <= 5; n++) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, title, number) VALUES ($1,$2,'test',$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number`,
      [`b_tracker_${n}`, SERIES, `/test/tracker/${n}.cbz`, `Chapter ${n}`, n],
    );
  }
  const mark = (n: number, completed: boolean) =>
    q(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (user_id, book_id) DO UPDATE SET completed = EXCLUDED.completed`,
      [userId, `b_tracker_${n}`, SERIES, completed],
    );

  await t.test('nothing read yet reports zero and is not finished', async () => {
    const p = await seriesProgressFor(userId, SERIES);
    assert.deepEqual(p, { chapters: 0, finished: false });
  });

  await t.test('reading in order advances progress', async () => {
    await mark(1, true);
    await mark(2, true);
    assert.deepEqual(await seriesProgressFor(userId, SERIES), { chapters: 2, finished: false });
  });

  await t.test('finishing a later chapter out of order jumps ahead', async () => {
    await mark(4, true);
    const p = await seriesProgressFor(userId, SERIES);
    assert.equal(p.chapters, 4, 'should report the highest completed chapter, not the count of them');
    assert.equal(p.finished, false, 'chapters 3 and 5 are still unread');
  });

  await t.test('re-reading an early chapter does not rewind the tracker', async () => {
    // the regression that matters: an organic ping on chapter 1 while 4 is already done
    await mark(1, true);
    assert.equal((await seriesProgressFor(userId, SERIES)).chapters, 4);
  });

  await t.test('finished only when every chapter is complete', async () => {
    await mark(3, true);
    assert.equal((await seriesProgressFor(userId, SERIES)).finished, false, '5 still unread');
    await mark(5, true);
    assert.deepEqual(await seriesProgressFor(userId, SERIES), { chapters: 5, finished: true });
  });

  await t.test('explicitly un-reading the top chapter walks progress back down', async () => {
    // mark-unread is deliberate user intent, so it should be honoured
    await mark(5, false);
    assert.deepEqual(await seriesProgressFor(userId, SERIES), { chapters: 4, finished: false });
  });

  await t.test('another user sees their own progress, not this one', async () => {
    const other = await q(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'user') RETURNING id`,
      ['tracker-test-2', 'Other', 'x'],
    );
    assert.deepEqual(await seriesProgressFor(other[0].id, SERIES), { chapters: 0, finished: false });
    await q(`DELETE FROM users WHERE username = $1`, ['tracker-test-2']);
  });

  await q(`DELETE FROM users WHERE username = $1`, ['tracker-test']);
  await q(`DELETE FROM lib_series WHERE id = $1`, [SERIES]);
});
