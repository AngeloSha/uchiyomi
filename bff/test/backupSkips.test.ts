// #199: a backup folder inside the config folder made every backup carry every earlier one.
//
// Wolf92s mapped the backups into their appdata folder. The server's config archive is `tar` over CONFIG_DIR, and the
// backup folder sat inside it, so each night's config.tar.gz held every earlier run -- whose own archives held the runs
// before them -- and the folder grew exponentially however few runs were kept. Inside the container the two folders
// never look alike (/backups and /config/backups are two mounts of one host folder), and an inode cannot be trusted to
// say so on Unraid, so the run finds ITSELF: a file with a random name in its own folder, looked for under CONFIG_DIR
// (lib/backup.ts backupSkips). The desktop's zip is desktopBackup.test.ts.
//
// No database: pg_dump is a stand-in first on PATH, and the settings query fails at once (port 1) and reads as the
// defaults. `tar` is the system's (GNU on CI); BusyBox's, in the all-in-one image, was run against the same arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
delete process.env.UCHIYOMI_DESKTOP;

const ROOT = mkdtempSync(join(tmpdir(), 'uchi-backupskips-'));
const BIN = join(ROOT, 'bin');
mkdirSync(BIN);
writeFileSync(join(BIN, 'pg_dump'), '#!/bin/sh\necho "-- a dump"\necho "SELECT 1;"\n');
chmodSync(join(BIN, 'pg_dump'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const RUN = /^\d{8}-\d{6}$/;
const MARKER = '.uchiyomi-run-0123456789abcdef';
const nextSecond = () => new Promise((r) => setTimeout(r, 1100)); // run folders are stamped to the second

const load = async () => ({ ...(await import('../src/lib/backup')), env: (await import('../src/env')).env });
const listTar = (file: string): string[] => {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
};
/** A config folder with what a real one holds: a secret, the custom sites, an art override. */
const configAt = (dir: string) => {
  mkdirSync(join(dir, 'series-art'), { recursive: true });
  writeFileSync(join(dir, 'jwt.secret'), 'x'.repeat(48));
  writeFileSync(join(dir, 'sites.json'), '{"sites":[]}');
  writeFileSync(join(dir, 'series-art', 'abc.jpg'), 'jpg');
  return dir;
};
/** Two runs a second apart against these folders: the second's archive is where an earlier run would show up. */
async function twoRuns(config: string, backups: string) {
  const { runBackup, env } = await load();
  const was = { c: env.CONFIG_DIR, b: env.BACKUP_DIR };
  env.CONFIG_DIR = config;
  env.BACKUP_DIR = backups;
  try {
    const first = await runBackup();
    await nextSecond();
    const second = await runBackup();
    return { first, second };
  } finally {
    env.CONFIG_DIR = was.c;
    env.BACKUP_DIR = was.b;
  }
}

test('a backup folder inside the config folder is never archived (the #199 layout)', async () => {
  // Reintroduce by returning [] from backupSkips, or by dropping the excludes from configTarArgs: the second run's
  // archive holds ./backups/<the first run>/db.sql.gz, and every later one holds all of them.
  const config = configAt(join(ROOT, 'nested', 'config'));
  const { first, second } = await twoRuns(config, join(config, 'backups'));
  for (const r of [first, second]) {
    const names = listTar(join(r.dir, 'config.tar.gz'));
    assert.ok(names.includes('./sites.json') && names.includes('./series-art/abc.jpg'), `the config itself is archived: ${names.join(' ')}`);
    assert.deepEqual(names.filter((n) => n.startsWith('./backups')), [], 'the backup folder went into the config archive');
    assert.equal(r.configEmpty, false);
    // The marker is the run's own business: it is gone when the run is done, and never counted as a run's content.
    assert.deepEqual(readdirSync(r.dir).sort(), ['config.tar.gz', 'db.sql.gz'], 'something besides the backup was left in the run folder');
  }
  assert.ok(existsSync(join(first.dir, 'db.sql.gz')), 'the first run is still there to have been left out');
});

test('one folder for both: the config is archived and the runs are not', async () => {
  // /backups and /config mapped to the same host folder. The folder cannot be left out whole -- it IS the config -- so
  // only the run folders are. Reintroduce by returning [] for CONFIG_DIR itself: the earlier run is inside the archive.
  const both = configAt(join(ROOT, 'same'));
  const { second } = await twoRuns(both, both);
  const names = listTar(join(second.dir, 'config.tar.gz'));
  assert.ok(names.includes('./jwt.secret') && names.includes('./series-art/abc.jpg'), `the config itself is archived: ${names.join(' ')}`);
  const runs = names.filter((n) => RUN.test(n.replace(/^\.\//, '').split('/')[0]));
  assert.deepEqual(runs, [], 'a run folder went into the config archive');
});

test('apart, as installed, nothing is left out', async () => {
  // The Unraid template and the compose file keep the two side by side: the archive is exactly what it always was.
  const config = configAt(join(ROOT, 'apart', 'config'));
  const { second } = await twoRuns(config, join(ROOT, 'apart', 'backups'));
  assert.deepEqual(listTar(join(second.dir, 'config.tar.gz')).sort(),
    ['./', './jwt.secret', './series-art/', './series-art/abc.jpg', './sites.json']);
});

test('backupSkips finds the backup folder only where this run can be reached', async () => {
  const { backupSkips } = await load();
  const config = configAt(join(ROOT, 'finder', 'config'));
  const backups = join(config, 'data', 'my-backups');
  const run = join(backups, '20261013-030000');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, MARKER), '');
  // Deeper than the top, and found as one path relative to the config folder.
  assert.deepEqual(await backupSkips(config, run, MARKER), ['data/my-backups']);

  // A folder that happens to hold a run of the same name, without this run's marker: an old copy, not the backup folder.
  mkdirSync(join(config, 'old-copy', '20261013-030000'), { recursive: true });
  // A link to the backup folder: tar keeps the link and never follows it, so there is nothing under it to leave out.
  symlinkSync(backups, join(config, 'link-to-backups'));
  assert.deepEqual(await backupSkips(config, run, MARKER), ['data/my-backups'], 'a decoy or a link was taken for the backup folder');

  // Elsewhere entirely, as another run (every run's marker is its own): nothing, though the planted one above is still there.
  const outside = join(ROOT, 'finder', 'backups', '20261013-030000');
  const another = '.uchiyomi-run-fedcba9876543210';
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, another), '');
  assert.deepEqual(await backupSkips(config, outside, another), []);
});

test('a folder the walk cannot read is passed over, not a failed backup', { skip: isRoot && 'root reads anything' }, async () => {
  const { backupSkips } = await load();
  const config = configAt(join(ROOT, 'locked', 'config'));
  const run = join(config, 'backups', '20261013-030000');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, MARKER), '');
  mkdirSync(join(config, 'private'));
  chmodSync(join(config, 'private'), 0o000);
  try {
    assert.deepEqual(await backupSkips(config, run, MARKER), ['backups']);
  } finally {
    chmodSync(join(config, 'private'), 0o755);
  }
});

test('a folder name is matched as written, not as a pattern', async () => {
  // Reintroduce by dropping globLiteral: `we[ir]d*?` is a glob that never matches its own name, so that folder would
  // stay in the archive. And the anchoring: `./backups` must not take `series-art/backups` or `backupsX` with it.
  const { configTarArgs, globLiteral } = await load();
  assert.equal(globLiteral('we[ir]d*?'), 'we\\[ir\\]d\\*\\?');
  const dir = join(ROOT, 'literal');
  for (const d of ['we[ir]d*?', 'we', 'backups/20261012-030000', 'backupsX', 'series-art/backups']) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, 'f'), d);
  }
  const out = join(ROOT, 'literal.tar.gz');
  const r = spawnSync('tar', configTarArgs(out, dir, ['we[ir]d*?', 'backups']), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listTar(out).filter((n) => n.endsWith('/f')).sort(),
    ['./backupsX/f', './series-art/backups/f', './we/f']);
});
