// Which copy the sweep downloads when the same release is on several followed sources (v0.81.0, lib/copyRouter.ts):
// the one at full speed, not the one that failed it last, on the quietest image server -- and never another group's
// copy, never past a source order an admin set. Against a real scratch database and the real sweep.
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
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-route-'));
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

const LIB = 'lib_route';
const MAIN = 'route-main', FOL = 'route-fol';
const S = (k: string) => `s_route_${k}`;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
/** Which source each chapter's page list was asked of. */
const askedOf: string[] = [];
/** The group each source names on its copies (per test). */
const groupOf = new Map<string, string>();
let q: any;
let clearPace: () => void;

const adapter = (id: string) => ({
  id, name: id,
  async search() { return []; },
  async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
  async listChapters(sid: string) {
    const g = groupOf.get(id) ?? 'Same Group';
    return [1].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}:${sid}:${n}`, scanlator: g, groups: [g] }));
  },
  async getPageUrls(chId: string) { askedOf.push(id); return [`https://example.invalid/route/${encodeURIComponent(chId)}.png`]; },
  async latest() { return []; },
});

/** A series on MAIN following FOL, holding nothing, never checked. */
async function series(key: string): Promise<string> {
  const id = S(key);
  rmSync(join(ROOT, id), { recursive: true, force: true });
  await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!route',$1,$1,0,$2,$3,$1,true)`, [id, LIB, MAIN]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $1)`, [id, FOL]);
  return id;
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ clearPace } = await import('../src/lib/pace'));
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(adapter(MAIN) as any);
  registerAdapter(adapter(FOL) as any);
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Route',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
});

beforeEach(async () => {
  if (!DSN) return;
  askedOf.length = 0;
  groupOf.clear();
  clearPace();
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[MAIN, FOL]]);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE id LIKE 's_route_%'`).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[MAIN, FOL]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  clearPace?.();
});

test('the chosen copy is taken while its site is at full speed', { skip }, async () => {
  const { updateSeries } = await import('../src/lib/updater');
  const id = await series('plain');
  const r = await updateSeries(id, 1);
  assert.equal(r.added, 1);
  assert.deepEqual(askedOf, [MAIN], 'PREMISE: the main is chosen first');
});

test('a slowed main gives way to the same release on a follower at full speed', { skip }, async () => {
  const { updateSeries } = await import('../src/lib/updater');
  const { noteRateLimited } = await import('../src/lib/pace');
  const id = await series('slow');
  noteRateLimited(MAIN);
  const r = await updateSeries(id, 1);
  assert.equal(r.added, 1);
  // Reintroduce by downloading the chosen copy always (lib/updater.ts `routable` false): the slowed main is asked.
  assert.deepEqual(askedOf, [FOL]);
});

test('never another group\'s copy: a follower with a different release is not the same chapter', { skip }, async () => {
  const { updateSeries } = await import('../src/lib/updater');
  const { noteRateLimited } = await import('../src/lib/pace');
  const id = await series('group');
  groupOf.set(FOL, 'Other Group');
  noteRateLimited(MAIN);
  const r = await updateSeries(id, 1);
  assert.equal(r.added, 1);
  // Reintroduce by routing over every copy of the number (dropping sameReleaseChapters): the other group's is taken.
  assert.deepEqual(askedOf, [MAIN]);
});

test('the source that failed a chapter last is asked after its twin', { skip }, async () => {
  const { updateSeries } = await import('../src/lib/updater');
  const id = await series('blamed');
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts, reason) VALUES ($1, 1, $2, 'error', 1, 'no page urls')`, [id, MAIN]);
  const r = await updateSeries(id, 1);
  assert.equal(r.added, 1);
  // Reintroduce by dropping `blamed` from routeCopy's order: the main that failed it is asked again first.
  assert.deepEqual(askedOf, [FOL]);
});

test('a source order an admin set is kept', { skip }, async () => {
  const { updateSeries } = await import('../src/lib/updater');
  const { noteRateLimited } = await import('../src/lib/pace');
  const id = await series('ordered');
  await q(`UPDATE lib_series SET source_prefs = $2::jsonb WHERE id = $1`, [id, JSON.stringify({ priority: [MAIN] })]);
  noteRateLimited(MAIN);
  const r = await updateSeries(id, 1);
  assert.equal(r.added, 1);
  // Reintroduce by routing whatever the order (dropping the `priority` test): the follower is asked.
  assert.deepEqual(askedOf, [MAIN]);
});
