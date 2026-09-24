// Paths on a PC's disk: typed and fetched names land on the spelling the disk already has (switch ON).
//
// NTFS and APFS are case-insensitive, and macOS keeps some names decomposed. The server's disks are neither,
// and everything this app stores -- lib_series.folder, libraries.path, lib_books.file -- is compared as an
// EXACT string with what the scanner reads back from readdir, which is always the on-disk spelling. So on a
// PC `mangadex/solo leveling` finds the folder but matches no row, and the series splits on the next scan.
// These run on Linux (case-sensitive), which is why they build the situations out of real directories and
// symlinks rather than relying on the test machine's filesystem to be forgiving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'uchi-deskpaths-'));
process.env.UCHIYOMI_DESKTOP = '1';
process.env.UCHIYOMI_DATA_DIR = DATA;
process.env.PORT = '43124';
process.env.DL_ROOT = join(DATA, 'Uchiyomi Library');
process.env.UCHIYOMI_DESKTOP_SECRET = 'a1'.repeat(32);
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
delete process.env.CONFIG_DIR;
delete process.env.LIBRARY_ROOT;
delete process.env.CUSTOM_SITES_FILE;

const DL = join(DATA, 'Uchiyomi Library');
const LIB = join(DATA, 'library'); // desktop.ts's default read library
mkdirSync(DL, { recursive: true });

test('diskSpelling: a typed path takes the spelling the disk already has, segment by segment', async () => {
  // Reintroduce by returning `rel` unchanged: every assertion below gets the typed case back.
  const { diskSpelling } = await import('../src/lib/libraryAdmin');
  mkdirSync(join(DL, 'MangaDex', 'Solo Leveling'), { recursive: true });
  assert.equal(await diskSpelling([DL, LIB], 'mangadex/solo leveling'), 'MangaDex/Solo Leveling');
  // Only what exists is respelled; a new leaf keeps the case it was typed in.
  assert.equal(await diskSpelling([DL, LIB], 'MANGADEX/A New Title'), 'MangaDex/A New Title');
  assert.equal(await diskSpelling([DL, LIB], 'Nowhere/at all'), 'Nowhere/at all');
  assert.equal(await diskSpelling([DL, LIB], ''), '');
});

test('diskSpelling: an exact match wins over a case-folded one (a case-sensitive volume holds both)', async () => {
  const { diskSpelling } = await import('../src/lib/libraryAdmin');
  mkdirSync(join(DL, 'Exact', 'one'), { recursive: true });
  mkdirSync(join(DL, 'exact', 'two'), { recursive: true });
  assert.equal(await diskSpelling([DL], 'exact/two'), 'exact/two');
  assert.equal(await diskSpelling([DL], 'Exact/one'), 'Exact/one');
});

test('diskSpelling: macOS decomposed names match their composed spelling', async () => {
  const { diskSpelling } = await import('../src/lib/libraryAdmin');
  const nfd = 'Jose\u0301';
  mkdirSync(join(DL, nfd), { recursive: true });
  assert.equal(await diskSpelling([DL], 'jos\u00e9'), nfd, 'the stored form is the one on disk');
});

test('diskSpelling: the root with the longest existing match wins', async () => {
  const { diskSpelling } = await import('../src/lib/libraryAdmin');
  mkdirSync(join(LIB, 'Manga', 'Seinen'), { recursive: true });
  mkdirSync(join(DL, 'manga'), { recursive: true });
  assert.equal(await diskSpelling([DL, LIB], 'MANGA/seinen'), 'Manga/Seinen');
});

test('sameDir: two spellings of one directory are the same directory; two directories are not', async () => {
  // What makes a case-only rename possible on a case-insensitive disk without letting it merge into a
  // genuinely different folder on a case-sensitive one. Linux cannot fold case, so a symlink stands in for
  // the second spelling: one directory, two names that differ only in case.
  const { sameDir } = await import('../src/lib/libraryAdmin');
  const base = join(DL, 'Src');
  mkdirSync(join(base, 'Title'), { recursive: true });
  symlinkSync(join(base, 'Title'), join(base, 'title'));
  assert.equal(await sameDir(join(base, 'Title'), join(base, 'title')), true);
  // A case-sensitive volume with two real folders: never "the same", so the rename still refuses.
  mkdirSync(join(base, 'Other'), { recursive: true });
  mkdirSync(join(base, 'other'), { recursive: true });
  assert.equal(await sameDir(join(base, 'Other'), join(base, 'other')), false);
  // Names that differ by more than case never qualify, whatever the ids say.
  assert.equal(await sameDir(join(base, 'Title'), join(base, 'Other')), false);
  assert.equal(await sameDir(join(base, 'Title'), join(base, 'missing')), false);
});

test('insideRealRoot: a root reached through a link still contains its own folders, and nothing else', async () => {
  // macOS: /tmp is /private/tmp, so realpath of a folder under a root given as /tmp/... no longer starts
  // with the root; Windows answers with the on-disk case and long names. `real.slice(root.length + 1)` cut
  // those in the wrong place. Reintroduce by going back to the slice: the folder that escapes through a
  // link reads as inside.
  const { insideRealRoot } = await import('../src/lib/libraryAdmin');
  const realRoot = join(DATA, 'real-root');
  mkdirSync(join(realRoot, 'Src', 'T'), { recursive: true });
  mkdirSync(join(realRoot, '..hidden'), { recursive: true });
  mkdirSync(join(DATA, 'real-root-other', 'Evil'), { recursive: true });
  const linked = join(DATA, 'linked-root');
  symlinkSync(realRoot, linked);
  const rr = realpathSync(realRoot);
  assert.equal(await insideRealRoot(linked, join(rr, 'Src', 'T')), true);
  assert.equal(await insideRealRoot(linked, rr), true, 'the root itself');
  assert.equal(await insideRealRoot(linked, join(rr, '..hidden')), true, 'a folder whose name starts with two dots is inside');
  assert.equal(await insideRealRoot(linked, realpathSync(join(DATA, 'real-root-other', 'Evil'))), false,
    'a sibling that merely shares the prefix is outside');
  assert.equal(await insideRealRoot(linked, '/etc'), false);
});

test('the custom sites file lives in the desktop config folder, not /config', async () => {
  // On Windows `/config/sites.json` is `C:\config\sites.json`. desktop.ts fills CUSTOM_SITES_FILE, and
  // customSites.ts's own desktop arm follows CONFIG_DIR, so both say the same thing.
  const { FILE } = await import('../src/lib/sources/customSites');
  assert.equal(FILE, join(DATA, 'config', 'sites.json'));
});
