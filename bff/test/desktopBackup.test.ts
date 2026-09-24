// A desktop backup, end to end, without a database (switch ON).
//
// The shell ships its own pg_dump and says where it is (PG_DUMP_PATH); the password travels in the child's
// environment, never on its command line; the config folder is zipped with no `tar` involved; and when any of
// it goes wrong the message talks about Uchiyomi on this computer, not about uid 10002 and `docker run`.
// A stand-in pg_dump (a shell script) records exactly what it was given, so the test sees argv and env as
// the real binary would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const DATA = mkdtempSync(join(tmpdir(), 'uchi-deskbackup-'));
process.env.UCHIYOMI_DESKTOP = '1';
process.env.UCHIYOMI_DATA_DIR = DATA;
process.env.PORT = '43125';
process.env.DL_ROOT = join(DATA, 'Uchiyomi Library');
process.env.UCHIYOMI_DESKTOP_SECRET = 'b2'.repeat(32);
// A password IN the URL on purpose: the shell never sends one there, but if anything ever does, it must still
// not reach argv. Port 1 refuses at once, so the "stamp the result" queries fail fast and are swallowed.
process.env.DATABASE_URL = 'postgres://yomi:hunter2@127.0.0.1:1/yomi';
process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
for (const k of ['CONFIG_DIR', 'BACKUP_DIR', 'CACHE_DIR', 'LIBRARY_ROOT', 'PGPASSWORD']) delete process.env[k];

const RECORD = join(DATA, 'pg_dump-was-given.txt');
const FAKE = join(DATA, 'bin', 'pg_dump');
mkdirSync(join(DATA, 'bin'));
writeFileSync(FAKE, `#!/bin/sh
printf '%s\\n' "$@" > "${RECORD}"
printf 'PGPASSWORD=%s\\n' "$PGPASSWORD" >> "${RECORD}"
echo '-- a dump'
echo 'SELECT 1;'
`);
chmodSync(FAKE, 0o755);

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a backup folder the account cannot write names the folder, not uid 10002 or docker', { skip: isRoot && 'root can write anywhere' }, async () => {
  // Reintroduce by dropping the forDesktop around the EACCES message: this reads "uid 10002 ... docker run".
  const { runBackup } = await import('../src/lib/backup');
  const backups = join(DATA, 'backups');
  chmodSync(backups, 0o555);
  try {
    await assert.rejects(runBackup(), (e: Error) => {
      assert.match(e.message, /^Can't write to .*backups; check your account can write to it\.$/);
      assert.doesNotMatch(e.message, /uid|docker|chown/i);
      return true;
    });
  } finally {
    chmodSync(backups, 0o755);
  }
});

test('a missing bundled pg_dump says to reinstall, and leaves no half-made backup behind', async () => {
  // Reintroduce by dropping the forDesktop around the ENOENT message: "pg_dump not found in the image".
  const { runBackup } = await import('../src/lib/backup');
  process.env.PG_DUMP_PATH = join(DATA, 'bin', 'no-such-pg_dump');
  try {
    await assert.rejects(runBackup(), /^Error: The bundled database tools are missing; reinstall Uchiyomi\.$/);
  } finally {
    delete process.env.PG_DUMP_PATH;
  }
  assert.deepEqual(readdirSync(join(DATA, 'backups')), [], 'the failed run removed its folder');
});

test('a desktop backup runs the bundled pg_dump without the password on its command line, and zips the config', async () => {
  // Reintroduce by spawning `pg_dump` with env.DATABASE_URL on desktop too: the record shows `hunter2` in argv
  // (and the shell's pg_dump is not the one that ran). Or by keeping `tar` on desktop: no config.zip.
  const { runBackup } = await import('../src/lib/backup');
  writeFileSync(join(DATA, 'config', 'sites.json'), '[]');
  // One second after the failed run, so this run's timestamped folder cannot be the one that run removed.
  await new Promise((r) => setTimeout(r, 1100));
  process.env.PG_DUMP_PATH = FAKE;
  let r;
  try {
    r = await runBackup();
  } finally {
    delete process.env.PG_DUMP_PATH;
  }
  const given = readFileSync(RECORD, 'utf8').trim().split('\n');
  assert.deepEqual(given.slice(0, 4), ['--no-owner', '--no-acl', '--clean', '--if-exists']);
  assert.equal(given[4], 'postgres://yomi@127.0.0.1:1/yomi', 'the URL, without its password');
  assert.ok(!given.slice(0, -1).join(' ').includes('hunter2'), 'the password reached argv');
  assert.equal(given.at(-1), 'PGPASSWORD=hunter2', 'the password went through the environment instead');

  assert.deepEqual(readdirSync(r.dir).sort(), ['config.zip', 'db.sql.gz']);
  assert.match(gunzipSync(readFileSync(join(r.dir, 'db.sql.gz'))).toString(), /SELECT 1;/);
  assert.equal(r.configEmpty, false);
  assert.ok(!existsSync(join(r.dir, 'config.tar.gz')));
});
