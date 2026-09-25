// #82: what the server is downloading, and a Cancel for it.
//
//   - a run card (lib/downloadJobs.ts): Cancel is a request, a cancelled run ends `cancelled`, a finished card
//     goes after a day, and a running one cannot be dismissed;
//   - updateSeries stops between chapters when its run is cancelled -- never mid-write, never later;
//   - the sweep obeys its card, and runSweep gives it one;
//   - a person's download stops after the chapter in flight, only for its starter or an admin, and says how
//     far it got;
//   - the server's own runs are an admin's to see (and a bulk run its starter's), nobody else's.
//
// Skipped automatically unless TEST_DATABASE_URL is set, except the first test, which needs no database.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-dlcancel-'));
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

const LIB = 'lib_dlcancel';
const SRC = 'dc-src';
const S = (k: string) => `s_dc_${k}`;
const USERS = ['dc-admin', 'dc-starter', 'dc-other'];
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chapter numbers whose pages were asked for, in order. */
const asked: number[] = [];
/** While set, chapter 1's page list waits on it: a chapter held in flight, so a Cancel lands mid-chapter. */
let gate: Promise<void> | null = null;

const source = {
  id: SRC, name: 'Zzz DC',
  async search() { return []; },
  async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: sid }; },
  async listChapters() {
    return [1, 2, 3, 4].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${SRC}-c${n}`, pages: 3 }));
  },
  async getPageUrls(chId: string) {
    const n = Number(chId.split('-c').pop());
    asked.push(n);
    if (n === 1 && gate) await gate;
    return Array.from({ length: 3 }, (_, i) => `https://example.invalid/${SRC}/${n}/${i}.png`);
  },
  async latest() { return []; },
};

let q: any;
/** The three accounts, made once in `before`. */
const ids = { admin: '', starter: '', other: '' };
async function until(what: string, f: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A series added from SRC holding nothing yet: chapters 1-4 are all missing. */
async function series(key: string) {
  await q('DELETE FROM lib_series WHERE id = $1', [S(key)]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!dc',$1,$1,0,$2,$3,$4,true)`, [S(key), LIB, SRC, `${SRC}-1`]);
  rmSync(join(ROOT, S(key)), { recursive: true, force: true });
  mkdirSync(join(ROOT, S(key)), { recursive: true });
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(source as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'DlCancel',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  const mk = async (username: string, role: string) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`,
      [username, role]))[0].id as string;
  ids.admin = await mk('dc-admin', 'admin');
  ids.starter = await mk('dc-starter', 'user');
  ids.other = await mk('dc-other', 'user');
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
});

beforeEach(async () => {
  asked.length = 0;
  gate = null;
  (await import('../src/lib/downloadJobs')).clearRuns();
  if (DSN) await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  (await import('../src/lib/downloadJobs')).clearRuns();
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM chapter_failures WHERE series_id LIKE $1', ['s_dc_%']).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
});

test('a run card: Cancel is a request, the run ends cancelled, and a finished card goes after a day', async () => {
  const { beginRun, endRun, requestStop, stopRequested, listRuns, dismissRun, RUN_TTL } = await import('../src/lib/downloadJobs');
  const c = beginRun('sweep', null, 10);
  assert.equal(stopRequested(c), false);
  assert.equal(dismissRun('sweep'), 'running', 'a running card was dismissed rather than cancelled');
  assert.equal(requestStop('sweep'), true);
  assert.equal(stopRequested(c), true);
  // The runner says "done"; the card knows it was asked to stop, and that is the true account.
  endRun(c, 'done');
  assert.equal(listRuns()[0].status, 'cancelled');
  assert.equal(requestStop('sweep'), false, 'a finished run took a cancel');
  // An error is an error, whatever was asked. Started a few milliseconds on, so the two cards end apart --
  // the case the expiry checks below must get right, rather than one they may happen to miss.
  await sleep(5);
  const e = beginRun('repair', 'u1');
  requestStop('repair');
  endRun(e, 'error', 'boom');
  assert.equal(listRuns().find((r) => r.kind === 'repair')?.status, 'error');
  // The two cards can end a millisecond apart, so each bound is taken from the card it is about: counting
  // both from the first card's end left the second a millisecond short of its day -- a failure that came
  // and went with the machine's load.
  const ends = listRuns().map((r) => r.finishedAt ?? 0);
  assert.equal(listRuns(Math.min(...ends) + RUN_TTL).length, 2, 'a card went before its day was up');
  assert.equal(listRuns(Math.max(...ends) + RUN_TTL + 1).length, 0, 'a day-old card was still listed');
});

test('updateSeries stops between chapters when its run is cancelled', { skip }, async () => {
  const { updateSeries } = await import('../src/lib/updater');
  await series('between');
  // Cancelled the moment the first chapter's pages were asked for: that chapter finishes, nothing after it starts.
  const r = await updateSeries(S('between'), 10, { cancelled: () => asked.length >= 1 });
  // Reintroduce by dropping `opts.cancelled?.()` from the loop's stop check: all four are fetched.
  assert.deepEqual(asked, [1]);
  assert.equal(r.added, 1, 'the chapter in flight did not land, or later ones did');
  assert.equal(r.failed, 0, 'a cancel was counted as a failure');
});

test('the sweep obeys its card, and runSweep gives it one', { skip }, async () => {
  const { runUpdateAll, runSweep } = await import('../src/lib/updater');
  const { beginRun, requestStop, listRuns } = await import('../src/lib/downloadJobs');
  await series('sweep');
  const card = beginRun('sweep', null);
  requestStop('sweep');
  const r = await runUpdateAll({ card });
  // Reintroduce by dropping the stopRequested(card) check in runUpdateAll's loop: the series is visited.
  assert.equal(r.stopped, 'cancelled');
  assert.equal(r.visited, 0);
  assert.deepEqual(asked, []);
  assert.ok(card.total >= 1, 'the card was never sized');

  // The wrapper the schedule and "Run now" use: it makes the card, hands it to the sweep, and closes it.
  const log = { info() {}, warn() {}, error() {} };
  let handed: unknown = null;
  const done = runSweep({ by: 'dc-user' }, log, async (o) => {
    handed = o?.card;
    requestStop('sweep');
    return { series: 0, visited: 0, added: 0, failed: 0, chapterFailures: 0, capped: 0, switched: 0, partial: 0, completed: 0,
      outcomes: { ok: 0, gone: 0, unrouted: 0, blocked: 0, source_error: 0, threw: 0, skipped: 0 }, healthy: true, stopped: 'cancelled' };
  });
  assert.ok(done, 'runSweep refused to start');
  await done;
  assert.ok(handed, 'the sweep was not handed a card');
  const c = listRuns().find((x) => x.kind === 'sweep');
  assert.equal(c?.status, 'cancelled');
  assert.equal(c?.by, 'dc-user');
});

test("a person's download stops after the chapter in flight, for its starter or an admin", { skip }, async () => {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const { startDownloadJob } = await import('../src/routes/sources');
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  const as = (id: string, role = 'user') => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  const card = async (who: { id: string; role?: string }) =>
    ((await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: as(who.id, who.role) })).json().content as any[])
      .find((j) => j.folder === S('manual'));
  try {
    await series('manual');
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    startDownloadJob({
      folder: S('manual'), title: S('manual'), seriesId: S('manual'),
      chapters: [1, 2, 3, 4].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${SRC}-c${n}`, source: SRC })),
      meta: { series: S('manual') },
      by: ids.starter,
    });
    await until('chapter 1 to be in flight', () => asked.includes(1));

    assert.equal((await card({ id: ids.starter })).mine, true, 'the starter is not told the job is theirs');
    assert.equal((await card({ id: ids.other })).mine, false);
    assert.equal((await card({ id: ids.starter })).by, undefined, 'who started a job left the server');

    const cancel = (who: string, role = 'user') =>
      app.inject({ method: 'POST', url: `/api/sources/jobs/${encodeURIComponent(S('manual'))}/cancel`, headers: as(who, role) });
    // Reintroduce by dropping the starter/admin check in the cancel route: this is a 200.
    assert.equal((await cancel(ids.other)).statusCode, 403, "another member stopped someone else's download");
    assert.equal((await cancel(ids.starter)).statusCode, 200);
    const mid = await card({ id: ids.starter });
    assert.equal(mid.status, 'downloading', 'the job stopped before the chapter in flight was done');
    assert.equal(mid.cancelRequested, true);

    open();
    await until('the job to stop', async () => (await card({ id: ids.admin, role: 'admin' }))?.status !== 'downloading');
    const end = await card({ id: ids.admin, role: 'admin' });
    // Reintroduce by dropping the cancelRequested check in startDownloadJob's loop: all four land, `done` 4.
    assert.deepEqual(asked, [1], 'a chapter after the cancel was started');
    assert.equal(end.status, 'done');
    assert.equal(end.cancelled, true);
    assert.equal(end.done, 1, 'the chapter in flight did not land');
    assert.match(end.reason, /^Cancelled after 1 of 4 chapters\./);
    assert.equal((await cancel(ids.admin, 'admin')).statusCode, 409, 'a stopped job took a cancel');
  } finally {
    await app.close();
  }
});

test("the server's own runs are an admin's to see and stop, and a bulk run its starter's", { skip }, async () => {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const { beginRun, listRuns } = await import('../src/lib/downloadJobs');
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  const as = (id: string, role = 'user') => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  const runsFor = async (id: string, role = 'user') =>
    ((await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: as(id, role) })).json().runs as any[]).map((r) => r.kind).sort();
  try {
    const sweep = beginRun('sweep', null);
    sweep.current = { id: 's_dc_somewhere', title: 'A series in some library' };
    beginRun('newest', ids.starter, 5);
    // Reintroduce by returning every run to every viewer: the other member reads the sweep's current series.
    assert.deepEqual(await runsFor(ids.other), [], 'a member saw the server\'s runs');
    assert.deepEqual(await runsFor(ids.starter), ['newest'], 'the starter did not see their own bulk run');
    assert.deepEqual(await runsFor(ids.admin, 'admin'), ['newest', 'sweep']);

    const post = (kind: string, id: string, role = 'user') =>
      app.inject({ method: 'POST', url: `/api/sources/runs/${kind}/cancel`, headers: as(id, role) });
    assert.equal((await post('sweep', ids.starter)).statusCode, 403, 'a member stopped the sweep');
    assert.equal((await post('newest', ids.other)).statusCode, 403, "a member stopped someone else's bulk run");
    assert.equal((await post('newest', ids.starter)).statusCode, 200);
    assert.equal((await post('sweep', ids.admin, 'admin')).statusCode, 200);
    assert.equal((await post('repair', ids.admin, 'admin')).statusCode, 404, 'a run that is not running took a cancel');
    assert.ok(listRuns().every((r) => r.cancelRequested), 'a cancel did not reach its card');
    const del = await app.inject({ method: 'DELETE', url: '/api/sources/runs/sweep', headers: as(ids.admin, 'admin') });
    assert.equal(del.statusCode, 409, 'a running card was dismissed');
  } finally {
    await app.close();
  }
});
