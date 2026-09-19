// "Fetch newest" over many series, driven through the real routes: POST starts a detached job, GET reports
// it, and every selected series ends with an outcome the person can read.
//
// PR #53 built this as one awaited request over up to 500 series: the reverse proxy timed it out while the
// server kept downloading, a re-click started a second loop, and nothing gated it against a member without
// canDownload beyond the button. What is pinned here is the shape that replaces it -- 202 then a status
// that progresses to done, 409 while one runs, 403 for a denied account, a stale id skipped rather than
// failing the batch, the scan after the loop that turns the file into a book, and a stop request that ends
// the run between series and says so.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-bn-'));
  DL = join(ROOT, 'dl');
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
  process.env.UPDATER_LIST_TIMEOUT_MS = '300';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_bn';
const S = (k: string) => `s_bn_${k}`;
const SRC = 'bn-src', SRC_SLOW = 'bn-slow', SRC_FAIL = 'bn-fail', SRC_ADULT = 'bn-adult';
const ADMIN = 'bn-admin', MEMBER = 'bn-member', NODL = 'bn-nodl', CAPPED = 'bn-capped';
const KEYS = ['new', 'upto', 'unrouted', 'fail', 'hidden', 'slow', 'stopA', 'stopB', 'adult', 'busy', 'deleted', 'inrun', 'cool1', 'cool2', 'cool3'];
const SRC_COOL = 'bn-cool';
let q: any, app: any, runtime: any, startDownloadJob: any, jobBusy: any;
let adminTok: string, memberTok: string, nodlTok: string, cappedTok: string;
/** Every chapter id a source was asked pages for, so a test can say exactly what was fetched. */
const asked: string[] = [];
/** The slow source's page list waits on this; a test holds it to keep a run in flight, then lets go. */
let gate: { promise: Promise<void>; release: () => void } = { promise: Promise.resolve(), release: () => {} };
const hold = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); gate = { promise, release }; };

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  if (String(u).includes('example.invalid')) return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  return realFetch(u, init);
}) as typeof fetch;

/** A three-chapter source; `pages` decides what happens when a chapter's pages are asked for. */
function source(id: string, pages: (chId: string) => Promise<string[]>, extra: Record<string, unknown> = {}) {
  return {
    id, name: id, ...extra,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}/c${n}` })); },
    async getPageUrls(chId: string) { asked.push(chId); return pages(chId); },
    async latest() { return []; },
  };
}
const page = async () => ['https://example.invalid/page.png'];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ runtime } = (await import('../src/lib/runtime')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const personalRoutes = (await import('../src/routes/personal')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  ({ startDownloadJob, jobBusy } = (await import('../src/routes/sources')) as any);
  await migrate();
  registerAdapter(source(SRC, page) as any);
  registerAdapter(source(SRC_SLOW, async () => { await gate.promise; return page(); }) as any);
  registerAdapter(source(SRC_FAIL, async () => { throw new Error('pages gone'); }) as any);
  registerAdapter(source(SRC_ADULT, page, { isNsfw: true }) as any);
  registerAdapter(source(SRC_COOL, page) as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, SRC_SLOW, SRC_FAIL, SRC_ADULT, SRC_COOL]]);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'BN',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [KEYS.map(S)]);
  const mk = async (key: string, sourceId: string | null) => {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
             VALUES ($1,'T!bn',$1,$1,0,$2,$3,$4,true)`, [S(key), LIB, sourceId, sourceId ? `${sourceId}-1` : null]);
    // A folder on disk for every fixture: the scan the job runs at the end must not take a series it did
    // not touch for one that has vanished from the shelf.
    mkdirSync(join(DL, S(key)), { recursive: true });
  };
  await mk('new', SRC);
  await mk('upto', SRC);
  await mk('unrouted', null);
  await mk('fail', SRC_FAIL);
  await mk('hidden', SRC);
  await mk('slow', SRC_SLOW);
  await mk('stopA', SRC_SLOW);
  await mk('stopB', SRC);
  await mk('adult', SRC_ADULT);
  await mk('busy', SRC);
  await mk('deleted', SRC);
  await mk('inrun', SRC_SLOW);
  for (const k of ['cool1', 'cool2', 'cool3']) await mk(k, SRC_COOL);
  // `upto` already holds the newest listed number, as a row (the scan that would mint it is not this test's).
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1, $2, 'T!bn', $3, 3, 'Chapter 3', 1)`,
    [`${S('upto')}_b3`, S('upto'), `${S('upto')}/Chapter 3.cbz`]);
  // `deleted` held it too, until Delete files took the bytes: the row the way deleteSeriesFiles leaves it.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pruned_at, pruned_reason) VALUES ($1, $2, 'T!bn', $3, 3, 'Chapter 3', 1, now(), 'deleted')`,
    [`${S('deleted')}_b3`, S('deleted'), `${S('deleted')}/Chapter 3.cbz`]);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S('hidden')]);

  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, NODL, CAPPED]]);
  const user = async (name: string, role: string, perms: any = {}, cap: number | null = null) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
              VALUES ($1,$1,'x',$2,'password',$3::jsonb,$4) RETURNING id`, [name, role, JSON.stringify(perms), cap]))[0].id;
  const adminId = await user(ADMIN, 'admin');
  const memberId = await user(MEMBER, 'user');
  const nodlId = await user(NODL, 'user', { canDownload: false });
  const cappedId = await user(CAPPED, 'user', {}, 13);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  // The series page's own Fetch, for the test that presses it while the run is on that series.
  await app.register(sourceRoutes);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
  memberTok = `Bearer ${app.jwt.sign({ sub: memberId, role: 'user' })}`;
  nodlTok = `Bearer ${app.jwt.sign({ sub: nodlId, role: 'user' })}`;
  cappedTok = `Bearer ${app.jwt.sign({ sub: cappedId, role: 'user' })}`;
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  runtime.stopping = false;
  await app?.close();
  await q('DELETE FROM chapter_failures WHERE series_id = ANY($1)', [KEYS.map(S)]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [KEYS.map(S)]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE file LIKE 's_bn_%'`).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [KEYS.map(S)]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE folder LIKE 's_bn_%'`).catch(() => {});
  await q('DELETE FROM audit_log WHERE event = $1', ['download.bulk_newest']).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, NODL, CAPPED]]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, SRC_SLOW, SRC_FAIL, SRC_ADULT, SRC_COOL]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

const start = (ids: string[], tok = adminTok) => app.inject({ method: 'POST', url: '/api/library/bulk/newest', headers: { authorization: tok }, payload: { ids } });
const status = async (tok = adminTok) => (await app.inject({ method: 'GET', url: '/api/library/bulk/newest', headers: { authorization: tok } })).json();
/** The answer comes back before the work; poll the status rather than guess a duration. */
async function finished(tok = adminTok, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await status(tok);
    if (!s.running) return s;
    if (Date.now() - t0 > ms) throw new Error(`still running after ${ms} ms: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const outcomeOf = (s: any, key: string) => s.results.find((r: any) => r.id === S(key));
const onDisk = (key: string, n: number) => existsSync(join(DL, S(key), `Chapter ${n}.cbz`));

test('a run is started with 202, progresses to done, and every series ends with an outcome the person can read', { skip }, async () => {
  const ids = [S('new'), S('upto'), S('unrouted'), S('fail'), S('hidden'), 's_bn_nope'];
  const r = await start(ids);
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual(r.json(), { ok: true, total: 6 }, 'the total counts every id asked for, so the page can show progress over the selection');

  const s = await finished();
  assert.equal(s.done, 6);
  assert.equal(s.total, 6);
  assert.ok(s.startedAt, 'the run says when it began');
  assert.deepEqual(s.results.map((x: any) => x.id), ids, 'results come back in the order the ids were given');

  assert.deepEqual(outcomeOf(s, 'new'), { id: S('new'), title: S('new'), outcome: 'downloaded' });
  assert.deepEqual(asked.filter((c) => c.startsWith(`${SRC}/`)), [`${SRC}/c3`], 'one page list was asked for: the newest listed chapter');
  assert.ok(onDisk('new', 3), 'and it landed');
  // The scan after the loop is the whole of PR #53's 3b: without it the CBZ is a file, not a book, and the
  // series page keeps saying the chapter is missing.
  // Reintroduce by dropping the `persistScan()` call in lib/bulkNewest.ts: this reads no row.
  const minted = await q('SELECT number FROM lib_books WHERE series_id = $1 AND number = 3 AND pruned_at IS NULL', [S('new')]);
  assert.equal(minted.length, 1, 'the scan after the run turned the file into a book row');

  assert.equal(outcomeOf(s, 'upto').outcome, 'up_to_date');
  assert.match(outcomeOf(s, 'upto').reason, /Chapter 3 is already here/);
  assert.equal(outcomeOf(s, 'unrouted').outcome, 'skipped');
  assert.match(outcomeOf(s, 'unrouted').reason, /No source is installed/);
  assert.equal(outcomeOf(s, 'fail').outcome, 'failed');
  assert.match(outcomeOf(s, 'fail').reason, /Chapter 3 could not be saved/);
  // A hidden series and an id that never existed read the same: not in your library. The batch went on.
  // Reintroduce by returning 404 from the route when `live.size < ids.length`: the first assertion above
  // reads 404.
  assert.deepEqual(outcomeOf(s, 'hidden'), { id: S('hidden'), title: '', outcome: 'skipped', reason: 'Not in your library.' });
  assert.deepEqual(s.results.find((x: any) => x.id === 's_bn_nope'), { id: 's_bn_nope', title: '', outcome: 'skipped', reason: 'Not in your library.' });

  const audit = await q(`SELECT detail FROM audit_log WHERE event = 'download.bulk_newest' ORDER BY at DESC LIMIT 1`);
  assert.equal(audit[0]?.detail?.count, 4, 'the audit row carries how many live series the run was over');
});

test('a second start while one runs is refused, and the first run is untouched', { skip }, async () => {
  hold();
  const first = await start([S('slow')]);
  assert.equal(first.statusCode, 202, first.body);
  const again = await start([S('new')]);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error, 'busy');
  const mid = await status();
  assert.equal(mid.running, true);
  assert.equal(mid.total, 1, 'the refused start did not replace the running one');
  gate.release();
  const s = await finished();
  assert.equal(outcomeOf(s, 'slow').outcome, 'downloaded');
  assert.ok(onDisk('slow', 3));
});

test('a member without canDownload is refused, and a member with it may start a run', { skip }, async () => {
  // Reintroduce by dropping the canDownload check in routes/personal.ts: reads 202.
  const denied = await start([S('new')], nodlTok);
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error, 'forbidden');
  const st = await status(nodlTok);
  assert.equal(st.running, false, 'nothing was started for the denied account');

  const ok = await start([S('upto')], memberTok);
  assert.equal(ok.statusCode, 202, ok.body);
  const s = await finished(memberTok);
  assert.equal(outcomeOf(s, 'upto').outcome, 'up_to_date');
});

test('a run\'s results are the starter\'s and an admin\'s to read; another member sees only the counts', { skip }, async () => {
  const r = await start([S('upto')], memberTok);
  assert.equal(r.statusCode, 202, r.body);
  const mine = await finished(memberTok);
  assert.equal(mine.results.length, 1, 'the starter reads the outcome');
  const admin = await status(adminTok);
  assert.equal(admin.results.length, 1, 'so does an admin');
  const other = await status(cappedTok);
  assert.equal(other.done, 1, 'another member sees the run happened');
  assert.deepEqual(other.results, [], 'but not what it was over: those are titles from a library they may not be granted');
});

test('an adult source on a capped account fetches nothing and says so', { skip }, async () => {
  const r = await start([S('adult')], cappedTok);
  assert.equal(r.statusCode, 202, r.body);
  const s = await finished(cappedTok);
  assert.equal(outcomeOf(s, 'adult').outcome, 'skipped');
  assert.match(outcomeOf(s, 'adult').reason, /not available on this account/);
  assert.ok(!asked.some((c) => c.startsWith(`${SRC_ADULT}/`)), 'the adult source was not asked for a page');
  assert.ok(!onDisk('adult', 3));
});

test('a series with a download already running is skipped, not doubled', { skip }, async () => {
  hold();
  // The download strip's own job on the folder, held open by the slow source.
  startDownloadJob({
    folder: S('busy'), title: S('busy'), seriesId: S('busy'),
    chapters: [{ number: 1, title: 'Chapter 1', sourceId: `${SRC_SLOW}/c1`, source: SRC_SLOW }],
    meta: { series: S('busy') },
  });
  try {
    const r = await start([S('busy')]);
    assert.equal(r.statusCode, 202, r.body);
    const s = await finished();
    assert.equal(outcomeOf(s, 'busy').outcome, 'skipped');
    assert.match(outcomeOf(s, 'busy').reason, /already running/);
  } finally {
    gate.release();
    await new Promise((r) => setTimeout(r, 300)); // let the strip's job land before the folder is swept
  }
});

/**
 * The other direction of the busy rule. The run goes through updateSeries, not the download strip's jobs
 * map, so until v0.37.0's fix pass jobBusy never saw it: a person on the series page pressing Fetch for
 * the chapter the run was downloading started a second job on the same path through the same source.
 * While the run is inside a series, that series' folder reads busy to every other writer, and is free
 * again the moment the run moves on.
 * Reintroduce by dropping the `busyFolders.has` test in routes/sources.ts's jobBusy (or the `add` in
 * lib/bulkNewest.ts): the fetch below reads 200 and a second download starts.
 */
test('a series-page fetch during the run is refused as busy for that series, and only while the run is on it', { skip }, async () => {
  hold();
  const mark = asked.length;
  const r = await start([S('inrun')]);
  assert.equal(r.statusCode, 202, r.body);
  // Waited for, not assumed: the run must be INSIDE updateSeries on this series -- its page list held
  // open by the slow source -- when the fetch is pressed.
  for (let i = 0; !asked.slice(mark).includes(`${SRC_SLOW}/c3`); i++) {
    if (i > 300) throw new Error(`the run never reached inrun's page list: asked ${asked.slice(mark)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    assert.equal(jobBusy(S('inrun')), true, 'the folder reads busy while the run is on it');
    const pressed = await app.inject({ method: 'POST', url: '/api/sources/fetch', headers: { authorization: adminTok }, payload: { seriesId: S('inrun'), numbers: [1] } });
    assert.equal(pressed.statusCode, 409, pressed.body);
    assert.equal(pressed.json().error, 'busy');
    assert.equal(jobBusy(S('new')), false, 'another series is not busy for it');
  } finally {
    gate.release();
    // Waited for even when an assertion above threw, so a failure here stays here rather than turning
    // the next test's start into a 409.
    await finished().catch(() => {});
  }
  const s = await status();
  assert.equal(outcomeOf(s, 'inrun').outcome, 'downloaded');
  assert.ok(onDisk('inrun', 3));
  assert.equal(jobBusy(S('inrun')), false, 'and free again once the run has moved on');
  assert.ok(!asked.slice(mark).includes(`${SRC_SLOW}/c1`), 'the refused fetch started nothing');
});

/**
 * The case Put back sends people to: after Delete files every row is a tombstone with pruned_reason
 * 'deleted', the series page says "deleted from the server", and the person selects the series and
 * presses Fetch newest to get it back. The have-set rightly holds the number (the sweep must not undo the
 * deletion every night), but "Chapter 3 is already here." over that row was a lie. It is now skipped
 * with the sentence that names the way back.
 * Reintroduce by dropping the `deleted` case from `explain` in lib/bulkNewest.ts (it falls to "no
 * verdict") or by answering `up_to_date` for every held number in lib/updater.ts.
 */
test('a newest chapter that was deleted on purpose is skipped with the way back, not "already here"', { skip }, async () => {
  const r = await start([S('deleted')]);
  assert.equal(r.statusCode, 202, r.body);
  const s = await finished();
  assert.deepEqual(outcomeOf(s, 'deleted'), {
    id: S('deleted'), title: S('deleted'), outcome: 'skipped',
    reason: 'Chapter 3 was deleted from this server on purpose. Fetch again on the series page brings it back.',
  });
  assert.ok(!onDisk('deleted', 3), 'and it was not fetched back: that is Fetch again\'s job, on purpose');
  const rows = await q('SELECT pruned_reason FROM lib_books WHERE series_id = $1 AND number = 3', [S('deleted')]);
  assert.deepEqual(rows, [{ pruned_reason: 'deleted' }], 'the tombstone is untouched');
});

/**
 * The pause between series is for the sources' sake, and a series that no source was asked about has
 * nothing to pace for. The first rule (`outcome !== 'gone' && !== 'unrouted'`) counted a cooldown as
 * asked, so 500 series on one cooled-down source slept 12.5 minutes to say "in a cooldown" 500 times.
 * Three of them must settle in well under one pace, at the route's real PACE_MS.
 * Reintroduce by setting `asked = true` after updateSeries in lib/bulkNewest.ts: this takes over 3 s.
 */
test('series that no source was asked about are not paced: three cooled-down series settle in under a second', { skip }, async () => {
  await q(`INSERT INTO source_health (source_id, status, blocked_until) VALUES ($1, 'blocked', now() + interval '1 hour')
           ON CONFLICT (source_id) DO UPDATE SET blocked_until = now() + interval '1 hour'`, [SRC_COOL]);
  try {
    const t0 = Date.now();
    const r = await start([S('cool1'), S('cool2'), S('cool3')]);
    assert.equal(r.statusCode, 202, r.body);
    const s = await finished();
    const took = Date.now() - t0;
    assert.ok(took < 1000, `three cooled-down series took ${took} ms: they were paced although nothing was asked`);
    for (const k of ['cool1', 'cool2', 'cool3']) {
      assert.equal(outcomeOf(s, k).outcome, 'skipped');
      assert.match(outcomeOf(s, k).reason, /in a cooldown/);
    }
    assert.ok(!asked.some((c) => c.startsWith(`${SRC_COOL}/`)), 'the cooled-down source was not asked');
  } finally {
    await q('DELETE FROM source_health WHERE source_id = $1', [SRC_COOL]).catch(() => {});
  }
});

test('a stop request ends the run between series and marks the rest skipped', { skip }, async () => {
  hold();
  const mark = asked.length;
  const r = await start([S('stopA'), S('stopB')]);
  assert.equal(r.statusCode, 202, r.body);
  // The signal arrives while stopA is in flight on its page list -- waited for, not assumed: a stop set
  // before updateSeries reaches its loop would end stopA at the loop's own check with nothing fetched,
  // which is that check working, not this one. stopA then finishes (never mid-write); stopB is never asked.
  // Reintroduce by dropping the `runtime.stopping` check in lib/bulkNewest.ts's loop: stopB is still
  // asked (its listing refreshed, a chapter queued -- "stopB was never asked" fails) and is only stopped
  // by updateSeries's own between-chapter check; drop the `runtime.stopping` branch in `explain` as well
  // and it reads `failed` with "could not be saved" -- the wrong answer for a shutdown.
  for (let i = 0; !asked.slice(mark).includes(`${SRC_SLOW}/c3`); i++) {
    if (i > 300) throw new Error(`stopA never reached its page list: asked ${asked.slice(mark)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  runtime.stopping = true;
  try {
    gate.release();
    const s = await finished();
    assert.equal(s.running, false);
    assert.equal(outcomeOf(s, 'stopA').outcome, 'downloaded', 'the chapter in flight is finished, never cut mid-write');
    assert.deepEqual(outcomeOf(s, 'stopB'), { id: S('stopB'), title: '', outcome: 'skipped', reason: 'The server is shutting down.' });
    assert.ok(!asked.slice(mark).includes(`${SRC}/c3`), 'stopB was never asked: the run ended before its turn, not during it');
    assert.ok(!onDisk('stopB', 3));
  } finally {
    runtime.stopping = false;
  }
});

test('a body that is not one to five hundred ids is a bad request', { skip }, async () => {
  const none = await start([]);
  assert.equal(none.statusCode, 400);
  const many = await start(Array.from({ length: 501 }, (_, i) => `x${i}`));
  assert.equal(many.statusCode, 400);
  const wrong = await app.inject({ method: 'POST', url: '/api/library/bulk/newest', headers: { authorization: adminTok }, payload: { seriesIds: [S('new')] } });
  assert.equal(wrong.statusCode, 400, 'the body key is `ids`, the contract the Library page sends');
});
