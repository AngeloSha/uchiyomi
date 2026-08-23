// The three container formats the README promises: CBZ, CBR, and a plain folder of images.
//
// CBZ is exercised everywhere. CBR had no test at all, in any file, despite being one of three formats the
// README names -- and it is the only one that goes through a completely separate reader (node-unrar-js,
// pure-wasm, rather than the zip path). A regression there would have been silent until someone with a
// .cbr library filed an issue.
//
// The reason it was untested is that there is no `rar` tool to make a fixture with: RAR compression is
// proprietary and no free encoder ships in any package manager. So this file writes the container itself.
// Store mode (METHOD 0x30) copies the bytes in verbatim, which is what a comic archive is anyway, and the
// block format is small enough to emit directly. That makes the fixture self-contained: no binary blob in
// the repo, nothing to install in CI.
//
// Pure unit tests: no database, no environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateSync } from 'zlib';

// library.ts imports db, which validates the environment at load. Nothing here opens a connection -- the
// pool is lazy -- but the URL has to parse or the import throws before a single assertion runs. Same reason
// fsGuard.ts was split out of visibility.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

/**
 * CRC32, table-driven.
 *
 * `zlib.crc32` only exists from Node 20.12, and this file has to run wherever the suite runs. Both PNG and
 * RAR use the same polynomial, so one implementation covers the fixture and its container.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ fixture builders

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const c = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(c) >>> 0);
    return Buffer.concat([len, c, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(w).fill(Buffer.from(rgb)))]);
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A RAR 4.x archive in store mode.
 *
 * Blocks are: marker, MAIN_HEAD (0x73), one FILE_HEAD (0x74) per entry with its bytes following the header,
 * then END_HEAD (0x7b). Every block starts with HEAD_CRC -- the low 16 bits of CRC32 over the block from
 * HEAD_TYPE onward, not counting the CRC field itself.
 */
function rar(files: Array<[string, Buffer]>): Buffer {
  const headCrc = (body: Buffer) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(crc32(body) & 0xffff);
    return b;
  };
  const u8 = (n: number) => Buffer.from([n]);
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

  const main = Buffer.concat([u8(0x73), u16(0x0000), u16(13), u16(0), u32(0)]);
  // 2026-08-23 12:00:00 in MS-DOS packed form; fixed so the fixture is byte-identical between runs.
  const ftime = ((2026 - 1980) << 25) | (8 << 21) | (23 << 16) | (12 << 11) | (0 << 5) | 0;

  const blocks = files.map(([name, data]) => {
    const nm = Buffer.from(name, 'utf8');
    const body = Buffer.concat([
      u8(0x74),                     // HEAD_TYPE
      u16(0x8000),                  // HEAD_FLAGS: LONG_BLOCK, packed data follows
      u16(32 + nm.length),          // HEAD_SIZE, header only
      u32(data.length),             // PACK_SIZE
      u32(data.length),             // UNP_SIZE, equal because it is stored
      u8(3),                        // HOST_OS: Unix
      u32(crc32(data) >>> 0),       // FILE_CRC
      u32(ftime),
      u8(20),                       // UNP_VER 2.0
      u8(0x30),                     // METHOD: store
      u16(nm.length),
      u32(0x20),                    // ATTR
      nm,
    ]);
    return Buffer.concat([headCrc(body), body, data]);
  });

  const end = Buffer.concat([u8(0x7b), u16(0x4000), u16(7)]);
  return Buffer.concat([
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]),
    headCrc(main), main,
    ...blocks,
    headCrc(end), end,
  ]);
}

const PAGES: Array<[string, Buffer]> = [
  ['001.png', png(64, 96, [220, 60, 60])],
  ['002.png', png(64, 96, [60, 220, 60])],
  ['003.png', png(64, 96, [60, 60, 220])],
];

// ------------------------------------------------------------------ the fixture is a real archive

test('the hand-written RAR is one the app\'s own reader accepts', async () => {
  // If this fails, every CBR assertion below is meaningless, so it is asserted separately and first.
  const { createExtractorFromData } = require('node-unrar-js');
  const data = rar(PAGES);
  const ex = await createExtractorFromData({ data: Uint8Array.from(data).buffer });
  const headers = [...ex.getFileList().fileHeaders];
  assert.deepEqual(headers.map((h: any) => h.name), ['001.png', '002.png', '003.png']);

  const got = ex.extract({ files: headers.map((h: any) => h.name) });
  const extracted = [...got.files].filter((f: any) => f.extraction);
  assert.equal(extracted.length, 3, 'all three pages should come back out');
  for (const f of extracted) {
    assert.equal(Buffer.from(f.extraction).subarray(1, 4).toString(), 'PNG', 'the bytes round-tripped');
  }
});

// ------------------------------------------------------------------ each format, through the real code

async function withLibrary(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'uchiyomi-fmt-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('CBR: pages are listed, read and measured', async () => {
  const { cbzPages, cbzPageAt, cbzPageDims } = await import('../src/lib/library');
  await withLibrary(async (root) => {
    const f = join(root, 'Chapter 001.cbr');
    await writeFile(f, rar(PAGES));

    const names = await cbzPages(f);
    assert.deepEqual(names, ['001.png', '002.png', '003.png'], 'the reader should list every page in order');

    // cbzPageAt takes a zero-based index and returns { name, bytes, total }.
    const first = await cbzPageAt(f, 0);
    assert.ok(first, 'the first page should be readable out of a .cbr');
    assert.equal(first!.name, '001.png');
    assert.equal(first!.total, 3, 'the page count should come from the archive, not a guess');
    assert.equal(first!.bytes.subarray(1, 4).toString(), 'PNG', 'the bytes should be the image itself');

    const last = await cbzPageAt(f, 2);
    assert.equal(last!.name, '003.png', 'the last page should be reachable, in natural order');
    assert.equal(await cbzPageAt(f, 3), null, 'past the end should be null, not a throw');

    const dims = await cbzPageDims(f);
    assert.equal(dims.length, 3);
    assert.equal(dims[0].width, 64, 'width should be read from the image inside the archive');
    assert.equal(dims[0].height, 96);
  });
});

test('CBZ: the same three assertions, for the format that has coverage elsewhere', async () => {
  const { cbzPages, cbzPageAt, cbzPageDims } = await import('../src/lib/library');
  const AdmZip = require('adm-zip');
  await withLibrary(async (root) => {
    const zip = new AdmZip();
    for (const [n, b] of PAGES) zip.addFile(n, b);
    const f = join(root, 'Chapter 001.cbz');
    await writeFile(f, zip.toBuffer());

    assert.deepEqual(await cbzPages(f), ['001.png', '002.png', '003.png']);
    const first = await cbzPageAt(f, 0);
    assert.equal(first!.name, '001.png');
    assert.equal(first!.total, 3);
    assert.equal(first!.bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(await cbzPageAt(f, 3), null);
    const dims = await cbzPageDims(f);
    assert.equal(dims.length, 3);
    assert.equal(dims[0].width, 64);
  });
});

test('listChapters accepts all three formats, and nothing else', async () => {
  const { listChapters, cbzPages, cbzPageAt } = await import('../src/lib/library');
  await withLibrary(async (root) => {
    // one of each container the README names
    await writeFile(join(root, 'Chapter 001.cbz'), (() => {
      const AdmZip = require('adm-zip'); const z = new AdmZip();
      for (const [n, b] of PAGES) z.addFile(n, b);
      return z.toBuffer();
    })());
    await writeFile(join(root, 'Chapter 002.cbr'), rar(PAGES));
    const loose = join(root, 'Chapter 003');
    await mkdir(loose, { recursive: true });
    for (const [n, b] of PAGES) await writeFile(join(loose, n), b);

    // and the things that must NOT become chapters
    await mkdir(join(root, 'empty folder'), { recursive: true });
    await writeFile(join(root, 'cover.jpg'), PAGES[0][1]);
    await writeFile(join(root, 'notes.txt'), 'not a chapter');
    await writeFile(join(root, 'Volume 1.pdf'), '%PDF-1.4 not supported on purpose');
    await writeFile(join(root, 'Volume 1.epub'), 'PK not supported on purpose');

    const found = await listChapters(root);
    assert.deepEqual(found, ['Chapter 001.cbz', 'Chapter 002.cbr', 'Chapter 003'],
      `expected exactly the three supported chapters, got ${JSON.stringify(found)}`);

    // and each one is genuinely readable, not merely listed
    for (const name of found) {
      const p = join(root, name);
      assert.equal((await cbzPages(p)).length, 3, `${name} should expose three pages`);
      assert.equal((await cbzPageAt(p, 0))!.bytes.subarray(1, 4).toString(), 'PNG', `${name} page 1`);
    }
  });
});

test('the format list in the README is the format list in the code', async () => {
  // README: "It reads CBZ, CBR and folders of images, and skips PDF and EPUB on purpose."
  const { readFileSync } = require('fs');
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'library.ts'), 'utf8');
  for (const ext of ['cbz', 'cbr', 'zip', 'rar']) {
    assert.ok(new RegExp(`\\b${ext}\\b`, 'i').test(src), `${ext} is no longer recognised by the scanner`);
  }
  assert.ok(!/\bepub\b/i.test(src) && !/\.pdf\b/i.test(src),
    'PDF or EPUB handling appeared in the scanner; the README says both are skipped on purpose');
});
