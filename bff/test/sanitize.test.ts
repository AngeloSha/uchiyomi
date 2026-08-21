// sanitize() decides the on-disk folder name for every series the downloader creates, and its output is
// joined straight onto DL_ROOT. It had no tests at all, which is uncomfortable for the one function standing
// between a source-supplied title and the filesystem.
//
// These pin CURRENT behaviour, including the parts that are merely adequate, so that the upcoming change to
// how library identity is derived shows up as a deliberate diff rather than a surprise. Where behaviour is
// weak rather than wrong, the test says so in its name instead of quietly asserting it is fine.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'path';

// sanitize() is pure, but it lives in downloader.ts, which transitively imports env.ts and validates the
// whole environment at module load. Satisfy that first, then import lazily.
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

let sanitize: (s: string) => string;
before(async () => {
  ({ sanitize } = await import('../src/lib/downloader'));
});

const DL_ROOT = '/library-dl';

/** Where a chapter would actually land for a given source-supplied series title. */
const landsIn = (title: string, source = 'Aqua') =>
  resolve(join(DL_ROOT, `${source}/${sanitize(title)}`, 'Chapter 1.cbz'));

test('sanitize: the security property — a title can never introduce a path separator', () => {
  for (const evil of [
    '../../etc/passwd',
    '..\\..\\windows\\system32',
    '/absolute/path',
    'C:\\Users\\me',
    'a/b/c',
    'nested\\deep\\title',
  ]) {
    const out = sanitize(evil);
    assert.ok(!out.includes('/'), `forward slash survived: ${out}`);
    assert.ok(!out.includes('\\'), `backslash survived: ${out}`);
  }
});

test('sanitize: every chapter still lands inside DL_ROOT', () => {
  for (const evil of [
    '../../etc/passwd',
    '/etc',
    '....//....//etc',
    'C:\\Windows',
    '..',
    '../',
    '.',
  ]) {
    const abs = landsIn(evil);
    assert.ok(
      abs === DL_ROOT || abs.startsWith(DL_ROOT + '/'),
      `escaped the download root with ${JSON.stringify(evil)} -> ${abs}`,
    );
  }
});

test('sanitize: replaces the characters that are illegal or meaningful in a path', () => {
  assert.equal(sanitize('a/b'), 'a_b');
  assert.equal(sanitize('a\\b'), 'a_b');
  assert.equal(sanitize('a:b'), 'a_b');
  assert.equal(sanitize('a*b'), 'a_b');
  assert.equal(sanitize('a?b'), 'a_b');
  assert.equal(sanitize('a"b'), 'a_b');
  assert.equal(sanitize('a<b>c'), 'a_b_c');
  assert.equal(sanitize('a|b'), 'a_b');
  // a run collapses to a single underscore rather than one per character
  assert.equal(sanitize('a///b'), 'a_b');
  assert.equal(sanitize('a<<>>b'), 'a_b');
});

test('sanitize: collapses whitespace and trims', () => {
  assert.equal(sanitize('  Solo   Leveling  '), 'Solo Leveling');
  assert.equal(sanitize('tabs\tand\nnewlines'), 'tabs and newlines');
});

test('sanitize: falls back to "untitled" only when nothing survives', () => {
  assert.equal(sanitize(''), 'untitled');
  assert.equal(sanitize('   '), 'untitled');
  assert.equal(sanitize(undefined as unknown as string), 'untitled');
  assert.equal(sanitize(null as unknown as string), 'untitled');
  // a title made entirely of illegal characters becomes underscores, which is NOT empty, so no fallback
  assert.equal(sanitize('///'), '_');
});

test('sanitize: keeps unicode, which matters because most titles are not ASCII', () => {
  assert.equal(sanitize('ソロレベリング'), 'ソロレベリング');
  assert.equal(sanitize('나 혼자만 레벨업'), '나 혼자만 레벨업');
  assert.equal(sanitize('Ère nouvelle'), 'Ère nouvelle');
  assert.equal(sanitize('日本語 : タイトル'), '日本語 _ タイトル');
});

test('sanitize: truncates at 150 characters, and two long titles can therefore collide', () => {
  const a = 'x'.repeat(150) + 'FIRST';
  const b = 'x'.repeat(150) + 'SECOND';
  assert.equal(sanitize(a).length, 150);
  assert.equal(
    sanitize(a),
    sanitize(b),
    'documented weakness: titles sharing a 150-char prefix map to the same folder',
  );
});

test('sanitize: truncation can leave trailing whitespace, unlike the trim before it', () => {
  // trim() runs BEFORE slice(), so a space at position 150 survives into the folder name.
  const withSpaceAtTheCut = 'y'.repeat(149) + ' tail';
  assert.equal(sanitize(withSpaceAtTheCut), 'y'.repeat(149) + ' ');
});

test('sanitize: leading and trailing dots are preserved, so ".." stays ".."', () => {
  // Not a traversal risk on its own — the chapter still lands inside DL_ROOT (asserted above) — but it does
  // mean a title of ".." writes into the source directory rather than a subfolder of it.
  assert.equal(sanitize('..'), '..');
  assert.equal(sanitize('.hidden'), '.hidden');
  assert.equal(resolve(join(DL_ROOT, `Aqua/${sanitize('..')}`)), DL_ROOT);
});

test('sanitize: Windows reserved device names are not special-cased', () => {
  // Documented gap rather than a bug for this project: the containers are Linux, where these are ordinary
  // names. Worth knowing if the library is ever mounted from Windows.
  for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1']) {
    assert.equal(sanitize(name), name);
  }
});

test('sanitize: is idempotent, so re-sanitising a stored folder name is safe', () => {
  for (const s of ['Solo Leveling', 'a/b', '  spaced  ', '???', 'ソロ']) {
    assert.equal(sanitize(sanitize(s)), sanitize(s));
  }
});
