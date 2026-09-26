// The library walk (lib/library.ts findSeriesDirs) on the filesystems #109 came from.
//
// v0.48.0 made the scan survive a folder the DATABASE refused, and reported it. An Unraid install was still
// missing downloads: the walk can drop folders before the database ever sees them, and said nothing. Unraid's
// user shares are one FUSE mount over several disks, which report each disk's own inode numbers, so two
// unrelated series folders could share the dev:ino the walk used as its loop guard -- and the second one, with
// everything in it, was skipped on every scan. The same walk read a whole folder as empty when one entry in it
// could not be checked, and skipped a folder it could not read without a word.
//
// None of that can be made on a test machine's own disk, so the walk takes its filesystem as a parameter and
// these tests hand it one that behaves like those mounts. No database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WalkFs } from '../src/lib/library';

// library.ts imports db, which validates the environment at load. Nothing here opens a connection (the pool is
// lazy), but the URL has to parse -- the same arrangement as archiveFormats.test.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

let findSeriesDirs: typeof import('../src/lib/library').findSeriesDirs;
let dirKey: typeof import('../src/lib/library').dirKey;
let listDir: typeof import('../src/lib/library').listDir;
let nodeFs: WalkFs;

let root = '';
const at = (...p: string[]) => join(root, ...p);

before(async () => {
  ({ findSeriesDirs, dirKey, listDir, nodeFs } = await import('../src/lib/library'));
  root = mkdtempSync(join(tmpdir(), 'uchiyomi-walk-'));
  for (const s of ['Src/A', 'Src/B', 'Other/C']) {
    mkdirSync(at(s), { recursive: true });
    writeFileSync(at(s, 'Chapter 1.cbz'), 'x');
  }
});
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

type Over = { [K in keyof WalkFs]?: (p: string) => ReturnType<WalkFs[K]> | undefined };
/** The real filesystem, except where `over` answers for a path (an override that returns undefined passes). */
function fsWith(over: Over): WalkFs {
  return {
    stat: (p) => over.stat?.(p) ?? nodeFs.stat(p),
    readdirTyped: (p) => over.readdirTyped?.(p) ?? nodeFs.readdirTyped(p),
    readdirNames: (p) => over.readdirNames?.(p) ?? nodeFs.readdirNames(p),
    lstat: (p) => over.lstat?.(p) ?? nodeFs.lstat(p),
  };
}
const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
const series = async (fsx: WalkFs) => {
  const r = await findSeriesDirs(root, fsx, 'linux');
  return { ...r, folders: r.found.map((f) => f.folderRel).sort() };
};

test('the walk reads disk ids exactly: bigints, not numbers', async () => {
  // Reintroduce by going back to a plain `stat()`: ids above 2^53 round onto their neighbours.
  const st = await nodeFs.stat(root);
  assert.equal(typeof st.ino, 'bigint', 'nodeFs.stat must ask for bigints');
  assert.equal(await dirKey('/x', { dev: 3n, ino: 2n ** 60n + 1n }, 'linux'), '3:1152921504606846977');
});

test('two folders that report one disk id are both scanned (#109, Unraid user shares)', async () => {
  // Src/A and Src/B on two different disks of one share: same dev (the FUSE mount), same inode number.
  // Reintroduce by refusing every repeated id, as v0.48.1 did: Src/B -- and everything in it -- is missing.
  const same = { dev: 99n, ino: 42n };
  const r = await series(fsWith({ stat: (p) => (p === at('Src/A') || p === at('Src/B') ? Promise.resolve(same) : undefined) }));
  assert.deepEqual(r.folders, ['Other/C', 'Src/A', 'Src/B'], 'a folder that shares a disk id was dropped');
  assert.equal(r.sharedIds, 1, 'the shared id is counted, so a Health screenshot shows it');
  assert.deepEqual(r.issues, []);
});

test('ids above 2^53 that differ only in their low bits are two folders', async () => {
  // A disk number in the high bits puts every id past 2^53, where a JavaScript number rounds to multiples of 16:
  // folders created one after another (two Discover adds) would share a key. Reintroduce by `Number()`ing the
  // ids in dirKey: this counts a shared id that is not there.
  const big = (n: bigint) => Promise.resolve({ dev: 7n, ino: 2n ** 60n + n });
  const r = await series(fsWith({ stat: (p) => (p === at('Src/A') ? big(1n) : p === at('Src/B') ? big(2n) : undefined) }));
  assert.deepEqual(r.folders, ['Other/C', 'Src/A', 'Src/B']);
  assert.equal(r.sharedIds, 0, 'two different ids were read as one');
});

test('a folder with an ancestor\'s id but its own entries is a different folder', async () => {
  const rootId = await nodeFs.stat(root);
  const r = await series(fsWith({ stat: (p) => (p === at('Src/A') ? Promise.resolve(rootId) : undefined) }));
  assert.deepEqual(r.folders, ['Other/C', 'Src/A', 'Src/B'], 'an id collision with the root was taken for a loop');
  assert.equal(r.sharedIds, 1);
});

test('a real loop -- the root mounted again inside itself -- is still refused, and said', async () => {
  // A walk that never follows symlinks can only loop through a mount: the same directory, so the same id AND the
  // same entries. Reintroduce by dropping the guard: nothing refuses it, and nothing says so.
  mkdirSync(at('Src/Loop'), { recursive: true });
  try {
    const rootId = await nodeFs.stat(root);
    const r = await series(fsWith({
      stat: (p) => (p === at('Src/Loop') ? Promise.resolve(rootId) : undefined),
      readdirTyped: (p) => (p === at('Src/Loop') ? nodeFs.readdirTyped(root) : undefined),
    }));
    assert.deepEqual(r.folders, ['Other/C', 'Src/A', 'Src/B'], 'the loop was walked into');
    assert.deepEqual(r.issues.map((i) => [i.folder, i.reason]), [['Src/Loop', 'loop']]);
  } finally {
    rmSync(at('Src/Loop'), { recursive: true, force: true });
  }
});

test('a listing that fails on one entry still lists the rest, and names the entry', async () => {
  // A filesystem that reports no entry types makes Node check every entry itself, and the first one it cannot
  // check fails the whole listing: a name that is not valid UTF-8 can never be opened. Reintroduce by returning
  // [] when the typed listing fails (every caller's old `.catch(() => [])`): Src/A and Src/B are missing.
  const r = await series(fsWith({
    readdirTyped: (p) => (p === at('Src') ? fail('ENOENT') : undefined),
    readdirNames: (p) => (p === at('Src') ? nodeFs.readdirNames(p).then((n) => [...n, 'bad�name', 'gone.tmp']) : undefined),
  }));
  assert.deepEqual(r.folders, ['Other/C', 'Src/A', 'Src/B'], 'one bad entry emptied its folder');
  // The undecodable name is named; the plain one that vanished was a temporary file being renamed, not a finding.
  assert.equal(r.issues.length, 1, JSON.stringify(r.issues));
  assert.equal(r.issues[0].folder, 'Src');
  assert.equal(r.issues[0].reason, 'unchecked');
  assert.match(r.issues[0].detail, /1 entry could not be checked: "bad�name"/);
});

test('a folder that cannot be read is named, not skipped in silence', async () => {
  // Reintroduce by returning without an issue on a failed listing: the walk reports nothing and Src/B is gone.
  const r = await series(fsWith({
    readdirTyped: (p) => (p === at('Src/B') ? fail('EACCES') : undefined),
    readdirNames: (p) => (p === at('Src/B') ? fail('EACCES') : undefined),
  }));
  assert.deepEqual(r.folders, ['Other/C', 'Src/A']);
  assert.deepEqual(r.issues.map((i) => [i.folder, i.reason, i.detail]), [['Src/B', 'unreadable', 'EACCES']]);
});

test('listDir: a typed listing that works is used as it is; a folder that is gone is an error, not a finding', async () => {
  const l = await listDir(at('Src'));
  assert.deepEqual(l.entries.map((e) => [e.name, e.kind]).sort(), [['A', 'dir'], ['B', 'dir']]);
  assert.equal(l.error, undefined);
  assert.equal((await listDir(at('nope'))).error, 'ENOENT');
  const r = await findSeriesDirs(at('nope'), nodeFs, 'linux');
  assert.deepEqual(r, { found: [], issues: [], sharedIds: 0 }, 'a root that is not there (not mounted) is not a finding');
});
