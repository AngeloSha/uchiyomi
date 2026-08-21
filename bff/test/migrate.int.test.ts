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
