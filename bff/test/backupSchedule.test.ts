// The desktop's backup: it catches up after a missed night, and it keeps the database password off argv.
// (Switch off in this process: every helper here takes the desktop decision as an argument, which is how the
// server's answer is proven unchanged beside the desktop's.)
//
// The server backs up at `backup_hour` every night and that is enough, because it is always on. A PC is off
// at three in the morning most nights, so a desktop install that only ever aimed at the hour would never
// back up at all -- the library's reading history and settings, the one irreplaceable part, unprotected for
// months with the Tasks tab saying "daily at 03:00".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 10:00 local on an ordinary day: the next 03:00 is seventeen hours away, far from any catch-up delay.
const NOW = new Date(2026, 8, 24, 10, 0, 0).getTime();

const load = async () => import('../src/lib/backup');

test('desktop: a last run more than a day old catches up a few minutes after start', async () => {
  // Reintroduce by returning msUntilHour unconditionally: a PC that is off at 03:00 never backs up.
  const { backupDelay, msUntilHour } = await load();
  const { DESKTOP_FLOORS } = await import('../src/lib/desktop');
  const d = backupDelay({ hour: 3, lastRun: NOW - 2 * DAY, lastAttempt: 0, now: NOW, desktop: true });
  assert.equal(d, DESKTOP_FLOORS.backupCatchUp);
  assert.ok(d < msUntilHour(3, new Date(NOW)), 'the catch-up is sooner than the hour, or it is not a catch-up');
});

test('desktop: a recent run waits for the hour, as the server does', async () => {
  const { backupDelay, msUntilHour } = await load();
  assert.equal(backupDelay({ hour: 3, lastRun: NOW - HOUR, lastAttempt: 0, now: NOW, desktop: true }), msUntilHour(3, new Date(NOW)));
  // Exactly a day is not "more than a day": last night's 03:00 run, seen at 03:00 today, is not missed.
  assert.equal(backupDelay({ hour: 3, lastRun: NOW - DAY, lastAttempt: 0, now: NOW, desktop: true }), msUntilHour(3, new Date(NOW)));
});

test('desktop: no backup on record at all catches up', async () => {
  // A fresh install's first backup should not wait for its first 3 a.m. with the machine on.
  const { backupDelay } = await load();
  const { DESKTOP_FLOORS } = await import('../src/lib/desktop');
  assert.equal(backupDelay({ hour: 3, lastRun: null, lastAttempt: 0, now: NOW, desktop: true }), DESKTOP_FLOORS.backupCatchUp);
});

test('desktop: an attempt this process made recently suppresses the catch-up, even with no stamp', async () => {
  // The database is the thing that is down: the run failed and could not stamp backup_last_run. Without the
  // in-memory attempt every re-arm (after each failed run, each wake) would try again five minutes later.
  // Reintroduce by dropping `o.lastAttempt` from the Math.max: this answers five minutes.
  const { backupDelay, msUntilHour } = await load();
  assert.equal(backupDelay({ hour: 3, lastRun: null, lastAttempt: NOW - 10 * 60 * 1000, now: NOW, desktop: true }), msUntilHour(3, new Date(NOW)));
  assert.equal(backupDelay({ hour: 3, lastRun: NOW - 3 * DAY, lastAttempt: NOW - 60 * 1000, now: NOW, desktop: true }), msUntilHour(3, new Date(NOW)));
});

test('the server ignores a month-old stamp and waits for its hour, exactly as before', async () => {
  // ⚠️ The server's half. Reintroduce by dropping the `o.desktop &&`: a server whose backups have been failing
  // (each failure stamps) is fine, but one restored from an old database would now run a backup at boot.
  const { backupDelay, msUntilHour } = await load();
  for (const lastRun of [NOW - 30 * DAY, null]) {
    assert.equal(backupDelay({ hour: 3, lastRun, lastAttempt: 0, now: NOW, desktop: false }), msUntilHour(3, new Date(NOW)));
  }
  assert.equal(backupDelay({ hour: 22, lastRun: NOW - 30 * DAY, lastAttempt: 0, now: NOW, desktop: false }), 12 * HOUR);
});

test('stampDelay: what is left of the interval since the stamp, never under the floor', async () => {
  // The desktop watchdog's first run (server.ts): the newest source_health.checked_at plus a day.
  const { stampDelay } = await load();
  const floor = 5 * 60 * 1000;
  assert.equal(stampDelay({ last: NOW - 2 * HOUR, interval: DAY, floor, now: NOW }), 22 * HOUR);
  assert.equal(stampDelay({ last: NOW - 25 * HOUR, interval: DAY, floor, now: NOW }), floor, 'overdue runs at the floor');
  assert.equal(stampDelay({ last: 0, interval: DAY, floor, now: NOW }), floor, 'never run runs at the floor');
  assert.equal(stampDelay({ last: NOW, interval: DAY, floor, now: NOW }), DAY);
});

test('the desktop dump keeps the password off the command line', async () => {
  // ⚠️ macOS `ps` shows every account's command lines. Reintroduce by passing the URL through unchanged in
  // desktopDumpCommand: the password is in the arguments.
  const { desktopDumpCommand } = await load();
  const base = ['--no-owner', '--no-acl', '--clean', '--if-exists'];
  const parent = { PATH: '/usr/bin', PG_DUMP_PATH: '/Apps/Uchiyomi.app/Contents/Resources/pg/bin/pg_dump' } as NodeJS.ProcessEnv;

  const c = desktopDumpCommand(base, 'postgres://yomi:s3cr%40t@127.0.0.1:54321/yomi', parent);
  assert.equal(c.bin, parent.PG_DUMP_PATH, 'the bundled pg_dump, not whatever is on PATH');
  assert.ok(!c.args.join(' ').includes('s3cr'), `the password reached argv: ${c.args.join(' ')}`);
  assert.equal(c.args.at(-1), 'postgres://yomi@127.0.0.1:54321/yomi');
  assert.deepEqual(c.args.slice(0, 4), base);
  assert.equal(c.env.PGPASSWORD, 's3cr@t', 'decoded, in the child environment');
  assert.equal(c.env.PATH, '/usr/bin', 'the rest of the environment is inherited');

  // The shell's own shape: no password in the URL, PGPASSWORD already set -- passed through as it is.
  const s = desktopDumpCommand(base, 'postgres://yomi@127.0.0.1:54321/yomi', { ...parent, PGPASSWORD: 'fromshell' });
  assert.equal(s.args.at(-1), 'postgres://yomi@127.0.0.1:54321/yomi');
  assert.equal(s.env.PGPASSWORD, 'fromshell');
  // No PG_DUMP_PATH: the one on PATH, as the server does.
  assert.equal(desktopDumpCommand(base, 'postgres://a@h/d', {}).bin, 'pg_dump');
  // Something `new URL` cannot read is left alone rather than mangled.
  assert.equal(desktopDumpCommand(base, 'not a url', {}).args.at(-1), 'not a url');
});

test('config.zip: every file, `/`-separated, names spelled exactly as on disk, and no .part left', async () => {
  // Reintroduce by building it with adm-zip's addLocalFolderAsync: it strips every non-ASCII character, so
  // `Jösé.txt` comes back as `Js.txt` and a restore puts it under the wrong name.
  const { zipConfig } = await load();
  const root = mkdtempSync(join(tmpdir(), 'uchiyomi-zipcfg-'));
  try {
    const cfg = join(root, 'config');
    mkdirSync(join(cfg, 'series-art', 'nested'), { recursive: true });
    writeFileSync(join(cfg, 'jwt.secret'), 'secret');
    writeFileSync(join(cfg, 'sites.json'), '[{"id":"x"}]');
    writeFileSync(join(cfg, 'series-art', 'abc-cover.webp'), Buffer.from([1, 2, 3]));
    writeFileSync(join(cfg, 'series-art', 'nested', 'Jösé 名前.txt'), 'unicode');
    const out = join(root, 'run');
    mkdirSync(out);
    await zipConfig(cfg, join(out, 'config.zip'));

    assert.deepEqual(readdirSync(out), ['config.zip'], 'the .part was renamed, not left beside it');
    const zip = new StreamZip.async({ file: join(out, 'config.zip') });
    try {
      const entries = await zip.entries();
      assert.deepEqual(Object.keys(entries).sort(), ['jwt.secret', 'series-art/abc-cover.webp', 'series-art/nested/Jösé 名前.txt', 'sites.json']);
      assert.equal(String(await zip.entryData('sites.json')), '[{"id":"x"}]');
      assert.deepEqual([...(await zip.entryData('series-art/abc-cover.webp'))], [1, 2, 3]);
    } finally {
      await zip.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config.zip: a failed archive leaves nothing that looks like one', async () => {
  const { zipConfig } = await load();
  const root = mkdtempSync(join(tmpdir(), 'uchiyomi-zipcfg-'));
  try {
    await assert.rejects(zipConfig(join(root, 'no-such-config'), join(root, 'config.zip')));
    assert.ok(!existsSync(join(root, 'config.zip')) && !existsSync(join(root, 'config.zip.part')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
