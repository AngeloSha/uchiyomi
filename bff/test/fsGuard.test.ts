// Path containment and the writability preflight.
//
// There was no path-containment check anywhere in this codebase before file operations existed, and
// sanitize() in the downloader strips path separators but lets `..` survive as a whole segment --
// sanitize.test.ts records that as an asserted behaviour. So containment is the backstop that has to hold
// even when a caller passes something it should not have.
//
// Pure unit tests: no database, no environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { containedPath, writePreflight, allWritable } from '../src/lib/fsGuard';

const ROOT = '/library';

test('an ordinary relative path resolves under the root', () => {
  assert.equal(containedPath(ROOT, 'Manga/Berserk'), '/library/Manga/Berserk');
  assert.equal(containedPath(ROOT, 'a/b/c.cbz'), '/library/a/b/c.cbz');
});

test('the root itself is contained', () => {
  assert.equal(containedPath(ROOT, '.'), '/library');
});

test('THE POINT: .. cannot escape', () => {
  assert.equal(containedPath(ROOT, '../etc/passwd'), null);
  assert.equal(containedPath(ROOT, 'Manga/../../etc'), null);
  assert.equal(containedPath(ROOT, '../../..'), null);
});

test('.. that stays inside is allowed, because it resolves inside', () => {
  assert.equal(containedPath(ROOT, 'Manga/Berserk/../Bleach'), '/library/Manga/Bleach');
});

test('an absolute path is refused outright', () => {
  assert.equal(containedPath(ROOT, '/etc/passwd'), null);
  assert.equal(containedPath(ROOT, '/library/Manga'), null, 'even one that happens to be inside');
});

test('empty and null bytes are refused', () => {
  assert.equal(containedPath(ROOT, ''), null);
  assert.equal(containedPath(ROOT, 'a\0b'), null);
});

test('a sibling directory sharing a name prefix is not "inside"', () => {
  // /library-dl must never be treated as inside /library just because the string starts the same way.
  assert.equal(containedPath('/library', '../library-dl/x'), null);
});

test('what sanitize() lets through is caught here', () => {
  // sanitize.test.ts asserts that '..' survives sanitisation as a whole segment. That is safe today only
  // because of where the result is joined; containment is what makes it safe on purpose.
  assert.equal(containedPath(ROOT, join('..', 'escaped')), null);
});

test('writePreflight succeeds on a directory we own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uchiyomi-fsg-'));
  try {
    const r = await writePreflight(dir);
    assert.equal(r.ok, true, 'a temp dir we just created should be writable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writePreflight reports a missing directory rather than throwing', async () => {
  const r = await writePreflight(join(tmpdir(), `uchiyomi-does-not-exist-${process.pid}`));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /does not exist|cannot be read/);
});

test('writePreflight names PUID as the fix, not "chown your library"', async () => {
  // The wording matters: the first suggestion must be the one that leaves the user's files alone.
  const root = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  if (root) return; // running as root defeats a permissions test

  const dir = await mkdtemp(join(tmpdir(), 'uchiyomi-fsg-ro-'));
  const inner = join(dir, 'locked');
  await mkdir(inner);
  await chmod(inner, 0o555);
  try {
    const r = await writePreflight(inner);
    assert.equal(r.ok, false, 'a 0555 directory should not be writable');
    if (!r.ok) {
      assert.match(r.fix, /PUID/, 'the fix should lead with PUID');
      assert.match(r.reason, /owned by uid \d+/, 'the reason should name the actual owner');
    }
  } finally {
    await chmod(inner, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('allWritable refuses if ANY root fails, because a partial rename is the bad outcome', async () => {
  const root = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  if (root) return;

  const good = await mkdtemp(join(tmpdir(), 'uchiyomi-fsg-ok-'));
  const dir = await mkdtemp(join(tmpdir(), 'uchiyomi-fsg-mixed-'));
  const bad = join(dir, 'locked');
  await mkdir(bad);
  await chmod(bad, 0o555);
  try {
    assert.equal((await allWritable([good])).ok, true);
    assert.equal((await allWritable([good, bad])).ok, false, 'one unwritable root must fail the whole set');
  } finally {
    await chmod(bad, 0o755).catch(() => {});
    await rm(good, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('a symlink pointing outside is caught once resolved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uchiyomi-fsg-link-'));
  try {
    await symlink('/etc', join(dir, 'out'), 'dir').catch(() => {});
    // containedPath is lexical, which is why the write path must ALSO realpath before acting. This pins the
    // lexical half: the string form does not escape, so the check cannot be relied on alone for symlinks.
    assert.equal(containedPath(dir, 'out/passwd'), resolve(dir, 'out/passwd'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
