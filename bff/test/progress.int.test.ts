// Integration test for the completion rules. These live in SQL (an ON CONFLICT ... CASE), so they can only
// be verified against a real Postgres — which is the point: this is the exact logic that silently stopped
// counting finished chapters and starved the streaks and household leaderboard.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { reachedEnd } from '../src/lib/progressRules'; // pure: safe to import without a database

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/koryomi-test-config';
}

// imported lazily so the module's Pool isn't constructed when we're skipping
type Mod = typeof import('../src/lib/progress');

const BOOK = 'b_test_progress';
const SERIES = 's_test_progress';

async function setup(): Promise<{ mod: Mod; q: any; userId: string }> {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const mod = await import('../src/lib/progress');
  await migrate();
  await q(`DELETE FROM users WHERE username = $1`, ['progress-test']); // cascades to read_progress
  const rows = await q(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'user') RETURNING id`,
    ['progress-test', 'Progress Test', 'x'],
  );
  return { mod, q, userId: rows[0].id };
}

const completedOf = async (q: any, userId: string): Promise<boolean | null> => {
  const r = await q(`SELECT completed FROM read_progress WHERE user_id=$1 AND book_id=$2`, [userId, BOOK]);
  return r[0]?.completed ?? null;
};

test('completion rules', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { mod, q, userId } = await setup();
  const write = (page: number, completed: boolean, silent = false) =>
    mod.writeProgress({ userId, bookId: BOOK, seriesId: SERIES, page, completed, silent });

  await t.test('an ordinary ping stores progress without completing', async () => {
    await write(5, false);
    assert.equal(await completedOf(q, userId), false);
  });

  await t.test('completing marks it read', async () => {
    await write(20, true);
    assert.equal(await completedOf(q, userId), true);
  });

  await t.test('re-reading does NOT un-read it (the regression that broke stats)', async () => {
    await write(2, false);
    assert.equal(await completedOf(q, userId), true, 'organic pings may only upgrade');
    const r = await q(`SELECT page FROM read_progress WHERE user_id=$1 AND book_id=$2`, [userId, BOOK]);
    assert.equal(r[0].page, 2, 'but the page position still moves');
  });

  await t.test('an explicit mark-unread DOES clear it', async () => {
    await write(0, false, true);
    assert.equal(await completedOf(q, userId), false);
  });

  await t.test('explicit marks are kept out of reading_events so stats stay honest', async () => {
    const before = await q(`SELECT count(*)::int c FROM reading_events WHERE user_id=$1`, [userId]);
    await write(0, true, true);
    const after = await q(`SELECT count(*)::int c FROM reading_events WHERE user_id=$1`, [userId]);
    assert.equal(after[0].c, before[0].c, 'bulk-marking a backlog must not inflate the weekly leaderboard');
  });

  await t.test('organic reads DO log an event', async () => {
    const before = await q(`SELECT count(*)::int c FROM reading_events WHERE user_id=$1`, [userId]);
    await write(7, false);
    const after = await q(`SELECT count(*)::int c FROM reading_events WHERE user_id=$1`, [userId]);
    assert.equal(after[0].c, before[0].c + 1);
  });

  await q(`DELETE FROM users WHERE id = $1`, [userId]);
});

test('reachedEnd only trusts a real page count', () => {
  assert.equal(reachedEnd(19, 20), true, 'last page');
  assert.equal(reachedEnd(20, 20), true, 'past the end');
  assert.equal(reachedEnd(5, 20), false, 'mid-book');
  assert.equal(reachedEnd(0, 0), false, 'unknown page count must never auto-complete');
  assert.equal(reachedEnd(0, 1), false, 'a 1-page count is not trustworthy');
});
