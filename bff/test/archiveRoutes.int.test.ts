// The slow archive's routes (#117), driven through Fastify with real accounts: who may queue, pause, resume and
// stop; which rows each viewer is shown; the add dialog's "archive the rest slowly"; the series page's line and
// ghost reason; the admin's pacing settings; the Fetch refused while the archive writes the same series.
//
// The scheduler itself -- what it starts, waits for and leaves behind -- is archive.int.test.ts.
//
// Skipped unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-archroutes-'));
  DL = join(ROOT, 'dl');
  mkdirSync(DL, { recursive: true });
  mkdirSync(join(ROOT, 'lib'), { recursive: true });
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.ARCHIVE_PAGE_GAP_MS = '0,0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '3000';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LIB_A = 'lib_ar_a', LIB_B = 'lib_ar_b';
const SRC = 'ar-src', ADULT = 'ar-adult', ADD = 'ar-add';
const S = (k: string) => `s_ar_${k}`;
const USERS = ['ar-admin', 'ar-member', 'ar-other', 'ar-capped', 'ar-nodl', 'ar-free'];
const ids = { admin: '', member: '', other: '', capped: '', nodl: '', free: '' };

let q: any, one: any, app: any, arch: typeof import('../src/lib/archive'), jobBusy: (f: string) => boolean;
const as = (id: string, role = 'user') => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
const H = () => ({
  admin: as(ids.admin, 'admin'), member: as(ids.member), other: as(ids.other), capped: as(ids.capped), nodl: as(ids.nodl),
  free: as(ids.free),
});

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  if (String(u).includes('example.invalid/')) return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  return realFetch(u, init);
}) as typeof fetch;

const holds = new Map<string, Promise<void>>();
function adapter(id: string, n: number, extra: Record<string, unknown> = {}) {
  return {
    id, name: `AR ${id}`, ...extra,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: `Added ${sid}` }; },
    async listChapters(sid: string) { return Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, sourceId: `${sid}/c${i + 1}` })); },
    async getPageUrls(chId: string) { const h = holds.get(chId); if (h) await h; return [0, 1].map((i) => `https://example.invalid/${chId}/${i}.png`); },
    async latest() { return []; },
  };
}

async function series(key: string, lib: string, src: string, o: { age?: number } = {}) {
  const id = S(key);
  await q('DELETE FROM lib_series WHERE id = $1 OR folder = $2', [id, `ar/${key}`]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, age_rating, source_checked_at)
           VALUES ($1,'T!ar',$2,$3,0,$4,$5,$6,true,$7,now())`, [id, `AR ${key}`, `ar/${key}`, lib, src, `${key}-ref`, o.age ?? null]);
  mkdirSync(join(DL, 'ar', key), { recursive: true });
  const { updateSeries } = await import('../src/lib/updater');
  assert.equal((await updateSeries(id, 0)).outcome, 'ok');
  return id;
}

const post = (url: string, headers: Record<string, string>, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload });
const queue = async (headers: Record<string, string>, seriesIds: string[]) => {
  const r = await post('/api/sources/archive', headers, { seriesIds });
  assert.equal(r.statusCode, 200, r.body);
  return new Map<string, any>(r.json().results.map((x: any) => [x.id, x]));
};
const archiveOf = async (headers: Record<string, string>) => {
  const r = await app.inject({ method: 'GET', url: '/api/sources/jobs?adult=1', headers });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().archive;
};
const rowOf = (id: string) => one('SELECT * FROM archive_queue WHERE series_id = $1', [id]);
async function until(what: string, f: () => Promise<boolean>, ms = 15_000) {
  const t0 = Date.now();
  while (!(await f())) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(25); }
}

let SA = '', SB = '', SX = '', SN = '';

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q, one } = (await import('../src/lib/db')) as any);
  arch = await import('../src/lib/archive');
  const { registerAdapter } = await import('../src/lib/sources');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sources = await import('../src/routes/sources');
  jobBusy = sources.jobBusy;
  const adminRoutes = (await import('../src/routes/admin')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  await migrate();
  registerAdapter(adapter(SRC, 4) as any);
  registerAdapter(adapter(ADULT, 4, { isNsfw: true }) as any);
  registerAdapter(adapter(ADD, 6) as any);
  await q('DELETE FROM source_health WHERE source_id LIKE $1', ['ar-%']);
  for (const [id, name] of [[LIB_A, 'AR A'], [LIB_B, 'AR B']]) await q(`INSERT INTO libraries (id, name, path) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING`, [id, name]);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  const mk = async (name: string, role: string, perms: any = {}, cap: number | null = null) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating) VALUES ($1,$1,'x',$2,'password',$3::jsonb,$4) RETURNING id`,
      [name, role, JSON.stringify(perms), cap]))[0].id;
  ids.admin = await mk('ar-admin', 'admin');
  ids.member = await mk('ar-member', 'user');
  ids.other = await mk('ar-other', 'user');
  ids.capped = await mk('ar-capped', 'user', {}, 13);
  ids.nodl = await mk('ar-nodl', 'user', { canDownload: false });
  // A member with no grants and no cap: every library, so a series they add is one they can see.
  ids.free = await mk('ar-free', 'user');
  // The members see library A only; the capped member every library, under an age cap of 13.
  for (const u of [ids.member, ids.other, ids.nodl]) await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [u, LIB_A]);

  SA = await series('a', LIB_A, SRC);
  SB = await series('b', LIB_B, SRC);
  SX = await series('x', LIB_A, SRC, { age: 18 });
  SN = await series('n', LIB_A, ADULT);
  await q('UPDATE server_settings SET archive_min_free_gb = 1, archive_paused = false, archive_per_hour = 4, archive_window_from = NULL, archive_window_to = NULL WHERE id = 1');

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sources.default);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.ready();
});

beforeEach(async () => {
  if (!DSN) return;
  await arch.archiveIdle();
  arch.resetArchiveMemory();
  await q(`DELETE FROM archive_queue WHERE series_id LIKE 's_ar_%' OR series_id IN (SELECT id FROM lib_series WHERE folder LIKE 'AR ar-add/%')`);
  await q(`DELETE FROM archive_pace WHERE source_id LIKE 'ar-%'`);
});

after(async () => {
  if (!DSN) return;
  await arch.archiveIdle();
  await app?.close();
  await q(`DELETE FROM archive_queue WHERE series_id LIKE 's_ar_%' OR series_id IN (SELECT id FROM lib_series WHERE folder LIKE 'AR ar-add/%')`);
  await q(`DELETE FROM archive_pace WHERE source_id LIKE 'ar-%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_ar_%' OR folder LIKE 'AR ar-add/%'`);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  await q('UPDATE server_settings SET archive_min_free_gb = 20, archive_paused = false, archive_per_hour = 4, archive_window_from = NULL, archive_window_to = NULL WHERE id = 1');
  const { pool } = await import('../src/lib/db');
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
});

test('who may queue: canDownload members for series they may see, inside their age cap', { skip }, async () => {
  const h = H();
  assert.equal((await post('/api/sources/archive', h.nodl, { seriesIds: [SA] })).statusCode, 403, 'no download permission, no archive');
  assert.equal((await post('/api/sources/archive', h.member, { seriesIds: [] })).statusCode, 400);
  assert.equal((await post('/api/sources/archive', h.member, { seriesIds: Array.from({ length: 501 }, (_, i) => `x${i}`) })).statusCode, 400);

  const m = await queue(h.member, [SA, SB, 'no-such-series']);
  assert.equal(m.get(SA).outcome, 'queued');
  assert.equal(m.get(SA).title, 'AR a');
  assert.equal(m.get(SB).outcome, 'not_found', 'a library the member is not granted');
  assert.equal(m.get(SB).title, undefined, 'and not a word about what is in it');
  assert.equal(m.get('no-such-series').outcome, 'not_found');
  assert.equal((await rowOf(SA)).added_by, ids.member);
  assert.equal((await queue(h.member, [SA])).get(SA).outcome, 'already');

  const c = await queue(h.capped, [SN, SX]);
  assert.equal(c.get(SX).outcome, 'not_found', 'rated above the cap: not visible at all');
  // Reintroduce by dropping the followed-source cap check in enqueueArchive: this reads queued.
  assert.equal(c.get(SN).outcome, 'denied', 'a capped member cannot queue a series an adult source serves');
  assert.equal(await rowOf(SN), null);

  const audit = await one(`SELECT detail FROM audit_log WHERE event = 'download.archive' AND user_id = $1 ORDER BY at DESC LIMIT 1`, [ids.member]);
  assert.deepEqual(audit?.detail?.seriesIds, [SA], 'audited, with what was queued');
});

test('pause, resume and stop: the enqueuer or an admin, 404 to one who cannot see it, 409 once finished', { skip }, async () => {
  const h = H();
  assert.equal((await queue(h.member, [SA])).get(SA).outcome, 'queued');
  // Reintroduce by dropping the enqueuer-or-admin check: another member's pause reads 200.
  assert.equal((await post(`/api/sources/archive/${SA}/pause`, h.other)).statusCode, 403, 'another member may not pause it');
  assert.equal((await post(`/api/sources/archive/${SA}/pause`, h.capped)).statusCode, 403);
  assert.equal((await post(`/api/sources/archive/${SA}/pause`, h.member)).statusCode, 200);
  assert.equal((await rowOf(SA)).state, 'paused');
  assert.equal((await post(`/api/sources/archive/${SA}/resume`, h.admin)).statusCode, 200, 'an admin may');
  assert.equal((await rowOf(SA)).state, 'queued');

  assert.equal((await queue(h.admin, [SB])).get(SB).outcome, 'queued');
  assert.equal((await post(`/api/sources/archive/${SB}/pause`, h.member)).statusCode, 404, 'not visible: not there');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/sources/archive/${SB}`, headers: h.member })).statusCode, 404);
  assert.equal((await post('/api/sources/archive/no-such/pause', h.admin)).statusCode, 404);

  await q(`UPDATE archive_queue SET state = 'done', finished_at = now() WHERE series_id = $1`, [SA]);
  assert.equal((await post(`/api/sources/archive/${SA}/pause`, h.member)).statusCode, 409);
  assert.equal((await post(`/api/sources/archive/${SA}/resume`, h.member)).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/sources/archive/${SA}`, headers: h.other })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/sources/archive/${SA}`, headers: h.member })).statusCode, 200, 'dismissed by its enqueuer');
  assert.equal(await rowOf(SA), null);
  assert.ok(await one(`SELECT 1 FROM audit_log WHERE event = 'download.archive_stop' AND user_id = $1`, [ids.member]));
  // A finished row is re-opened by queueing it again.
  assert.equal((await queue(h.admin, [SB])).get(SB).outcome, 'already');
  await q(`UPDATE archive_queue SET state = 'done', done_count = 3, finished_at = now() WHERE series_id = $1`, [SB]);
  assert.equal((await queue(h.admin, [SB])).get(SB).outcome, 'queued');
  const re = await rowOf(SB);
  assert.equal(re.state, 'queued');
  assert.equal(re.done_count, 0, 'counts start again');
});

test("the queue follows the viewer: each sees only rows they may browse, from one shared cache", { skip }, async () => {
  const h = H();
  assert.equal((await queue(h.member, [SA])).get(SA).outcome, 'queued');
  assert.equal((await queue(h.admin, [SB, SX])).get(SX).outcome, 'queued');

  const admin = await archiveOf(h.admin);
  assert.deepEqual(admin.series.map((r: any) => r.seriesId).sort(), [SA, SB, SX].sort());
  assert.equal(admin.series.find((r: any) => r.seriesId === SA).mine, false, "the member's, not the admin's");
  assert.equal(admin.series.find((r: any) => r.seriesId === SB).mine, true);
  assert.equal(admin.paused, false);
  assert.equal(admin.perHour, 4);
  assert.equal(admin.window, null);
  const a = admin.series.find((r: any) => r.seriesId === SA);
  assert.equal(a.state, 'queued');
  assert.equal(a.left, 4, 'four listed, none held');
  assert.ok(a.etaMs > 0, 'an estimate');
  assert.ok(!('addedBy' in a), 'who queued it stays on the server');

  // Straight after the admin, inside the shared cache's ten seconds.
  // Reintroduce by answering every row (dropping the filter in archiveView): the member reads SB.
  const member = await archiveOf(h.member);
  assert.deepEqual(member.series.map((r: any) => r.seriesId).sort(), [SA, SX].sort(), "the member's library only, never the admin's answer replayed");
  assert.equal(member.series.find((r: any) => r.seriesId === SA).mine, true);
  const capped = await archiveOf(h.capped);
  assert.deepEqual(capped.series.map((r: any) => r.seriesId).sort(), [SA, SB].sort(), 'rated above the cap: left out');
  const direct = await app.inject({ method: 'GET', url: '/api/sources/archive?adult=1', headers: h.member });
  assert.equal(direct.statusCode, 200);
  assert.deepEqual(direct.json().series.map((r: any) => r.seriesId).sort(), [SA, SX].sort(), 'the archive alone, by the same rule');
});

test("the series page: its ghosts read 'archive' and it carries the archive's line", { skip }, async () => {
  const h = H();
  const before = await app.inject({ method: 'GET', url: `/api/series/${SA}/listing`, headers: h.member });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().archive, null);
  assert.ok(before.json().content.every((g: any) => g.why === 'missing'));
  assert.equal((await queue(h.member, [SA])).get(SA).outcome, 'queued');
  const r = await app.inject({ method: 'GET', url: `/api/series/${SA}/listing`, headers: h.member });
  const body = r.json();
  assert.deepEqual(body.content.map((g: any) => g.why), ['archive', 'archive', 'archive', 'archive']);
  assert.equal(body.archive.state, 'queued');
  assert.equal(body.archive.left, 4);
  assert.equal(body.archive.mine, true);
  // v0.49.1: the admin's pause of every archive rides on the line. The page read it only from the queue, which a viewer
  // who may not download is refused, and their run row said "being archived slowly" under the pause. Reintroduce by
  // leaving it out of archiveSummaryFor: the line does not say; by answering false: the reader cannot tell.
  assert.equal(body.archive.pausedForAll, false, 'the line does not say whether every archive is paused');
  const other = (await app.inject({ method: 'GET', url: `/api/series/${SA}/listing`, headers: h.other })).json();
  assert.equal(other.archive.mine, false, "another member sees it is not theirs to stop");

  assert.equal((await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: h.nodl })).statusCode, 403, 'PREMISE: the queue is refused to them');
  const patch = (archivePaused: boolean) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: h.admin, payload: { archivePaused } });
  assert.equal((await patch(true)).statusCode, 200);
  try {
    const reader = (await app.inject({ method: 'GET', url: `/api/series/${SA}/listing`, headers: h.nodl })).json();
    assert.equal(reader.archive.state, 'queued', "PREMISE: its own row is not paused");
    assert.equal(reader.archive.pausedForAll, true, 'a viewer who may not download cannot tell every archive is paused');
  } finally {
    await patch(false);
  }
});

test("the add dialog's 'archive the rest slowly'", { skip }, async () => {
  const h = H();
  // The free member: a member granted only library A would add into the default library, which they cannot see,
  // and an archive is only ever queued for a series its enqueuer may see (that answers not_found).
  const add = (sourceId: string, extra: Record<string, unknown>) => post('/api/sources/add', h.free, { source: ADD, sourceId, archive: true, ...extra });
  const idOf = async (sourceId: string) => (await one('SELECT id FROM lib_series WHERE folder = $1', [`AR ${ADD}/Added ${sourceId}`]))?.id as string | undefined;
  await q(`DELETE FROM lib_series WHERE folder LIKE 'AR ar-add/%'`);

  // Nothing yet: everything the source lists is the archive's, from chapter one.
  const none = await add('none1', { chapterFrom: 'none' });
  assert.equal(none.statusCode, 200, none.body);
  assert.equal(none.json().archive, 'queued');
  const noneRow = await rowOf(none.json().seriesId);
  assert.ok(Math.abs(Number(noneRow.boundary) - 6.001) < 1e-4, 'the boundary is the nothing-yet floor');
  assert.equal(noneRow.direction, 'up');
  assert.equal(noneRow.added_by, ids.free);
  // The granted-to-A member's add lands where they cannot see it: nothing is queued on their behalf.
  const walled = await post('/api/sources/add', h.member, { source: ADD, sourceId: 'walled1', chapterFrom: 'none', archive: true });
  assert.equal(walled.json().archive, 'not_found');

  // Latest 2: the download answers first, and the rest is queued once chapter one is in and the listing written.
  const latest = await add('latest1', { chapterFrom: 'newest', chapterCount: 2 });
  assert.equal(latest.statusCode, 200, latest.body);
  assert.equal(latest.json().archive, 'later');
  await until('the latest add to queue its rest', async () => { const id = await idOf('latest1'); return !!id && !!(await rowOf(id)); });
  const latestRow = await rowOf((await idOf('latest1'))!);
  assert.equal(latestRow.direction, 'down', 'grown down from the chapters the person picked');
  assert.equal(Number(latestRow.boundary), 5, 'at the floor the add wrote');
  assert.equal(Number((await one('SELECT chapter_floor FROM lib_series WHERE id = $1', [latestRow.series_id])).chapter_floor), 5);

  // The whole listing: there is no rest to archive.
  const all = await add('all1', {});
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().archive, 'nothing');
  await until('the whole add to land', async () => !!(await idOf('all1')));
  await sleep(200);
  assert.equal(await rowOf((await idOf('all1'))!), null);

  // Without the switch nothing is queued and the answer says nothing about it.
  const plain = await post('/api/sources/add', h.free, { source: ADD, sourceId: 'plain1', chapterFrom: 'none' });
  assert.equal(plain.json().archive, undefined);
  assert.equal(await rowOf(plain.json().seriesId), null);
  await until('the adds to settle', async () => !jobBusy(`AR ${ADD}/Added latest1`) && !jobBusy(`AR ${ADD}/Added all1`));
});

test('pacing is the admin\'s: settings round-trip, the window comes in pairs, and a pause shows on the view', { skip }, async () => {
  const h = H();
  const patch = (headers: Record<string, string>, payload: unknown) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers, payload });
  const settings = async () => (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: h.admin })).json();
  assert.equal((await patch(h.member, { archivePerHour: 10 })).statusCode, 403, 'members do not set the pace');
  const ok = await patch(h.admin, { archivePerHour: 10, archiveMinFreeGb: 2 });
  assert.equal(ok.statusCode, 200, ok.body);
  let s = await settings();
  assert.equal(s.archive_per_hour, 10);
  assert.equal(s.archive_min_free_gb, 2);
  assert.equal(typeof s.archive_free_gb, 'number', 'the free space the floor is set against');
  assert.notEqual((await patch(h.admin, { archivePerHour: 31 })).statusCode, 200, 'above the range');
  assert.notEqual((await patch(h.admin, { archivePerHour: 0 })).statusCode, 200);
  assert.notEqual((await patch(h.admin, { archiveWindowFrom: 22 })).statusCode, 200, 'one end of a window alone');
  assert.notEqual((await patch(h.admin, { archiveWindowFrom: 22, archiveWindowTo: null })).statusCode, 200, 'half cleared');
  s = await settings();
  assert.equal(s.archive_window_from, null, 'nothing was written by a refused request');
  assert.equal((await patch(h.admin, { archiveWindowFrom: 22, archiveWindowTo: 6 })).statusCode, 200);
  s = await settings();
  assert.deepEqual([s.archive_window_from, s.archive_window_to], [22, 6]);
  assert.deepEqual((await archiveOf(h.member)).window, { from: 22, to: 6 });
  assert.equal((await patch(h.admin, { archiveWindowFrom: null, archiveWindowTo: null })).statusCode, 200);
  assert.equal((await settings()).archive_window_from, null);

  assert.equal((await patch(h.admin, { archivePaused: true })).statusCode, 200);
  const v = await archiveOf(h.member);
  assert.equal(v.paused, true);
  assert.equal(v.waiting?.why, 'paused');
  assert.equal((await patch(h.admin, { archivePaused: false, archivePerHour: 4, archiveMinFreeGb: 1 })).statusCode, 200);
});

test('a Fetch into a series the archive is writing is refused, and says why', { skip }, async () => {
  const h = H();
  assert.equal((await queue(h.admin, [SA])).get(SA).outcome, 'queued');
  let release!: () => void;
  holds.set(`a-ref/c1`, new Promise<void>((r) => { release = r; }));
  // Let go whatever happens: a chapter left held would keep after()'s archiveIdle() waiting for good.
  try {
    const t = await arch.archiveTick({ busy: jobBusy });
    assert.deepEqual(t.started.map((x) => x.number), [1]);
    assert.equal(arch.archiveBusy('ar/a'), true);
    const r = await post('/api/sources/fetch', h.admin, { seriesId: SA, numbers: [2] });
    assert.equal(r.statusCode, 409, r.body);
    // Reintroduce by keeping the old wording: a person is told "a download is running" with none in sight.
    assert.match(r.json().message, /slow archive/);
  } finally {
    holds.delete('a-ref/c1');
    release();
    await arch.archiveIdle();
  }
  assert.equal(arch.archiveBusy('ar/a'), false);
  assert.equal(jobBusy('ar/a'), false, 'and the series is free again');
});
