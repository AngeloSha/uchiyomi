// The nightly backup, and whether what it reports matches what it did.
//
// This file had no behavioural test at all. Its only coverage was four string greps in aioParity.test.ts,
// which assert that the text `spawn('pg_dump'`, `recordFailure` and `fs.rm(dir` still appear in the source
// -- and which pass unchanged with both bugs below still present. That is the shape of the problem: the
// thing that LOOKS like coverage sits exactly where coverage should be.
//
// The two bugs, both in reporting rather than in the backup itself:
//
//  1. `configEmpty` was computed, put on the returned BackupResult, and then dropped by BOTH consumers --
//     the row written to server_settings and the in-memory runtime store each kept only { bytes, ms }. So a
//     backup that had silently lost jwt.secret, sites.json and every series-art override was stored, and
//     displayed, as a clean run.
//
//  2. `dirSize(...).catch(() => 0)` meant a successful backup could report 0 bytes -- the identical signal
//     to the empty-archive bug this file was rewritten to prevent after the all-in-one image shipped two
//     releases writing 20-byte archives. `bytes` is the only health signal the admin panel has.
//
// Needs TEST_DATABASE_URL and a pg_dump at least as new as the server (GitHub's runner has one).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DSN = process.env.TEST_DATABASE_URL;

/**
 * pg_dump refuses to dump a server newer than itself, so a client older than the database is an environment
 * problem rather than a failing backup. Detected and skipped rather than reported as a fault, because a red
 * test that means "your container is out of date" trains people to ignore red tests.
 */
function pgDumpUsable(): string | false {
  const v = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) return 'pg_dump not on PATH';
  const client = Number(/(\d+)/.exec(v.stdout || '')?.[1]);
  if (!DSN) return false;
  const srv = spawnSync('psql', [DSN, '-tAc', 'SHOW server_version_num'], { encoding: 'utf8' });
  if (srv.status !== 0) return false; // let the DB-connection failure surface elsewhere
  const server = Math.floor(Number((srv.stdout || '').trim()) / 10000);
  if (client < server) return `pg_dump ${client} is older than the server (${server}); install a matching client`;
  return false;
}
const PG_PROBLEM = DSN ? pgDumpUsable() : false;

let root = '';
if (DSN && !PG_PROBLEM) {
  root = mkdtempSync(join(tmpdir(), 'yomi-backup-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.BACKUP_DIR = join(root, 'backups');
  process.env.CONFIG_DIR = join(root, 'config');
  process.env.LIBRARY_BACKEND = 'owned';
  mkdirSync(process.env.BACKUP_DIR, { recursive: true });
  mkdirSync(process.env.CONFIG_DIR, { recursive: true });
}
const skip = !DSN ? 'set TEST_DATABASE_URL to run' : PG_PROBLEM || false;

let runBackup: any, q: any;

before(async () => {
  if (skip) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ runBackup } = (await import('../src/lib/backup')) as any);
  await migrate();
});

after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

/** What the admin panel actually reads, as opposed to what runBackup happens to return. */
const persisted = async () => {
  // jsonb comes back already parsed from the driver; tolerate text too rather than assuming either.
  const v = (await q('SELECT backup_last_result FROM server_settings WHERE id = 1'))[0]?.backup_last_result;
  return typeof v === 'string' ? JSON.parse(v) : v;
};

test('a backup reports what it really captured', { skip }, async (t) => {
  await t.test('a run with a populated config dir is clean, and says so where it counts', async () => {
    writeFileSync(join(process.env.CONFIG_DIR!, 'sites.json'), '{"sites":[]}');
    const r = await runBackup();

    assert.equal(r.configEmpty, false, 'the config was captured');
    assert.ok(r.bytes > 0, 'a real dump has a size');
    assert.ok(existsSync(join(r.dir, 'db.sql.gz')), 'and the dump is on disk');
    // Written as .part and renamed once whole. Reintroduce by dumping straight to db.sql.gz: nothing here
    // changes, but a SIGKILL mid-dump then leaves a partial archive that ls and rotation both count as a run.
    assert.ok(!existsSync(join(r.dir, 'db.sql.gz.part')), 'and no half-written .part is left beside it');
    assert.ok(existsSync(join(r.dir, 'config.tar.gz')), 'so is the config archive');

    const p = await persisted();
    assert.equal(p.configEmpty, false, 'and the panel is told, rather than the flag being dropped here');
    assert.ok(p.bytes > 0);
  });

  await t.test('a run that captured NO config says so instead of reading as clean', async () => {
    rmSync(join(process.env.CONFIG_DIR!, 'sites.json'), { force: true });
    // Backup folders are stamped to the second, and the run above takes well under one -- without this the
    // second run lands in the SAME directory and inspects the first run's archive.
    await new Promise((r) => setTimeout(r, 1100));
    const r = await runBackup();

    assert.equal(r.configEmpty, true, 'nothing was there to capture');
    assert.ok(!existsSync(join(r.dir, 'config.tar.gz')), 'so no archive was written into this run\'s folder');

    const p = await persisted();
    assert.equal(p.configEmpty, true,
      'this is the assertion that matters: the flag has to SURVIVE to the thing that displays it');
  });

  await t.test('bytes is never silently zero on a run that worked', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // a folder of its own, for the same reason
    const r = await runBackup();
    assert.equal(r.sizeUnknown, false, 'the size was measurable');
    assert.notEqual(r.bytes, 0,
      'zero is the empty-archive failure signal; a working backup must never be able to emit it');
  });
});
