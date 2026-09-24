// "Restore a backup": the order of the steps, what survives a failure, and archives that try to climb out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restore, inspectBackup, backupDate, unpackConfig } = require('../src/restore.js');
const archive = require('../src/archive.js');
const quiet = { info() {}, warn() {}, error() {} };

/** One ustar entry (+ data) and the two zero blocks, gzipped: enough to build a hostile archive by hand. */
function tarGz(entries) {
  const blocks = [];
  for (const { name, data = '', type = '0' } of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(Buffer.byteLength(data).toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write(type, 156);
    h.write('ustar\0', 257); h.write('00', 263);
    h.fill(' ', 148, 156);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h);
    const d = Buffer.from(data);
    blocks.push(Buffer.concat([d, Buffer.alloc((512 - (d.length % 512)) % 512)]));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-restore-'));
  const configDir = path.join(tmp, 'data', 'config');
  const backupsDir = path.join(tmp, 'data', 'backups');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'jwt.secret'), 'OLD');
  const bdir = path.join(backupsDir, '20260920-031500');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'db.sql.gz'), zlib.gzipSync('-- dump'));
  const cfgSrc = path.join(tmp, 'cfg');
  fs.mkdirSync(path.join(cfgSrc, 'series-art'), { recursive: true });
  fs.writeFileSync(path.join(cfgSrc, 'jwt.secret'), 'NEW');
  fs.writeFileSync(path.join(cfgSrc, 'series-art', 'a.webp'), 'img');
  return { tmp, configDir, backupsDir, bdir, cfgSrc };
}

function fakePg(calls, { fail = false } = {}) {
  return {
    dump: async (file, o) => { calls.push(`dump${o?.clean ? ':clean' : ''}`); fs.writeFileSync(file, '-- current'); },
    restoreSqlGz: async (f) => { calls.push(`psql:${path.basename(f)}`); if (fail) throw new Error('psql failed (exit 3); the database was left as it was.'); },
  };
}

test('order: safety copy (dump --clean + config.zip) -> stop -> psql -> config swap -> start', async () => {
  // Reintroduce by starting the psql before stopBff(), or by dropping the safety copy: the call order differs.
  const s = setup();
  try {
    await archive.writeZip(s.cfgSrc, path.join(s.bdir, 'config.zip'));
    const b = inspectBackup(path.join(s.bdir, 'db.sql.gz'));
    assert.equal(b.config, path.join(s.bdir, 'config.zip'));
    assert.equal(b.date.toISOString(), '2026-09-20T03:15:00.000Z');
    const calls = [];
    const r = await restore({ ...b, configDir: s.configDir, backupsDir: s.backupsDir, pg: fakePg(calls), stopBff: async () => calls.push('stop'), startBff: async () => calls.push('start'), log: quiet });
    assert.deepEqual(calls, ['dump:clean', 'stop', 'psql:db.sql.gz', 'start']);
    assert.equal(r.configRestored, true);
    assert.equal(fs.readFileSync(path.join(s.configDir, 'jwt.secret'), 'utf8'), 'NEW');
    assert.equal(fs.readFileSync(path.join(s.configDir, 'series-art', 'a.webp'), 'utf8'), 'img');
    // The safety copy: restorable the same way, and NOT named like the bff's rotated backups.
    assert.match(path.basename(r.safety), /^before-restore-\d{8}-\d{6}$/);
    assert.doesNotMatch(path.basename(r.safety), /^\d{8}-\d{6}$/);
    assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(r.safety, 'db.sql.gz'))).toString(), '-- current');
    const old = path.join(s.tmp, 'old');
    await archive.extractZip(path.join(r.safety, 'config.zip'), old);
    assert.equal(fs.readFileSync(path.join(old, 'jwt.secret'), 'utf8'), 'OLD');
    assert.deepEqual(fs.readdirSync(path.dirname(s.configDir)).filter((x) => x.startsWith('config')), ['config'], 'no .old / .restoring folders left');
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('a failed psql leaves config/ untouched and still starts the server again', async () => {
  // Reintroduce by starting the bff only after a success: a failed restore leaves the app without its server.
  const s = setup();
  try {
    await archive.writeZip(s.cfgSrc, path.join(s.bdir, 'config.zip'));
    const calls = [];
    await assert.rejects(() => restore({ ...inspectBackup(path.join(s.bdir, 'db.sql.gz')), configDir: s.configDir, backupsDir: s.backupsDir, pg: fakePg(calls, { fail: true }), stopBff: async () => calls.push('stop'), startBff: async () => calls.push('start'), log: quiet }), /left as it was/);
    assert.deepEqual(calls, ['dump:clean', 'stop', 'psql:db.sql.gz', 'start']);
    assert.equal(fs.readFileSync(path.join(s.configDir, 'jwt.secret'), 'utf8'), 'OLD');
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a server's backup (config.tar.gz beside the dump) is refused, not restored", { skip: process.platform === 'win32' }, async () => {
  // Moving a library from a Docker server is not in v1. Restoring one anyway replaced this library with one whose
  // series all point at the server's folders (/library-dl): every series missing, after a restore that said it
  // worked. Reintroduce by dropping the SERVER_BACKUP refusal from inspectBackup: this one resolves.
  const s = setup();
  try {
    execFileSync('tar', ['-czf', path.join(s.bdir, 'config.tar.gz'), '-C', s.cfgSrc, '.']);
    assert.throws(() => inspectBackup(path.join(s.bdir, 'db.sql.gz')), (e) => e.code === 'SERVER_BACKUP' && /server backups/.test(e.message));
    assert.equal(fs.readFileSync(path.join(s.configDir, 'jwt.secret'), 'utf8'), 'OLD', 'the settings changed');
    // A folder with the desktop's own config.zip beside it is a desktop backup, whatever else is there.
    fs.copyFileSync(path.join(s.bdir, 'config.tar.gz'), path.join(s.bdir, 'config.zip'));
    assert.equal(inspectBackup(path.join(s.bdir, 'db.sql.gz')).config, path.join(s.bdir, 'config.zip'));
    // The tar reader itself still takes a real `tar -C /config .` archive (its entries are ./name).
    await unpackConfig(path.join(s.bdir, 'config.tar.gz'), path.join(s.tmp, 'unpacked'));
    assert.equal(fs.readFileSync(path.join(s.tmp, 'unpacked', 'series-art', 'a.webp'), 'utf8'), 'img');
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('archives that climb out of the config folder, or carry links, are refused', async () => {
  // Reintroduce by returning path.join(dest, name) in unpackConfig instead of safeJoin: ../escaped.txt lands.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-restore-'));
  try {
    const evil = path.join(tmp, 'evil.tar.gz');
    fs.writeFileSync(evil, tarGz([{ name: '../escaped.txt', data: 'x' }]));
    await assert.rejects(() => unpackConfig(evil, path.join(tmp, 'dest')), /unsafe archive path/);
    assert.equal(fs.existsSync(path.join(tmp, 'escaped.txt')), false);
    const abs = path.join(tmp, 'abs.tar.gz');
    fs.writeFileSync(abs, tarGz([{ name: '/etc/uchiyomi-test', data: 'x' }]));
    await assert.rejects(() => unpackConfig(abs, path.join(tmp, 'dest2')), /unsafe archive path/);
    const link = path.join(tmp, 'link.tar.gz');
    fs.writeFileSync(link, tarGz([{ name: 'l', type: '2' }, { name: 'ok.txt', data: 'fine' }]));
    await unpackConfig(link, path.join(tmp, 'dest3'));
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'dest3')), ['ok.txt'], 'the link is skipped, the file lands');
    assert.throws(() => inspectBackup(path.join(tmp, 'notes.txt')), /db\.sql\.gz/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a backup outside the bff naming is dated by the file', () => {
  // Reintroduce by dating every backup `now`: a hand-picked old dump claims to be from today.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-restore-'));
  try {
    const f = path.join(tmp, 'db.sql.gz');
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, new Date('2026-01-02T03:04:05Z'), new Date('2026-01-02T03:04:05Z'));
    assert.equal(backupDate(f).toISOString(), '2026-01-02T03:04:05.000Z');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Admin -> Tasks asks once: the shell skips its own question when the web has asked, and the tray still asks', () => {
  // The web's danger dialog, then the file picker, then the shell's own "Restore the backup from …?" was two
  // confirmations for one click. Reintroduce by calling restoreBackupFlow() from the bridge again: the first
  // match fails; by dropping the `if (!fromWeb)` around the question: the second one does.
  const main = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /restoreBackup: \(\) => restoreBackupFlow\(\{ fromWeb: true \}\),/, 'the bridge makes the shell ask again');
  const flow = main.slice(main.indexOf('async function restoreBackupFlow('), main.indexOf('// ---------------------------------------------------------------- quit + updates'));
  assert.match(flow, /if \(!fromWeb\) \{\s*const ask = await dialog\.showMessageBox/, 'the shell asks even when the web already did');
  // The tray keeps its question, and a refused server backup is said in the shell's language on both paths.
  assert.match(main, /restoreBackupFlow\(\)\.catch\(/, 'the tray no longer goes through the asking path');
  assert.match(flow, /code === 'SERVER_BACKUP' \? t\('restore\.server'\)/);
});
