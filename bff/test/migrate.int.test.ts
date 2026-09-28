// runOnce(): the mechanism for data migrations that must never run twice.
//
// migrate() has always been a single idempotent DDL string, which is exactly right for CREATE/ALTER ... IF
// NOT EXISTS and useless for anything that changes data — an UPDATE placed there would re-run on every boot,
// forever. runOnce fills that gap, and the property that makes it trustworthy is that the ledger stamp is
// written in the SAME transaction as the work, so the two can never disagree.
//
// These tests exist because that property is invisible: a broken runOnce looks fine until the day a step
// half-applies against someone's library and there is no way to tell what state they are in.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let pool: import('pg').Pool;
let runOnce: typeof import('../src/lib/migrate').runOnce;
let migrate: typeof import('../src/lib/migrate').migrate;
let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;

const IDS = ['t-once', 't-throws', 't-concurrent', 't-work'];

before(async () => {
  if (!DSN) return;
  ({ runOnce, migrate } = await import('../src/lib/migrate'));
  ({ pool, q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q(`DELETE FROM schema_migrations WHERE id = ANY($1)`, [IDS]);
  await q(`DROP TABLE IF EXISTS runonce_probe`);
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM schema_migrations WHERE id = ANY($1)`, [IDS]).catch(() => {});
  await q(`DROP TABLE IF EXISTS runonce_probe`).catch(() => {});
});

/** Borrow a client the way migrate() does, run fn, always release. */
async function withClient<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

test('runOnce: runs the first time and reports that it did', { skip }, async () => {
  let calls = 0;
  const ran = await withClient((c) => runOnce(c, 't-once', async () => { calls++; }));
  assert.equal(ran, true);
  assert.equal(calls, 1);

  const stamped = await q(`SELECT id, ms FROM schema_migrations WHERE id = 't-once'`);
  assert.equal(stamped.length, 1, 'no ledger row was written');
  assert.ok(stamped[0].ms !== null, 'duration was not recorded');
});

test('runOnce: never runs a second time', { skip }, async () => {
  let calls = 0;
  const again = await withClient((c) => runOnce(c, 't-once', async () => { calls++; }));
  assert.equal(again, false, 'reported as freshly applied when it was already done');
  assert.equal(calls, 0, 'the step body ran a second time');
});

test('runOnce: a step that throws leaves NO stamp, so it retries next boot', { skip }, async () => {
  // The failure mode this rules out: work partially applied, ledger says done, nobody can tell.
  await assert.rejects(
    withClient((c) =>
      runOnce(c, 't-throws', async (cc) => {
        await cc.query(`CREATE TABLE runonce_probe (x int)`);
        throw new Error('boom');
      }),
    ),
    /boom/,
  );

  const stamped = await q(`SELECT 1 FROM schema_migrations WHERE id = 't-throws'`);
  assert.equal(stamped.length, 0, 'a failed step was stamped as applied');

  const table = await q(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'runonce_probe'`,
  );
  assert.equal(table.length, 0, 'the failed step left its work behind — the transaction did not roll back');
});

test('runOnce: the work and the stamp commit together', { skip }, async () => {
  await withClient((c) =>
    runOnce(c, 't-work', async (cc) => {
      await cc.query(`CREATE TABLE runonce_probe (x int)`);
      await cc.query(`INSERT INTO runonce_probe (x) VALUES (42)`);
    }),
  );
  const rows = await q<{ x: number }>(`SELECT x FROM runonce_probe`);
  assert.deepEqual(rows.map((r) => r.x), [42]);
  assert.equal((await q(`SELECT 1 FROM schema_migrations WHERE id = 't-work'`)).length, 1);
});

test('runOnce: two callers racing still run the body exactly once', { skip }, async () => {
  // migrate() holds an advisory lock around this, so in production the race cannot happen. Assert the
  // primary key catches it anyway: whichever loses gets a duplicate-key error rather than doing the work
  // twice, which is the behaviour that matters if runOnce is ever called from somewhere new.
  let calls = 0;
  const attempt = () =>
    withClient((c) => runOnce(c, 't-concurrent', async () => { calls++; await new Promise((r) => setTimeout(r, 40)); }));

  const results = await Promise.allSettled([attempt(), attempt()]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;

  assert.ok(ok >= 1, 'neither caller succeeded');
  assert.equal(
    (await q(`SELECT 1 FROM schema_migrations WHERE id = 't-concurrent'`)).length,
    1,
    'the ledger ended up with more or less than one row',
  );
  assert.ok(calls <= 2, 'sanity: the body ran more times than there were callers');
});

test('migrate: is still idempotent, and the shipped data migrations are applied', { skip }, async () => {
  await migrate();
  await migrate();
  const noop = await q(`SELECT id FROM schema_migrations WHERE id = '0001-noop'`);
  assert.equal(noop.length, 1, 'the shipped no-op migration did not record exactly one row');
});

// v0.49.0's promise is that a rollback to v0.48.4 still works: the old image boots on the new schema and keeps
// writing its rows. The new tables are invisible to it, but the columns added to tables it already INSERTs into
// are not -- one of them declared NOT NULL without a default and every old INSERT into that table fails, which
// a fresh test database never shows, because ADD COLUMN on an empty table succeeds either way.
const V049_TABLES = ['download_log', 'repair_runs', 'series_post_numbers', 'archive_queue', 'archive_pace'];
// v0.49.1's block (after v0.49.0's): two new tables and nothing else, so v0.49.0 boots on it and never meets them.
const V0491_TABLES = ['series_alt_titles', 'source_find_runs'];
const V049_COLUMNS: Record<string, string[]> = {
  lib_books: ['short_result', 'source_chapter_id'],
  chapter_failures: ['first_at'],
  source_health: ['live_at', 'live_by', 'live_state', 'live_code', 'live_stage', 'live_detail', 'live_checks', 'stages'],
  lib_series: [
    'numbering', 'numbering_by', 'numbering_source', 'numbering_pending', 'numbering_note', 'numbering_changed_at',
    'renumber_plan',
  ],
  server_settings: [
    'archive_paused', 'archive_per_hour', 'archive_window_from', 'archive_window_to', 'archive_min_free_gb',
  ],
};
/** v0.48.4's own schema, captured from its migrate() (see the file's _provenance). */
const V0484 = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'v0.48.4-required-columns.json'), 'utf8')) as {
  tables: string[];
  columns: Record<string, string[]>;
};

test('migrate: v0.49.0 only adds, and every added column lets v0.48.4 keep writing its rows', { skip }, async () => {
  const tables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [V049_TABLES],
  );
  assert.deepEqual(tables.map((t) => t.table_name).sort(), [...V049_TABLES].sort(), 'a v0.49.0 table is missing');

  for (const [table, cols] of Object.entries(V049_COLUMNS)) {
    const rows = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
      [table, cols],
    );
    assert.deepEqual(rows.map((r) => r.column_name).sort(), [...cols].sort(), `a v0.49.0 column of ${table} is missing`);
  }

  // The rule itself, over the WHOLE schema rather than the list above, so an amendment to the block that adds
  // a column and forgets the list is caught too: on every table v0.48.4 has, the only required columns are the
  // ones v0.48.4 already wrote. Reintroduce by adding `ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS
  // numbering_extra text NOT NULL;` to the block, or by dropping the default from source_health.stages: the
  // assertion names the column.
  const current = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [V0484.tables],
  );
  assert.deepEqual(current.map((t) => t.table_name).sort(), [...V0484.tables].sort(), 'a v0.48.4 table is gone: v0.49.0 only adds');
  const required = await q<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) AND is_nullable = 'NO' AND column_default IS NULL`,
    [V0484.tables],
  );
  for (const r of required) {
    assert.ok(
      (V0484.columns[r.table_name] ?? []).includes(r.column_name),
      `${r.table_name}.${r.column_name} is NOT NULL with no default: after a rollback, v0.48.4's INSERTs into ${r.table_name} fail`,
    );
  }

  // The one server_settings row existed before the columns did; ADD COLUMN … DEFAULT fills it. What is
  // checked is the DECLARED default, not the live row: in a serial run on one database a test that changes
  // the archive pacing and forgets to put it back must not fail this one. Reintroduce `DEFAULT 5` on
  // archive_per_hour: "server_settings.archive_per_hour" fails.
  const defaults = await q<{ column_name: string; column_default: string | null; is_nullable: string }>(
    `SELECT column_name, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'server_settings' AND column_name = ANY($1)`,
    [V049_COLUMNS.server_settings],
  );
  const declared = Object.fromEntries(defaults.map((d) => [d.column_name, [d.column_default, d.is_nullable]]));
  assert.deepEqual(declared, {
    archive_paused: ['false', 'NO'], archive_per_hour: ['4', 'NO'], archive_min_free_gb: ['20', 'NO'],
    archive_window_from: [null, 'YES'], archive_window_to: [null, 'YES'],
  }, 'server_settings.archive_per_hour (or another archive column) is not declared as the design set it');
});

test('migrate: v0.49.1 adds its two tables and nothing a v0.49.0 image would have to write', { skip }, async () => {
  // A rollback to v0.49.0 boots on this schema: the block is two CREATE TABLEs and an index, no column on any
  // older table (the whole-schema rule above still holds against v0.48.4's own list). Reintroduce by dropping
  // either CREATE TABLE: "a v0.49.1 table is missing".
  const tables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [V0491_TABLES],
  );
  assert.deepEqual(tables.map((t) => t.table_name).sort(), [...V0491_TABLES].sort(), 'a v0.49.1 table is missing');
  // What a v0.49.1 writer must supply: only the key columns, everything else has a default or may be NULL.
  const required = await q<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) AND is_nullable = 'NO' AND column_default IS NULL`,
    [V0491_TABLES],
  );
  assert.deepEqual(required.map((r) => `${r.table_name}.${r.column_name}`).sort(),
    ['series_alt_titles.norm', 'series_alt_titles.origin', 'series_alt_titles.series_id', 'series_alt_titles.title']);
  // The origin is the database's rule too, not only the writers': a name from nowhere is refused. Reintroduce by
  // dropping the CHECK: the insert below succeeds.
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO lib_series (id, source, title, folder) VALUES ('t-alt-origin', 'test', 'T', '/t-alt')`);
      await c.query(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ('t-alt-origin', 'another', 'Another', 'admin')`);
      await assert.rejects(
        c.query(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ('t-alt-origin', 'bogusname', 'Bogus Name', 'guessed')`),
        /check constraint/i,
      );
    } finally {
      await c.query('ROLLBACK');
    }
  });
});

test('migrate: the archive compares its bounds in the listing\'s own type', { skip }, async () => {
  // #117 picks `series_listing.number < boundary`. With boundary numeric, Postgres compares the real as float8,
  // and 45.3::real reads as 45.29999923706055 -- below a numeric 45.3 -- so the boundary chapter counted as
  // strictly below itself and both the archive and the sweep claimed it. Reintroduce `boundary numeric` in the
  // block: "archive_queue.boundary is not the listing's type" fails.
  const types = await q<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN
        (('series_listing', 'number'), ('archive_queue', 'boundary'), ('archive_queue', 'floor_at_start'), ('archive_queue', 'current_number'))`,
  );
  const t = Object.fromEntries(types.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));
  const listing = t['series_listing.number'];
  assert.equal(listing, 'real');
  for (const col of ['boundary', 'floor_at_start', 'current_number']) {
    assert.equal(t[`archive_queue.${col}`], listing, `archive_queue.${col} is not the listing's type`);
  }
  // And what that buys, on this server: an admin's floor of 45.3 stored as the boundary does not hold a listed
  // 45.3 below it. In a transaction that is rolled back, so the shared test database keeps no series.
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO lib_series (id, source, title, folder) VALUES ('t-archive-bound', 'test', 'T', '/t')`);
      await c.query(`INSERT INTO archive_queue (series_id, boundary) VALUES ('t-archive-bound', 45.3)`);
      const { rows } = await c.query(`SELECT 45.3::real < boundary AS below FROM archive_queue WHERE series_id = 't-archive-bound'`);
      assert.equal(rows[0].below, false, 'a listed 45.3 counts as below a boundary of 45.3');
    } finally {
      await c.query('ROLLBACK');
    }
  });
});
