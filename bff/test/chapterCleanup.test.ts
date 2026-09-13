// The read-chapter cleanup, without a database: the day clamp, and the vetoes in the eligibility SQL.
//
// The SQL assertions look like testing a string, and they are. This is the only scheduled job in the product
// that deletes files, and every clause in that query is the reason it does not delete the wrong one. Losing
// one of them is a silent change -- the query still runs, still returns rows, and the rows are simply wrong.
// So each veto is pinned here, and removing one has to be a deliberate act that also edits this file.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

// Imported after the environment is set, not with it: a static import is hoisted above these assignments,
// and lib/env refuses to load without DATABASE_URL. Nothing here connects -- the DSN points nowhere.
let clampDays: (d: unknown) => number;
let dueSql: (limit: number | null) => string;
before(async () => {
  ({ clampDays, dueSql } = await import('../src/lib/chapterCleanup'));
});

test('zero days survives the clamp: it is a grace period, not the off switch', () => {
  // The bug this guards against is a `|| 30` somewhere in the chain, which turns "delete as soon as it is
  // read" -- the setting the admin explicitly chose -- into a month's wait with no error and no clue.
  assert.equal(clampDays(0), 0);
  assert.equal(clampDays('0'), 0);
});

test('the day count is clamped rather than trusted', () => {
  assert.equal(clampDays(-1), 0, 'a negative grace period would delete chapters from the future');
  assert.equal(clampDays(7), 7);
  assert.equal(clampDays(7.9), 7, 'make_interval takes an integer');
  assert.equal(clampDays(99999), 3650);
  assert.equal(clampDays(undefined), 30, 'an absent value is the stored default, never zero');
  assert.equal(clampDays(null), 30, 'and so is a null, which is what an unreadable settings row looks like');
  assert.equal(clampDays('nonsense'), 0);
});

test('a chapter is due only when EVERY reader of it finished', () => {
  const sql = dueSql(null);
  assert.match(sql, /bool_and\(completed\)/, 'one unfinished reader must veto the whole chapter');
  assert.match(sql, /GROUP BY book_id/, 'the rule is per chapter across users, not per row');
  // A group exists only for a chapter someone has a read_progress row for, which is what makes "nobody has
  // read it" fall out of the join rather than needing a clause of its own.
  assert.match(sql, /JOIN \(/, 'an inner join is what excludes a chapter nobody has opened');
});

test('the clock is the LAST reader to finish, not the first', () => {
  assert.match(dueSql(null), /max\(updated_at\) <= now\(\) - make_interval\(days => \$2\)/);
});

test('only the download directory is ever considered', () => {
  // A library somebody assembled by hand is not ours to prune. This is the clause that says so.
  assert.match(dueSql(null), /b\.root = \$1/);
});

test('an already-pruned chapter is not reconsidered', () => {
  assert.match(dueSql(null), /b\.pruned_at IS NULL/);
});

test('a bookmarked chapter is never pruned', () => {
  // A bookmark points at a page number INSIDE the file. Progress survives losing the pages; a bookmark does
  // not, it becomes a pointer at nothing.
  assert.match(dueSql(null), /NOT EXISTS \(SELECT 1 FROM bookmarks bm WHERE bm\.book_id = b\.id\)/);
});

test("the chapter a series draws its artwork from is never pruned", () => {
  // Every cover, thumbnail and backdrop falls back to the first page of cover_book_id. Prune it and the
  // series loses its art in the grid, the rails and its own page -- for one chapter's worth of disk.
  assert.match(dueSql(null), /NOT EXISTS \(SELECT 1 FROM lib_series s WHERE s\.cover_book_id = b\.id\)/);
});

test('the limit is applied only when one is asked for', () => {
  assert.doesNotMatch(dueSql(null), /LIMIT/, 'the counting form must see the whole backlog');
  assert.match(dueSql(500), /LIMIT 500/);
});
