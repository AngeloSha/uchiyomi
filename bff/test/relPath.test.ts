// Windows paths, proven on Linux (switch off: these are the rules for every platform, not desktop wording).
//
// The database stores relative paths with `/` and its SQL builds prefixes with `/` (`folder || '/%'`,
// `s.folder || '/Chapter '`). On Windows `path.join` and `path.relative` answer with `\`, so before lib/relPath.ts
// a chapter downloaded there was stored in a shape the nightly repair, the Health "Fix" chip and "Fetch again"
// never matched, and a refetch that was put back after a crash stayed marked deleted. None of it can be seen by
// running on Linux with the platform's own path module -- `path.join` IS `path.posix.join` here -- so these
// tests hand the helpers `path.win32` (and a platform string) the way Windows would.
//
// The other half is just as important: on Linux a backslash is an ordinary filename character, and the server
// build must not change by one byte. Every Windows rule below has a POSIX twin asserting nothing moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

import { toStoredRel, relFromAbs, joinRel, dirnameRel } from '../src/lib/relPath';
import { renameRetry } from '../src/lib/fsAtomic';

const W = path.win32;

test('toStoredRel: a Windows relative path is stored with `/`', () => {
  // Reintroduce by returning `p` unchanged: the stored path keeps its backslashes.
  assert.equal(toStoredRel('Src\\T\\Chapter 1.cbz', W), 'Src/T/Chapter 1.cbz');
  assert.equal(toStoredRel('Src/T\\Chapter 1.cbz', W), 'Src/T/Chapter 1.cbz', 'a mixed path too');
});

test('relFromAbs: a file under a Windows root comes back relative, in the stored form, and resolves back', () => {
  // This is fsAtomic's reapStaleTemp on Windows: the file it restored, named the way lib_books.file names it.
  const stored = relFromAbs('C:\\Lib', 'C:\\Lib\\Src\\T\\Chapter 1.cbz', W);
  assert.equal(stored, 'Src/T/Chapter 1.cbz');
  // And the stored form is still a path Windows resolves to the same file: `/` is a separator there too.
  assert.equal(W.resolve('C:\\Lib', stored), 'C:\\Lib\\Src\\T\\Chapter 1.cbz');
});

test('on POSIX a backslash is a filename character, and nothing touches it', () => {
  // ⚠️ The server's half. Reintroduce by replacing `\` unconditionally: a real folder called `a\b` on a Linux
  // library would be stored as `a/b`, a different path, and its series would split on the next scan.
  assert.equal(toStoredRel('a\\b', path.posix), 'a\\b');
  assert.equal(toStoredRel('a\\b'), 'a\\b', 'the platform default on this (Linux) test machine');
  assert.equal(relFromAbs('/lib', '/lib/a\\b/Chapter 1.cbz', path.posix), 'a\\b/Chapter 1.cbz');
});

test('chapterFileRel is exactly the SQL form repair.ts and health.ts compare it with', async () => {
  // `s.folder || '/Chapter ' || b.number || '.cbz'` in repair.ts, and the literal equality in health.ts and the
  // refetch route. On Linux this passes whether chapterFileRel uses join or posix.join; the static half (that
  // it is posix.join) is in desktopSwitchHygiene.test.ts.
  const { chapterFileRel } = await import('../src/lib/downloader');
  for (const [folder, n] of [['MangaDex/Solo Leveling', 1], ['Src/T', 12.5], ['Library/Some Title', 100]] as const) {
    assert.equal(chapterFileRel(folder, n), `${folder}/Chapter ${n}.cbz`);
  }
  assert.equal(joinRel('Src/T', 'Chapter 1.cbz'), 'Src/T/Chapter 1.cbz');
  assert.equal(dirnameRel('Src/T/Chapter 1.cbz'), 'Src/T');
});

test('sanitize on win32: names Explorer cannot open or delete are made safe', async () => {
  // Reintroduce by returning the POSIX result unchanged on win32: `CON` and `Title.` come back as they are.
  const { sanitize } = await import('../src/lib/downloader');
  const win = (s: string) => sanitize(s, 'win32');
  // Reserved device names, any case, bare or with an extension -- the device is the stem.
  assert.equal(win('CON'), 'CON_');
  assert.equal(win('con'), 'con_');
  assert.equal(win('nul.txt'), 'nul_.txt');
  assert.equal(win('Com1'), 'Com1_');
  assert.equal(win('LPT9 volume'), 'LPT9_ volume');
  assert.equal(win('AUX'), 'AUX_');
  assert.equal(win('PRN'), 'PRN_');
  // ...and only the device: a longer word that begins with one is a normal name.
  assert.equal(win('CONSOLE'), 'CONSOLE');
  assert.equal(win('Auxiliary'), 'Auxiliary');
  assert.equal(win('COM10'), 'COM10');
  // Trailing dots and spaces: Windows strips them when it opens the name, and finds nothing.
  assert.equal(win('Title.'), 'Title');
  assert.equal(win('Title...'), 'Title');
  assert.equal(win('Title . .'), 'Title');
  assert.equal(win('...'), 'untitled', 'a name that was only dots is not a name');
  // Control characters are illegal outright; tabs and newlines have already become spaces.
  assert.equal(win('a\u0001b\u001fc'), 'abc');
  assert.equal(win('tabs\tand\nnewlines'), 'tabs and newlines');
  // Still no separator, still inside the root.
  for (const evil of ['..\\..\\Windows', 'C:\\Users\\me', '../..']) {
    const out = win(evil);
    assert.ok(!out.includes('/') && !out.includes('\\'), `separator survived: ${out}`);
    assert.notEqual(out, '..');
  }
});

test('sanitize on Linux is byte-for-byte what it was', async () => {
  // The server's half. The expression is copied from v0.43.0 on purpose: if it ever changes, it changes here too,
  // deliberately. Reintroduce by applying the Windows rules on every platform: `CON` and `Title.` change.
  const { sanitize } = await import('../src/lib/downloader');
  const v043 = (s: string) => (s || '').replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'untitled';
  for (const s of ['CON', 'nul.txt', 'Title.', 'Title...', '...', '..', 'a\u0001b', '  Solo   Leveling  ', 'a/b\\c:d', 'x'.repeat(200), '', 'COM1']) {
    assert.equal(sanitize(s, 'linux'), v043(s), JSON.stringify(s));
    assert.equal(sanitize(s), v043(s), `default platform, ${JSON.stringify(s)}`);
  }
});

const err = (code: string) => Object.assign(new Error(code), { code });

test('a rename Windows refuses twice (antivirus holding the new file) still lands', async () => {
  // Reintroduce by returning to a bare `fs.rename` in writeAtomic: the first EPERM is the chapter's failure.
  let calls = 0;
  const flaky = async () => { calls++; if (calls <= 2) throw err(calls === 1 ? 'EPERM' : 'EBUSY'); };
  await renameRetry('a', 'b', 'win32', flaky, [0, 0, 0]);
  assert.equal(calls, 3);
});

test('the rename retry gives up, and is Windows-only and transient-only', async () => {
  // Exhausted: three waits, four attempts, then the error stands.
  let calls = 0;
  await assert.rejects(renameRetry('a', 'b', 'win32', async () => { calls++; throw err('EACCES'); }, [0, 0, 0]), /EACCES/);
  assert.equal(calls, 4);
  // Linux: an EPERM there is a real permission problem; retrying would only delay the message.
  calls = 0;
  await assert.rejects(renameRetry('a', 'b', 'linux', async () => { calls++; throw err('EPERM'); }, [0, 0, 0]), /EPERM/);
  assert.equal(calls, 1, 'the server build tries exactly once, as before');
  // The same with the platform left to its default, which is how writeAtomic calls it: on this Linux machine
  // that must be the rule above. Reintroduce by defaulting platform to 'win32': every chapter or cache write
  // that meets a real permission error waits ~1.4 s over three retries before it says so.
  calls = 0;
  await assert.rejects(renameRetry('a', 'b', undefined, async () => { calls++; throw err('EPERM'); }, [0, 0, 0]), /EPERM/);
  assert.equal(calls, 1, 'the default platform on this Linux machine retries');
  // A missing source is not a lock: no retry on Windows either.
  calls = 0;
  await assert.rejects(renameRetry('a', 'b', 'win32', async () => { calls++; throw err('ENOENT'); }, [0, 0, 0]), /ENOENT/);
  assert.equal(calls, 1);
});

test('the loop guard on Windows keys folders by real path, case-folded, not by a lossy inode', async () => {
  // Reintroduce by returning dev:ino on every platform: two different NTFS folders whose 64-bit ids collide in
  // a double (here, both stat as ino 0, as FAT and exFAT report) share a key and the second is never scanned.
  const { dirKey } = await import('../src/lib/library');
  const real = async (p: string) => p.replace(/\\link$/i, '\\Target');
  const a = await dirKey('C:\\Lib\\Series A', { dev: 1, ino: 0 }, 'win32', real);
  const b = await dirKey('C:\\Lib\\Series B', { dev: 1, ino: 0 }, 'win32', real);
  assert.notEqual(a, b, 'two folders with the same (useless) id share a key');
  // The same folder reached through a link, or spelt in another case, is one folder.
  assert.equal(await dirKey('C:\\Lib\\link', { dev: 1, ino: 7 }, 'win32', real), await dirKey('C:\\Lib\\TARGET', { dev: 1, ino: 9 }, 'win32', real));
  // POSIX keeps dev:ino, exactly as before.
  assert.equal(await dirKey('/lib/a', { dev: 3, ino: 42 }, 'linux'), '3:42');
  // And with the platform left to its default, which is how findSeriesDirs calls it. Reintroduce by defaulting
  // platform to 'win32': a Linux server keys by lower-cased real path, so `Title` and `title` (two real folders
  // there) share one key and the second is silently never scanned.
  assert.equal(await dirKey('/lib/a', { dev: 3, ino: 42 }), '3:42', 'the default platform is not the server');
});

test('the loop guard on Windows still finds a real symlink loop (real filesystem, win32 rule)', async () => {
  const { dirKey } = await import('../src/lib/library');
  const root = mkdtempSync(path.join(tmpdir(), 'uchiyomi-loop-'));
  try {
    mkdirSync(path.join(root, 'Series'));
    symlinkSync(root, path.join(root, 'Series', 'back'));
    const k1 = await dirKey(root, { dev: 0, ino: 0 }, 'win32');
    const k2 = await dirKey(path.join(root, 'Series', 'back'), { dev: 0, ino: 0 }, 'win32');
    assert.equal(k1, k2, 'the link back to the root is recognised as the root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
