// Files are either entirely there or not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, reapStaleTemp, TMP_RE } from '../src/lib/fsAtomic';

const ROOT = mkdtempSync(join(tmpdir(), 'yomi-atomic-'));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('a successful write leaves the file and nothing else', async () => {
  await writeAtomic(join(ROOT, 'a.cbz'), Buffer.from('hello'));
  assert.deepEqual(readdirSync(ROOT).sort(), ['a.cbz']);
  assert.equal(readFileSync(join(ROOT, 'a.cbz'), 'utf8'), 'hello');
});

test('a write that cannot finish leaves no file under the final name', async () => {
  // A real reason for the rename to fail, not a patched function (module exports are getters under this
  // build, so patching silently does nothing -- see uchiyomi-route-testing-gap): the final name is already a
  // non-empty directory, which rename(2) refuses with ENOTEMPTY. The temp was written; the rename was not.
  const dir = join(ROOT, 'gone');
  mkdirSync(dir);
  const p = join(dir, 'b.cbz');
  mkdirSync(p);
  writeFileSync(join(p, 'occupant'), 'x');
  await assert.rejects(writeAtomic(p, 'x'), 'the write must surface the failure rather than pretend');
  const left = readdirSync(dir);
  assert.ok(statSync(p).isDirectory(), 'nothing was written under the final name');
  assert.ok(left.some((n) => TMP_RE.test(n)), 'the abandoned temp is what remains, and it is recognisable');
  assert.equal(await reapStaleTemp(ROOT), 1, 'and the boot-time reaper removes exactly it');
  assert.ok(!readdirSync(dir).some((n) => TMP_RE.test(n)));
});

test('the reaper ignores real files', async () => {
  writeFileSync(join(ROOT, 'keep.cbz'), 'k');
  writeFileSync(join(ROOT, 'keep.tmp'), 'k'); // not our suffix shape
  assert.equal(await reapStaleTemp(ROOT), 0);
});

/**
 * Who has to use it. The downloader writes the permanent library; if it goes back to a plain writeFile the
 * guarantee above protects nothing that matters. Pinned on the source because "kill the container
 * mid-write" is not something a unit test can do.
 */
test('the downloader writes chapters atomically', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'downloader.ts'), 'utf8');
  assert.match(src, /writeAtomic\(abs, zip\.toBuffer\(\)\)/, 'the final chapter write goes through writeAtomic');
  assert.doesNotMatch(src, /writeFile\(abs/, 'and never straight onto the final name');
});
