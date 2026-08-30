// A chapter that did not fully download must not be written as if it had.
//
// This is behavioural on purpose. The repo already had regex-over-source guards standing in for coverage on
// exactly this path, and a regex cannot tell you that seventeen of twenty pages was packed and returned as
// success. The bug: `worst` was only consulted when EVERY page failed, so a partial chapter was written,
// reported as complete, and -- because an existing file is skipped on sight -- never fetched again. The
// reader simply stopped early, permanently, and nothing recorded it.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Set before the module graph loads: DL_ROOT is read once, at import, and the downloader writes real files.
const ROOT = mkdtempSync(join(tmpdir(), 'uy-dl-'));
process.env.DL_ROOT = ROOT;
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let downloadChapter: typeof import('../src/lib/downloader')['downloadChapter'];

/** A one-pixel PNG, comfortably over the 256-byte floor the downloader uses to skip blocked responses. */
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);

let served: number[] = [];
const realFetch = globalThis.fetch;

/** Serves `ok` pages, then fails the rest — the exact shape of a chapter that dies part-way. */
function serve(ok: number) {
  served = [];
  globalThis.fetch = (async (u: any) => {
    const n = served.length; served.push(n);
    if (n < ok) {
      return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('nope', { status: 503 });
  }) as typeof fetch;
}

before(async () => {
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = await import('../src/lib/downloader'));
  registerAdapter({
    id: 'test-partial',
    name: 'Test Partial',
    search: async () => [],
    getSeries: async () => null,
    listChapters: async () => [],
    // Five pages, always.
    getPageUrls: async () => ['a', 'b', 'c', 'd', 'e'].map((p) => `https://example.invalid/${p}.png`),
  } as any);
});
beforeEach(() => { served = []; });
after(async () => { globalThis.fetch = realFetch; await rm(ROOT, { recursive: true, force: true }); });

const chapter = (n: number, pages?: number) => ({ sourceId: `c${n}`, number: n, pages });
const exists = (rel: string) => stat(join(ROOT, rel)).then(() => true).catch(() => false);

test('a complete chapter is written', async () => {
  serve(5);
  const r = await downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Whole', chapter: chapter(1) } as any);
  assert.equal(r.pages, 5);
  assert.equal(await exists('T/Whole/Chapter 1.cbz'), true);
});

test('THE TRUNCATION: a chapter missing pages is refused, not written', async () => {
  // Four of five. Before this, that was packed and returned `{ pages: 4 }` as a success.
  //
  // Reintroduce by consulting `worst` only when `n === 0`: this resolves instead of throwing, and the
  // assertion below that no file was left behind is the one that really matters -- a written short chapter
  // is skipped forever afterwards.
  serve(4);
  await assert.rejects(
    downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Short', chapter: chapter(2) } as any),
    /incomplete chapter: 4 of 5 pages/,
  );
  assert.equal(await exists('T/Short/Chapter 2.cbz'), false, 'a truncated chapter was left on disk and will never be retried');
});

test('the source\'s own page count wins over the number of urls', async () => {
  // MangaDex reports `pages` per chapter. If it says 5 and the url list is short, the chapter is still
  // incomplete -- trusting the url list alone would call it whole.
  serve(5);
  await assert.rejects(
    downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Declared', chapter: chapter(3, 9) } as any),
    /incomplete chapter: 5 of 9 pages/,
  );
  assert.equal(await exists('T/Declared/Chapter 3.cbz'), false);
});

test('a chapter where nothing downloaded still reports as blocked', async () => {
  // The pre-existing behaviour, which must survive: zero pages is a source problem, not just a short read.
  serve(0);
  await assert.rejects(
    downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/None', chapter: chapter(4) } as any),
    (e: any) => !!e.blockStatus,
  );
});
