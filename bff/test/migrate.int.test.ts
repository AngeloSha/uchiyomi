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
// (Its whole-schema rule against v0.49.0's own list is the test after v0.49.0's.)
const V0491_TABLES = ['series_alt_titles', 'source_find_runs'];
// v0.51.0's block: one new table (lib/autoHero.ts), so v0.50.0 -- v0.49.1's schema -- boots on it and never meets it.
const V0510_TABLES = ['series_hero'];
// v0.52.0's block: no table, four columns on two tables v0.51.0 writes every day (lib/lang.ts, lib/seriesLang.ts).
const V0520_COLUMNS: Record<string, string[]> = {
  lib_series: ['lang', 'work_id'],
  server_settings: ['mangadex_langs', 'unstated_lang'],
};
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
/** v0.49.0's own schema, captured the same way (see the file's _provenance): what a rollback from v0.49.1 boots. */
const V0490 = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'v0.49.0-required-columns.json'), 'utf8')) as {
  tables: string[];
  columns: Record<string, string[]>;
};
/** v0.51.0's own schema, captured the same way (see the file's _provenance): what a rollback from v0.52.0 boots. */
const V0510 = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'v0.51.0-required-columns.json'), 'utf8')) as {
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

test('migrate: v0.49.1 only adds, and every column lets v0.49.0 keep writing its rows', { skip }, async () => {
  // The same rule as v0.49.0's above, held against v0.49.0's own schema: a rollback from v0.49.1 boots v0.49.0 on
  // this one. v0.48.4's list cannot hold it for the tables v0.49.0 added -- download_log, repair_runs,
  // series_post_numbers, archive_queue, archive_pace are not in it -- so a column declared NOT NULL without a
  // default on one of them in the v0.49.1 block would fail every v0.49.0 INSERT into it after a rollback, and no
  // test would say so. Reintroduce by adding `ALTER TABLE download_log ADD COLUMN IF NOT EXISTS find_run text NOT
  // NULL;` to the v0.49.1 block: the assertion names download_log.find_run.
  assert.ok(V049_TABLES.every((t) => V0490.tables.includes(t)), 'the fixture is not v0.49.0: a v0.49.0 table is missing from it');
  const current = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [V0490.tables],
  );
  assert.deepEqual(current.map((t) => t.table_name).sort(), [...V0490.tables].sort(), 'a v0.49.0 table is gone: v0.49.1 only adds');
  const required = await q<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) AND is_nullable = 'NO' AND column_default IS NULL`,
    [V0490.tables],
  );
  for (const r of required) {
    assert.ok(
      (V0490.columns[r.table_name] ?? []).includes(r.column_name),
      `${r.table_name}.${r.column_name} is NOT NULL with no default: after a rollback, v0.49.0's INSERTs into ${r.table_name} fail`,
    );
  }
  // And the new ones are new: a v0.49.1 table that v0.49.0 already had would be one it writes in its own shape.
  assert.deepEqual(V0491_TABLES.filter((t) => V0490.tables.includes(t)), [], 'a v0.49.1 table is one v0.49.0 already has');
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

test('migrate: a fork-shaped series_alt_titles (PR #119\'s build) is brought to v0.49.1\'s shape', { skip }, async () => {
  // An install that ran the fork build of PR #119 before v0.49.1: no removed_at (every read of the names failed on
  // it), added_by a uuid referencing users, a source_id column, origins 'confirmed' and 'merged', no CHECK.
  // Reintroduce by dropping the repair block: removed_at is missing and the read below throws.
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ('t-fork', 'test', 'Fork Tale', '/t-fork') ON CONFLICT (id) DO NOTHING`);
  try {
    await q(`ALTER TABLE series_alt_titles DROP CONSTRAINT IF EXISTS series_alt_titles_origin_check`);
    await q(`ALTER TABLE series_alt_titles DROP COLUMN removed_at`);
    await q(`ALTER TABLE series_alt_titles ADD COLUMN source_id text`);
    await q(`ALTER TABLE series_alt_titles ALTER COLUMN added_by TYPE uuid
               USING CASE WHEN added_by ~ '^[0-9a-f-]{36}$' THEN added_by::uuid END`);
    await q(`ALTER TABLE series_alt_titles ADD CONSTRAINT series_alt_titles_added_by_fkey FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL`);
    await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin, source_id) VALUES
               ('t-fork', 'otherforkname', 'Other Fork Name', 'confirmed', 'x'), ('t-fork', 'mergedfork', 'Merged Fork', 'merged', null)`);
    await migrate();
    const cols = Object.fromEntries((await q<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'series_alt_titles'`))
      .map((c) => [c.column_name, c.data_type]));
    assert.equal(cols.removed_at, 'timestamp with time zone');
    assert.equal(cols.added_by, 'text');
    assert.equal('source_id' in cols, false);
    const rows = await q(`SELECT norm, origin FROM series_alt_titles WHERE series_id = 't-fork' AND removed_at IS NULL ORDER BY norm`);
    assert.deepEqual(rows.map((r: any) => [r.norm, r.origin]), [['mergedfork', 'admin'], ['otherforkname', 'admin']]);
    await assert.rejects(q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ('t-fork', 'bogusname', 'Bogus', 'guessed')`), /check constraint/i);
    // And a table already in shape is left as it is.
    await migrate();
  } finally {
    await q(`DELETE FROM lib_series WHERE id = 't-fork'`).catch(() => {});
  }
});

test('migrate: v0.51.0 adds its one table and nothing a v0.50.0 image would have to write', { skip }, async () => {
  // v0.50.0 changed no schema, so a rollback from v0.51.0 boots v0.49.1's: v0.49.0's tables (the fixture) and
  // v0.49.1's two. The block is one CREATE TABLE. Reintroduce by dropping it: "a v0.51.0 table is missing".
  const tables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [V0510_TABLES],
  );
  assert.deepEqual(tables.map((t) => t.table_name).sort(), [...V0510_TABLES].sort(), 'a v0.51.0 table is missing');
  assert.deepEqual(V0510_TABLES.filter((t) => V0490.tables.includes(t) || V0491_TABLES.includes(t)), [],
    'a v0.51.0 table is one v0.50.0 already has');
  // Only the key must be supplied: a seed of 0 is the banner every series starts with, the rest may be NULL.
  const required = await q<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) AND is_nullable = 'NO' AND column_default IS NULL`,
    [V0510_TABLES],
  );
  assert.deepEqual(required.map((r) => `${r.table_name}.${r.column_name}`), ['series_hero.series_id']);
});

test('migrate: v0.52.0 only adds, and every column lets v0.51.0 keep writing its rows', { skip }, async () => {
  for (const [table, cols] of Object.entries(V0520_COLUMNS)) {
    const rows = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
      [table, cols],
    );
    assert.deepEqual(rows.map((r) => r.column_name).sort(), [...cols].sort(), `a v0.52.0 column of ${table} is missing`);
  }
  // The whole-schema rule again, held against v0.51.0's own schema, which a rollback from v0.52.0 boots: on every
  // table v0.51.0 has, the only required columns are the ones it already writes. The block adds to lib_series and
  // server_settings, which v0.51.0 INSERTs into all day. Reintroduce by declaring lib_series.lang NOT NULL: the
  // assertion names lib_series.lang.
  assert.ok([...V049_TABLES, ...V0491_TABLES, ...V0510_TABLES].every((t) => V0510.tables.includes(t)),
    'the fixture is not v0.51.0: a table v0.51.0 has is missing from it');
  const current = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [V0510.tables],
  );
  assert.deepEqual(current.map((t) => t.table_name).sort(), [...V0510.tables].sort(), 'a v0.51.0 table is gone: v0.52.0 only adds');
  const required = await q<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) AND is_nullable = 'NO' AND column_default IS NULL`,
    [V0510.tables],
  );
  for (const r of required) {
    assert.ok(
      (V0510.columns[r.table_name] ?? []).includes(r.column_name),
      `${r.table_name}.${r.column_name} is NOT NULL with no default: after a rollback, v0.51.0's INSERTs into ${r.table_name} fail`,
    );
  }
  // As the design declares them: unstated English, no extra MangaDex language, and a series stating nothing and
  // standing alone. Reintroduce DEFAULT 'es' on unstated_lang: "server_settings.unstated_lang" fails.
  const declared = await q<{ table_name: string; column_name: string; column_default: string | null; is_nullable: string }>(
    `SELECT table_name, column_name, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN
        (('lib_series', 'lang'), ('lib_series', 'work_id'), ('server_settings', 'mangadex_langs'), ('server_settings', 'unstated_lang'))`,
  );
  assert.deepEqual(Object.fromEntries(declared.map((d) => [`${d.table_name}.${d.column_name}`, [d.column_default, d.is_nullable]])), {
    'lib_series.lang': [null, 'YES'], 'lib_series.work_id': [null, 'YES'],
    'server_settings.mangadex_langs': ["'[]'::jsonb", 'NO'], 'server_settings.unstated_lang': ["'en'::text", 'NO'],
  }, 'server_settings.unstated_lang (or another v0.52.0 column) is not declared as the design set it');

  // One edition per language per work, and nothing for v0.51.0's rows, which never name a work. Reintroduce by
  // dropping lib_series_work_lang_idx: "a work held one language twice". In a transaction that is rolled back, so
  // the shared test database keeps no series.
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const add = (id: string, work: string | null, lang: string) => c.query(
        `INSERT INTO lib_series (id, source, title, folder, work_id, lang) VALUES ($1, 'test', 'T', $1, $2, $3)`, [id, work, lang]);
      await add('t-ed-alone-1', null, 'en');
      await add('t-ed-alone-2', null, 'en');
      const work = '5a1e0000-0000-4000-8000-000000000520';
      await add('t-ed-en', work, 'en');
      await add('t-ed-es', work, 'es-419');
      await assert.rejects(add('t-ed-en-2', work, 'en'), /lib_series_work_lang_idx/, 'a work held one language twice');
    } finally {
      await c.query('ROLLBACK');
    }
  });
  // Partial: the index holds only rows in a work, which v0.51.0 never writes. Reintroduce by dropping its WHERE.
  const [idx] = await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'lib_series_work_lang_idx'`);
  assert.match(idx?.indexdef ?? '', /^CREATE UNIQUE INDEX .* WHERE \(work_id IS NOT NULL\)$/, 'the edition index is not unique and partial');
});

test("migrate: v0.52.0's data migration states a MangaDex series' language from its listing", { skip }, async () => {
  // A Spanish title that came in through the English adapter's fallback reads as English to every other rule; its
  // MangaDex listing says what it is. Each series: main source, stated language, and its listing as [source, lang].
  const SEED: Record<string, [string, string | null, [string, string][]]> = {
    't-mdl-es': ['mangadex', null, [['mangadex', 'es-la'], ['mangadex', 'es-la'], ['mangadex', 'en']]],
    't-mdl-zh': ['mangadex', null, [['mangadex', 'zh-hk']]],
    't-mdl-en': ['mangadex', null, [['mangadex', 'en'], ['other-src', 'es'], ['other-src', 'es']]],
    't-mdl-odd': ['mangadex', null, [['mangadex', 'ja-ro']]],
    't-mdl-stated': ['mangadex', 'pt-BR', [['mangadex', 'es-la']]],
    't-mdl-follower': ['other-src', null, [['mangadex', 'es-la']]],
  };
  const ids = Object.keys(SEED);
  try {
    for (const [id, [source, lang, listing]] of Object.entries(SEED)) {
      await q(`INSERT INTO lib_series (id, source, title, folder, source_id, lang) VALUES ($1, 'test', 'T', $1, $2, $3)`, [id, source, lang]);
      for (const [i, [src, chLang]] of listing.entries()) {
        await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1, $2, $3, $4::jsonb)`,
          [id, i + 1, src, JSON.stringify({ sourceId: `${id}-c${i + 1}`, number: i + 1, lang: chLang })]);
      }
    }
    await q(`DELETE FROM schema_migrations WHERE id = 'v0.52.0-series-lang-from-mangadex'`);
    await migrate();
    const rows = await q<{ id: string; lang: string | null }>(`SELECT id, lang FROM lib_series WHERE id = ANY($1)`, [ids]);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.lang])), {
      // Reintroduce by stamping MangaDex's own code (no mapping): es-la and zh-hk.
      't-mdl-es': 'es-419',
      't-mdl-zh': 'zh-Hant',
      // Reintroduce by counting every row, not only MangaDex's own: a follower's Spanish outvotes it.
      't-mdl-en': 'en',
      't-mdl-odd': null,
      // Reintroduce by dropping "s.lang IS NULL": the stated pt-BR is overwritten.
      't-mdl-stated': 'pt-BR',
      // Reintroduce by dropping "s.source_id = 'mangadex'": a follower's copies state the series' language.
      't-mdl-follower': null,
    }, 'the data migration stated the wrong language for a series');
    assert.equal((await q(`SELECT 1 FROM schema_migrations WHERE id = 'v0.52.0-series-lang-from-mangadex'`)).length, 1,
      'the data migration did not run, or did not stamp itself');
  } finally {
    await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
  }
});

test("migrate: v0.55.2's data migration types a series from its genres, and only one nothing has typed", { skip }, async () => {
  // Notice chapters are switched per series type (lib/noticeChapters.ts), so every series whose genres say what it is
  // has a type at the first boot. Each: its genres, the admin's genres (null for none), the type it already had and
  // from where, and the admin's own type (series_overrides.series_type).
  const SEED: Record<string, [string[], string[] | null, [string, string] | null, string | null]> = {
    't-st-genre': [['Action', 'Manhwa'], null, null, null],
    't-st-webtoon': [['Webtoon', 'Romance'], null, null, null],
    't-st-none': [['Action'], null, null, null],
    't-st-menu': [['Manga', 'Manhwa', 'Manhua', 'Action'], null, null, null],
    't-st-lone-manga': [['Manga', 'Action'], null, null, null],
    't-st-admin-genres': [['Action'], ['Manhua'], null, null],
    't-st-typed': [['Manhwa'], null, ['manga', 'source'], null],
    't-st-admin-type': [['Manhwa'], null, null, 'comic'],
  };
  const ids = Object.keys(SEED);
  try {
    for (const [id, [genres, ovGenres, typed, ovType]] of Object.entries(SEED)) {
      await q(`INSERT INTO lib_series (id, source, title, folder, genres, series_type, series_type_from) VALUES ($1, 'test', 'T', $1, $2, $3, $4)`,
        [id, genres, typed?.[0] ?? null, typed?.[1] ?? null]);
      if (ovGenres || ovType) await q(`INSERT INTO series_overrides (series_id, genres, series_type) VALUES ($1, $2, $3)`, [id, ovGenres, ovType]);
    }
    // Reintroduce the PR's id ('notice-chapters-series-type-from-genres'): this stamp is not the one migrate() checks,
    // the migration does not run again, and t-st-genre stays untyped. An id is permanent once it has shipped.
    await q(`DELETE FROM schema_migrations WHERE id = 'v0.55.2-series-type-from-genres'`);
    await migrate();
    const rows = await q<{ id: string; t: string | null; ov: string | null }>(
      `SELECT s.id, s.series_type || '/' || s.series_type_from AS t, o.series_type AS ov
         FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.id = ANY($1)`, [ids]);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, [r.t, r.ov]])), {
      't-st-genre': ['manhwa/genre', null],
      't-st-webtoon': ['webtoon/webtoon', null],
      't-st-none': [null, null],
      // typeFromGenres' own rule, not a copy of it in SQL: a genre menu, or "Manga" alone, is no evidence.
      // Reintroduce the SQL table (the first origin named wins): manhwa/genre and manga/genre.
      't-st-menu': [null, null],
      't-st-lone-manga': [null, null],
      // The admin's genres are the series' genres, as everywhere.
      't-st-admin-genres': ['manhua/genre', null],
      // Only a series nothing has typed: MangaDex said manga, and a genre does not get to say otherwise here.
      // Reintroduce by dropping "s.series_type IS NULL": manhwa/genre.
      't-st-typed': ['manga/source', null],
      // The evidence is filled in beside the admin's word, never over it: their comic is still what applies.
      't-st-admin-type': ['manhwa/genre', 'comic'],
    }, 'the data migration typed the wrong series, or the wrong way');
    assert.equal((await q(`SELECT 1 FROM schema_migrations WHERE id = 'v0.55.2-series-type-from-genres'`)).length, 1,
      'the data migration did not run, or did not stamp itself');
  } finally {
    await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
  }
});

test("migrate: v0.55.3's data migration files a failed chapter under its series' main source when the series no longer uses its own", { skip }, async () => {
  // The owner's library (2026-10-04): Replace had moved two series off AllManga onto Natomanga, and their 32 failed
  // chapters stayed filed under AllManga (attempts reset to 0 by v0.54.0's switch) -- listed there by Health, and
  // "chapters no source can download" at the end of every Fix everything run. Each row: its series' main source, the
  // sources it follows, the source the row is filed under, and its tries.
  const SEED: Record<string, [string | null, string[], string, number]> = {
    // The owner's: neither the main source nor followed -- the new main's now.
    't-ff-orphan': ['t-ff-nato', [], 't-ff-allmanga', 0],
    't-ff-capped': ['t-ff-nato', ['t-ff-kakalot'], 't-ff-allmanga', 3],
    // Its own source, failing or not: a row under the main source, or under a source it follows, stays as it is.
    // Reintroduce by dropping the main-source test (`f.source_id <> s.source_id`): t-ff-main's row reads `moved`, its
    // tries reset. By dropping the series_sources test: t-ff-follower's row moves.
    't-ff-main': ['t-ff-allmanga', [], 't-ff-allmanga', 3],
    't-ff-follower': ['t-ff-nato', ['t-ff-allmanga'], 't-ff-allmanga', 2],
    // No main source to give it to: left where it is.
    't-ff-nomain': [null, [], 't-ff-allmanga', 1],
  };
  const ids = Object.keys(SEED);
  try {
    for (const [id, [main, follows, under, attempts]] of Object.entries(SEED)) {
      await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id) VALUES ($1, 'test', 'T', $1, $2, $3)`,
        [id, main, main ? `${main}|${id}` : null]);
      for (const f of follows) await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $3)`, [id, f, `${f}|${id}`]);
      await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at, first_at)
               VALUES ($1, 7, $2, 'error', 'no page urls', $3, now() - interval '1 day', now() - interval '3 days')`, [id, under, attempts]);
    }
    // Reintroduce by leaving the step out of DATA_MIGRATIONS: every row stays under t-ff-allmanga.
    await q(`DELETE FROM schema_migrations WHERE id = 'v0.55.3-failures-follow-the-series'`);
    await migrate();
    const rows = await q<{ series_id: string; source_id: string; status: string; reason: string; attempts: number; old: boolean }>(
      `SELECT series_id, source_id, status, reason, attempts, first_at < now() - interval '2 days' AS old FROM chapter_failures WHERE series_id = ANY($1)`, [ids]);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.series_id, [r.source_id, r.status, r.reason, r.attempts, r.old]])), {
      't-ff-orphan': ['t-ff-nato', 'moved', 'no page urls', 0, true],
      't-ff-capped': ['t-ff-nato', 'moved', 'no page urls', 0, true],
      't-ff-main': ['t-ff-allmanga', 'error', 'no page urls', 3, true],
      't-ff-follower': ['t-ff-allmanga', 'error', 'no page urls', 2, true],
      't-ff-nomain': ['t-ff-allmanga', 'error', 'no page urls', 1, true],
    }, 'the data migration filed the wrong rows, or the wrong way');
    assert.equal((await q(`SELECT 1 FROM schema_migrations WHERE id = 'v0.55.3-failures-follow-the-series'`)).length, 1,
      'the data migration did not run, or did not stamp itself');
  } finally {
    await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
  }
});

test("migrate: v0.55.5's data migration takes a site's genre menu out of a series' genres and its override, and types what is left", { skip }, async () => {
  // The owner's library (2026-10-06): twelve series held Natomanga's whole 59-genre menu after their own genres, read
  // twice -- "Fantasy, Action, ..., Fantasy, Action, ..., All, Completed, Ongoing, Action, Adaptation, Adult, ...".
  const MENU = ['All', 'Completed', 'Ongoing', 'Action', 'Adult', 'Hentai', 'Manga', 'Manhua', 'Manhwa', 'Smut', 'Webtoons'];
  // Each row: the scanned genres, the override's (undefined: no override row), and the stored type and its provenance.
  const SEED: Record<string, [string[], string[] | undefined, string | null, string | null]> = {
    // Cleaned, then typed by its own genres: the menu names three origins, so nothing typed it before.
    't-gm-typed': [['Action', 'Manhwa', 'Action', 'Manhwa', ...MENU], undefined, null, null],
    // Cleaned; its own genres name no origin, so it stays untyped.
    't-gm-untyped': [['Fantasy', 'Demons', 'Fantasy', 'Demons', ...MENU], undefined, null, null],
    // Cleaned; its own Webtoon genre ranks below the source that typed it, which stands (learnSeriesType's rule).
    't-gm-ranked': [['Drama', 'Webtoon', ...MENU], undefined, 'manhua', 'source'],
    // The override holds the menu too (Edit details froze it there on a save): cleaned, the scanned genres as well.
    't-gm-override': [['Drama', ...MENU], ['Drama', 'Romance', ...MENU], null, null],
    // No menu: an "Ongoing" alone is a genre like any other, and nothing changes.
    't-gm-clean': [['Action', 'Ongoing'], undefined, null, null],
  };
  const ids = Object.keys(SEED);
  try {
    for (const [id, [genres, override, type, from]] of Object.entries(SEED)) {
      await q(`INSERT INTO lib_series (id, source, title, folder, genres, series_type, series_type_from) VALUES ($1, 'test', 'T', $1, $2, $3, $4)`,
        [id, genres, type, from]);
      if (override) await q(`INSERT INTO series_overrides (series_id, genres) VALUES ($1, $2)`, [id, override]);
    }
    // Reintroduce by leaving the step out of DATA_MIGRATIONS: every menu stays.
    await q(`DELETE FROM schema_migrations WHERE id = 'v0.55.5-genres-without-site-menu'`);
    await migrate();
    const read = async () => Object.fromEntries((await q<{ id: string; genres: string[]; o: string[] | null; series_type: string | null; series_type_from: string | null }>(
      `SELECT s.id, s.genres, o.genres AS o, s.series_type, s.series_type_from FROM lib_series s
         LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.id = ANY($1)`, [ids])).map((r) => [r.id, [r.genres, r.o, r.series_type, r.series_type_from]]));
    const want = {
      't-gm-typed': [['Action', 'Manhwa'], null, 'manhwa', 'genre'],
      't-gm-untyped': [['Fantasy', 'Demons'], null, null, null],
      't-gm-ranked': [['Drama', 'Webtoon'], null, 'manhua', 'source'],
      't-gm-override': [['Drama'], ['Drama', 'Romance'], null, null],
      't-gm-clean': [['Action', 'Ongoing'], null, null, null],
    };
    assert.deepEqual(await read(), want, 'the data migration cleaned the wrong rows, or the wrong way');
    assert.equal((await q(`SELECT 1 FROM schema_migrations WHERE id = 'v0.55.5-genres-without-site-menu'`)).length, 1,
      'the data migration did not run, or did not stamp itself');
    // Run again, nothing changes.
    await q(`DELETE FROM schema_migrations WHERE id = 'v0.55.5-genres-without-site-menu'`);
    await migrate();
    assert.deepEqual(await read(), want, 'a second run changed something');
  } finally {
    await q(`DELETE FROM series_overrides WHERE series_id = ANY($1)`, [ids]);
    await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
  }
});

test('migrate: an edition v0.51.0 merged away after a rollback gives its language back at the next boot', { skip }, async () => {
  // The rollback drill's find: v0.51.0's merge sets merged_into and leaves work_id and lang alone, so the absorbed
  // French row kept its slot in lib_series_work_lang_idx, and v0.52.0 then refused a new French edition of the
  // survivor as edition_exists while the series page showed no edition at all. Two works, as v0.51.0 leaves them:
  // a pair whose French edition it merged into the English one, and a trio that loses its French edition the same way.
  const { linkEdition } = await import('../src/lib/editions');
  const pair = '5a1e0000-0000-4000-8000-0000005201a0';
  const trio = '5a1e0000-0000-4000-8000-0000005201b0';
  const SEED: [string, string | null, string][] = [
    ['t-rb-en', pair, 'en'], ['t-rb-fr', pair, 'fr'],
    ['t-rb3-en', trio, 'en'], ['t-rb3-es', trio, 'es'], ['t-rb3-fr', trio, 'fr'],
    ['t-rb-new', null, 'fr'],
  ];
  const ids = SEED.map(([id]) => id);
  try {
    for (const [id, work, lang] of SEED) {
      await q(`INSERT INTO lib_series (id, source, title, folder, work_id, lang) VALUES ($1, 'test', 'T', $1, $2, $3)`, [id, work, lang]);
    }
    // v0.51.0's mergeSeries, as far as these columns go: the absorbed row points at its survivor and nothing else.
    await q(`UPDATE lib_series SET merged_into = 't-rb-en' WHERE id = 't-rb-fr'`);
    await q(`UPDATE lib_series SET merged_into = 't-rb3-en' WHERE id = 't-rb3-fr'`);
    await migrate();
    const work = Object.fromEntries((await q<{ id: string; work_id: string | null }>(
      `SELECT id, work_id FROM lib_series WHERE id = ANY($1)`, [ids])).map((r) => [r.id, r.work_id]));
    // Reintroduce by dropping the first UPDATE in the v0.52.0 block: both merged rows keep their work.
    assert.equal(work['t-rb-fr'], null, 'a row merged away still holds its language in the work');
    assert.equal(work['t-rb3-fr'], null, 'a row merged away still holds its language in the work');
    // Reintroduce by dropping the second: the English survivor of the pair stays a "work of one".
    assert.equal(work['t-rb-en'], null, 'the edition a v0.51.0 merge left alone does not stand on its own');
    // A work that still has two editions keeps them.
    assert.deepEqual([work['t-rb3-en'], work['t-rb3-es']], [trio, trio], 'a work with two editions left was dissolved');
    // What the user saw: French can be added to each survivor again.
    const again = await linkEdition('t-rb-new', { of: 't-rb3-en', lang: 'fr' });
    assert.deepEqual(again, { workId: trio, lang: 'fr' }, 'a French edition is still refused where the merged one was');
  } finally {
    await q(`UPDATE lib_series SET merged_into = NULL WHERE id = ANY($1)`, [ids]);
    await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
  }
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

test('migrate: v0.55.1 adds library_paths, seeded from libraries.path, and a v0.55.0 rollback is put right at boot', { skip }, async () => {
  // #148: a library holds several folders, one library_paths row each. libraries.path stays and holds the first, which
  // is all v0.55.0 reads -- so a rollback boots on this schema, and the table must be right again when v0.55.1 boots
  // back after v0.55.0 has created, re-pathed or deleted libraries knowing only that column.
  const IDS = ['t-lp-a', 't-lp-b', 't-lp-c', 't-lp-d', 't-lp-e'];
  const rows = async () => Object.fromEntries((await q<{ library_id: string; paths: string[] }>(
    `SELECT library_id, array_agg(path ORDER BY path) AS paths FROM library_paths WHERE library_id = ANY($1) GROUP BY library_id`,
    [IDS])).map((r) => [r.library_id, r.paths]));
  try {
    // A single-folder library as every install has them today: the boot seeds its row. Reintroduce by dropping the
    // INSERT ... SELECT from libraries: "an existing library's folder is not seeded" fails.
    await q(`INSERT INTO libraries (id, name, path) VALUES ('t-lp-a', 'A', 'Lp/A')`);
    await migrate();
    assert.deepEqual(await rows(), { 't-lp-a': ['Lp/A'] }, 'an existing library\'s folder is not seeded');
    assert.equal((await q(`SELECT 1 FROM library_paths WHERE library_id = 'lib'`)).length, 0,
      'the default library holds a folder: its empty path is "everything no other library holds"');

    // v0.55.1's own state, as the routes leave it: libraries.path is the first of several folders.
    await q(`INSERT INTO libraries (id, name, path) VALUES ('t-lp-b', 'B', 'Lp/B'), ('t-lp-c', 'C', 'Lp/C'), ('t-lp-d', 'D', 'Lp/D'), ('t-lp-e', 'E', 'Lp/E')`);
    await q(`INSERT INTO library_paths (library_id, path) VALUES
               ('t-lp-a', 'Lp/A2'), ('t-lp-b', 'Lp/B'), ('t-lp-b', 'Lp/B2'), ('t-lp-c', 'Lp/C'), ('t-lp-c', 'Lp/Shared'),
               ('t-lp-d', 'Lp/D'), ('t-lp-e', 'Lp/E'), ('t-lp-e', 'Lp/E2')`);
    const steady = await rows();
    // Idempotent: two more boots change nothing.
    await migrate();
    await migrate();
    assert.deepEqual(await rows(), steady, 'a boot changed a v0.55.1 library\'s folders');

    // Now v0.55.0 runs for a while. It re-paths A (its only folder, as far as it knows), files a new library F under a
    // folder C holds as a further one (it checks only libraries.path for a duplicate), and deletes D.
    await q(`UPDATE libraries SET path = 'Lp/Z' WHERE id = 't-lp-a'`);
    await q(`INSERT INTO libraries (id, name, path) VALUES ('t-lp-f', 'F', 'Lp/Shared')`);
    IDS.push('t-lp-f');
    await q(`DELETE FROM libraries WHERE id = 't-lp-d'`);
    await migrate();
    assert.deepEqual(await rows(), {
      // Reintroduce by dropping the DELETE: A keeps Lp/A and Lp/A2 beside Lp/Z, folders v0.55.0 took away from it.
      't-lp-a': ['Lp/Z'],
      't-lp-b': ['Lp/B', 'Lp/B2'],
      // Reintroduce ON CONFLICT DO NOTHING: F holds no folder at all, and C keeps the one F has been filing since.
      't-lp-c': ['Lp/C'],
      't-lp-f': ['Lp/Shared'],
      't-lp-e': ['Lp/E', 'Lp/E2'],
    }, 'a library v0.55.0 changed does not hold what v0.55.0 left it holding');
    // D's rows went with it (ON DELETE CASCADE): v0.55.0's DELETE FROM libraries never meets the table.
    assert.equal((await q(`SELECT 1 FROM library_paths WHERE library_id = 't-lp-d'`)).length, 0);
    const again = await rows();
    await migrate();
    assert.deepEqual(await rows(), again, 'the reconcile is not idempotent');

    // What a v0.55.0 writer has to supply is unchanged: libraries gained no required column, and the new table has
    // only its two.
    const required = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'library_paths' AND is_nullable = 'NO' AND column_default IS NULL
        ORDER BY column_name`);
    assert.deepEqual(required.map((r) => r.column_name), ['library_id', 'path']);
  } finally {
    await q(`DELETE FROM libraries WHERE id = ANY($1)`, [IDS]);
  }
});

test('migrate: lib_books.created_at is when a row was first scanned, and v0.55.1 keeps writing its rows', { skip }, async () => {
  // Updates tells the rows that came since a reader looked apart by it (lib/enrich.ts newSinceSeen). NOT NULL with a
  // default: v0.55.1 boots on this schema and INSERTs without naming it. Reintroduce it without the default: the
  // v0.55.1 INSERT below fails, and so does every scan v0.55.1 makes after a rollback.
  const cols = await q<{ data_type: string; column_default: string | null; is_nullable: string }>(
    `SELECT data_type, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'lib_books' AND column_name = 'created_at'`);
  assert.deepEqual(cols.map((c) => [c.data_type, c.column_default, c.is_nullable]), [['timestamp with time zone', 'now()', 'NO']],
    'created_at is not NOT NULL DEFAULT now(): a v0.55.1 INSERT would leave it empty, or fail');
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO lib_series (id, source, title, folder) VALUES ('t-made', 'test', 'T', 'T!made-m/T')`);
      // Exactly the INSERT v0.55.1's scan makes.
      await c.query(`INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root)
                     VALUES ('t-made-b', 't-made', 'test', 'T!made-m/T/Chapter 1.cbz', 1, 'Chapter 1', 0, '/library')`);
      const { rows } = await c.query(`SELECT created_at = now() AS now FROM lib_books WHERE id = 't-made-b'`);
      assert.equal(rows[0].now, true, 'a v0.55.1 row does not carry the time it came');
    } finally {
      await c.query('ROLLBACK');
    }
  });
});

test('migrate: v0.55.2 reads every chapter already in a library by rule 1, and v0.55.1 keeps writing its rows', { skip }, async () => {
  // #150: lib_books.name_rule says which rule reads a row's number out of its file name (lib/naming.ts numberByRule).
  // Every row that exists when the column arrives is rule 1, the first number, as it always was; v0.55.1 boots on
  // this schema and INSERTs without naming the column, so whatever it adds is rule 1 too. Reintroduce DEFAULT 2:
  // "a v0.55.1 row" reads 2, and the next scan renumbers every chapter v0.55.1 added.
  // number_end, a range's last chapter, is nullable with no default and no CHECK: v0.55.1's scan rewrites `number` and
  // never meets it, and a CHECK against `number` would fail that UPDATE and its whole folder (lib/chapterRanges.ts).
  const cols = await q<{ column_name: string; data_type: string; column_default: string | null; is_nullable: string }>(
    `SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'lib_books' AND column_name IN ('name_rule', 'number_end')
      ORDER BY column_name`);
  assert.deepEqual(cols.map((c) => [c.column_name, c.data_type, c.column_default, c.is_nullable]),
    [['name_rule', 'smallint', '1', 'NO'], ['number_end', 'real', null, 'YES']]);
  const checks = await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'lib_books'::regclass AND contype = 'c'
                             AND pg_get_constraintdef(oid) LIKE '%number_end%'`);
  assert.deepEqual(checks, [], 'a CHECK on number_end would refuse what a v0.55.1 scan writes');
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO lib_series (id, source, title, folder) VALUES ('t-rule', 'test', 'T', 'T!rule-m/T')`);
      // Exactly the INSERT v0.55.1's scan makes.
      await c.query(`INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root)
                     VALUES ('t-rule-b', 't-rule', 'test', 'T!rule-m/T/Vol 2 Ch 5.cbz', 2, 'Vol 2 Ch 5', 0, '/library')`);
      const { rows } = await c.query(`SELECT name_rule, number_end FROM lib_books WHERE id = 't-rule-b'`);
      assert.equal(rows[0].name_rule, 1, 'a v0.55.1 row is not rule 1');
      assert.equal(rows[0].number_end, null, 'a v0.55.1 row holds a range');
      // ...and its scan's UPDATE of a rule-2 range row, `number` rewritten under an untouched end, goes through.
      await c.query(`UPDATE lib_books SET number_end = 7 WHERE id = 't-rule-b'`);
      await c.query(`UPDATE lib_books SET number = 1987 WHERE id = 't-rule-b'`);
    } finally {
      await c.query('ROLLBACK');
    }
  });
});

test('migrate: v0.55.7 marks no match as checked that was stored before it, and v0.55.6 keeps writing its rows', { skip }, async () => {
  // #168: checked_at NULL is what the background recheck takes up (lib/matchCheck.ts), so every link and art row that is
  // there when the column arrives must read NULL -- a DEFAULT is written into every existing row by ADD COLUMN, and each
  // would read as checked, never to be looked at. v0.55.6 boots on this schema and INSERTs without naming it: its rows
  // are unchecked too. Reintroduce `DEFAULT now()` on either column: the declared default reads now(), and "a v0.55.6
  // row reads as checked" fails.
  // The same block's #150 piece (the integration folded both lanes' into one): lib_series.info_read, the file a scan last
  // read a series' ComicInfo from, nullable with no default -- NULL is "read it at the next scan", which is what a series
  // v0.55.6 adds after a rollback must be. Reintroduce a default: "a v0.55.6 series reads as read" fails.
  const cols = await q<{ table_name: string; column_name: string; data_type: string; column_default: string | null; is_nullable: string }>(
    `SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('series_trackers', 'series_art', 'server_settings', 'lib_series')
        AND column_name IN ('checked_at', 'match_check_last_run', 'match_check_last_result', 'info_read')
      ORDER BY table_name, column_name`);
  assert.deepEqual(cols.map((c) => [c.table_name, c.column_name, c.data_type, c.column_default, c.is_nullable]), [
    ['lib_series', 'info_read', 'text', null, 'YES'],
    ['series_art', 'checked_at', 'timestamp with time zone', null, 'YES'],
    ['series_trackers', 'checked_at', 'timestamp with time zone', null, 'YES'],
    ['server_settings', 'match_check_last_result', 'jsonb', null, 'YES'],
    ['server_settings', 'match_check_last_run', 'timestamp with time zone', null, 'YES'],
  ], 'a v0.55.7 column is missing, required, or has a default');
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO lib_series (id, source, title, folder) VALUES ('t-match', 'test', 'T', 'T!match-m/T')`);
      // Exactly the INSERTs v0.55.6 makes: the backdrop's art row (routes/images.ts) and its link (lib/trackers.ts).
      await c.query(`INSERT INTO series_art (series_id, banner, cover) VALUES ('t-match', NULL, 'https://example.org/c.jpg')`);
      await c.query(`INSERT INTO series_trackers (series_id, provider, external_id, title, linked_by) VALUES ('t-match', 'anilist', '1', 'T', NULL)`);
      const { rows } = await c.query(`SELECT (SELECT checked_at FROM series_art WHERE series_id = 't-match') AS art,
                                             (SELECT checked_at FROM series_trackers WHERE series_id = 't-match') AS link,
                                             (SELECT info_read FROM lib_series WHERE id = 't-match') AS info`);
      assert.deepEqual([rows[0].art, rows[0].link], [null, null], 'a v0.55.6 row reads as checked');
      assert.equal(rows[0].info, null, 'a v0.55.6 series reads as read');
    } finally {
      await c.query('ROLLBACK');
    }
  });
});

test('migrate: v0.55.8 enables automatic AniList enrichment for existing and rollback-created libraries', { skip }, async () => {
  const cols = await q<{ data_type: string; column_default: string | null; is_nullable: string }>(
    `SELECT data_type, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'libraries' AND column_name = 'anilist_lookup'`);
  assert.deepEqual(cols.map((c) => [c.data_type, c.column_default, c.is_nullable]),
    [['boolean', 'true', 'NO']], 'the per-library AniList policy is not an additive compatible boolean');
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      // The INSERT an older binary makes after rollback omits the new column and must keep historical behaviour.
      await c.query(`INSERT INTO libraries (id, name, path) VALUES ('t-anilist-default','Old writer','T AniList Default')`);
      const { rows } = await c.query(`SELECT anilist_lookup FROM libraries WHERE id = 't-anilist-default'`);
      assert.equal(rows[0]?.anilist_lookup, true);
    } finally {
      await c.query('ROLLBACK');
    }
  });
});

test('migrate: v0.55.8 preserves the natural state underneath a blocked listing', { skip }, async () => {
  const id = 't-listing-natural';
  await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
  try {
    await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test',$1,'T!listing-natural')`, [id]);
    // Model the schema immediately before v0.55.8: the additive column is nullable and has no useful values yet.
    await q(`ALTER TABLE series_listing DROP CONSTRAINT IF EXISTS series_listing_unblocked_status_check`);
    await q(`ALTER TABLE series_listing ALTER COLUMN unblocked_status DROP NOT NULL`);
    await q(`ALTER TABLE series_listing ALTER COLUMN unblocked_status DROP DEFAULT`);
    for (const [number, status] of [[1, 'blocked'], [2, 'available'], [3, 'held'], [4, 'covered']] as const) {
      await q(`INSERT INTO series_listing
                 (series_id, number, source_id, chosen, status, copies, unblocked_status)
               VALUES ($1,$2,'test',$3::jsonb,$4,'[]'::jsonb,NULL)`,
        [id, number, JSON.stringify({ sourceId: `c-${number}`, source: 'test', number }), status]);
    }

    await migrate();
    const rows = await q<{ number: number; unblocked_status: string }>(
      `SELECT number, unblocked_status FROM series_listing WHERE series_id = $1 ORDER BY number`, [id]);
    assert.deepEqual(rows.map((r) => [Number(r.number), r.unblocked_status]),
      [[1, 'held'], [2, 'available'], [3, 'held'], [4, 'covered']],
      'legacy blocked rows must fail closed, while visible rows already state their natural status');
    const col = (await q<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'series_listing' AND column_name = 'unblocked_status'`))[0];
    assert.deepEqual([col?.column_default, col?.is_nullable], ["'available'::text", 'NO']);
    const check = (await q<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'series_listing'::regclass AND conname = 'series_listing_unblocked_status_check'`))[0]?.def;
    assert.match(check ?? '', /available.*held.*covered/, 'the natural state accepts anything outside its three values');

    // A rollback writer omits the new column. It must get the compatible available state, never fail its insert.
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies)
             VALUES ($1,5,'test',$2::jsonb,'available','[]'::jsonb)`,
      [id, JSON.stringify({ sourceId: 'c-5', source: 'test', number: 5 })]);
    assert.equal((await q<{ unblocked_status: string }>(
      'SELECT unblocked_status FROM series_listing WHERE series_id = $1 AND number = 5', [id]))[0]?.unblocked_status, 'available');
    await assert.rejects(
      q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies, unblocked_status)
         VALUES ($1,6,'test',$2::jsonb,'blocked','[]'::jsonb,'blocked')`,
      [id, JSON.stringify({ sourceId: 'c-6', source: 'test', number: 6 })]),
      /series_listing_unblocked_status_check/,
    );
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
    // If an assertion above interrupted the schema exercise, leave the shared test database usable.
    await migrate().catch(() => {});
  }
});

test('migrate: v0.55.8 distinguishes Rescan-missing legacy tombstones from proven deliberate deletion', { skip }, async () => {
  const ids = [
    't-prov-none', 't-prov-owned', 't-prov-chapter', 't-prov-chapter-stale', 't-prov-partial', 't-prov-series',
    't-prov-series-mismatch', 't-prov-series-stale', 't-prov-series-exact', 't-prov-rollback',
  ];
  const dl = process.env.DL_ROOT || '/library-dl';
  await q('DELETE FROM audit_log WHERE detail->>\'id\' = ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ids]).catch(() => {});
  try {
    for (const id of ids) {
      await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test',$1,$2)`, [id, `T!prov/${id}`]);
      await q(`INSERT INTO lib_books (id, series_id, source, file, root, pruned_at, pruned_reason)
               VALUES ($1,$2,'test',$3,$4,now(),'deleted')`, [`b-${id}`, id, `T!prov/${id}/1.cbz`, id === 't-prov-owned' ? dl : '/library']);
    }
    await q(`INSERT INTO audit_log (event, detail) VALUES
      ('series.chapters_delete', $1::jsonb),
      ('series.chapters_delete', $2::jsonb),
      ('series.delete_files', $3::jsonb),
      ('series.delete_files', $4::jsonb),
      ('series.delete_files', $5::jsonb)`, [
      JSON.stringify({ id: 't-prov-chapter', bookIds: ['b-t-prov-chapter'], applied: 1 }),
      JSON.stringify({ id: 't-prov-partial', bookIds: ['b-t-prov-partial', 'skipped-book'], applied: 1 }),
      JSON.stringify({ id: 't-prov-series', files: 1, bytes: 12 }),
      JSON.stringify({ id: 't-prov-series-mismatch', files: 2, bytes: 12 }),
      JSON.stringify({ id: 't-prov-series-exact', files: 0, bytes: 0, bookIds: ['b-t-prov-series-exact'], applied: 1 }),
    ]);
    await q(`INSERT INTO audit_log (at, event, detail)
             VALUES
               (now() - interval '10 minutes', 'series.delete_files', $1::jsonb),
               (now() - interval '10 minutes', 'series.chapters_delete', $2::jsonb)`, [
      JSON.stringify({ id: 't-prov-series-stale', files: 1, bytes: 12 }),
      JSON.stringify({ id: 't-prov-chapter-stale', bookIds: ['b-t-prov-chapter-stale'], applied: 1 }),
    ]);

    await migrate();
    const reason = async (id: string) => (await q<{ pruned_reason: string }>(
      'SELECT pruned_reason FROM lib_books WHERE id = $1', [`b-${id}`]))[0]?.pruned_reason;
    assert.equal(await reason('t-prov-none'), 'rescan_missing', 'an unowned ambiguous row stayed deliberately deleted');
    assert.equal(await reason('t-prov-owned'), 'deleted', 'an owned download tombstone was reclassified');
    assert.equal(await reason('t-prov-chapter'), 'deleted', 'an exact successful chapter-delete audit was ignored');
    assert.equal(await reason('t-prov-chapter-stale'), 'rescan_missing',
      'an old exact chapter-delete audit was allowed to bless a later ambiguous tombstone for the same stable id');
    assert.equal(await reason('t-prov-partial'), 'rescan_missing', 'a request audit was mistaken for proof its skipped book was deleted');
    assert.equal(await reason('t-prov-series'), 'deleted',
      'a contemporaneous legacy whole-series audit with the exact removed-file count was ignored');
    assert.equal(await reason('t-prov-series-mismatch'), 'rescan_missing',
      'a whole-series audit whose file count does not prove every contemporaneous tombstone was trusted');
    assert.equal(await reason('t-prov-series-stale'), 'rescan_missing',
      'an old whole-series audit was allowed to bless a later ambiguous tombstone');
    assert.equal(await reason('t-prov-series-exact'), 'deleted',
      'the exact affected-book proof written by the current Delete files route was ignored');

    // A rollback can create another legacy value after the first v0.55.8 boot. The next boot must repair it too,
    // rather than treating this as a once-only data migration whose stamp survived the rollback.
    await q(`UPDATE lib_books SET pruned_reason = 'deleted' WHERE id = 'b-t-prov-rollback'`);
    await migrate();
    assert.equal(await reason('t-prov-rollback'), 'rescan_missing');
  } finally {
    await q('DELETE FROM audit_log WHERE detail->>\'id\' = ANY($1)', [ids]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ids]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [ids]).catch(() => {});
  }
});
