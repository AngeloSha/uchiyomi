// PDF and image-EPUB chapters.
//
// Both formats were skipped until now, and both are the same thing a CBZ is: an ordered run of page images
// in a container. Komga and Kavita read them, so a library brought over from either had to be converted
// first. These tests exist because both readers are new code on the path that decides what a chapter is and
// what bytes a page serves -- and because archiveFormats.test.ts had to write a RAR by hand for the same
// reason, both fixtures are built here rather than committed as binaries.
//
// The one case worth stating: a TEXT EPUB must not become a chapter. That is not enforced with a rule, it
// falls out -- a reflowable novel has no images in its spine, so it yields no pages, so listChapters does
// not count it. This pins that, because a novel appearing in someone's manga library as an unopenable
// chapter would be worse than not reading EPUB at all.
//
// Pure unit tests: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateSync } from 'zlib';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

// ------------------------------------------------------------------ fixtures

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const c = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(c));
    return Buffer.concat([len, c, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(w).fill(Buffer.from(rgb)))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PDF of `n` pages, each a plain page box. Written by hand: no generator is available here. */
function pdf(n: number, w = 600, h = 900): Buffer {
  const objs: Array<[number, Buffer]> = [];
  const kids = Array.from({ length: n }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push([1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')]);
  objs.push([2, Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`)]);
  for (let i = 0; i < n; i++) {
    const pageNo = 3 + i * 2;
    objs.push([pageNo, Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${pageNo + 1} 0 R ` +
      `/Resources << /Font << /F1 ${3 + n * 2} 0 R >> >> >>`)]);
    const content = `BT /F1 36 Tf 40 ${Math.floor(h / 2)} Td (Page ${i + 1}) Tj ET`;
    objs.push([pageNo + 1, Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)]);
  }
  objs.push([3 + n * 2, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')]);

  let out = Buffer.from('%PDF-1.4\n');
  const offs = new Map<number, number>();
  for (const [num, body] of objs) {
    offs.set(num, out.length);
    out = Buffer.concat([out, Buffer.from(`${num} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
  }
  const xref = out.length;
  let table = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const [num] of objs) table += `${String(offs.get(num)).padStart(10, '0')} 00000 n \n`;
  return Buffer.concat([out, Buffer.from(table),
    Buffer.from(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}

/** A zip, store mode, so an EPUB can be assembled without pulling in a writer. */
function zip(files: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nm = Buffer.from(name, 'utf8');
    const c = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, nm, data]);
    locals.push(local);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(c, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nm]));
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A fixed-layout image EPUB: XHTML wrappers in spine order, each holding one image. */
function imageEpub(): Buffer {
  const imgs: Array<[string, Buffer]> = [
    ['OEBPS/images/i_003.png', png(64, 96, [220, 60, 60])],
    ['OEBPS/images/i_001.png', png(64, 96, [60, 220, 60])],
    ['OEBPS/images/i_002.png', png(64, 96, [60, 60, 220])],
  ];
  // Deliberately named so that filename order (001, 002, 003) DISAGREES with spine order (003, 001, 002).
  // That disagreement is the whole reason EPUB needs its own ordering rather than reusing the zip sort.
  const spine = ['i_003', 'i_001', 'i_002'];
  const pages: Array<[string, Buffer]> = spine.map((id, i) => [
    `OEBPS/text/p${i + 1}.xhtml`,
    Buffer.from(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>` +
                `<img src="../images/${id}.png" alt=""/></body></html>`),
  ]);
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
${pages.map((p, i) => `    <item id="p${i + 1}" href="text/p${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
${spine.map((id) => `    <item id="${id}" href="images/${id}.png" media-type="image/png"/>`).join('\n')}
  </manifest>
  <spine>
${pages.map((_, i) => `    <itemref idref="p${i + 1}"/>`).join('\n')}
  </spine>
</package>`;
  return zip([
    ['mimetype', Buffer.from('application/epub+zip')],
    ['META-INF/container.xml', Buffer.from(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)],
    ['OEBPS/content.opf', Buffer.from(opf)],
    ...pages, ...imgs,
  ]);
}

/** A reflowable novel: a real EPUB, no images anywhere. */
function textEpub(): Buffer {
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  return zip([
    ['mimetype', Buffer.from('application/epub+zip')],
    ['META-INF/container.xml', Buffer.from(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)],
    ['content.opf', Buffer.from(opf)],
    ['c1.xhtml', Buffer.from('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>It was a dark and stormy night.</p></body></html>')],
  ]);
}

async function withLibrary(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'uchiyomi-fmt2-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ PDF

test('PDF: pages are counted, rendered and measured', async () => {
  const { cbzPages, cbzPageAt, cbzPageDims } = await import('../src/lib/library');
  await withLibrary(async (root) => {
    const f = join(root, 'Chapter 001.pdf');
    await writeFile(f, pdf(3));

    const names = await cbzPages(f);
    assert.equal(names.length, 3, 'a three-page PDF should list three pages');
    assert.deepEqual(names, ['page-0001.png', 'page-0002.png', 'page-0003.png'],
      'names are zero-padded so the natural sort used everywhere else holds past page 9');

    const first = await cbzPageAt(f, 0);
    assert.ok(first, 'page 1 should render');
    assert.equal(first!.total, 3);
    assert.equal(first!.bytes.subarray(1, 4).toString(), 'PNG', 'a rendered page is a PNG');
    assert.ok(first!.bytes.length > 500, 'the render should not be an empty image');

    assert.equal(await cbzPageAt(f, 3), null, 'past the end is null, not a throw');

    const dims = await cbzPageDims(f);
    assert.equal(dims.length, 3);
    // 600pt wide at the reader's target width; measured from the page box, never by rendering.
    assert.ok(dims[0].width! > 1000, `expected a readable render width, got ${dims[0].width}`);
    assert.ok(dims[0].height! > dims[0].width!, 'a 600x900 page should come out taller than it is wide');
  });
});

test('PDF: dimensions match what the renderer actually produces', async () => {
  // cbzPageDims is what the reader reserves space with. If it disagreed with the bytes, every page would
  // jump as it loaded -- the exact problem page_dims exists to solve.
  const { cbzPageAt, cbzPageDims } = await import('../src/lib/library');
  const sharp = require('sharp');
  await withLibrary(async (root) => {
    const f = join(root, 'Chapter 001.pdf');
    await writeFile(f, pdf(1, 800, 1200));
    const [claimed] = await cbzPageDims(f);
    const actual = await sharp((await cbzPageAt(f, 0))!.bytes).metadata();
    assert.equal(actual.width, claimed.width, 'claimed width must equal the rendered width');
    assert.equal(actual.height, claimed.height, 'claimed height must equal the rendered height');
  });
});

// ------------------------------------------------------------------ EPUB

test('EPUB: an image EPUB reads in SPINE order, not filename order', async () => {
  const { cbzPages, cbzPageAt } = await import('../src/lib/library');
  await withLibrary(async (root) => {
    const f = join(root, 'Chapter 001.epub');
    await writeFile(f, imageEpub());

    const names = await cbzPages(f);
    assert.deepEqual(names, [
      'OEBPS/images/i_003.png', 'OEBPS/images/i_001.png', 'OEBPS/images/i_002.png',
    ], 'the spine says 003, 001, 002; sorting the filenames would give the wrong reading order');

    const first = await cbzPageAt(f, 0);
    assert.equal(first!.name, 'OEBPS/images/i_003.png');
    assert.equal(first!.total, 3);
    assert.equal(first!.bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(await cbzPageAt(f, 3), null);
  });
});

test('THE RULE: a text EPUB is not a chapter', async () => {
  const { listChapters, cbzPages } = await import('../src/lib/library');
  await withLibrary(async (root) => {
    await writeFile(join(root, 'Volume 1.epub'), imageEpub());
    await writeFile(join(root, 'A Novel.epub'), textEpub());

    assert.deepEqual(await cbzPages(join(root, 'A Novel.epub')), [],
      'a reflowable novel has no pages a manga reader can show');

    const found = await listChapters(root);
    assert.deepEqual(found, ['Volume 1.epub'],
      `only the image EPUB is a chapter, got ${JSON.stringify(found)}`);
  });
});

// ------------------------------------------------------------------ the scanner

test('listChapters accepts every format the README now claims', async () => {
  const { listChapters } = await import('../src/lib/library');
  const AdmZip = require('adm-zip');
  await withLibrary(async (root) => {
    const z = new AdmZip();
    z.addFile('001.png', png(64, 96, [10, 10, 10]));
    await writeFile(join(root, 'Chapter 001.cbz'), z.toBuffer());
    await writeFile(join(root, 'Chapter 002.pdf'), pdf(2));
    await writeFile(join(root, 'Chapter 003.epub'), imageEpub());
    const dir = join(root, 'Chapter 004');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '001.png'), png(64, 96, [20, 20, 20]));

    // and the things that still must not count
    await writeFile(join(root, 'A Novel.epub'), textEpub());
    await writeFile(join(root, 'notes.txt'), 'no');
    await mkdir(join(root, 'empty'), { recursive: true });

    assert.deepEqual(await listChapters(root),
      ['Chapter 001.cbz', 'Chapter 002.pdf', 'Chapter 003.epub', 'Chapter 004']);
  });
});

test('a PDF and an EPUB both fingerprint, so rename detection still works', async () => {
  // findRematch is what stops a renamed folder from re-minting ids and stranding reading progress. A format
  // it cannot fingerprint silently opts out of that protection.
  const { fingerprintChapter } = await import('../src/lib/fingerprint');
  await withLibrary(async (root) => {
    const p = join(root, 'a.pdf'); await writeFile(p, pdf(2));
    const e = join(root, 'a.epub'); await writeFile(e, imageEpub());

    const fp = await fingerprintChapter(p);
    assert.ok(fp.fingerprint, 'a PDF must fingerprint');
    assert.notEqual(fp.kind, 'error');

    const fe = await fingerprintChapter(e);
    assert.ok(fe.fingerprint, 'an EPUB must fingerprint');
    assert.notEqual(fe.kind, 'error');

    // the same bytes elsewhere must give the same answer, or a moved file looks like a new one
    const p2 = join(root, 'moved.pdf'); await writeFile(p2, pdf(2));
    assert.equal((await fingerprintChapter(p2)).fingerprint, fp.fingerprint,
      'an identical PDF at another path must fingerprint the same');
    assert.notEqual((await fingerprintChapter(join(root, 'a.pdf'))).fingerprint, fe.fingerprint,
      'different content must not collide');
  });
});
