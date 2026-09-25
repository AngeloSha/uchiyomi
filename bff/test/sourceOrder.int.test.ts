// The source order (lib/sourcePrefs.ts, from #93): which followed source a chapter the server does not have
// yet is taken from. Pinned against the real updater, with files on disk:
//
//   - no order: the primary wins the tie, exactly as before the order existed;
//   - an order: the higher-ranked source's copy is taken instead;
//   - the scanlation group preferences still rank above it;
//   - a series' own order replaces the server's;
//   - nothing already held is fetched again because of an order -- the half of #93 that was not taken;
//   - the routes keep every id they are given, loaded or not (an order saved while the engine restarts must
//     not lose its extensions), and a series' order is cleared by null or an empty list.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-srcorder-'));
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

const LIB = 'lib_srcorder';
/** The source every series here was added from: the primary, which wins a tie by default. */
const PRIMARY = 'so-primary';
/** A followed source, which an order can put first. */
const FOLLOWER = 'so-follower';
const S = (k: string) => `s_so_${k}`;
const HELD = Buffer.from('the copy already on disk');
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const ADMIN = 'so-admin';

/** Page asks per source, as `<source>:<chapter number>`. */
const asked: string[] = [];
/** The group each source credits its copies to; none by default. */
const groupOf = new Map<string, string>();

function source(id: string) {
  return {
    id, name: `Zzz ${id}`,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() {
      return [1, 2, 3, 4, 5].map((n) => ({
        number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, pages: 5,
        ...(groupOf.has(id) ? { scanlator: groupOf.get(id) } : {}),
      }));
    },
    async getPageUrls(chId: string) {
      const n = Number(chId.split('-c').pop());
      asked.push(`${id}:${n}`);
      return Array.from({ length: 5 }, (_, i) => `https://example.invalid/${id}/${n}/${i}.png`);
    },
    async latest() { return []; },
  };
}

let q: any, updateSeries: any, invalidateSourcePrefs: any;
let savedScanlatorPrefs: unknown = null;

const file = (key: string, n: number) => join(ROOT, S(key), `Chapter ${n}.cbz`);

/** A series added from PRIMARY, following FOLLOWER too, holding chapters 1..`held` as files and rows. */
async function series(key: string, held = 4, own: string[] | null = null) {
  await q('DELETE FROM lib_series WHERE id = $1', [S(key)]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, source_prefs)
           VALUES ($1,'T!so',$1,$1,$2,$3,$4,$5,true,$6::jsonb)`,
  [S(key), held, LIB, PRIMARY, `${PRIMARY}-1`, own ? JSON.stringify({ priority: own }) : null]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,$3)`, [S(key), FOLLOWER, `${FOLLOWER}-1`]);
  rmSync(join(ROOT, S(key)), { recursive: true, force: true });
  mkdirSync(join(ROOT, S(key)), { recursive: true });
  for (let n = 1; n <= held; n++) {
    writeFileSync(file(key, n), HELD);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, source_id) VALUES ($1,$2,'T!so',$3,$4,$5,5,$6)`,
      [`${S(key)}_b${n}`, S(key), `${S(key)}/Chapter ${n}.cbz`, n, `Chapter ${n}`, PRIMARY]);
  }
}

async function order(priority: string[]) {
  await q(`UPDATE server_settings SET source_prefs = $1::jsonb WHERE id = 1`, [JSON.stringify({ priority })]);
  invalidateSourcePrefs();
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  ({ invalidateSourcePrefs } = (await import('../src/lib/sourcePrefs')) as any);
  await migrate();
  registerAdapter(source(PRIMARY) as any);
  registerAdapter(source(FOLLOWER) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'SrcOrder',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  savedScanlatorPrefs = (await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0]?.scanlator_prefs ?? null;
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
});

beforeEach(async () => {
  if (!DSN) return;
  asked.length = 0;
  groupOf.clear();
  await order([]);
  await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(savedScanlatorPrefs)]);
  // A cooldown left by one test would skip a listing in the next and pass "was not asked" for the wrong reason.
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[PRIMARY, FOLLOWER]]);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  // Shared database: an order or a group list left behind would change what every later suite downloads.
  await order([]).catch(() => {});
  await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(savedScanlatorPrefs)]).catch(() => {});
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[PRIMARY, FOLLOWER]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
});

test('with no order, the source the series was added from wins the tie, as it always did', { skip }, async () => {
  await series('none');
  const r = await updateSeries(S('none'), 10);
  assert.equal(r.added, 1);
  assert.deepEqual(asked, [`${PRIMARY}:5`]);
});

test('a new chapter comes from the higher-ranked source', { skip }, async () => {
  await order([FOLLOWER]);
  await series('ranked');
  const r = await updateSeries(S('ranked'), 10);
  // Reintroduce by going back to the follow order alone in updateSeries' `chooseOpts`: PRIMARY:5 is asked.
  assert.deepEqual(asked, [`${FOLLOWER}:5`]);
  assert.equal(r.added, 1);
});

test('the scanlation group preferences still rank above the source order', { skip }, async () => {
  await order([FOLLOWER]);
  groupOf.set(PRIMARY, 'Zzso Good Group');
  groupOf.set(FOLLOWER, 'Zzso Other Group');
  await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1',
    [JSON.stringify({ priority: ['Zzso Good Group'], blocked: [], patienceDays: 0 })]);
  await series('groups');
  await updateSeries(S('groups'), 10);
  // The order prefers FOLLOWER, the group ranking prefers PRIMARY's copy, and the group ranking decides.
  // Reintroduce by moving sourceRank ahead of the group rank in lib/releases.ts `releaseOrder`: FOLLOWER:5.
  assert.deepEqual(asked, [`${PRIMARY}:5`]);
});

test("a series' own order replaces the server's", { skip }, async () => {
  await order([FOLLOWER]);
  await series('own', 4, [PRIMARY]);
  await updateSeries(S('own'), 10);
  // Reintroduce by reading only the server's order (dropping `own` in effectiveSourcePriority): FOLLOWER:5.
  assert.deepEqual(asked, [`${PRIMARY}:5`]);
});

test('nothing already held is fetched again because of an order', { skip }, async () => {
  await order([FOLLOWER]);
  await series('held', 5);
  const r = await updateSeries(S('held'), 10);
  assert.equal(r.added, 0);
  assert.deepEqual(asked, [], `pages were asked for chapters already held: ${asked}`);
  for (let n = 1; n <= 5; n++) assert.deepEqual(readFileSync(file('held', n)), HELD, `chapter ${n} was replaced`);
});

test('the routes keep every id they are given, and a series order clears with null or an empty list', { skip }, async () => {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const admin = (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`,
    [ADMIN],
  ))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  try {
    // An extension id no engine has registered (the engine is restarting), a duplicate, a value that is not
    // an id at all, and a mixed-case id: kept, dropped, dropped, kept as written.
    const r = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers,
      payload: { sourcePrefs: { priority: ['sw:8683375824843625513', FOLLOWER, FOLLOWER, 'not an id!', 'Mixed-Case'] } } });
    assert.equal(r.statusCode, 200, r.body);
    // Reintroduce #93's admin list by filtering the order to registered sources: the sw: id is gone.
    assert.deepEqual(r.json().source_prefs, { priority: ['sw:8683375824843625513', FOLLOWER, 'Mixed-Case'] });
    const g = await app.inject({ method: 'GET', url: '/api/admin/settings', headers });
    assert.deepEqual(g.json().source_prefs, { priority: ['sw:8683375824843625513', FOLLOWER, 'Mixed-Case'] });

    await series('route');
    const seriesOrder = async () => (await app.inject({ method: 'GET', url: `/api/series/${S('route')}`, headers })).json().sourcePrefs;
    assert.equal(await seriesOrder(), null, 'a series with no order of its own reads null');
    const p = await app.inject({ method: 'PATCH', url: `/api/admin/series/${S('route')}`, headers, payload: { sourcePrefs: { priority: [FOLLOWER, PRIMARY] } } });
    assert.equal(p.statusCode, 200, p.body);
    assert.deepEqual(await seriesOrder(), { priority: [FOLLOWER, PRIMARY] });
    await app.inject({ method: 'PATCH', url: `/api/admin/series/${S('route')}`, headers, payload: { sourcePrefs: { priority: [] } } });
    assert.equal(await seriesOrder(), null, 'an empty order did not clear the series back to the server default');
    await app.inject({ method: 'PATCH', url: `/api/admin/series/${S('route')}`, headers, payload: { sourcePrefs: { priority: [PRIMARY] } } });
    await app.inject({ method: 'PATCH', url: `/api/admin/series/${S('route')}`, headers, payload: { sourcePrefs: null } });
    assert.equal(await seriesOrder(), null, 'null did not clear the series order');
  } finally {
    await app.close();
  }
});
