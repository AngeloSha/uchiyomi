// A tiny body that decodes as an image is a page; a tiny body that does not is still an empty body.
//
// The 256-byte floor in downloader.ts was there to catch a CDN answering 200 with nothing behind it, and it
// did. It also caught the last slice of a long strip: sources slice webtoons into fixed-height WebPs and
// the remainder slice is often blank, and an all-white WebP is 88-130 bytes. Every night that chapter was
// refused as "109 of 110 pages (empty body)", the ledger filled with 153 rows of that shape, and nothing
// said why. The floor now asks sharp before it refuses: a body with a width and a height is a page.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

// Set before the module graph loads: DL_ROOT is read once, at import, and the downloader writes real files.
const ROOT = mkdtempSync(join(tmpdir(), 'uy-tiny-'));
process.env.DL_ROOT = ROOT;
process.env.DOWNLOAD_PAGE_GAP_MS = '0';
process.env.DOWNLOAD_MIN_GAP_MS ||= '0';
process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0';
process.env.MIN_FREE_GB = '0';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let downloadChapter: typeof import('../src/lib/downloader')['downloadChapter'];
let clearPace: () => void;

/** The fixture the other downloader tests use: a PNG header and padding, over the floor, NOT decodable. */
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
/** A real, decodable, lossy WebP of a blank slice: the shape of the page the floor was refusing. */
let TINY: Buffer;

const realFetch = globalThis.fetch;
const urls = ['a', 'b', 'c', 'd', 'e'].map((p) => `https://example.invalid/${p}.png`);

/** Serves PIXEL for the first four pages and `last` (with its content-type) for the fifth. */
function serve(last: { body: Buffer | string; type: string }) {
  globalThis.fetch = (async (u: any) => {
    if (String(u).endsWith('/e.png')) return new Response(last.body, { status: 200, headers: { 'content-type': last.type } });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
}

before(async () => {
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = await import('../src/lib/downloader'));
  ({ clearPace } = await import('../src/lib/pace'));
  registerAdapter({
    id: 'test-tiny', name: 'Test Tiny',
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async () => urls,
  } as any);
  TINY = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).webp({ quality: 1 }).toBuffer();
  assert.ok(TINY.length < 256, `the fixture must be under the floor to prove anything: ${TINY.length} B`);
});
beforeEach(() => clearPace());
after(async () => { globalThis.fetch = realFetch; await rm(ROOT, { recursive: true, force: true }); });

const exists = (rel: string) => stat(join(ROOT, rel)).then(() => true).catch(() => false);

test('a real image under 256 bytes is a page: the chapter lands whole', async () => {
  // Reintroduce by restoring the bare `if (buf.length < 256) { worst = ...EMPTY_BODY; return; }` in
  // fetchPages: the blank last slice is refused, this rejects with "4 of 5 pages", and the chapter is back
  // to being retried every night for a page that was there all along.
  serve({ body: TINY, type: 'image/webp' });
  const res = await downloadChapter({ sourceId: 'test-tiny', seriesFolder: 'Tiny/S', chapter: { sourceId: 't1', number: 1 } });
  assert.ok(res, 'not skipped');
  assert.equal(res!.pages, 5, 'pages === expected: the tiny slice counted');
  assert.equal(await exists('Tiny/S/Chapter 1.cbz'), true);

  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(join(ROOT, 'Tiny/S/Chapter 1.cbz'));
  const last = zip.getEntry('0005.webp');
  assert.ok(last, 'the fifth page is in the fifth slot, under the extension the content-type gave it');
  assert.equal(last!.getData().length, TINY.length, 'byte for byte the body the site sent');
});

test('a small body that is not an image is still an empty body, whatever content-type it wears', async () => {
  // An error page or an empty CDN answer with `image/png` on it must not become a page because it is
  // small. Reintroduce by making isImage() return true unconditionally: this lands with a 100-byte text
  // file as page five.
  serve({ body: 'x'.repeat(100), type: 'image/png' });
  const err = await downloadChapter({ sourceId: 'test-tiny', seriesFolder: 'Tiny/S', chapter: { sourceId: 't2', number: 2 } })
    .then(() => null, (e) => e);
  assert.ok(err, 'refused');
  assert.match(String(err.message), /incomplete chapter: 4 of 5 pages/);
  assert.equal(err.blockStatus, undefined, 'an empty body under the soft bar is the chapter\'s problem, not the source\'s');
  assert.deepEqual(err.failedPages, [{ index: 4, status: 200, type: 'image/png', bytes: 100 }],
    'the evidence says exactly what arrived: a 200, image/png, 100 bytes');
  assert.equal(await exists('Tiny/S/Chapter 2.cbz'), false);

  const { reasonOf } = await import('../src/lib/chapterFailures');
  assert.equal(reasonOf(err), 'incomplete chapter: 4 of 5 pages (page 5: 200 image/png 100 B)');
});

test('an HTML body under an image content-type is an error page, and the evidence says so', async () => {
  // The hotlink guard is untouched by the sharp gate: it never reads the body, so its evidence carries the
  // type and no byte count. Reintroduce by dropping the `failed.set(...)` from the hotlink branch of
  // fetchPage: the chapter is still refused, but `failedPages` is empty and the ledger is back to saying
  // "4 of 5 pages" and nothing else.
  serve({ body: '<html>hotlink denied</html>', type: 'text/html' });
  const err = await downloadChapter({ sourceId: 'test-tiny', seriesFolder: 'Tiny/S', chapter: { sourceId: 't3', number: 3 } })
    .then(() => null, (e) => e);
  assert.ok(err);
  assert.deepEqual(err.failedPages, [{ index: 4, status: 200, type: 'text/html' }]);
});
