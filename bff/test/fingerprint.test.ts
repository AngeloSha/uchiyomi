// The fingerprint is what will let a chapter be recognised after it moves, so reading progress survives a
// library reorganisation. Its whole value rests on one property of the zip format — that CRC-32 is computed
// over UNCOMPRESSED bytes — and on never, ever throwing.
//
// The recompression test below is the one that matters most: if it ever fails, the fingerprint is really
// just "how this file happened to be packed" and the entire design underneath it is wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fingerprintChapter } from '../src/lib/fingerprint';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let dir: string;
const p = (name: string) => join(dir, name);

/** A CBZ with the given pages. `stored` repacks identical content uncompressed, on purpose. */
async function cbz(name: string, pages: Record<string, string>, stored = false) {
  const zip = new AdmZip();
  for (const [entry, body] of Object.entries(pages)) zip.addFile(entry, Buffer.from(body));
  // method 0 = STORED, 8 = DEFLATED. Same bytes in, a very different container out.
  if (stored) for (const e of zip.getEntries()) e.header.method = 0;
  const abs = p(name);
  await writeFile(abs, zip.toBuffer());
  return abs;
}

const PAGES = { '001.jpg': 'first-page-bytes', '002.jpg': 'second-page-bytes', 'ComicInfo.xml': '<ComicInfo/>' };

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uchiyomi-fp-'));
});
test.after(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('fingerprint: identical content at a different path gives the same value', async () => {
  const a = await cbz('a.cbz', PAGES);
  const b = await cbz('b.cbz', PAGES);
  const fa = await fingerprintChapter(a);
  const fb = await fingerprintChapter(b);
  assert.equal(fa.kind, 'zip');
  assert.ok(fa.fingerprint, 'no fingerprint produced');
  assert.equal(fa.fingerprint, fb.fingerprint, 'the same chapter at two paths fingerprinted differently');
});

test('fingerprint: SURVIVES recompression — the property the whole design rests on', async () => {
  // Identical pages, one archive stored and one deflated. CRC-32 is over the uncompressed data, so the
  // fingerprint must not move even though the two files share almost no bytes.
  const stored = await cbz('stored.cbz', PAGES, true);
  const packed = await cbz('packed.cbz', PAGES, false);
  const fs1 = await fingerprintChapter(stored);
  const fp1 = await fingerprintChapter(packed);
  assert.ok(fs1.fingerprint && fp1.fingerprint);
  assert.notEqual(fs1.size, fp1.size, 'the two files must differ on disk, or this test proves nothing');
  assert.equal(
    fs1.fingerprint,
    fp1.fingerprint,
    'recompressing a chapter changed its fingerprint — the design is unsound if this fails',
  );
});

test('fingerprint: changes when a page changes', async () => {
  const base = await fingerprintChapter(await cbz('base.cbz', PAGES));
  const edited = await fingerprintChapter(
    await cbz('edited.cbz', { ...PAGES, '002.jpg': 'second-page-bytes-EDITED' }),
  );
  assert.notEqual(base.fingerprint, edited.fingerprint);
});

test('fingerprint: changes when a page is added or removed', async () => {
  const base = await fingerprintChapter(await cbz('n-base.cbz', PAGES));
  const added = await fingerprintChapter(await cbz('n-add.cbz', { ...PAGES, '003.jpg': 'third' }));
  const { '002.jpg': _drop, ...fewer } = PAGES;
  const removed = await fingerprintChapter(await cbz('n-del.cbz', fewer));
  assert.notEqual(base.fingerprint, added.fingerprint, 'adding a page did not change it');
  assert.notEqual(base.fingerprint, removed.fingerprint, 'removing a page did not change it');
});

test('fingerprint: changes when a page is renamed, even with identical bytes', async () => {
  const base = await fingerprintChapter(await cbz('r-base.cbz', { '001.jpg': 'x', '002.jpg': 'y' }));
  const renamed = await fingerprintChapter(await cbz('r-new.cbz', { '001.jpg': 'x', '999.jpg': 'y' }));
  assert.notEqual(base.fingerprint, renamed.fingerprint);
});

test('fingerprint: entry order inside the archive does not matter', async () => {
  const forward = await cbz('o-fwd.cbz', { '001.jpg': 'a', '002.jpg': 'b', '003.jpg': 'c' });
  const zip = new AdmZip();
  for (const [n, b] of [['003.jpg', 'c'], ['001.jpg', 'a'], ['002.jpg', 'b']] as const) {
    zip.addFile(n, Buffer.from(b));
  }
  const reversed = p('o-rev.cbz');
  await writeFile(reversed, zip.toBuffer());
  assert.equal(
    (await fingerprintChapter(forward)).fingerprint,
    (await fingerprintChapter(reversed)).fingerprint,
  );
});

test('fingerprint: two chapters sharing only a cover page do NOT collide', async () => {
  // The failure mode a first-N-bytes fingerprint would have had.
  const one = await fingerprintChapter(await cbz('c1.cbz', { '001.jpg': 'SAME-COVER', '002.jpg': 'one' }));
  const two = await fingerprintChapter(await cbz('c2.cbz', { '001.jpg': 'SAME-COVER', '002.jpg': 'two' }));
  assert.notEqual(one.fingerprint, two.fingerprint);
});

test('fingerprint: never throws, and returns null for anything unreadable', async () => {
  const corrupt = p('corrupt.cbz');
  await writeFile(corrupt, Buffer.from('this is definitely not a zip archive'));
  const truncated = p('truncated.cbz');
  const good = new AdmZip();
  good.addFile('001.jpg', Buffer.from('some page data here'));
  await writeFile(truncated, good.toBuffer().subarray(0, 20));

  for (const [label, abs] of [
    ['corrupt', corrupt],
    ['truncated', truncated],
    ['missing', p('does-not-exist.cbz')],
  ] as const) {
    const f = await fingerprintChapter(abs);
    assert.equal(f.fingerprint, null, `${label} produced a fingerprint`);
    assert.equal(f.kind, 'error', `${label} was not reported as an error`);
  }
});

test('fingerprint: an empty archive identifies nothing rather than everything', async () => {
  // Every empty archive would otherwise share one fingerprint and rematch against each other.
  const empty = p('empty.cbz');
  await writeFile(empty, new AdmZip().toBuffer());
  const f = await fingerprintChapter(empty);
  assert.equal(f.fingerprint, null);
  assert.equal(f.kind, 'error');
});

test('fingerprint: directories of loose images work, by name and size', async () => {
  const folder = p('loose');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '001.jpg'), 'aaaa');
  await writeFile(join(folder, '002.jpg'), 'bbbbbb');
  await writeFile(join(folder, 'notes.txt'), 'ignored');

  const f = await fingerprintChapter(folder);
  assert.equal(f.kind, 'dir');
  assert.ok(f.fingerprint);
  assert.equal(f.size, 10, 'size should sum only the image pages');

  // a copy of the same folder matches
  const copy = p('loose-copy');
  await mkdir(copy, { recursive: true });
  await writeFile(join(copy, '001.jpg'), 'aaaa');
  await writeFile(join(copy, '002.jpg'), 'bbbbbb');
  assert.equal((await fingerprintChapter(copy)).fingerprint, f.fingerprint);

  // changing a page's size changes it
  const differs = p('loose-diff');
  await mkdir(differs, { recursive: true });
  await writeFile(join(differs, '001.jpg'), 'aaaa');
  await writeFile(join(differs, '002.jpg'), 'bbbbbbbb');
  assert.notEqual((await fingerprintChapter(differs)).fingerprint, f.fingerprint);
});

test('fingerprint: an empty directory identifies nothing', async () => {
  const folder = p('loose-empty');
  await mkdir(folder, { recursive: true });
  const f = await fingerprintChapter(folder);
  assert.equal(f.fingerprint, null);
  assert.equal(f.kind, 'error');
});

test('fingerprint: reports the file size alongside', async () => {
  const abs = await cbz('sized.cbz', PAGES);
  const f = await fingerprintChapter(abs);
  assert.ok(typeof f.size === 'number' && f.size > 0);
});

test('fingerprint: is stable across repeated calls', async () => {
  const abs = await cbz('stable.cbz', PAGES);
  const a = await fingerprintChapter(abs);
  const b = await fingerprintChapter(abs);
  assert.equal(a.fingerprint, b.fingerprint);
});
