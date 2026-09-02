// Who gets blamed when a chapter comes back short.
//
// The chapter is refused either way: an incomplete chapter must never be written, because the file is then
// skipped on sight forever. What this file pins is the SECOND consequence, which is the one that went wrong.
//
// v0.11.0 called reportFail on any shortfall, so one flaky image put the whole source into an escalating
// cooldown. Live, that blocked mangakakalot over 98 of 101 pages and natomanga over 109 of 110, and because
// every caller breaks on `blockStatus`, a 92-chapter fill stopped after three. Over four nightly sweeps the
// library gained 26 chapters and lost 40.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-blame-'));
  process.env.DATABASE_URL = DSN;
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0'; // pacing is real now; timing it belongs in downloadPacing, not here
  process.env.MIN_FREE_GB = '0'; // the disk floor belongs to diskGuard.test.ts
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SRC = 'blame-src';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
let q: any, downloadChapter: any;

/** Fails exactly the pages at `bad`, every time. */
function serveExcept(bad: number[], status = 503) {
  const fail = new Set(bad);
  globalThis.fetch = (async (u: any) => {
    const i = Number(String(u).match(/p(\d+)\.png$/)?.[1] ?? -1);
    if (fail.has(i)) return new Response('nope', { status });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
}

/** Answers 200 with nothing behind it for the pages at `empty`, the way a CDN does when its origin is gone. */
function serveEmpty(empty: number[]) {
  const e = new Set(empty);
  globalThis.fetch = (async (u: any) => {
    const i = Number(String(u).match(/p(\d+)\.png$/)?.[1] ?? -1);
    if (e.has(i)) return new Response(Buffer.alloc(10), { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
}

const health = async () =>
  (await q(`SELECT status, consecutive, blocked_until FROM source_health WHERE source_id = $1`, [SRC]))[0] || null;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = (await import('../src/lib/downloader')) as any);
  await migrate();
  registerAdapter({
    id: SRC, name: 'Blame Source',
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async () => Array.from({ length: 110 }, (_, i) => `https://example.invalid/p${i}.png`),
  } as any);
});

beforeEach(async () => { if (DSN) await q('DELETE FROM source_health WHERE source_id = $1', [SRC]); });

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]).catch(() => {});
});

test('THE COOLDOWN: one page lost in a hundred leaves the source alone', { skip }, async () => {
  serveExcept([7]);
  await downloadChapter({ sourceId: SRC, seriesFolder: 'B/S', chapter: { sourceId: 'c1', number: 1 } })
    .then(() => assert.fail('an incomplete chapter must still be refused'), () => {});
  assert.equal(await health(), null,
    'no health row at all: 109 of 110 pages is a flaky CDN, not a source that has stopped serving');
});

test('a large shortfall still puts the source in a cooldown', { skip }, async () => {
  serveExcept(Array.from({ length: 30 }, (_, i) => i + 80));
  await downloadChapter({ sourceId: SRC, seriesFolder: 'B/S', chapter: { sourceId: 'c2', number: 2 } })
    .catch(() => {});
  const h = await health();
  assert.ok(h, 'losing a fifth of the chapter is the source, and must be recorded against it');
  assert.equal(h.consecutive, 1);
  assert.ok(h.blocked_until, 'and it earns a cooldown');
});

test('a refusal is a cooldown however few pages it lost', { skip }, async () => {
  serveExcept([3], 403);
  await downloadChapter({ sourceId: SRC, seriesFolder: 'B/S', chapter: { sourceId: 'c3', number: 3 } })
    .catch(() => {});
  const h = await health();
  assert.ok(h, '403 is the source saying no, at any page count');
});

test('a chapter that recovers on the retry clears nothing and blames nobody', { skip }, async () => {
  let firstPass = true;
  globalThis.fetch = (async (u: any) => {
    const i = Number(String(u).match(/p(\d+)\.png$/)?.[1] ?? -1);
    if (i === 5 && firstPass) { firstPass = false; return new Response('nope', { status: 503 }); }
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const res = await downloadChapter({ sourceId: SRC, seriesFolder: 'B/S', chapter: { sourceId: 'c4', number: 4 } });
  assert.equal(res.pages, 110, 'the retry saved it');
  const h = await health();
  assert.ok(!h || h.status === 'ok', 'and the source is not marked down for a page that arrived on the second ask');
});


/**
 * A 429 on the very first page.
 *
 * The retry block was guarded by `gaps.length < urls.length`, which is FALSE when nothing arrived -- so on a
 * first-page 429 the entire block was skipped, including the sleep the site had just asked for. Measured
 * live: "0/115 pages downloaded (HTTP 429)" was written 1.28 seconds after ONE request. That put the source
 * in an escalating cooldown and, because every caller breaks on blockStatus, abandoned the other 58 chapters
 * of the run. Three separate "it still won't download" reports were all this line.
 *
 * Reintroduce by restoring `if (gaps.length && gaps.length < urls.length)`: this test fails with
 * "no images downloaded (blocked?)" and a health row appears.
 */
test('a 429 on the FIRST page is waited out, not reported as "0 of 110"', { skip }, async () => {
  let refuse = true;
  globalThis.fetch = (async () => {
    if (refuse) { refuse = false; return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }); }
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  const res = await downloadChapter({ sourceId: SRC, seriesFolder: 'B/S', chapter: { sourceId: 'c5', number: 5 } });

  assert.equal(res.pages, 110, 'the chapter completes once Retry-After is honoured');
  // A completed download calls reportOk, so a row is expected here -- what must NOT be here is blame.
  const h = await health();
  assert.equal(h?.status ?? 'ok', 'ok', 'the burst was ours, and the site told us the remedy');
  assert.equal(Number(h?.consecutive ?? 0), 0, 'no strike against the source');
  assert.ok(!h?.blocked_until, 'and above all no cooldown, which is what abandoned the other 58 chapters');
});

/**
 * The protection this must not remove: a source that keeps refusing IS refusing.
 *
 * Waiting out a 429 is right; waiting forever is how a polite pause becomes a hammer. After MAX_RESUMES the
 * chapter is refused and the source earns its cooldown, exactly as before.
 */
test('a source that says 429 to everything is still eventually a refusal', { skip }, async () => {
  globalThis.fetch = (async () =>
    new Response('no', { status: 429, headers: { 'retry-after': '1' } })) as typeof fetch;

  await downloadChapter({ sourceId: SRC, seriesFolder: 'B/S', chapter: { sourceId: 'c6', number: 6 } })
    .then(() => assert.fail('a chapter that never arrived must be refused'), () => {});

  const h = await health();
  assert.ok(h, 'a sustained refusal still earns the cooldown');
  assert.equal(h.consecutive, 1);
});


/**
 * THE EMPTY BODY: a CDN answering 200 with nothing in it is not the source refusing.
 *
 * `if (buf.length < 256) return;` set no `worst`, so this was the one page failure that reached the blame
 * code as `worst === 0`, and classify(null, undefined) fell through to the harshest 'blocked' tier. Live:
 * 151 of 176 pages arrived, one chapter, a 30-minute cooldown on the source that carries 192 of 226 series,
 * 164 series skipped for the rest of the night, and not one line in the log.
 *
 * Reintroduce by restoring the two lines that did the damage, in place of the soft/blip/blameFor trio:
 *   const blip = ratio >= NEAR_COMPLETE && !refusing;
 *   const status: SourceStatus = worst === 1 ? 'down' : classify(null, worst >= 400 ? worst : undefined) || 'blocked';
 * The first test then finds a 'blocked' row. The second needs the bare `return` at the 256-byte check put
 * back as well, so `worst` stays 0 and falls through classify() to 'blocked': with the sentinel alone it
 * lands on 'down' only because EMPTY_BODY happens to equal the old network value. Restoring only the bare
 * `return` brings nothing back -- `worst === 0` is caught by the soft branch regardless. The sentinel names
 * the failure; the threshold and blameFor() are the fix.
 */
test('THE EMPTY BODY: a CDN serving nothing for a few pages is not the source refusing', { skip }, async () => {
  serveEmpty(Array.from({ length: 16 }, (_, i) => i + 40)); // 94 of 110 real: 0.855, under NEAR_COMPLETE
  const err = await downloadChapter({ sourceId: SRC, seriesFolder: 'B/S', chapter: { sourceId: 'c7', number: 7 } })
    .then(() => null, (e) => e);
  assert.ok(err, 'still refused: an incomplete chapter must never be written');
  assert.match(err.message, /incomplete chapter: 94 of 110/);
  assert.equal(err.blockStatus, undefined, 'and it must not end the caller\'s run');
  assert.equal(await health(), null, 'no strike, no cooldown: half the chapter arriving proves the CDN is up');
});

test('a CDN serving nothing for MOST of a chapter is an outage, and a mild one', { skip }, async () => {
  serveEmpty(Array.from({ length: 100 }, (_, i) => i)); // 10 of 110 real: under EMPTY_TOLERANCE
  const err = await downloadChapter({ sourceId: SRC, seriesFolder: 'B/S', chapter: { sourceId: 'c8', number: 8 } })
    .then(() => null, (e) => e);
  assert.equal(err?.blockStatus, 'down', 'an outage ends the run, at the 5-minute tier, not the 30-minute one');
  const h = await health();
  assert.equal(h?.status, 'down', 'down, never blocked: nobody refused anything');
  assert.equal(Number(h?.consecutive), 1);
});
