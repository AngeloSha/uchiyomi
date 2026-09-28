// What GET /api/sources/jobs tells each viewer, and who may dismiss a card (v0.49.0, the Downloads view).
//
// The Downloads view lists everything this route answers, so the route's gaps would be the view's:
//
//   - a job card is shown by its folder's series row through browsable() -- library grants, the age cap, the
//     18+ hide -- for EVERY viewer, not only while the 18+ hide is on; a folder with no row yet (an add whose
//     first chapter is still in flight) is its starter's and an admin's, and a starter keeps their own card
//     wherever it lands (title only, then). The activity feed and a run's current series go through the same
//     helper, the run's by series id;
//   - a failed card is its starter's and an admin's on top of that (it is never swept);
//   - a card names its series (`seriesId`, from the folder's row), what kind of job it is (`origin`) and, once
//     it has failed, the chapters it did not land (`left`) -- only where POST /api/sources/fetch can redo them,
//     since that is what Try again sends them to;
//   - Cancel and DELETE answer 404 for a card this viewer is not handed, and 403 to anyone but its starter or
//     an admin, before the 409 for a running one.
//
// Skipped unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
/** A fourth: an add whose FIRST chapter is refused, so nothing of it ever lands. */
const FIRST_FAILS = 'dv-first';
/** A fifth: an add that lands whole, for the starter who cannot browse where it landed. */
const LANDS = 'dv-lands';
const LANDS_COVER = 'https://example.invalid/covers/dv-lands.jpg';
const LIB_A = 'lib_dv_a';
const LIB_B = 'lib_dv_b';
/** A library rated 18: what the 18+ hide keeps off every listing until "Show 18+" is on. */
const LIB_X = 'lib_dv_x';
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
const jobsFor = async (headers: Record<string, string>, { hide = false } = {}) => {
  const r = await app.inject({ method: 'GET', url: hide ? '/api/sources/jobs' : '/api/sources/jobs?adult=1', headers });
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
const OURS = `id LIKE 's_dv_%' OR folder LIKE 's_dv_%' OR folder LIKE 'dv-new/%' OR folder LIKE 'Zzz dv-%'`;

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
  registerAdapter({
    ...adapter(FIRST_FAILS),
    async getSeries(sid: string) { return { sourceId: sid, source: FIRST_FAILS, title: 'Dv First Fails' }; },
    async listChapters() { return chapters('firstref', FIRST_FAILS, 3).map(({ source: _s, ...c }) => c); },
  } as any);
  registerAdapter({
    ...adapter(LANDS),
    async getSeries(sid: string) { return { sourceId: sid, source: LANDS, title: 'Dv Lands', coverUrl: LANDS_COVER }; },
    async listChapters() { return chapters('lands', LANDS, 2).map(({ source: _s, ...c }) => c); },
  } as any);
  for (const l of [LIB_A, LIB_B]) await q(`INSERT INTO libraries (id, name, path) VALUES ($1,$1,$1) ON CONFLICT (id) DO NOTHING`, [l]);
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,$1,$1,18) ON CONFLICT (id) DO UPDATE SET age_rating = 18`, [LIB_X]);
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
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, REFUSING, ADDING, FIRST_FAILS, LANDS]]);
  // Every page is an image, except the refusing sources' second chapters and the first-fails source's first:
  // the site says no (403).
  globalThis.fetch = (async (u: any) => (/\/((refuse|addref)-c2|firstref-c1)\//.test(String(u))
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
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, REFUSING, ADDING, FIRST_FAILS, LANDS]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB_A, LIB_B, LIB_X]]).catch(() => {});
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

  // A run's current series is held to the same rule, by id -- and it is one no card or activity entry names:
  // the sweep sets `current` on every series it checks, and most download nothing, so only the by-id half of
  // the lookup can find it. Reintroduce by dropping the redaction: the member reads the title of a series in a
  // library they cannot open. Reintroduce by dropping `OR s.id = ANY(...)` from downloadsAudience: nobody may
  // see a series the lookup never found, and the admin loses it too.
  await series('s_dv_c', LIB_B);
  const { beginRun } = await import('../src/lib/downloadJobs');
  const run = beginRun('newest', ids.member, 3);
  run.current = { id: 's_dv_c', title: 's_dv_c' };
  const memberRun = (await jobsFor(w.member)).runs.find((r: any) => r.kind === 'newest');
  assert.ok(memberRun, 'the starter sees their own bulk run');
  assert.equal(memberRun.current, undefined, "a run's current series outside the viewer's libraries is not named");
  assert.equal((await jobsFor(w.admin)).runs.find((r: any) => r.kind === 'newest').current?.title, 's_dv_c', 'an admin still reads it');
  (await import('../src/lib/downloadJobs')).clearRuns();
});

test('the 18+ hide keeps an adult library\'s cards and chapters away until "Show 18+" is on', { skip }, async () => {
  const { startDownloadJob } = await import('../src/routes/sources');
  await series('s_dv_x', LIB_X);
  // Started by the admin: a starter keeps their own card wherever it is, so the viewer here must not be it.
  startDownloadJob({ folder: 's_dv_x', title: 's_dv_x', seriesId: 's_dv_x', chapters: chapters('s_dv_x', SRC, 1), meta: { series: 's_dv_x' }, by: ids.admin });
  await until('s_dv_x to finish', async () => (await cardOf('s_dv_x'))?.status === 'done');
  // `other` has no grants and no cap: only the hide stands between them and the adult library. Reintroduce by
  // filtering with visible() instead of browsable() in downloadsAudience: the hidden list has the card.
  const hidden = await jobsFor(who().other, { hide: true });
  assert.ok(!hidden.content.some((j: any) => j.folder === 's_dv_x'), 'the 18+ hide keeps an adult library\'s card away');
  assert.ok(![...hidden.activity.active, ...hidden.activity.recent].some((e: any) => e.folder === 's_dv_x'), "and its chapters");
  const shown = await jobsFor(who().other);
  assert.ok(shown.content.some((j: any) => j.folder === 's_dv_x'), 'with "Show 18+" on, the card is there');
  assert.ok(shown.activity.recent.some((e: any) => e.folder === 's_dv_x'));
});

test("a repair's card does not name a series the viewer hides", { skip }, async () => {
  // A one-row Health press on an adult series: its card's `label` is that series' title. Reintroduce by passing
  // `label` through the jobs route untouched: the admin with the 18+ hide on reads it.
  const { beginRun, clearRuns } = await import('../src/lib/downloadJobs');
  await series('s_dv_rx', LIB_X);
  try {
    const card = beginRun('repair', ids.admin);
    Object.assign(card, { repairKind: 'fill', label: 's_dv_rx title', seriesId: 's_dv_rx' });
    const hidden = (await jobsFor(who().admin, { hide: true })).runs.find((r: any) => r.kind === 'repair');
    assert.equal(hidden.label, undefined, "the title of a series the admin hides is not on the repair's card");
    assert.equal(hidden.seriesId, undefined);
    assert.equal(hidden.repairKind, 'fill', 'what kind of run it is stays');
    const shown = (await jobsFor(who().admin)).runs.find((r: any) => r.kind === 'repair');
    assert.equal(shown.label, 's_dv_rx title', 'with "Show 18+" on the card names it');
    // A source's name has no series behind it, but a label goes whenever the run's current series does.
    Object.assign(card, { label: 'Some Source', seriesId: undefined, current: { id: 's_dv_rx', title: 's_dv_rx' } });
    const cur = (await jobsFor(who().admin, { hide: true })).runs.find((r: any) => r.kind === 'repair');
    assert.equal(cur.current, undefined);
    assert.equal(cur.label, undefined, 'the label goes with the current series it rode in on');
  } finally {
    clearRuns();
    await q('DELETE FROM lib_series WHERE id = $1', ['s_dv_rx']);
  }
});

test('a folder with a deleted twin is spoken for by its live row', { skip }, async () => {
  const { startDownloadJob } = await import('../src/routes/sources');
  // The deleted row first, by insertion, by id and by library: whichever order the lookup returns them in, it
  // meets the deleted one first. Reintroduce by keeping the first row a folder meets (`if (!had)` alone): the
  // card goes to nobody but its starter, and there is none.
  await q('DELETE FROM lib_series WHERE folder = $1', ['s_dv_twin']);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, deleted_at)
           VALUES ('s_dv_twin_0','Zzz','s_dv_twin','s_dv_twin',0,$1,$2,'tw-x',now())`, [LIB_A, SRC]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
           VALUES ('s_dv_twin_1','Zzz','s_dv_twin','s_dv_twin',0,$1,$2,'tw-x')`, [LIB_B, SRC]);
  mkdirSync(join(ROOT, 's_dv_twin'), { recursive: true });
  startDownloadJob({ folder: 's_dv_twin', title: 's_dv_twin', seriesId: 's_dv_twin_1', chapters: chapters('twin', SRC, 1), meta: { series: 's_dv_twin' } });
  await until('the twin to finish', async () => (await cardOf('s_dv_twin'))?.status === 'done');
  for (const h of [who().admin, who().other]) {
    const card = (await jobsFor(h)).content.find((j: any) => j.folder === 's_dv_twin');
    assert.ok(card, 'a card whose folder has a deleted twin is still shown');
    assert.equal(card.seriesId, 's_dv_twin_1', 'and names the live row');
  }
  // Which of the two the query returns first is the heap's business (a freed slot is reused), so the choice is
  // also held on its own, fed both orders.
  const { speakingRows } = await import('../src/routes/sources');
  const dead = { id: 'dead', folder: 'f', ok: false };
  const live = { id: 'live', folder: 'f', ok: true };
  for (const rows of [[dead, live], [live, dead]]) {
    assert.equal(speakingRows(rows, ['f']).byFolder.get('f')?.id, 'live', 'the browsable twin speaks for the folder, whichever comes first');
  }
  assert.deepEqual([...speakingRows([dead, live, { id: 'x', folder: 'other', ok: true }], ['f']).okIds].sort(), ['live', 'x'],
    'every browsable row is known by id, asked for by folder or not');
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
  assert.equal(failed.origin, 'fetch', 'a Fetch card says it is one');
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

test('a failed fill or refetch card names nothing to try again, and a chapter already on disk is never "left"', { skip }, async () => {
  const { startDownloadJob } = await import('../src/routes/sources');
  // The same shape as the failed Fetch above -- chapter one lands, two is refused -- under the two origins whose
  // chapters POST /api/sources/fetch cannot take again (a fill's source need not be followed; a refetch's
  // numbers are already here). Reintroduce by setting `left` whatever the origin: [2, 3, 4].
  for (const origin of ['fill', 'refetch'] as const) {
    const folder = `s_dv_${origin}`;
    await series(folder, LIB_A, { source: REFUSING });
    await q('DELETE FROM source_health WHERE source_id = $1', [REFUSING]);
    startDownloadJob({ origin, folder, title: folder, seriesId: folder, chapters: chapters('refuse', REFUSING, 4), meta: { series: folder }, by: ids.other });
    await until(`the ${origin} to stop`, async () => (await cardOf(folder))?.status === 'error');
    const card = await cardOf(folder);
    assert.equal(card.origin, origin, 'the card says what kind of job it was');
    assert.equal(card.done, 1);
    assert.equal(card.left, undefined, 'a failed fill or refetch card names nothing to try again');
  }

  // A Fetch whose chapter one is already on disk (a download nobody scanned, #109) and whose chapter two is
  // refused: one is there, so it is not what is left. Reintroduce by leaving `onDisk` out of leftOf: [1, 2, 3].
  await series('s_dv_disk', LIB_A, { source: REFUSING });
  await q('DELETE FROM source_health WHERE source_id = $1', [REFUSING]);
  const { chapterFileRel } = await import('../src/lib/downloader');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('001.png', PIXEL);
  zip.addFile('ComicInfo.xml', Buffer.from('<?xml version="1.0"?><ComicInfo><Series>s_dv_disk</Series><Number>1</Number></ComicInfo>'));
  writeFileSync(join(ROOT, chapterFileRel('s_dv_disk', 1)), zip.toBuffer());
  startDownloadJob({ folder: 's_dv_disk', title: 's_dv_disk', seriesId: 's_dv_disk', chapters: chapters('refuse', REFUSING, 3), meta: { series: 's_dv_disk' }, by: ids.other });
  await until('the on-disk Fetch to stop', async () => (await cardOf('s_dv_disk'))?.status === 'error');
  assert.deepEqual((await cardOf('s_dv_disk')).left, [2, 3], 'a chapter already on disk is not left to fetch');
});

test('Cancel and Dismiss: 404 for a card the viewer is not handed, 403 for one they did not start, both before the 409', { skip }, async () => {
  const { startDownloadJob } = await import('../src/routes/sources');
  const w = who();
  const del = (folder: string, h: Record<string, string>) =>
    app.inject({ method: 'DELETE', url: `/api/sources/jobs/${encodeURIComponent(folder)}`, headers: h });
  const cancel = (folder: string, h: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/api/sources/jobs/${encodeURIComponent(folder)}/cancel`, headers: h });
  // Someone else's failed card, and an add that is not a series yet: neither is handed to the member, so neither
  // exists as far as they can tell. Reintroduce by answering 404 only for a missing job: 403, which says that a
  // download for that title is running or failed.
  assert.equal((await del('s_dv_fail', w.member)).statusCode, 404, 'a member is not told of a card they do not receive');
  assert.equal((await del('s_dv_fail', w.capped)).statusCode, 404);
  assert.equal((await cancel('s_dv_fail', w.member)).statusCode, 404, 'a Cancel is not told of a card the member does not receive');
  assert.equal((await del(NEW, w.member)).statusCode, 404);
  assert.equal((await cancel(NEW, w.member)).statusCode, 404, 'nor is a Cancel told of a running one');
  assert.ok(await cardOf('s_dv_fail'), 'a refused dismiss removed the card');
  // A card they ARE handed but did not start. Reintroduce by dropping the starter/admin check in the DELETE
  // route: this is a 200, and the card is gone.
  assert.equal((await del('s_dv_a', w.member)).statusCode, 403, 'another member may not dismiss a card they did not start');
  assert.ok(await cardOf('s_dv_a'));
  assert.equal((await del('s_dv_fail', w.other)).statusCode, 200, 'its starter may');
  assert.equal(await cardOf('s_dv_fail'), undefined);

  // Still running, in a series the member can open: the ownership answer comes first, then the 409 for the one
  // who may dismiss it. Reintroduce by moving the check below the 409: the member is told it is running.
  startDownloadJob({
    folder: 's_dv_a', title: 's_dv_a', seriesId: 's_dv_a', meta: { series: 's_dv_a' }, by: ids.other,
    chapters: [{ number: 5, title: 'Chapter 5', sourceId: 'gated-a-c5', source: SRC }],
  });
  await until('the second Fetch to be in flight', async () => (await jobsFor(w.admin)).activity.active.some((e: any) => e.folder === 's_dv_a'));
  assert.equal((await del('s_dv_a', w.member)).statusCode, 403, 'the ownership answer comes before the 409');
  assert.equal((await cancel('s_dv_a', w.member)).statusCode, 403);
  assert.equal((await del('s_dv_a', w.other)).statusCode, 409);
  assert.equal((await del('nope', w.member)).statusCode, 404);
  openGate();
  await until('the add to land', async () => (await cardOf(NEW))?.status !== 'downloading');
  await until('the Fetch to land', async () => (await cardOf('s_dv_a'))?.status !== 'downloading');
  assert.equal((await del('s_dv_a', w.admin)).statusCode, 200, 'an admin may dismiss anyone\'s');
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
  assert.equal(card.origin, 'add', 'an add says it is one');
});

test('an add whose first chapter fails names every chapter it asked for', { skip }, async () => {
  const w = who();
  const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: w.other, payload: { source: FIRST_FAILS, sourceId: 'dv-first' } });
  assert.equal(r.statusCode, 200, r.body);
  const folder = r.json().folder as string;
  await until('the add to fail', async () => (await cardOf(folder))?.status === 'error');
  const card = (await jobsFor(w.other)).content.find((j: any) => j.folder === folder);
  assert.equal(card.done, 0);
  // Reintroduce by dropping `j.left = leftOf(toFetch, [], [])` where the detached add's first chapter fails: no
  // `left`, and nothing to try again with once the series exists.
  assert.deepEqual(card.left, [1, 2, 3], 'an add whose first chapter failed names every chapter it asked for');
});

test('a starter keeps their own card when it lands where they cannot browse, title only', { skip }, async () => {
  const w = who();
  // The member adds; the series lands, and is then in library B, which they have no grant to (as when the
  // downloads library is one they cannot open, or the scan rates it above a cap).
  const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: w.member, payload: { source: LANDS, sourceId: 'dv-lands' } });
  assert.equal(r.statusCode, 200, r.body);
  const folder = r.json().folder as string;
  await until('the add to finish', async () => (await cardOf(folder))?.status === 'done');
  await q('UPDATE lib_series SET library_id = $2 WHERE folder = $1', [folder, LIB_B]);
  const theirs = (await jobsFor(w.member)).content.find((j: any) => j.folder === folder);
  // Reintroduce by answering `s.ok` alone for a folder with a row: the card is gone.
  assert.ok(theirs, 'a starter keeps their own card when it lands where they cannot browse');
  assert.equal(theirs.title, 'Dv Lands');
  assert.equal(theirs.mine, true);
  // Reintroduce by keeping the id and the cover on such a card: the member reads them.
  assert.equal(theirs.seriesId, undefined, 'but it does not name a series they cannot open');
  assert.equal(theirs.cover, undefined, 'nor carry its cover');
  const act = (await jobsFor(w.member)).activity.recent.filter((e: any) => e.folder === folder);
  assert.ok(act.length > 0, 'their own chapters are still theirs to see');
  assert.ok(act.every((e: any) => e.seriesId === null), 'without the id');
  // An admin, who may browse it, gets it all.
  const admin = (await jobsFor(w.admin)).content.find((j: any) => j.folder === folder);
  assert.ok(admin.seriesId, 'an admin reads the id');
  assert.deepEqual(admin.cover, { source: LANDS, url: LANDS_COVER });
});

test("an add's carrier card is its starter's, wherever the series lands", { skip }, async () => {
  // A nothing-yet add (and one whose chapters are all here already) has no download, so a card is minted only to
  // carry the follow results to the dialog's poll -- and it carried no starter, so an admin with the 18+ hide on,
  // adding into an 18+ library, never saw their own results (integration-1 review). Reintroduce by dropping `by`
  // from either carrier jobs.set in routes/sources.ts: that half finds no card.
  const { registerAdapter } = await import('../src/lib/sources');
  const CARRIER = 'dv-carrier';
  registerAdapter({
    ...adapter(CARRIER),
    async getSeries(sid: string) { return { sourceId: sid, source: CARRIER, title: 'Dv Carrier' }; },
    async listChapters() { return chapters('carrier', CARRIER, 2).map(({ source: _s, ...c }) => c); },
  } as any);
  const w = who();
  const add = (payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/api/sources/add', headers: w.admin,
    payload: { source: CARRIER, sourceId: 'dv-carrier', alsoFollow: [{ source: ADDING, sourceId: 'dv-added' }], ...payload },
  });
  const r = await add({ chapterFrom: 'none' });
  assert.equal(r.statusCode, 200, r.body);
  const folder = r.json().folder as string;
  // It lands in the 18+ library, which this admin's poll hides.
  await q('UPDATE lib_series SET library_id = $2 WHERE folder = $1', [folder, LIB_X]);
  const card = async () => (await jobsFor(w.admin, { hide: true })).content.find((j: any) => j.folder === folder);
  const nothingYet = await card();
  assert.ok(nothingYet, "a nothing-yet add's carrier card is its starter's");
  assert.equal(nothingYet.mine, true);

  // Added again, every chapter it selects already here: the other carrier card.
  const id = (await q('SELECT id FROM lib_series WHERE folder = $1', [folder]))[0].id;
  for (const n of [1, 2]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1,$2,'Zzz',$3,$4,$5,1)`,
      [`${id}_b${n}`, id, `${folder}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [id]);
  const again = await add({ chapterFrom: 'oldest', chapterCount: 2 });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().alreadyHere, 2, 'nothing to fetch: the held branch');
  const held = await card();
  assert.ok(held, "a held add's carrier card is its starter's");
  assert.equal(held.mine, true);
});
