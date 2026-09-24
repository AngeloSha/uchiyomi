// The dependency-free archive code the app unpacks downloads and backups with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const archive = require('../src/archive.js');

test('safeJoin refuses every way out of the destination', () => {
  // Reintroduce by dropping the drive-letter test in safeJoin: `C:/Windows/x` is accepted.
  const d = path.resolve('/tmp/dest');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', 'c:x', '..']) assert.throws(() => archive.safeJoin(d, bad), /unsafe/, bad);
  assert.equal(archive.safeJoin(d, './a/b.txt'), path.join(d, 'a', 'b.txt'));
  assert.equal(archive.safeJoin(d, 'a/./b/../c.txt'), path.join(d, 'a', 'c.txt'));
});

test('writeZip -> extractZip round-trips bytes and the exec bit; a symlink entry is refused unless asked for', { skip: process.platform === 'win32' }, async () => {
  // Reintroduce by removing the allowSymlinks check in extractZip: the hand-made link entry is created.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-zip-'));
  try {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(path.join(src, 'jre', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(src, 'jre', 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(src, 'engine.json'), '{"a":1}');
    const zip = path.join(tmp, 'p.zip');
    await archive.writeZip(src, zip);
    const out = path.join(tmp, 'out');
    const r = await archive.extractZip(zip, out);
    assert.equal(r.files, 2);
    assert.equal(fs.statSync(path.join(out, 'jre', 'bin', 'java')).mode & 0o111, 0o111);
    assert.equal(fs.readFileSync(path.join(out, 'engine.json'), 'utf8'), '{"a":1}');
    // A zip with one symlink entry (unix mode 0120777), written by hand.
    const name = Buffer.from('evil');
    const target = Buffer.from('/etc');
    const crc = (await import('node:zlib')).crc32(target) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(target.length, 18); lh.writeUInt32LE(target.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(target.length, 20); ch.writeUInt32LE(target.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(((0o120777 << 16) >>> 0), 38); ch.writeUInt32LE(0, 42);
    const cdStart = lh.length + name.length + target.length;
    const cd = Buffer.concat([ch, name]);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdStart, 16);
    const evil = path.join(tmp, 'evil.zip');
    fs.writeFileSync(evil, Buffer.concat([lh, name, target, cd, eocd]));
    await assert.rejects(() => archive.extractZip(evil, path.join(tmp, 'e1')), /symlink in archive refused/);
    assert.equal(fs.existsSync(path.join(tmp, 'e1', 'evil')), false);
    await archive.extractZip(evil, path.join(tmp, 'e2'), (n) => n, { allowSymlinks: true });
    assert.equal(fs.readlinkSync(path.join(tmp, 'e2', 'evil')), '/etc');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
