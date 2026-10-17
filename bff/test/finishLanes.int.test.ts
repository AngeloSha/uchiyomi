// The finishing sweep's lanes (v0.81.0, lib/updater.ts runUpdateAll, lib/finishDownloads.ts FINISH_LANES): series on
// different image servers are worked on side by side, and never two on one server, two through the extension engine or
// more chapters than the budget, however many lanes are open.
//
// Before, the finishing sweep took one series at a time across the whole library: a long series on a slow site held up
// every series on every other site, and the owner's first finishing pass ran past half an hour for 18 series.
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
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-lanes-'));
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_lanes';
/** Three sites on three image servers. */
const A = 'lane-a', B = 'lane-b', C = 'lane-c';
/** Another site on A's image server (one rate group): A's twin. */
const A2 = 'lane-a2';
/** Two extension-engine sources, each its own server: the engine is one process for both. */
const E1 = 'sw:lane-e1', E2 = 'sw:lane-e2';
const ALL = [A, B, C, A2, E1, E2];
const S = (k: string) => `s_lanes_${k}`;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
/** Chapters being fetched right now, the most at once, and every chapter asked for (`<series>:<n>`). */
let active = 0, peak = 0;
const asked: string[] = [];
/** How long a chapter's page list takes: long enough for two lanes to overlap. */
let pageMs = 250;
let q: any;

const adapter = (id: string, rateGroup?: string) => ({
  id, name: id, ...(rateGroup ? { rateGroup } : {}),
  async search() { return []; },
  async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
  async listChapters(sid: string) { return [1, 2].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${sid}:${n}` })); },
  async getPageUrls(chId: string) {
    asked.push(chId);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((r) => setTimeout(r, pageMs));
      return [`https://example.invalid/lanes/${encodeURIComponent(chId)}.png`];
    } finally {
      active--;
    }
  },
  async latest() { return []; },
});

/** A series on `source`, never checked (so behind), holding nothing, monitored. */
const mk = (key: string, source: string) =>
  q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
     VALUES ($1,'T!lanes',$1,$1,0,$2,$3,$1,true) ON CONFLICT (id) DO NOTHING`, [S(key), LIB, source]);
/** Only these series are monitored, and none of them is checked or holds anything yet: not even a file from a test before. */
const only = async (keys: string[]) => {
  for (const k of keys) rmSync(join(ROOT, S(k)), { recursive: true, force: true });
  await q(`UPDATE lib_series SET auto_update = (id = ANY($1::text[]))`, [keys.map(S)]);
  await q(`UPDATE lib_series SET source_checked_at = NULL, deleted_at = NULL, merged_into = NULL WHERE id = ANY($1::text[])`, [keys.map(S)]);
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1::text[])`, [keys.map(S)]);
  await q(`DELETE FROM chapter_failures WHERE series_id = ANY($1::text[])`, [keys.map(S)]);
};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(adapter(A, 'lane-a') as any);
  registerAdapter(adapter(A2, 'lane-a') as any);
  registerAdapter(adapter(B) as any);
  registerAdapter(adapter(C) as any);
  registerAdapter(adapter(E1) as any);
  registerAdapter(adapter(E2) as any);
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Lanes',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  for (const [k, src] of [['a', A], ['a2', A2], ['b', B], ['c', C], ['e1', E1], ['e2', E2]] as const) await mk(k, src);
});

beforeEach(async () => {
  if (!DSN) return;
  active = 0; peak = 0; asked.length = 0; pageMs = 250;
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [ALL]);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_lanes_%'`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_lanes_%'`).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [ALL]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('two series on two image servers finish side by side', { skip }, async () => {
  const { runUpdateAll } = await import('../src/lib/updater');
  await only(['a', 'b']);
  const r = await runUpdateAll({ behindOnly: true, maxNew: 2, sweepMax: 60 });
  // Reintroduce by running the finishing sweep one lane wide (lib/updater.ts `lanes`): a peak of one.
  assert.equal(peak, 2, `the two sites were asked one after the other: ${asked.join(', ')}`);
  assert.equal(r.added, 4, 'both series landed both chapters');
  assert.equal(r.stopped, undefined);
});

test('one image server never runs two at once', { skip }, async () => {
  const { runUpdateAll } = await import('../src/lib/updater');
  await only(['a', 'a2']);
  const r = await runUpdateAll({ behindOnly: true, maxNew: 2, sweepMax: 60 });
  // Reintroduce by keying the lanes on the source id instead of rateKeyOf: the twins run together, a peak of two.
  assert.equal(peak, 1, 'two sites on one image server are one site');
  assert.equal(r.added, 4);
});

test('never two lanes through the extension engine', { skip }, async () => {
  const { runUpdateAll } = await import('../src/lib/updater');
  await only(['e1', 'e2', 'b']);
  const r = await runUpdateAll({ behindOnly: true, maxNew: 2, sweepMax: 60 });
  // Two engine sources on two servers, and B beside them: B overlaps one of them, never both engine series at once.
  // Reintroduce by dropping the engine rule: a peak of three.
  assert.equal(peak, 2, `${asked.join(', ')}`);
  assert.equal(r.added, 6);
});

test('the budget holds across lanes', { skip }, async () => {
  const { runUpdateAll } = await import('../src/lib/updater');
  await only(['a', 'b', 'c']);
  const r = await runUpdateAll({ behindOnly: true, maxNew: 2, sweepMax: 3 });
  // Each lane reserves its chapters before it starts. Reintroduce by not reserving (each lane takes what is left of the
  // budget when it starts): three lanes of two, six chapters.
  assert.equal(asked.length, 3, `${asked.join(', ')}`);
  assert.equal(r.stopped, 'budget');
});

test('a yield stops every lane between chapters', { skip }, async () => {
  const { runUpdateAll } = await import('../src/lib/updater');
  const { wantQuiet, clearQuiet } = await import('../src/lib/finishDownloads');
  const { runtime } = await import('../src/lib/runtime');
  await only(['a', 'b', 'c']);
  pageMs = 400;
  runtime.finishing = true;
  try {
    const run = runUpdateAll({ behindOnly: true, maxNew: 2, sweepMax: 60 });
    const until = Date.now() + 20_000;
    while (asked.length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.equal(asked.length, 3, 'PREMISE: the three lanes are each inside a chapter');
    wantQuiet();
    const r = await run;
    // The three lanes were each inside their first chapter: each finishes it, and none starts its second.
    // Reintroduce by dropping `cancelled` from the lanes' visits: six chapters.
    assert.equal(r.stopped, 'yield');
    assert.equal(asked.length, 3, `${asked.join(', ')}`);
  } finally {
    runtime.finishing = false;
    clearQuiet();
  }
});

test('every other sweep stays one series at a time', { skip }, async () => {
  const { runUpdateAll } = await import('../src/lib/updater');
  await only(['a', 'b']);
  const r = await runUpdateAll({ maxNew: 2, sweepMax: 60 });
  // Reintroduce by opening the lanes for every sweep: a peak of two.
  assert.equal(peak, 1);
  assert.equal(r.added, 4);
});
