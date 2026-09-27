// What GET /api/sources/jobs tells each viewer, and who may dismiss a card (v0.49.0, the Downloads view).
//
// The Downloads view lists everything this route answers, so the route's gaps would be the view's:
//
//   - a job card is shown by its folder's series row through browsable() -- library grants, the age cap, the
//     18+ hide -- for EVERY viewer, not only while the 18+ hide is on; a folder with no row yet (an add whose
//     first chapter is still in flight) is its starter's and an admin's. The activity feed and a run's
//     current series go through the same helper;
//   - a failed card is its starter's and an admin's on top of that (it is never swept);
//   - a card names its series (`seriesId`, from the folder's row) and, once it has failed, the chapters it did
//     not land (`left`), which is what Try again sends back;
//   - DELETE /api/sources/jobs/:folder is its starter's or an admin's, answered before the 409 for a running one.
//
// Skipped unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-dlview-'));
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SRC = 'dv-src';
/** A second source, for the job that is refused: a refusal puts its source in a cooldown. */
const REFUSING = 'dv-refusing';
/** A third, for an add from Discover: it has a cover, three chapters, and refuses the second. */
const ADDING = 'dv-adding';
const COVER = 'https://example.invalid/covers/dv-added.jpg';
const LIB_A = 'lib_dv_a';
const LIB_B = 'lib_dv_b';
const USERS = ['dv-admin', 'dv-member', 'dv-capped', 'dv-other'];
/** The folder of an add whose first chapter is still in flight: no series row exists for it yet. */
const NEW = 'dv-new/Brand New';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);

/** While set, the gated chapter's page list waits on it, so its job stays `downloading`. */
let gate: Promise<void> | null = null;
let openGate: () => void = () => {};
const adapter = (id: string) => ({
  id, name: `Zzz ${id}`,
  async search() { return []; },
  async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
  async listChapters() { return []; },
  async getPageUrls(chId: string) {
    if (chId.startsWith('gated') && gate) await gate;
    return [0, 1].map((i) => `https://example.invalid/${chId}/${i}.png`);
  },
  async latest() { return []; },
});

let q: any;
const ids = { admin: '', member: '', capped: '', other: '' };
let app: any;
const as = (id: string, role = 'user') => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
const who = () => ({
  admin: as(ids.admin, 'admin'), member: as(ids.member), capped: as(ids.capped), other: as(ids.other),
});
/**
 * ⚠️ `adult=1` (the "Show 18+" reveal) throughout, and it must stay. Without it the 18+ hide is on, and the route
 * filtered cards through browsable() even before v0.49.0 -- so every assertion below would pass against the old
 * route. The leak was a member with the reveal ON receiving the cards of libraries their grants or age cap shut
 * them out of: the hide is a surfacing preference, the grants and the cap are permissions, and only the
 * permissions are left to filter here.
 */
const jobsFor = async (headers: Record<string, string>) => {
  const r = await app.inject({ method: 'GET', url: '/api/sources/jobs?adult=1', headers });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const folders = async (headers: Record<string, string>) => (await jobsFor(headers)).content.map((j: any) => j.folder).sort();
const cardOf = async (folder: string) => (await jobsFor(who().admin)).content.find((j: any) => j.folder === folder);
async function until(what: string, f: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Every row this file makes, by id and by folder: a library scan mints its own ids for the folders it finds. */
const OURS = `id LIKE 's_dv_%' OR folder LIKE 's_dv_%' OR folder LIKE 'dv-new/%' OR folder LIKE 'Zzz dv-adding/%'`;

/**
 * Until no library scan has started for a moment. Every job here ends with a detached scan of its own, after
 * its card already reads failed, so without this the cleanup raced it and the scan put the rows back.
 */
async function scansSettle(): Promise<void> {
  const { persistScan, scanCount } = await import('../src/lib/library');
  for (;;) {
    const n = scanCount();
    await sleep(300);
    if (scanCount() === n) return;
    await persistScan().catch(() => {});
  }
}

/** A series with its own folder under the download root. */
async function series(id: string, lib: string, extra: { age?: number; source?: string } = {}) {
  await q('DELETE FROM lib_series WHERE id = $1 OR folder = $1', [id]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, age_rating, source_id, source_series_id)
           VALUES ($1,'Zzz',$1,$1,0,$2,$3,$4,$5)`, [id, lib, extra.age ?? null, extra.source ?? SRC, `${id}-x`]);
  rmSync(join(ROOT, id), { recursive: true, force: true });
  mkdirSync(join(ROOT, id), { recursive: true });
}
const chapters = (key: string, source: string, n = 2) =>
  Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, sourceId: `${key}-c${i + 1}`, source }));

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(adapter(SRC) as any);
  registerAdapter(adapter(REFUSING) as any);
  registerAdapter({
    ...adapter(ADDING),
    async getSeries(sid: string) { return { sourceId: sid, source: ADDING, title: 'Dv Added', coverUrl: COVER }; },
    async listChapters() { return chapters('addref', ADDING, 3).map(({ source: _s, ...c }) => c); },
  } as any);
  for (const l of [LIB_A, LIB_B]) await q(`INSERT INTO libraries (id, name, path) VALUES ($1,$1,$1) ON CONFLICT (id) DO NOTHING`, [l]);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  const mk = async (u: string, role: string, cap: number | null = null) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating)
              VALUES ($1,$1,'x',$2,'password',$3) RETURNING id`, [u, role, cap]))[0].id as string;
  ids.admin = await mk('dv-admin', 'admin');
  ids.member = await mk('dv-member', 'user');
  ids.capped = await mk('dv-capped', 'user', 16);
  ids.other = await mk('dv-other', 'user');
  // The member may open library A only; the capped member every library, below 18.
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [ids.member, LIB_A]);
  await q(`DELETE FROM lib_series WHERE ${OURS}`);
  await series('s_dv_a', LIB_A);
  await series('s_dv_b', LIB_B);
  await series('s_dv_adult', LIB_A, { age: 18 });
  await series('s_dv_fail', LIB_A, { source: REFUSING });
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, REFUSING, ADDING]]);
  // Every page is an image, except the refusing sources' second chapters: the site says no (403).
  globalThis.fetch = (async (u: any) => (/\/(refuse|addref)-c2\//.test(String(u))
    ? new Response('no', { status: 403 })
    : new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } }))) as typeof fetch;
  (await import('../src/lib/downloadActivity')).clearActivity();

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
});

after(async () => {
  openGate();
  if (DSN) await scansSettle();
  if (app) await app.close();
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  (await import('../src/lib/downloadJobs')).clearRuns();
  if (!DSN) return;
  await q(`DELETE FROM chapter_failures WHERE series_id IN (SELECT id FROM lib_series WHERE ${OURS})`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE ${OURS}`).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, REFUSING, ADDING]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB_A, LIB_B]]).catch(() => {});
});

test('cards and activity go to who may see each series; a folder with no row yet to its starter and admins', { skip }, async () => {
  const { startDownloadJob } = await import('../src/routes/sources');
  // Three finished Fetches, all started by `other`: one per library, and one rated 18 in the member's library.
  for (const s of ['s_dv_a', 's_dv_b', 's_dv_adult']) {
    startDownloadJob({ folder: s, title: s, seriesId: s, chapters: chapters(s, SRC), meta: { series: s }, by: ids.other });
    await until(`${s} to finish`, async () => (await cardOf(s))?.status === 'done');
  }
  // And an add's first chapter, held in flight: its folder is not a series yet.
  gate = new Promise<void>((r) => { openGate = r; });
  startDownloadJob({ folder: NEW, title: 'Brand New', seriesId: '', chapters: chapters('gated', SRC, 1), meta: { series: 'Brand New' }, by: ids.other });
  await until('the new add to be in flight', async () => (await jobsFor(who().admin)).activity.active.some((e: any) => e.folder === NEW));

  const w = who();
  // Reintroduce by showing a folder with no row to everyone (`seen.folder` answering true without a row): the
  // member and the capped member see 'Brand New'.
  for (const h of [w.member, w.capped]) {
    assert.ok(!(await folders(h)).includes(NEW), 'an add that is not a series yet is not shown to a member who did not start it');
  }
  // Reintroduce by filtering cards only under the 18+ hide, as before v0.49.0 (`if (!vc(req).hideAdultLibraries)
  // return { content: all, ... }`): with the reveal on, the member sees library B's card and the capped member
  // the adult one.
  assert.deepEqual(await folders(w.member), ['s_dv_a', 's_dv_adult'], 'a member receives no card for a series they cannot open');
  assert.deepEqual(await folders(w.capped), ['s_dv_a', 's_dv_b'], 'a capped member receives no card above their age cap');
  assert.deepEqual(await folders(w.admin), [NEW, 's_dv_a', 's_dv_adult', 's_dv_b'].sort(), 'an admin sees every card');
  assert.deepEqual(await folders(w.other), [NEW, 's_dv_a', 's_dv_adult', 's_dv_b'].sort(), 'the starter sees their add before it is a series');

  // The activity feed, by the same helper: what came in, and what is in flight.
  const titles = async (h: Record<string, string>) => {
    const a = (await jobsFor(h)).activity;
    return [...new Set([...a.active, ...a.recent].map((e: any) => e.title))].sort();
  };
  assert.deepEqual(await titles(w.member), ['s_dv_a', 's_dv_adult']);
  assert.deepEqual(await titles(w.capped), ['s_dv_a', 's_dv_b']);
  assert.deepEqual(await titles(w.admin), ['Brand New', 's_dv_a', 's_dv_adult', 's_dv_b']);
  assert.deepEqual(await titles(w.other), ['Brand New', 's_dv_a', 's_dv_adult', 's_dv_b']);

  // The card names its series from the folder's row: a Fetch never stamped one. Reintroduce by mapping the
  // cards without `seriesId: j.seriesId ?? seen.row(folder)?.id`: the card has none.
  const a = (await jobsFor(w.member)).content.find((j: any) => j.folder === 's_dv_a');
  assert.equal(a.seriesId, 's_dv_a', 'a Fetch card carries its series id');
  assert.equal(a.mine, false);
  assert.ok(!('by' in a), 'who started a job left the server');
  assert.equal(a.left, undefined, 'a job that finished has nothing left to fetch');
  const mine = (await jobsFor(w.other)).content.find((j: any) => j.folder === NEW);
  assert.equal(mine.mine, true);
  assert.equal(mine.seriesId, undefined, 'no row, no id');

  // A run's current series is held to the same rule, by id. Reintroduce by dropping the redaction: the member
  // reads the title of a series in a library they cannot open.
  const { beginRun } = await import('../src/lib/downloadJobs');
  const run = beginRun('newest', ids.member, 3);
  run.current = { id: 's_dv_b', title: 's_dv_b' };
  const memberRun = (await jobsFor(w.member)).runs.find((r: any) => r.kind === 'newest');
  assert.ok(memberRun, 'the starter sees their own bulk run');
  assert.equal(memberRun.current, undefined, "a run's current series outside the viewer's libraries is not named");
  assert.equal((await jobsFor(w.admin)).runs.find((r: any) => r.kind === 'newest').current?.title, 's_dv_b', 'an admin still reads it');
});

test('a failed card is its starter\'s and an admin\'s, and names the chapters it did not land', { skip }, async () => {
  const { startDownloadJob } = await import('../src/routes/sources');
  // Four chapters from a source that refuses the second: the first lands, the second is refused, and with
  // every source it could draw on refusing, the job stops there.
  startDownloadJob({
    folder: 's_dv_fail', title: 's_dv_fail', seriesId: 's_dv_fail',
    chapters: chapters('refuse', REFUSING, 4), meta: { series: 's_dv_fail' }, by: ids.other,
  });
  await until('the refused job to stop', async () => (await cardOf('s_dv_fail'))?.status === 'error');
  const w = who();
  const failed = await cardOf('s_dv_fail');
  assert.equal(failed.done, 1);
  // Reintroduce by dropping the `j.left = leftOf(...)` line at the end of startDownloadJob: no `left`.
  assert.deepEqual(failed.left, [2, 3, 4], 'a job that ends in error names the chapters it did not land');

  // Reintroduce by dropping `admin || j.status !== 'error' || by === me`: the member's list has it.
  assert.ok(!(await folders(w.member)).includes('s_dv_fail'), "a member does not receive someone else's failed card");
  assert.ok(!(await folders(w.capped)).includes('s_dv_fail'));
  assert.ok((await folders(w.other)).includes('s_dv_fail'), 'its starter does');
  assert.ok((await folders(w.admin)).includes('s_dv_fail'), 'and an admin does');
  // The chapters themselves are activity like any other: every viewer who may browse the series sees them.
  const recent = (await jobsFor(w.member)).activity.recent.filter((e: any) => e.folder === 's_dv_fail');
  assert.deepEqual(recent.map((e: any) => `${e.number}:${e.status}`).sort(), ['1:done', '2:failed']);
});

test('only its starter or an admin may dismiss a card, and that is answered before a running one\'s 409', { skip }, async () => {
  const w = who();
  const del = (folder: string, h: Record<string, string>) =>
    app.inject({ method: 'DELETE', url: `/api/sources/jobs/${encodeURIComponent(folder)}`, headers: h });
  // Reintroduce by dropping the starter/admin check in the DELETE route: this is a 200, and the card is gone.
  assert.equal((await del('s_dv_fail', w.member)).statusCode, 403, "another member dismissed someone else's failed card");
  assert.equal((await del('s_dv_fail', w.capped)).statusCode, 403);
  assert.ok(await cardOf('s_dv_fail'), 'a refused dismiss removed the card');
  assert.equal((await del('s_dv_fail', w.other)).statusCode, 200, 'its starter may');
  assert.equal(await cardOf('s_dv_fail'), undefined);
  assert.equal((await del('s_dv_a', w.admin)).statusCode, 200, 'an admin may dismiss anyone\'s');
  // Still running: the ownership answer comes first, then the 409 for the one who may dismiss it. Reintroduce by
  // moving the check below the 409: the member is told the download is running.
  assert.equal((await del(NEW, w.member)).statusCode, 403, 'the ownership answer comes before the 409');
  assert.equal((await del(NEW, w.other)).statusCode, 409);
  assert.equal((await del('nope', w.member)).statusCode, 404);
  openGate();
  await until('the add to land', async () => (await cardOf(NEW))?.status !== 'downloading');
});

test("an add's card carries its source's cover, and a failed add names what it did not land", { skip }, async () => {
  const w = who();
  const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: w.other, payload: { source: ADDING, sourceId: 'dv-added' } });
  assert.equal(r.statusCode, 200, r.body);
  const folder = r.json().folder as string;
  assert.equal(r.json().started, true, r.body);
  // Chapter one lands, the second is refused, and with one source there is nowhere else to take it from.
  await until('the add to stop', async () => (await cardOf(folder))?.status === 'error');
  const card = (await jobsFor(w.other)).content.find((j: any) => j.folder === folder);
  // Reintroduce by dropping the `cover` spread where the add makes its card: the view has nothing to draw
  // until chapter one is scanned in.
  assert.deepEqual(card.cover, { source: ADDING, url: COVER }, "an add's card carries the cover its source gave");
  // Reintroduce by making the add loop's noteLeft a no-op: no `left`.
  assert.deepEqual(card.left, [2, 3], 'a failed add names the chapters it did not land');
  assert.equal(card.done, 1);
  assert.equal(card.mine, true);
});
