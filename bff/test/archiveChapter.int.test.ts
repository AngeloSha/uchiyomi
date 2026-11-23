// A chapter a source hands over as ONE finished archive (SourceAdapter.archive).
//
// PandaChaika publishes every gallery only as a zip, and the extension it was read with unzipped it client-side,
// so those "pages" never existed as URLs. The downloader stores that zip instead: the site's own api.json is kept,
// a spec ComicInfo.xml (PageCount, not the <Pages> number Suwayomi writes) is added over it, and the file lands by
// the same rules as a page-built chapter -- so a library made by the pack holds the file the extension left behind.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-archive-'));
  process.env.DATABASE_URL = DSN;
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SRC = 'archive-src';
const ZIP_URL = 'https://archive.example.invalid/1.zip';
const API_URL = 'https://archive.example.invalid/api.json';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const API = JSON.stringify({ gallery: 7, title: 'Secret', filecount: 2, filesize: 900 });
let q: any, downloadChapter: any;
/** What the site's own zip holds; api.json is a sidecar here, the case the downloader must fill in. */
const siteZip = () => {
  const z = new AdmZip();
  z.addFile('001.png', PIXEL);
  z.addFile('002.png', PIXEL);
  return z.toBuffer();
};

const chapter = { sourceId: '7', number: 1, title: 'Secret', pages: 2 };
const meta = { series: 'Secret', url: 'https://archive.example.invalid/archive/7/', genres: ['doujinshi'] };

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = (await import('../src/lib/downloader')) as any);
  await migrate();
  registerAdapter({
    id: SRC, name: 'Archive Source',
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async () => { throw new Error('archive source has no page list'); },
    archive: async (id: string) => id === '7' ? { url: ZIP_URL, files: [{ name: 'api.json', url: API_URL }] } : null,
  });
});

beforeEach(() => {
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    if (url === ZIP_URL) return new Response(siteZip(), { status: 200, headers: { 'content-type': 'application/vnd.comicbook+zip' } });
    if (url === API_URL) return new Response(API, { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

test('an archive chapter is stored whole, with api.json kept and a spec ComicInfo', { skip }, async () => {
  const r = await downloadChapter({ sourceId: SRC, seriesFolder: 'Archive Source/Secret', chapter, meta });
  assert.equal(r.pages, 2);
  const zip = new AdmZip(await readFile(join(ROOT, 'Archive Source/Secret/Chapter 1.cbz')));
  const names = zip.getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names, ['001.png', '002.png', 'ComicInfo.xml', 'api.json']);
  assert.equal(zip.readAsText('api.json'), API, "the site's own api.json is kept byte for byte");
  const xml = zip.readAsText('ComicInfo.xml');
  assert.match(xml, /<PageCount>2<\/PageCount>/, 'the spec count, not a bare <Pages>');
  assert.doesNotMatch(xml, /<Pages>/);
  assert.match(xml, /<Series>Secret<\/Series>/);
  assert.match(xml, /<Web>https:\/\/archive\.example\.invalid\/archive\/7\/<\/Web>/);
});

test('a second call sees the file and downloads nothing', { skip }, async () => {
  let asked = 0;
  globalThis.fetch = (async (u: any) => {
    asked++;
    return new Response(String(u) === API_URL ? API : siteZip(), { status: 200 });
  }) as typeof fetch;
  assert.equal(await downloadChapter({ sourceId: SRC, seriesFolder: 'Archive Source/Secret', chapter, meta }), null);
  assert.equal(asked, 0);
});

test('an archive the site refuses names the refusal, so the run stops', { skip }, async () => {
  globalThis.fetch = (async () => new Response('no', { status: 403 })) as typeof fetch;
  await assert.rejects(
    () => downloadChapter({ sourceId: SRC, seriesFolder: 'Archive Source/Refused', chapter, meta }),
    (e: any) => e.blockStatus === 'blocked',
  );
  const row = (await q(`SELECT status FROM source_health WHERE source_id = $1`, [SRC]))[0];
  assert.equal(row?.status, 'blocked');
});

test('archive() returning null leaves the page path alone', { skip }, async () => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { registerAdapter } = await import('../src/lib/sources/loader');
  registerAdapter({
    id: 'mixed-src', name: 'Mixed Source',
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async () => ['https://archive.example.invalid/p1.png'],
    archive: async () => null,
  });
  const r = await downloadChapter({ sourceId: 'mixed-src', seriesFolder: 'Mixed Source/Thing', chapter: { sourceId: 'x', number: 1, pages: 1 }, meta });
  assert.equal(r.pages, 1);
});
