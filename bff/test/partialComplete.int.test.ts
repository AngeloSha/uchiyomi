// A partial chapter on disk, its row, its DTO, and the pass that completes it.
//
// partialChapter.test.ts pins the hold; this file pins what happens once the hold is WRITTEN: setBookMeta
// stamps which pages are placeholders, the book DTO and page list say so, and the completion pass
// (lib/partial.ts) asks the same source for exactly the missing pages, merges them by index into the
// archive it has, and clears everything derived from the old bytes. Against a real scratch database and a
// real scratch disk, because every one of those is a place a stale value would silently survive.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A viewer that sees every library (see prunedBooks.int.test.ts for why it is written out).
const SYSTEM_CTX = { userId: null, libraryIds: null, maxAgeRating: null } as const;

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '', LIB = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-pcomp-'));
  DL = join(ROOT, 'dl');
  LIB = join(ROOT, 'lib');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = LIB;
  process.env.DL_ROOT = DL;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const SRC = 'pc-src';
const ADULT_SRC = 'pc-adult';
const ALT = 'pc-alt';
const S = 's_pcomp_series';
const FOLDER = 'T!pcomp/Partial Complete';

let q: any, owned: any, downloadChapter: any, completePartial: any, setBookMeta: any, persistScan: any, clearPace: () => void;
let app: any, headers: Record<string, string>;
const USER = 'pcomp-user';
/** (chapter id, page index) pairs the site answers 404 for; everything else is a real, distinct PNG. */
const failing = new Set<string>();
/** How many pages each chapter has, so the re-slice case can change one. */
const pageCount = new Map<string, number>();
/** Every image request, as `chapter/index`: what the source was asked for. */
let asked: string[] = [];
const pngs = new Map<number, Buffer>();
const realFetch = globalThis.fetch;

async function png(i: number): Promise<Buffer> {
  let b = pngs.get(i);
  if (!b) {
    const sharp = (await import('sharp')).default;
    // A distinct colour per index, and a gradient so it is a page with identity rather than a flat slab.
    const w = 40, h = 60;
    const px = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; px[o] = (i * 37) % 256; px[o + 1] = Math.round((x / w) * 255); px[o + 2] = 40; }
    b = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    pngs.set(i, b);
  }
  return b;
}

const adapter = {
  id: SRC, name: 'Partial Complete',
  async search() { return []; },
  async getSeries() { return null; },
  async listChapters() { return []; },
  async getPageUrls(ch: string) { return Array.from({ length: pageCount.get(ch) ?? 5 }, (_, i) => `https://example.invalid/${ch}/p${i}.png`); },
};

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any) => {
    const m = String(u).match(/\/([^/]+)\/p(\d+)\.png$/);
    if (!m) return realFetch(u);
    asked.push(`${m[1]}/${m[2]}`);
    if (failing.has(`${m[1]}/${m[2]}`)) return new Response('gone', { status: 404 });
    return new Response(await png(Number(m[2])), { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  ({ downloadChapter } = await import('../src/lib/downloader'));
  ({ completePartial } = await import('../src/lib/partial'));
  ({ setBookMeta, persistScan } = await import('../src/lib/library'));
  ({ clearPace } = await import('../src/lib/pace'));
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(adapter as any);
  registerAdapter({ ...adapter, id: ADULT_SRC, name: 'Partial Complete Adult', isNsfw: true } as any);
  registerAdapter({ ...adapter, id: ALT, name: 'Partial Alternate' } as any);
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1,'T!pcomp','Partial Complete',$2,0,$3,'pc-1')`, [S, FOLDER, SRC]);

  // The two routes that carry the page list off the server: the offline manifest and the Komga-compatible
  // page list Mihon reads. Both go through owned.bookPages.
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  const uid = (await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'admin','x','password') RETURNING id`, [USER]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/downloads')).default);
  await app.ready();
  headers = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
});
// A five-page fixture chapter at four of five is under NEAR_COMPLETE, so the seeding download puts the source
// in a cooldown exactly as it should live -- and the completion pass rightly skips a source in a cooldown.
// Cleared before every test, as chapterActions.int.test.ts does, so each test starts where its cause is.
beforeEach(async () => {
  asked = [];
  clearPace();
  if (DSN) await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, ALT, ADULT_SRC]]).catch(() => {});
});
after(async () => {
  globalThis.fetch = realFetch;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, ALT, ADULT_SRC]]).catch(() => {});
});

const abs = (n: number) => join(DL, FOLDER, `Chapter ${n}.cbz`);
const entries = (file: string): Map<string, Buffer> =>
  new Map(new AdmZip(file).getEntries().map((e: any) => [e.entryName, e.getData()]));
const row = async (n: number) => (await q(
  `SELECT id, series_id, root, file, number, missing_pages, source_id, pages, page_dims, size, fp_at, short_confirmed_at FROM lib_books WHERE series_id = $1 AND number = $2`, [S, n],
))[0];
/** A written partial for chapter `n` with page 4 (index 3) missing, scanned and stamped as the sweep would. */
async function partial(n: number): Promise<any> {
  failing.add(`c${n}/3`);
  const err = await downloadChapter({ sourceId: SRC, seriesFolder: FOLDER, chapter: { sourceId: `c${n}`, number: n }, meta: { series: 'Partial Complete' } })
    .then(() => null, (e: any) => e);
  assert.deepEqual(err?.partial?.missing, [3], 'the hold is offered');
  const w = await err.partial.write();
  await persistScan();
  await setBookMeta(FOLDER, [{ number: n, source: SRC, missing: w.missing.map((i: number) => i + 1) }]);
  // The seeding download is not the subject: neither its requests nor the cooldown it earned.
  asked = [];
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
  return row(n);
}

test('setBookMeta stamps the placeholder pages 1-based, and the DTO and page list carry them', { skip }, async () => {
  // Reintroduce by dropping `missing_pages = v.miss` from setBookMeta's UPDATE: the column stays NULL and
  // the series page cannot say the chapter has a page missing.
  const b = await partial(1);
  assert.deepEqual(b.missing_pages, [4], 'lib_books.missing_pages is 1-based: the fourth page');
  assert.equal(b.source_id, SRC);

  const dto = await owned.book(SYSTEM_CTX, b.id);
  assert.deepEqual(dto.missingPages, [4], 'the book DTO carries it');
  // Reintroduce by returning the page list unmarked from bookPages in ownedCatalog.ts: `missing` is
  // undefined on entry 4, and the reader has no way to caption the placeholder.
  const pages = await owned.bookPages(SYSTEM_CTX, b.id);
  assert.equal(pages.length, 5, 'five pages: the placeholder counts, so the reader lays out the right length');
  assert.deepEqual(pages.map((p: any) => p.missing ?? false), [false, false, false, true, false], 'exactly page 4 is marked');
  assert.equal(pages[3].fileName, '0004.png', 'the placeholder sits in its index slot');
  assert.equal(pages[3].width, 40, 'sized like the page beside it');
  // The first read cached page_dims; the second read answers from the cache and must mark the same page.
  assert.ok(Array.isArray((await row(1)).page_dims), 'page_dims was cached by the read');
  const again = await owned.bookPages(SYSTEM_CTX, b.id);
  assert.deepEqual(again.map((p: any) => p.missing ?? false), [false, false, false, true, false], 'marked from the cache too');

  // The page list route and the offline manifest carry the mark off the server; the reader and the offline
  // copy both read it from there. Reintroduce by dropping `missing: p.missing || undefined` from the
  // manifest mapping in routes/downloads.ts: the offline copy of a partial chapter has no caption to show.
  const list = await app.inject({ method: 'GET', url: `/api/books/${b.id}/pages`, headers });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().map((p: any) => p.missing ?? false), [false, false, false, true, false], 'GET /api/books/:id/pages marks it');
  const manifest = await app.inject({ method: 'GET', url: `/api/books/${b.id}/download-manifest`, headers });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.json().pageCount, 5, 'the offline copy has the full length');
  assert.deepEqual(manifest.json().pages.map((p: any) => p.missing ?? false), [false, false, false, true, false], 'and the mark travels with it');

  // A complete chapter, or a partial landing complete later, stamps NULL.
  await setBookMeta(FOLDER, [{ number: 1, source: SRC }]);
  assert.equal((await row(1)).missing_pages, null, 'no `missing` on the landing clears the mark');
  assert.equal((await owned.book(SYSTEM_CTX, b.id)).missingPages, null);
  await setBookMeta(FOLDER, [{ number: 1, source: SRC, missing: [4] }]); // put it back for the next test
});

test('the completion pass asks for exactly the missing page, merges it by index, and clears what was derived from the old bytes', { skip }, async () => {
  // Reintroduce by dropping the `DELETE FROM page_hashes WHERE book_id` from restampBook in partial.ts: the
  // hash computed from the PLACEHOLDER survives the rewrite and the `hashes of the old bytes are gone`
  // assertion reads 2 -- and live, three partial chapters would make the placeholder a "repeated page".
  // (Keeping the old placeholder entry in the merge is NOT a reintroduction: adm-zip replaces a duplicate
  // name, so the real page wins either way; the byte-identity checks below pin the merge itself.)
  const b = await row(1);
  const before = entries(abs(1));
  assert.ok(before.has('uchiyomi-partial.json'), 'a partial to begin with');
  // Things the old bytes produced, which must not survive the rewrite.
  await q('INSERT INTO page_hashes (book_id, page, hash) VALUES ($1, 0, NULL), ($1, 4, $2)', [b.id, '0000000000000000']);
  await q('UPDATE lib_books SET fp_at = now(), short_confirmed_at = now() WHERE id = $1', [b.id]);
  assert.ok((await row(1)).page_dims, 'page_dims cached from the previous test');

  failing.delete('c1/3'); // the page is back
  const out = await completePartial(await row(1), { alternates: async () => [] });
  assert.equal(out, 'completed');
  assert.deepEqual(asked, ['c1/3'], 'the source was asked for the one missing page, once, and nothing else');

  const after = entries(abs(1));
  assert.ok(!after.has('uchiyomi-partial.json'), 'no manifest: the chapter is whole');
  assert.deepEqual([...after.keys()], ['0001.png', '0002.png', '0003.png', '0004.png', '0005.png', 'ComicInfo.xml'],
    'stored in page order, the filled page in its slot rather than appended');
  for (const name of ['0001.png', '0002.png', '0003.png', '0005.png', 'ComicInfo.xml']) {
    assert.ok(before.get(name)!.equals(after.get(name)!), `${name} is byte-identical: only the hole was touched`);
  }
  assert.ok(after.get('0004.png')!.equals(await png(3)), 'slot 4 holds the real page now');
  assert.ok(!before.get('0004.png')!.equals(after.get('0004.png')!), 'and it is not the placeholder any more');

  const r = await row(1);
  assert.equal(r.missing_pages, null, 'the column is NULL');
  assert.equal(r.page_dims, null, 'page_dims dropped: it described the placeholder');
  assert.equal(r.fp_at, null, 'the fingerprint is due again');
  // Reintroduce by removing `short_confirmed_at = NULL` from the SET in restampBook: a chapter proven to
  // be two pages stays "proven" over a file that has since been rewritten, and the Health page would go
  // quiet about a download that failed a second time.
  assert.equal(r.short_confirmed_at, null, 'a proof about the old bytes says nothing about these ones');
  assert.equal(r.pages, 5);
  assert.equal(Number(r.size), (await stat(abs(1))).size, 'size is the new file');
  assert.equal((await q('SELECT count(*)::int AS n FROM page_hashes WHERE book_id = $1', [b.id]))[0].n, 0, 'hashes of the old bytes are gone');
  assert.equal((await owned.book(SYSTEM_CTX, b.id)).missingPages, null);
  assert.deepEqual((await owned.bookPages(SYSTEM_CTX, b.id)).map((p: any) => p.missing ?? false), [false, false, false, false, false]);
});

test('a page that is still missing leaves the file and the row exactly as they were', { skip }, async () => {
  // Reintroduce by writing the archive unconditionally (dropping the `filled.length` guard): the file's
  // mtime moves and the `untouched` assertion fails on the bytes' timestamp.
  await partial(2);
  const bytes = await readFile(abs(2));
  const mtime = (await stat(abs(2))).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const out = await completePartial(await row(2), { alternates: async () => [] });
  assert.equal(out, 'unchanged');
  assert.deepEqual(asked, ['c2/3'], 'asked once for the one hole -- no retry pass in the completion pass');
  assert.ok(bytes.equals(await readFile(abs(2))), 'untouched');
  assert.equal((await stat(abs(2))).mtimeMs, mtime, 'not even rewritten with the same bytes');
  assert.deepEqual((await row(2)).missing_pages, [4]);
});

test('the completion pass applies its age predicate to the old copy and fallback copies', { skip }, async () => {
  // Reintroduce by omitting `allowed` from completePartial's same-copy gate or fallback call: this asks
  // pc-src for the hole, or pc-adult for the whole chapter, on behalf of a viewer/clean-series rule that
  // excluded both.
  await partial(8);
  let hunts = 0;
  const out = await completePartial(await row(8), {
    alternates: async () => [{ source: ADULT_SRC, sourceId: 'adult-c8', number: 8 }],
    allowed: () => false,
    hunt: async () => { hunts++; return null; },
  });
  assert.equal(out, 'unchanged');
  assert.deepEqual(asked, [], 'neither the old source nor the alternate was reached');
  assert.equal(hunts, 0, 'a source excluded before any attempt does not provoke a hunt');
  assert.deepEqual((await row(8)).missing_pages, [4]);
});

test('a worse alternate is rejected before it can replace the canonical partial', { skip }, async () => {
  // The canonical copy has one hole in ten; the alternate has two. The old completion path let fallback
  // write the worse file first and restored ours afterward, leaving a crash window with real-page loss.
  pageCount.set('c6', 10);
  const b = await partial(6);
  pageCount.set('alt6', 10);
  failing.add('alt6/2');
  failing.add('alt6/3');
  const bytes = await readFile(abs(6));
  const out = await completePartial(b, {
    alternates: async () => [{ source: ALT, sourceId: 'alt6', number: 6 }],
  });
  assert.equal(out, 'unchanged');
  assert.ok(bytes.equals(await readFile(abs(6))), 'a rejected alternate wrote before the comparison');
  assert.deepEqual((await row(6)).missing_pages, [4], 'the canonical one-hole marker survived');
});

test('a corrupt manifest keeps the missing-page marker for a later retry', { skip }, async () => {
  const b = await partial(7);
  const zip = new AdmZip(abs(7));
  zip.updateFile('uchiyomi-partial.json', Buffer.from('{not json'));
  zip.writeZip(abs(7));
  const out = await completePartial(b, { alternates: async () => [] });
  assert.equal(out, 'unchanged');
  assert.deepEqual((await row(7)).missing_pages, [4], 'an unreadable manifest was mistaken for a complete file');
});

test('a chapter the source re-sliced is fetched whole, because the old indices mean nothing', { skip }, async () => {
  // Reintroduce by treating a length mismatch like a match (fetching `missing` against the new urls): the
  // chapter keeps five pages with page 4 of the new slicing in slot 4, and `six pages` fails.
  await partial(3);
  pageCount.set('c3', 6);
  failing.delete('c3/3');
  const out = await completePartial(await row(3), { alternates: async () => [] });
  assert.equal(out, 'completed');
  assert.deepEqual([...entries(abs(3)).keys()].sort(), ['0001.png', '0002.png', '0003.png', '0004.png', '0005.png', '0006.png', 'ComicInfo.xml'], 'six pages');
  const r = await row(3);
  assert.equal(r.missing_pages, null);
  assert.equal(r.pages, 6, 'the row says six too');
});

test('a chapter whose file has no manifest any more is "gone" and its column is cleared', { skip }, async () => {
  // A refetch or a hand-copied complete file: the mark outlived the placeholders. Reintroduce by returning
  // 'unchanged' without the UPDATE when the manifest is missing: the badge never goes away.
  await partial(4);
  // Rewrite the file complete, the way the admin refetch would, without telling the row.
  failing.delete('c4/3');
  const r = await downloadChapter({ sourceId: SRC, seriesFolder: FOLDER, chapter: { sourceId: 'c4', number: 4 } }, { replace: true });
  assert.equal(r?.pages, 5, 'replace: true writes over the partial');
  asked = [];
  const out = await completePartial(await row(4), { alternates: async () => [] });
  assert.equal(out, 'gone');
  assert.deepEqual(asked, [], 'nothing was asked of the source');
  assert.equal((await row(4)).missing_pages, null);
});

test('replace is what bypasses the on-disk skip, and only replace', { skip }, async () => {
  // Reintroduce by dropping `!opts.replace &&` from the stat check in downloadChapter: the second call
  // below downloads again and `null` reads as an object.
  const first = await downloadChapter({ sourceId: SRC, seriesFolder: FOLDER, chapter: { sourceId: 'c5', number: 5 } });
  assert.equal(first?.pages, 5);
  asked = [];
  assert.equal(await downloadChapter({ sourceId: SRC, seriesFolder: FOLDER, chapter: { sourceId: 'c5', number: 5 } }), null, 'already on disk: null, no request');
  assert.deepEqual(asked, []);
  const again = await downloadChapter({ sourceId: SRC, seriesFolder: FOLDER, chapter: { sourceId: 'c5', number: 5 } }, { replace: true });
  assert.equal(again?.pages, 5, 'with replace the file is fetched and written again');
  assert.equal(asked.length, 5);
});
