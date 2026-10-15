// One file in the library cannot make the server hold an unbounded amount of memory, and a chapter folder's pages
// are its regular files only (lib/archiveCaps.ts, used by every reader in lib/library.ts, readers/, partial.ts and
// the OPDS folder download).
//
// The audit OOM-killed a 1 GiB process with a 1.4 MB CBZ whose single entry inflated ~1,000x (entryData buffered it
// whole), measured a PDF page box that rendered to 15000x15000 pixels, and read a jwt.secret through a page entry
// that was a symlink out of the library. Pure file fixtures, no database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');
const caps = require('../src/lib/archiveCaps') as typeof import('../src/lib/archiveCaps');
const { cbzPageAt, cbzPages } = require('../src/lib/library') as typeof import('../src/lib/library');
const { renderScale, MAX_PDF_PIXELS } = require('../src/lib/readers/pdf') as typeof import('../src/lib/readers/pdf');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let dir = '';
before(async () => { dir = await mkdtemp(join(tmpdir(), 'uchiyomi-caps-')); });
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test('a CBZ page that inflates past the cap is refused, not read whole', async () => {
  // Reintroduce by going back to zip.entryData() in cbzPageAt: the 65 MiB page comes back as a 65 MiB buffer.
  const zip = new AdmZip();
  zip.addFile('001.png', PNG);
  zip.addFile('002.png', Buffer.alloc(caps.MAX_PAGE_BYTES + 1024 * 1024)); // zeros: a few KB on disk
  const file = join(dir, 'bomb.cbz');
  await writeFile(file, zip.toBuffer());
  const first = await cbzPageAt(file, 0);
  assert.ok(first?.bytes.equals(PNG), 'an ordinary page still reads');
  await assert.rejects(cbzPageAt(file, 1), caps.EntryTooLarge);
});

test('an entry that lies about its size is still stopped by the byte count', async () => {
  // The declared size is the archive's own claim. Write a 2 MiB entry, then edit the central directory to say 1000
  // bytes: the declared-size check passes and the streamed count must stop it at the 1 MiB cap.
  const zip = new AdmZip();
  zip.addFile('page.png', Buffer.alloc(2 * 1024 * 1024));
  const buf: Buffer = zip.toBuffer();
  const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); // central directory header
  buf.writeUInt32LE(1000, cd + 24);                                   // its uncompressed size
  const lf = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));      // and the local header's, to match
  buf.writeUInt32LE(1000, lf + 22);
  const file = join(dir, 'liar.cbz');
  await writeFile(file, buf);
  const z = new StreamZip.async({ file });
  try {
    assert.equal((await z.entry('page.png')).size, 1000, 'premise: the entry now claims 1000 bytes');
    await assert.rejects(caps.zipEntryCapped(z, 'page.png', 1024 * 1024));
  } finally { await z.close(); }
});

test('a folder chapter lists and reads regular files only: a symlinked page is not a page', async () => {
  // Reintroduce by listing with a bare readdir and reading with readFile: page 2 is the file outside the library.
  const ch = join(dir, 'Series', 'Ch 1');
  await mkdir(ch, { recursive: true });
  await writeFile(join(ch, '001.png'), PNG);
  const outside = join(dir, 'outside-secret.txt');
  await writeFile(outside, 'DUMMY-SECRET');
  await symlink(outside, join(ch, '002.jpg'));
  await mkdir(join(ch, '003.png')); // a directory named like a page
  assert.deepEqual(await cbzPages(ch), ['001.png']);
  const p = await cbzPageAt(ch, 0);
  assert.equal(p?.total, 1);
  assert.equal(await cbzPageAt(ch, 1), null, 'there is no second page');
  await assert.rejects(caps.readRegularFile(ch, '002.jpg'), 'naming the symlink directly is refused too');
  await assert.rejects(caps.readRegularFile(ch, '../outside-secret.txt'));
});

test('a loose page over the cap is refused before it is read', async () => {
  const ch = join(dir, 'Big', 'Ch 1');
  await mkdir(ch, { recursive: true });
  await writeFile(join(ch, '001.png'), Buffer.alloc(2048));
  await assert.rejects(caps.readRegularFile(ch, '001.png', 1024), caps.EntryTooLarge);
});

test('a RAR entry is judged on its header before extraction', () => {
  assert.equal(caps.rarEntryAllowed({ unpSize: 5_000_000 }), true);
  assert.equal(caps.rarEntryAllowed({ unpSize: caps.MAX_PAGE_BYTES + 1 }), false);
  assert.equal(caps.rarEntryAllowed(undefined), true, 'an unknown size is not refused here (a missing entry fails later)');
});

test('a PDF page renders at most MAX_PDF_PIXELS, and an ordinary page is untouched', () => {
  // Reintroduce by using only the width-relative scale: the 200000-point page asks for a 100000 x 100000 render.
  const huge = renderScale(200_000, 200_000);
  assert.ok(200_000 * huge * 200_000 * huge <= MAX_PDF_PIXELS * 1.0001);
  const tall = renderScale(1600, 60_000);
  assert.ok(1600 * tall * 60_000 * tall <= MAX_PDF_PIXELS * 1.0001, 'a very tall page is drawn smaller, not refused');
  assert.equal(renderScale(600, 800), 1600 / 600, 'an ordinary page keeps its usual scale');
});
