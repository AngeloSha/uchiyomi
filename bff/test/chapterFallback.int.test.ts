// The one-chapter fallback policy against real downloader writes and a scratch database.
//
// These tests deliberately enter through downloadWithFallback rather than mocking downloadChapter: the
// distinction between an incomplete copy (which may become a partial or switch source) and a refusal
// (which may switch to an already-followed source, but may never become a partial or start a hunt) is made
// by the downloader's page evidence.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-fallback-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const PRI = 'fb-pri', FOL = 'fb-fol', NEW = 'fb-new';
const failures = new Map<string, number>();
const asked: string[] = [];
const realFetch = globalThis.fetch;
let PIXEL: Buffer;
let q: any, downloadWithFallback: any, clearPace: () => void;

const adapter = (id: string) => ({
  id, name: id,
  async search() { return []; },
  async getSeries(sid: string) { return { sourceId: sid, source: id, title: 'Fallback Tale' }; },
  async listChapters() { return []; },
  async getPageUrls(chapterId: string) {
    const count = chapterId.includes('one') ? 1 : 5;
    return Array.from({ length: count }, (_, i) => `https://fb.invalid/${id}/${chapterId}/${i}.png`);
  },
});

before(async () => {
  if (!DSN) return;
  const sharp = (await import('sharp')).default;
  PIXEL = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#5a7fa2' } }).png().toBuffer();
  globalThis.fetch = (async (url: any) => {
    const m = String(url).match(/fb\.invalid\/([^/]+)\/([^/]+)\/(\d+)\.png$/);
    if (!m) return realFetch(url);
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    asked.push(key);
    const status = failures.get(key);
    if (status) return new Response(status === 429 ? 'slow down' : 'gone', { status, headers: status === 429 ? { 'retry-after': '0' } : {} });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  const { migrate } = await import('../src/lib/migrate');
  ({ q } = await import('../src/lib/db'));
  ({ downloadWithFallback } = await import('../src/lib/chapterFallback'));
  ({ clearPace } = await import('../src/lib/pace'));
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(adapter(PRI) as any);
  registerAdapter(adapter(FOL) as any);
  registerAdapter(adapter(NEW) as any);
});

beforeEach(async () => {
  failures.clear();
  asked.length = 0;
  clearPace?.();
  if (ROOT) {
    rmSync(join(ROOT, 'Fallback Tale'), { recursive: true, force: true });
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[PRI, FOL, NEW]]).catch(() => {});
  }
});

after(async () => {
  globalThis.fetch = realFetch;
  if (DSN) await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[PRI, FOL, NEW]]).catch(() => {});
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

const chapter = (source: string, sourceId: string, number: number, pinned = false) =>
  ({ source, sourceId, number, ...(pinned ? { pinned: true } : {}) });
const run = (chosen: any, alternates: any[] = [], extra: Record<string, unknown> = {}) => {
  const refusing = (extra.refusing as Set<string> | undefined) ?? new Set<string>();
  return {
    refusing,
    result: downloadWithFallback({
      seriesId: 's-fallback', title: 'Fallback Tale', folder: 'Fallback Tale',
      meta: { series: 'Fallback Tale' }, chapter: chosen,
      alternates: async () => alternates, refusing, ...extra,
    }),
  };
};

test('an incomplete chosen copy lands from the same-number follower and records the switch', { skip }, async () => {
  // Reintroduce by calling downloadChapter directly, or by dropping the alternate loop: this returns a
  // partial from fb-pri instead of the complete fb-fol copy.
  failures.set(`${PRI}/pri-five/4`, 404);
  const { result } = run(chapter(PRI, 'pri-five', 1), [chapter(FOL, 'fol-five', 1)]);
  const out = await result;
  assert.equal(out.kind, 'landed');
  assert.equal(out.via, FOL);
  assert.deepEqual(out.switched, { from: PRI, why: 'incomplete' });
  assert.ok(asked.some((x) => x.startsWith(`${FOL}/fol-five/`)), 'the follower was asked');
  assert.ok(existsSync(join(ROOT, 'Fallback Tale', 'Chapter 1.cbz')), 'the complete alternate was written');
});

test('a refusal costs one source strike but an already-followed alternate may still land', { skip }, async () => {
  failures.set(`${PRI}/pri-one/0`, 403);
  const refusing = new Set<string>();
  const { result } = run(chapter(PRI, 'pri-one', 2), [chapter(FOL, 'fol-one', 2)], { refusing });
  const out = await result;
  assert.equal(out.kind, 'landed');
  assert.equal(out.via, FOL);
  assert.equal(out.switched?.why, 'blocked');
  assert.deepEqual([...refusing], [PRI], 'the refusing source is not asked again this run');
  const health = (await q('SELECT consecutive FROM source_health WHERE source_id = $1', [PRI]))[0];
  assert.equal(Number(health?.consecutive), 1, 'one refusal is one health strike');
});

test('a pinned copy and the viewer age predicate both prevent alternate requests', { skip }, async (t) => {
  await t.test('pinned', async () => {
    failures.set(`${PRI}/pinned-one/0`, 404);
    const out = await run(chapter(PRI, 'pinned-one', 3, true), [chapter(FOL, 'fol-one', 3)]).result;
    assert.equal(out.kind, 'failed');
    assert.ok(!asked.some((x) => x.startsWith(`${FOL}/`)), 'the named version was not replaced');
  });
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[PRI, FOL]]);
  asked.length = 0;
  await t.test('age cap', async () => {
    failures.set(`${PRI}/denied-one/0`, 404);
    const out = await run(chapter(PRI, 'denied-one', 4), [chapter(FOL, 'fol-one', 4)], { allowed: (id: string) => id !== FOL }).result;
    assert.equal(out.kind, 'failed');
    assert.ok(!asked.some((x) => x.startsWith(`${FOL}/`)), 'an excluded source was never reached');
  });
});

test('the best incomplete hold is written only after every non-refusing option is exhausted', { skip }, async () => {
  failures.set(`${PRI}/partial-five/4`, 404);
  let hunts = 0;
  const out = await run(chapter(PRI, 'partial-five', 5), [], { hunt: async () => { hunts++; return null; } }).result;
  assert.equal(out.kind, 'partial');
  assert.deepEqual(out.missing, [4]);
  assert.equal(hunts, 1, 'an incomplete chapter is eligible for one hunt before its hold is written');
  assert.ok(existsSync(join(ROOT, 'Fallback Tale', 'Chapter 5.cbz')));
});

test('429 never writes a partial and never starts a hunt', { skip }, async () => {
  failures.set(`${PRI}/rate-five/4`, 429);
  let hunts = 0;
  const refusing = new Set<string>();
  const out = await run(chapter(PRI, 'rate-five', 6), [], {
    refusing,
    hunt: async () => { hunts++; return chapter(NEW, 'new-five', 6); },
  }).result;
  assert.equal(out.kind, 'failed');
  assert.equal(hunts, 0, 'a refusal is answered by its cooldown, not more source traffic');
  assert.ok(refusing.has(PRI));
  assert.equal(existsSync(join(ROOT, 'Fallback Tale', 'Chapter 6.cbz')), false, 'no placeholder archive was written');
});
