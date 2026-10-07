// The slow archive's scheduler against a real Postgres and fake sources (#117, lib/archive.ts).
//
// What is pinned here is what the owner was promised, one behaviour per test:
//
//   - a restart keeps its place and its break: the next start is reserved BEFORE a chapter begins, so a crash
//     mid-chapter comes back into a break, and a chapter that landed is not fetched again;
//   - it yields: to a sweep, a repair, the daily source check, the admin's pause, the hours it may run in, the
//     disk floor, a shutdown; per source to anybody else's download on the gate, a pace level, a cooldown, a
//     disabled or missing source; per series to a download already running for it -- and a series on another
//     source still goes;
//   - a refusal backs off 1 h then 3 h and keeps the queue, and a chapter the site lets through ends the run; an
//     alternate asked inside a failed chapter rests and backs off too;
//   - a listing that cannot be read is asked for less and less often, and flagged after three days; chapters coming
//     in and a resume start those three days again;
//   - numbers a scan could not index are stepped over without ending the archive early;
//   - the running cycle is the chapter's time, not the window's or a backoff's;
//   - the sweep and the archive split the work at the boundary, chapter_floor is left alone, and a clean
//     finish clears a floor only if it is still the one the archive started from;
//   - done with gaps says what was left behind, and lifts the boundary;
//   - archived chapters are not updates;
//   - deleting or merging a series drops its archive.
//
// The clock is the archive's own (setArchiveClock), so a 45-minute break is waited out by moving it, never by
// waiting. Skipped unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-archive-'));
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
  process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0';
  process.env.MIN_FREE_GB = '0';
  process.env.ARCHIVE_PAGE_GAP_MS = '0,0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '3000';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_arch';
const S = (k: string) => `s_arch_${k}`;
const A = 'arch-a', B = 'arch-b', R = 'arch-refuse', R2 = 'arch-refuse2', CHK = 'arch-check', GONE = 'arch-gone';
/** v0.55.4 (#158): a third site carrying the same releases, and an adult one. */
const C = 'arch-c', NSFW = 'arch-nsfw';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let q: any, one: any, runtime: any, arch: typeof import('../src/lib/archive'), updateSeries: typeof import('../src/lib/updater')['updateSeries'];
let withGate: typeof import('../src/lib/gate')['withGate'], noteRateLimited: any, clearPace: any, setDisabled: any, clearBlock: any;
let viewCtxFor: any, adminId = '', adminCtx: any;

/** The archive's clock. Real time still passes underneath; only the breaks are jumped. */
let now = Date.now();
/** Every chapter a source was asked pages for. */
const asked: string[] = [];
/** What each series' source lists, by its source_series_id. */
const listed = new Map<string, number[]>();
/** A chapter whose page list waits on a promise the test holds. */
const holds = new Map<string, Promise<void>>();
/**
 * Sources whose pages are refused. 403, not 429: a 429 with no Retry-After is waited out for five seconds three
 * times inside the chapter (lib/downloader.ts), which is the downloader's test, not this one; both are refusals.
 */
const refusing = new Set<string>([R, R2]);
/** How many times each series' listing was asked for, by its source_series_id. */
const listAsks = new Map<string, number>();
/** Series whose listing read throws, as a site that is down does. */
const listThrows = new Set<string>();
/** The group a series' chapters name, by its source_series_id: absent names none, as aggregators mostly do. */
const scanlated = new Map<string, string>();

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const s = String(u);
  if (s.includes('example.invalid/refuse/')) return new Response('go away', { status: 403 });
  if (s.includes('example.invalid/')) return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  return realFetch(u, init);
}) as typeof fetch;

let checkGate: { promise: Promise<void>; release: () => void } | null = null;
function adapter(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: `Arch ${id}`, ...extra,
    async search() { if (id === CHK && checkGate) await checkGate.promise; return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters(sid: string) {
      listAsks.set(sid, (listAsks.get(sid) ?? 0) + 1);
      if (listThrows.has(sid)) throw new Error('503 Service Unavailable');
      return (listed.get(sid) ?? []).map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${sid}/c${n}`, scanlator: scanlated.get(sid) }));
    },
    async getPageUrls(chId: string) {
      asked.push(chId);
      const h = holds.get(chId);
      if (h) await h;
      return [0, 1].map((i) => `https://example.invalid/${refusing.has(id) ? 'refuse' : 'ok'}/${chId}/${i}.png`);
    },
    async latest() { return []; },
  };
}
const hold = (chId: string) => { let release!: () => void; holds.set(chId, new Promise<void>((r) => { release = r; })); return () => { holds.delete(chId); release(); }; };

/** A series on `src` listing `numbers`, with `held` numbers already in the library (as rows, no files). */
async function series(key: string, src: string, numbers: number[], o: { floor?: number | null; held?: number[]; favoriteOf?: string } = {}) {
  const id = S(key);
  const folder = `arch/${key}`;
  await q('DELETE FROM lib_series WHERE id = $1 OR folder = $2', [id, folder]);
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, chapter_floor, source_checked_at)
     VALUES ($1,'T!arch',$2,$3,0,$4,$5,$6,true,$7,now())`,
    [id, `Arch ${key}`, folder, LIB, src, `${key}-ref`, o.floor ?? null]);
  listed.set(`${key}-ref`, numbers);
  rmSync(join(DL, folder), { recursive: true, force: true });
  mkdirSync(join(DL, folder), { recursive: true });
  for (const n of o.held ?? []) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1,$2,'T!arch',$3,$4,$5,1)`,
      [`${id}_b${n}`, id, `${folder}/held ${n}.cbz`, n, `Chapter ${n}`]);
  }
  await q('UPDATE lib_series SET books_count = (SELECT count(*) FROM lib_books WHERE series_id = $1) WHERE id = $1', [id]);
  // The listing the sweep would have written: through the real path, a listing refresh that downloads nothing.
  const r = await updateSeries(id, 0);
  assert.equal(r.outcome, 'ok', `the listing of ${key} was written`);
  return { id, folder, ref: `${key}-ref` };
}

const row = (id: string) => one('SELECT * FROM archive_queue WHERE series_id = $1', [id]);
/**
 * An archive that has landed a chapter of this series before. The first one it lands is scanned in at once (v0.49.1),
 * and the tests that are about a chapter waiting for its batch scan need theirs to be a later one.
 */
const pastFirst = (id: string) => q('UPDATE archive_queue SET done_count = 1 WHERE series_id = $1', [id]);
const pace = (src: string) => one('SELECT * FROM archive_pace WHERE source_id = $1', [src]);
const tick = (o: Parameters<typeof arch.archiveTick>[0] = {}) => arch.archiveTick(o);
const onDiskNums = (folder: string) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((n) => existsSync(join(DL, folder, `Chapter ${n}.cbz`)));

/** Move the clock past every rest the archive has written, then look once and let what started finish. */
async function step(o: Parameters<typeof arch.archiveTick>[0] = {}) {
  const p = await one(`SELECT max(GREATEST(next_at, backoff_until)) AS t FROM archive_pace WHERE source_id LIKE 'arch-%'`);
  if (p?.t) now = Math.max(now, new Date(p.t).getTime() + 1000);
  const r = await tick(o);
  await arch.archiveIdle();
  return r;
}
async function drain(id: string, max = 40) {
  const picks: number[] = [];
  for (let i = 0; i < max; i++) {
    const r = await row(id);
    if (!r || r.state === 'done') return picks;
    const t = await step();
    for (const s of t.started) if (s.seriesId === id && s.number != null) picks.push(s.number);
  }
  assert.fail(`${id} did not finish in ${max} looks`);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q, one } = (await import('../src/lib/db')) as any);
  ({ runtime } = (await import('../src/lib/runtime')) as any);
  arch = await import('../src/lib/archive');
  ({ updateSeries } = await import('../src/lib/updater'));
  ({ withGate } = await import('../src/lib/gate'));
  ({ noteRateLimited, clearPace } = (await import('../src/lib/pace')) as any);
  ({ setDisabled, clearBlock } = (await import('../src/lib/sourceHealth')) as any);
  ({ viewCtxFor } = (await import('../src/lib/visibility')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  // The check's source first: the daily source check walks the registry in order.
  registerAdapter(adapter(CHK) as any);
  for (const id of [A, B, R, R2, C]) registerAdapter(adapter(id) as any);
  registerAdapter(adapter(NSFW, { isNsfw: true }) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Arch',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`DELETE FROM users WHERE username IN ('arch-admin', 'arch-capped')`);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('arch-admin','arch-admin','x','admin','password') RETURNING id`))[0].id;
  adminCtx = await viewCtxFor(adminId, 'admin');
  // The default floor is 20 GB and a test's tmpfs is smaller; the disk test sets its own.
  await q('UPDATE server_settings SET archive_min_free_gb = 1, archive_paused = false, archive_window_from = NULL, archive_window_to = NULL, archive_per_hour = 4 WHERE id = 1');
  arch.setArchiveClock(() => now);
});

beforeEach(async () => {
  if (!DSN) return;
  await arch.archiveIdle();
  arch.resetArchiveMemory();
  clearPace();
  await q(`DELETE FROM archive_queue WHERE series_id LIKE 's_arch_%'`);
  await q(`DELETE FROM archive_pace WHERE source_id LIKE 'arch-%'`);
  await q(`DELETE FROM source_health WHERE source_id LIKE 'arch-%'`);
  await q(`DELETE FROM chapter_failures WHERE series_id LIKE 's_arch_%'`);
  runtime.updating = false; runtime.repairing = false; runtime.stopping = false;
  now = Date.now();
});

after(async () => {
  if (!DSN) return;
  await arch.archiveIdle();
  arch.setArchiveClock(null);
  await q(`DELETE FROM archive_queue WHERE series_id LIKE 's_arch_%'`);
  await q(`DELETE FROM archive_pace WHERE source_id LIKE 'arch-%'`);
  await q(`DELETE FROM source_health WHERE source_id LIKE 'arch-%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_arch_%' OR folder LIKE 'arch/%'`);
  await q(`DELETE FROM users WHERE username IN ('arch-admin', 'arch-capped')`);
  await q('UPDATE server_settings SET archive_min_free_gb = 20 WHERE id = 1');
  const { pool } = await import('../src/lib/db');
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
});

test('a restart keeps its place and its break', { skip }, async () => {
  const s = await series('restart', A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await pastFirst(s.id);
  const q0 = await row(s.id);
  assert.equal(q0.direction, 'up', 'nothing held: from chapter one');
  assert.ok(Math.abs(Number(q0.boundary) - 10.001) < 1e-4, `the boundary is a hair above the newest listed (${q0.boundary})`);
  assert.equal((await one('SELECT chapter_floor FROM lib_series WHERE id = $1', [s.id])).chapter_floor, null, 'chapter_floor is never written');

  // Deterministic breaks: 0.99 draws a short break near its top and never a long one.
  const rand = () => 0.99;
  const t1 = await tick({ rand });
  assert.deepEqual(t1.started.map((x) => x.number), [1]);
  await arch.archiveIdle();
  assert.deepEqual(onDiskNums(s.folder), [1], 'chapter one landed');
  const p1 = await pace(A);
  const breakEnds = new Date(p1.next_at).getTime();
  assert.ok(breakEnds >= now + 10 * MIN, `the break after a chapter is written down (${Math.round((breakEnds - now) / MIN)} min)`);

  // The restart: memory gone, the database kept.
  arch.resetArchiveMemory();
  await arch.archiveBoot();
  now += MIN;
  // Reintroduce by dropping the break's write after the chapter: only the 45 s reservation is left and this
  // tick, a minute on, starts chapter two at once.
  const t2 = await tick({ rand });
  assert.deepEqual(t2.started, [], 'a restart does not shorten the break');
  assert.equal(t2.waits[s.id]?.why, 'break');

  now = breakEnds + 1000;
  const askedBefore = asked.filter((c) => c === `${s.ref}/c1`).length;
  const t3 = await tick({ rand });
  // Chapter one is on disk but was never scanned (the scan waits for a batch): it is stepped over, not refetched.
  assert.deepEqual(t3.started.map((x) => x.number), [2], 'it carries on at chapter two');
  await arch.archiveIdle();
  assert.equal(asked.filter((c) => c === `${s.ref}/c1`).length, askedBefore, 'chapter one was not asked for again');
});

test('a chapter cut off by a crash comes back into a break, not a burst', { skip }, async () => {
  const s = await series('crash', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  const release = hold(`${s.ref}/c1`);
  // Let go whatever happens: a held chapter left behind would keep every later test's archiveIdle() waiting.
  try {
    const t1 = await tick();
    assert.deepEqual(t1.started.map((x) => x.number), [1]);
    assert.equal(Number((await row(s.id)).current_number), 1, 'what is in flight is on the row');
    // Reintroduce by dropping the reservation in begin(): while the chapter is still in flight nothing says when
    // the source may be asked again, so a crash now would come back to an empty next_at.
    const reserved = (await pace(A))?.next_at;
    assert.ok(reserved && new Date(reserved).getTime() >= now + 44_000, 'the next start is reserved before the chapter is asked for');
    // The process dies here, mid-chapter: nothing after the download runs. Its memory goes, the database stays.
    arch.resetArchiveMemory();
    await arch.archiveBoot();
    assert.equal((await row(s.id)).current_number, null, 'boot clears a chapter that died with the last process');
    now += 5_000;
    const t2 = await tick();
    assert.deepEqual(t2.started, [], 'the break was reserved before the chapter started');
    assert.equal(t2.waits[s.id]?.why, 'break');
  } finally {
    release();
    await arch.archiveIdle();
  }
});

test('it yields: to every server-wide job and gate, per source, and per series', { skip }, async () => {
  const y1 = await series('y1', A, [1, 2, 3]);
  const y2 = await series('y2', B, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(y1.id, adminId, adminCtx), 'queued');
  assert.equal(await arch.enqueueArchive(y2.id, adminId, adminCtx), 'queued');

  const global = async (why: string, on: () => Promise<void> | void, off: () => Promise<void> | void) => {
    await on();
    try {
      const t = await tick();
      assert.equal(t.waiting?.why, why, `waits for ${why}`);
      assert.deepEqual(t.started, [], `nothing starts while ${why}`);
    } finally { await off(); }
  };
  await global('sweep', () => { runtime.updating = true; }, () => { runtime.updating = false; });
  await global('repair', () => { runtime.repairing = true; }, () => { runtime.repairing = false; });
  await global('stopping', () => { runtime.stopping = true; }, () => { runtime.stopping = false; });
  await global('paused', () => q('UPDATE server_settings SET archive_paused = true WHERE id = 1'), () => q('UPDATE server_settings SET archive_paused = false WHERE id = 1'));
  const h = new Date(now).getHours();
  await global('window',
    () => q('UPDATE server_settings SET archive_window_from = $1, archive_window_to = $2 WHERE id = 1', [(h + 2) % 24, (h + 3) % 24]),
    () => q('UPDATE server_settings SET archive_window_from = NULL, archive_window_to = NULL WHERE id = 1'));
  await global('disk', () => q('UPDATE server_settings SET archive_min_free_gb = 1000000 WHERE id = 1'), () => q('UPDATE server_settings SET archive_min_free_gb = 1 WHERE id = 1'));
  // The daily source check walks every source; the archive stands aside while it does.
  const { runSourceCheck, checkRunning } = await import('../src/lib/sourceWatchdog');
  let release!: () => void;
  checkGate = { promise: new Promise<void>((r) => { release = r; }), release: () => release() };
  const check = runSourceCheck({ autoFix: false });
  await global('check', () => assert.equal(checkRunning(), true), () => { checkGate!.release(); });
  await check;
  checkGate = null;

  // Per source, one series at a time: y2 is paused so only y1 is looked at.
  await arch.archiveAct('pause', y2.id, { userId: adminId, admin: true, ctx: adminCtx });
  const perSource = async (why: string, on: () => Promise<unknown> | unknown, off: () => Promise<unknown> | unknown) => {
    await on();
    try {
      const t = await tick();
      assert.deepEqual(t.started, [], `nothing starts on ${A} (${why})`);
      assert.equal(t.waits[y1.id]?.why, why);
    } finally { await off(); }
  };
  // Another download on the same source -- a person's Fetch, an add -- holds the gate.
  let openGate!: () => void;
  const gateHeld = new Promise<void>((r) => { openGate = r; });
  let gateRun: Promise<unknown> = Promise.resolve();
  // Reintroduce by dropping the gate from sourceWait: this starts chapter one beside the person's download.
  await perSource('source_busy', () => { gateRun = withGate(A, () => gateHeld); }, async () => { openGate(); await gateRun; });
  await perSource('pace', () => noteRateLimited(A), () => clearPace());
  await perSource('cooldown',
    () => q(`INSERT INTO source_health (source_id, status, blocked_until) VALUES ($1, 'rate_limited', now() + interval '10 minutes')
             ON CONFLICT (source_id) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`, [A]),
    () => clearBlock(A));
  await perSource('disabled', () => setDisabled(A, true), () => setDisabled(A, false));

  // A download already running for the series itself: that series waits, one on another source still goes.
  await arch.archiveAct('resume', y2.id, { userId: adminId, admin: true, ctx: adminCtx });
  const t = await tick({ busy: (folder) => folder === y1.folder });
  assert.equal(t.waits[y1.id]?.why, 'series_busy');
  assert.deepEqual(t.started.map((x) => x.seriesId), [y2.id], 'the other source is not held up by it');
  await arch.archiveIdle();

  // Every gate released: y1 starts.
  const t2 = await tick();
  assert.deepEqual(t2.started.map((x) => `${x.seriesId}:${x.number}`), [`${y1.id}:1`]);
  await arch.archiveIdle();
});

test('a series whose source is gone waits, and says so', { skip }, async () => {
  const s = await series('gone', A, [1, 2]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  // The extension is uninstalled: every copy the listing has is on a source no adapter serves.
  await q(`UPDATE series_listing SET copies = (SELECT jsonb_agg(c || jsonb_build_object('source', $2::text)) FROM jsonb_array_elements(copies) c)
            WHERE series_id = $1`, [s.id, GONE]);
  const t = await tick();
  assert.deepEqual(t.started, []);
  assert.equal(t.waits[s.id]?.why, 'source_missing');
  let v = await arch.archiveView(() => true, adminId);
  // Reintroduce by flagging a missing source at once (attentionOf): this reads source_missing -- as every extension
  // reload would.
  assert.equal(v.series.find((x) => x.seriesId === s.id)?.attention, undefined, 'not on the first look: a reload is not a problem');
  now += DAY;
  assert.equal((await tick()).waits[s.id]?.why, 'source_missing');
  v = await arch.archiveView(() => true, adminId);
  assert.equal(v.series.find((x) => x.seriesId === s.id)?.attention?.why, 'source_missing', 'a day on, Needs attention shows it');
});

test('a listing that cannot be read is asked for less and less often, and flagged after three days', { skip }, async () => {
  // A series its site lists nothing for (moved, delisted), and one whose site is down: neither has a listing, so
  // neither has a boundary, and each read of it is its source's turn.
  const e = await series('nolist', A, []);
  const d = await series('downlist', B, []);
  listThrows.add(d.ref);
  const rand = () => 0.99;
  try {
    assert.equal(await arch.enqueueArchive(e.id, adminId, adminCtx), 'queued');
    assert.equal(await arch.enqueueArchive(d.id, adminId, adminCtx), 'queued');
    assert.equal((await row(e.id)).boundary, null, 'no listing, no boundary yet');
    const queuedAt = now;
    listAsks.clear();
    let waits: Record<string, { why: string; until?: number }> = {};
    // An hour of the scheduler's own rhythm, a look a minute.
    for (let i = 0; i < 60; i++) {
      const t = await tick({ rand });
      await arch.archiveIdle();
      if (i === 0) {
        assert.deepEqual(t.started.map((x) => `${x.seriesId}:${x.kind}`).sort(), [`${d.id}:listing`, `${e.id}:listing`].sort());
        // Reintroduce by resting the minimum after a read that gave nothing: A is free again in 45 s.
        const rest = new Date((await pace(A)).next_at).getTime() - now;
        assert.ok(rest >= 10 * MIN, `the source rests a whole break after a read that gave nothing (${Math.round(rest / 1000)} s)`);
      }
      if (i === 1) waits = t.waits;
      now += MIN;
    }
    // Reintroduce by dropping the ladder in tickOnce: each is read at every break, four times in the hour.
    assert.ok((listAsks.get(e.ref) ?? 0) <= 2, `an empty listing is asked for at most twice in an hour (${listAsks.get(e.ref)})`);
    assert.ok((listAsks.get(d.ref) ?? 0) <= 2, `a failing one too (${listAsks.get(d.ref)})`);
    assert.equal(waits[e.id]?.why, 'listing', 'and it says why it waits');
    assert.equal(waits[e.id]?.until, queuedAt + HOUR, 'read again an hour after the first read');
    assert.equal(waits[d.id]?.why, 'listing');
    assert.equal((await row(e.id)).state, 'queued', 'a listing that is not there today may be tomorrow');

    // The ladder: 1 h, 3 h, 12 h, then a day, kept on the row (a restart keeps it).
    const rungs: number[] = [];
    for (let i = 0; i < 5; i++) {
      now = Date.parse((await row(e.id)).note.listingRetryAt);
      const before = listAsks.get(e.ref) ?? 0;
      await tick({ rand });
      await arch.archiveIdle();
      assert.equal(listAsks.get(e.ref), before + 1, 'read once at its time');
      rungs.push(Date.parse((await row(e.id)).note.listingRetryAt) - now);
      if (i === 1) {
        // A restart: the ladder is on the row, so the next read does not come any sooner.
        arch.resetArchiveMemory();
        now += MIN;
        assert.equal((await tick({ rand })).waits[e.id]?.why, 'listing', 'a restart does not bring the next read forward');
        await arch.archiveIdle();
        assert.equal(listAsks.get(e.ref), before + 1);
      }
    }
    assert.deepEqual(rungs.map((x) => x / HOUR), [3, 12, 24, 24, 24], 'after the first hour: 3 h, 12 h, then a day');
    // 64 hours in: had its turns, nothing came of them, not yet three days.
    const shown = async (id: string) => (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === id);
    assert.ok(now - queuedAt < 3 * DAY);
    assert.equal((await shown(e.id))?.attention, undefined, 'under three days');
    now = queuedAt + 3 * DAY + MIN;
    // Reintroduce by dropping the queued 'stalled' rule (attentionOf): nothing under Needs attention, ever.
    assert.deepEqual((await shown(e.id))?.attention, { why: 'stalled', since: new Date(queuedAt).toISOString() }, 'three days of turns with nothing in');
    assert.equal((await shown(d.id))?.attention?.why, 'stalled');

    // The listing comes back: read at its next turn, the boundary placed, the flag and the ladder gone.
    listed.set(e.ref, [1, 2]);
    now = Date.parse((await row(e.id)).note.listingRetryAt);
    await tick({ rand });
    await arch.archiveIdle();
    const back = await row(e.id);
    assert.ok(Math.abs(Number(back.boundary) - 2.001) < 1e-4, `the boundary is placed (${back.boundary})`);
    assert.equal(back.note.listingRetryAt, undefined);
    assert.equal(back.note.progressAt, new Date(now).toISOString(), 'a listing at last is progress');
    assert.equal((await shown(e.id))?.attention, undefined);
    const t2 = await step({ rand });
    assert.deepEqual(t2.started.filter((x) => x.seriesId === e.id).map((x) => x.number), [1], 'and its first chapter follows');
  } finally {
    listThrows.delete(d.ref);
    await arch.archiveIdle();
  }
});

test('chapters coming in, and a resume, start the three days again', { skip }, async () => {
  const s = await series('steady', A, [1, 2, 3, 4, 5, 6]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  const shown = async () => (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === s.id);
  // A chapter a day for four days: slow, but moving.
  for (let day = 1; day <= 4; day++) {
    assert.deepEqual((await tick()).started.map((x) => x.number), [day]);
    await arch.archiveIdle();
    now += DAY;
    // Reintroduce by dropping the progress stamp on a landed chapter (runChapter): day three reads stalled.
    assert.equal((await shown())?.attention, undefined, `day ${day}: a chapter came in, so it is not stalled`);
  }
  // Paused ten days, then resumed: the pause was a person's, not the series' failure.
  const who = { userId: adminId, admin: true, ctx: adminCtx };
  assert.equal(await arch.archiveAct('pause', s.id, who), 'ok');
  now += 10 * DAY;
  assert.equal((await shown())?.attention?.why, 'stalled', 'paused for over a week');
  assert.equal(await arch.archiveAct('resume', s.id, who), 'ok');
  // Reintroduce by clearing the note on resume (archiveAct): this reads stalled, from progress ten days old.
  assert.equal((await shown())?.attention, undefined, 'resumed: its three days start again');
});

test('numbers a scan could not index are stepped over, and the rest of the catalogue is still fetched', { skip }, async () => {
  const s = await series('stuck', A, [1, 2, 3, 4, 5, 6, 7]);
  // Chapters 1-5 are on disk, and the library will not index them (a trigger drops their rows, as a folder the
  // scan cannot take would): five in a row, the whole of one pick.
  for (const n of [1, 2, 3, 4, 5]) writeFileSync(join(DL, s.folder, `Chapter ${n}.cbz`), 'not a zip');
  await q(`CREATE OR REPLACE FUNCTION arch_stuck_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN IF NEW.series_id = '${s.id}' AND NEW.number <= 5 THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await q('DROP TRIGGER IF EXISTS arch_stuck_refuse ON lib_books');
  await q('CREATE TRIGGER arch_stuck_refuse BEFORE INSERT ON lib_books FOR EACH ROW EXECUTE FUNCTION arch_stuck_refuse()');
  try {
    assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
    const t1 = await tick();
    assert.deepEqual(t1.started, [], 'the five on disk are not fetched again');
    await arch.flushArchiveScan();
    assert.deepEqual(await q('SELECT number FROM lib_books WHERE series_id = $1', [s.id]), [], 'and the library did not take them');
    const t2 = await step();
    // Reintroduce by filtering the stuck numbers after the query (candidatesFor): the pick is empty, and this
    // finishes the series with 6 and 7 never asked for.
    assert.deepEqual(t2.finished, [], 'five stuck numbers do not end the archive');
    assert.deepEqual(t2.started.map((x) => x.number), [6]);
    assert.deepEqual(await drain(s.id), [7]);
    assert.deepEqual(onDiskNums(s.folder), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual((await q('SELECT number FROM lib_books WHERE series_id = $1 ORDER BY number', [s.id])).map((b: any) => Number(b.number)), [6, 7]);
  } finally {
    await q('DROP TRIGGER IF EXISTS arch_stuck_refuse ON lib_books');
    await q('DROP FUNCTION IF EXISTS arch_stuck_refuse()');
  }
});

test("the running cycle is the chapter's time: a backoff and a night outside the window are left out", { skip }, async () => {
  const rand = () => 0.99;
  const { nextBreakMs } = await import('../src/lib/archivePace');
  // What 0.99 draws at four an hour after a chapter that took no time on this clock (17.5 minutes): the first
  // cycle on a source is its chapter and its break.
  const brk = nextBreakMs({ perHour: 4, chapterMs: 0, rand, minBreakMs: 45_000 }).ms;

  // A refusal, an hour's backoff, then the chapter. The source's break (17.5 min) is the pace; the 42.5 minutes of
  // backoff beyond it are the site's.
  const b = await series('cycleback', R, [1, 2]);
  assert.equal(await arch.enqueueArchive(b.id, adminId, adminCtx), 'queued');
  assert.deepEqual((await tick({ rand })).started.map((x) => x.number), [1]);
  await arch.archiveIdle();
  let p = await pace(R);
  assert.equal(p.cycle_ms, brk, 'the first cycle is the chapter and its break');
  assert.equal(new Date(p.backoff_until).getTime(), now + HOUR, 'an hour of backoff');
  refusing.delete(R);
  try {
    clearPace();
    await clearBlock(R);
    now += HOUR + MIN;
    assert.deepEqual((await tick({ rand })).started.map((x) => x.number), [1]);
    await arch.archiveIdle();
    p = await pace(R);
    // Reintroduce by feeding the whole span (61 minutes) to ewmaCycle: the average jumps by minutes, not 12 s.
    assert.equal(p.cycle_ms, Math.round(brk + 0.2 * MIN), 'the sample is the break and the minute after the backoff');
  } finally {
    refusing.add(R);
    await arch.archiveAct('stop', b.id, { userId: adminId, admin: true, ctx: adminCtx });
  }

  // A window of 10:00-11:00: a chapter at 10:50, the next at 10:01 the morning after. The ten minutes before it
  // shut and the minute after it opened are the pace; the 23 hours between are the window's.
  const w = await series('cyclenight', A, [1, 2, 3]);
  const day = new Date(Date.now() + 2 * DAY);
  day.setHours(10, 50, 0, 0);
  now = day.getTime();
  await q('UPDATE server_settings SET archive_window_from = 10, archive_window_to = 11 WHERE id = 1');
  try {
    assert.equal(await arch.enqueueArchive(w.id, adminId, adminCtx), 'queued');
    const mine = async () => (await tick({ rand })).started.filter((x) => x.seriesId === w.id).map((x) => x.number);
    assert.deepEqual(await mine(), [1]);
    await arch.archiveIdle();
    const c1 = (await pace(A)).cycle_ms;
    assert.equal(c1, brk);
    now += 23 * HOUR + 11 * MIN;
    assert.deepEqual(await mine(), [2]);
    await arch.archiveIdle();
    // Reintroduce by leaving the window out of outsideCycleMs' call: the sample is 23 hours, and only ewmaCycle's
    // cap stands between the night and the average.
    assert.equal((await pace(A)).cycle_ms, Math.round(c1 + 0.2 * (11 * MIN - c1)), 'the night is the window\'s, not the chapter\'s');
  } finally {
    await q('UPDATE server_settings SET archive_window_from = NULL, archive_window_to = NULL WHERE id = 1');
  }
});

test('a chapter slower than its share of the hour counts in full in the running cycle', { skip }, async () => {
  // A sample is capped against what a chapter of THAT length costs at the rate (expectedCycleMs), not the hour's bare
  // share: capped at the share, an 80-minute chapter at four an hour read 75 minutes, and the ETA ran short. The
  // archfix review's integration note. Reintroduce the share as the cap in runChapter (ewmaCycle(..., 3_600_000 /
  // set.perHour)): this reads 75 minutes.
  const rand = () => 0.99;
  const s = await series('slowch', A, [1, 2]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  const release = hold(`${s.ref}/c1`);
  try {
    assert.deepEqual((await tick({ rand })).started.map((x) => x.number), [1]);
    now += 80 * MIN;
  } finally {
    release();
    await arch.archiveIdle();
  }
  const cycle = Number((await pace(A)).cycle_ms);
  assert.ok(cycle >= 80 * MIN, `a chapter slower than its share of the hour counts in full (${Math.round(cycle / MIN)} min)`);
});

test('a refusal backs off and keeps the queue; a chapter let through ends the run', { skip }, async () => {
  const s = await series('refuse', R, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  const settle = async () => { clearPace(); await clearBlock(R); };

  const t1 = await tick();
  assert.deepEqual(t1.started.map((x) => x.number), [1]);
  await arch.archiveIdle();
  let r = await row(s.id);
  // Reintroduce by ending the row when its only source refuses, as a job card does: this reads done.
  assert.equal(r.state, 'queued', 'a refusal is "not now", not "never"');
  assert.equal(r.failed_count, 1);
  let p = await pace(R);
  assert.equal(p.backoff_level, 1);
  const first = new Date(p.backoff_until).getTime();
  assert.ok(first >= now + 60 * MIN - 1000, `left alone an hour (${Math.round((first - now) / MIN)} min)`);
  await settle();

  now += 30 * MIN;
  // Reintroduce by skipping the backoff write: the break alone has run out, and this starts a chapter.
  const t2 = await tick();
  assert.deepEqual(t2.started, [], 'half an hour on, still left alone');
  assert.equal(t2.waits[s.id]?.why, 'backoff');

  now = first + MIN;
  const t3 = await tick();
  assert.equal(t3.started.length, 1, 'an hour on, it tries again');
  await arch.archiveIdle();
  p = await pace(R);
  assert.equal(p.backoff_level, 2, 'a second refusal in a row');
  assert.ok(new Date(p.backoff_until).getTime() >= now + 3 * 60 * MIN - 1000, 'three hours this time');
  const v = await arch.archiveView(() => true, adminId);
  assert.equal(v.series.find((x) => x.seriesId === s.id)?.attention?.why, 'backoff', 'twice in a row is worth a look');
  await settle();

  refusing.delete(R);
  try {
    now = new Date(p.backoff_until).getTime() + MIN;
    const t4 = await tick();
    assert.equal(t4.started.length, 1);
    await arch.archiveIdle();
    p = await pace(R);
    assert.equal(p.backoff_level, 0, 'a chapter the site let through ends the run');
    assert.equal(p.backoff_until, null);
    r = await row(s.id);
    assert.equal(r.done_count, 1);
  } finally { refusing.add(R); }
});

test('an alternate asked inside a failed chapter rests and backs off as the chosen source does', { skip }, async () => {
  const s = await series('alt', R, [1, 2]);
  // The same series followed on a second site, which refuses too.
  listed.set('alt-ref2', [1, 2]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'alt-ref2') ON CONFLICT DO NOTHING`, [s.id, R2]);
  assert.equal((await updateSeries(s.id, 0)).outcome, 'ok');
  const copies = (await one('SELECT copies FROM series_listing WHERE series_id = $1 AND number = 1', [s.id])).copies;
  assert.deepEqual(copies.map((c: any) => c.source).sort(), [R, R2].sort(), 'both sites list chapter one');
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  const t = await tick({ rand: () => 0.99 });
  assert.deepEqual(t.started.map((x) => `${x.source}:${x.number}`), [`${R}:1`]);
  await arch.archiveIdle();
  assert.ok(asked.includes('alt-ref2/c1'), 'the alternate was asked for the chapter');
  assert.equal((await pace(R)).backoff_level, 1);
  // Reintroduce by resting and backing off only the chosen source (runChapter): this finds no row for R2, and
  // the next tick may start another series' chapter on the site that has just said no.
  const p2 = await pace(R2);
  assert.ok(p2, 'the alternate has its own rest');
  assert.ok(new Date(p2.next_at).getTime() >= now + 10 * MIN, 'the same break as the chosen source');
  assert.equal(p2.backoff_level, 1, "its refusal backs it off as the chosen source's does");
  assert.ok(new Date(p2.backoff_until).getTime() >= now + HOUR - 1000, 'an hour');
});

test('the sweep and the archive split the work at the boundary; the floor is left alone', { skip }, async () => {
  const w = await series('split', A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(await arch.enqueueArchive(w.id, adminId, adminCtx), 'queued');
  assert.equal((await one('SELECT chapter_floor FROM lib_series WHERE id = $1', [w.id])).chapter_floor, null);
  // Reintroduce by reading chapter_floor alone in the updater: this downloads chapters 1-5.
  let r = await updateSeries(w.id, 5);
  assert.equal(r.added, 0, 'the sweep leaves the back catalogue to the archive');
  assert.equal((await one('SELECT source_missing FROM lib_series WHERE id = $1', [w.id])).source_missing, 0, '"behind" counts only the sweep\'s own work');
  // A new release above the boundary is the sweep's.
  listed.set(w.ref, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  r = await updateSeries(w.id, 5);
  assert.deepEqual(r.landed.map((l) => l.number), [11]);
  // A paused archive still owns its part.
  await arch.archiveAct('pause', w.id, { userId: adminId, admin: true, ctx: adminCtx });
  r = await updateSeries(w.id, 5);
  assert.equal(r.added, 0, 'paused, the boundary still holds');
  // Stopped, the sweep takes the back catalogue again, as it did before the archive.
  assert.equal(await arch.archiveAct('stop', w.id, { userId: adminId, admin: true, ctx: adminCtx }), 'ok');
  r = await updateSeries(w.id, 5);
  assert.deepEqual(r.landed.map((l) => l.number), [1, 2, 3, 4, 5]);
  // Health's Fill now asks past the boundary on purpose.
  const f = await series('fillnow', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(f.id, adminId, adminCtx), 'queued');
  r = await updateSeries(f.id, 5, { ignoreArchiveBoundary: true });
  assert.deepEqual(r.landed.map((l) => l.number), [1, 2, 3], 'Fill now fetches below an active boundary');
});

test('a Latest-N series is filled downwards from its own edge, and its unchanged floor is cleared at the end', { skip }, async () => {
  const l = await series('latest', A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { floor: 6, held: [6, 7, 8, 9, 10] });
  assert.equal(await arch.enqueueArchive(l.id, adminId, adminCtx), 'queued');
  const r0 = await row(l.id);
  assert.equal(Number(r0.boundary), 6, 'the boundary is the floor');
  assert.equal(r0.direction, 'down', 'grown from the held block\'s own edge');
  assert.equal(Number((await one('SELECT chapter_floor FROM lib_series WHERE id = $1', [l.id])).chapter_floor), 6, 'the floor is not moved');
  const picks = await drain(l.id);
  assert.deepEqual(picks, [5, 4, 3, 2, 1], 'no interior hole at any point');
  const done = await row(l.id);
  assert.equal(done.state, 'done');
  // Reintroduce by never clearing the floor: 1-5 are in, and a floor of 6 would still say they are not wanted.
  assert.equal((await one('SELECT chapter_floor FROM lib_series WHERE id = $1', [l.id])).chapter_floor, null, 'nothing is left below the floor it kept out');

  // The same, with the floor changed by someone in between: theirs, and kept.
  const k = await series('kept', A, [1, 2, 3, 4], { floor: 3, held: [3, 4] });
  assert.equal(await arch.enqueueArchive(k.id, adminId, adminCtx), 'queued');
  await q('UPDATE lib_series SET chapter_floor = 4 WHERE id = $1', [k.id]);
  await drain(k.id);
  // Reintroduce by clearing the floor unconditionally at done: this reads null.
  assert.equal(Number((await one('SELECT chapter_floor FROM lib_series WHERE id = $1', [k.id])).chapter_floor), 4, 'a floor changed since is kept');
});

test('done with gaps: what was left behind is counted, and the boundary is lifted', { skip }, async () => {
  const g = await series('gaps', A, [1, 2, 3, 4, 5]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts) VALUES ($1, 3, $2, 'error', 'gone', 3)`, [g.id, A]);
  assert.equal(await arch.enqueueArchive(g.id, adminId, adminCtx), 'queued');
  const picks = await drain(g.id);
  assert.deepEqual(picks, [1, 2, 4, 5], 'the capped chapter is not asked for');
  const r = await row(g.id);
  assert.equal(r.state, 'done');
  assert.ok(r.finished_at);
  assert.deepEqual(r.note, { capped: 1, held: 0, blocked: 0 });
  assert.equal(r.done_count, 4);
  // The library has the four, and the Updates count agrees.
  const books = await q('SELECT number FROM lib_books WHERE series_id = $1 ORDER BY number', [g.id]);
  assert.deepEqual(books.map((b: any) => Number(b.number)), [1, 2, 4, 5], 'scanned in when the series finished');
  const stamped = await q('SELECT number, source_chapter_id FROM lib_books WHERE series_id = $1 ORDER BY number', [g.id]);
  assert.deepEqual(stamped.map((b: any) => b.source_chapter_id), [1, 2, 4, 5].map((n) => `${g.ref}/c${n}`), 'each file knows the source chapter it came from');
  // The boundary no longer counts for the sweep: chapter 3 is behind again, for the repair's weekly retry.
  await updateSeries(g.id, 0);
  assert.equal((await one('SELECT source_missing FROM lib_series WHERE id = $1', [g.id])).source_missing, 1);
  const v = await arch.archiveView(() => true, adminId);
  const shown = v.series.find((x) => x.seriesId === g.id);
  assert.equal(shown?.attention?.why, 'finished_with_gaps');
  assert.deepEqual(shown?.note, { capped: 1, held: 0, blocked: 0 });
  // Dismissed by stopping it.
  assert.equal(await arch.archiveAct('stop', g.id, { userId: adminId, admin: true, ctx: adminCtx }), 'ok');
  assert.equal(await row(g.id), null);
});

test('archived chapters are not updates; a real new release still is', { skip }, async () => {
  const u = await series('updates', A, [1, 2, 3]);
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [adminId, u.id]);
  await q(`INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, 0)
           ON CONFLICT (user_id, series_id) DO UPDATE SET seen_books_count = 0`, [adminId, u.id]);
  const newCount = async () => {
    const r = await one(`SELECT s.books_count - ss.seen_books_count AS n FROM lib_series s JOIN series_seen ss ON ss.series_id = s.id
                          WHERE s.id = $1 AND ss.user_id = $2`, [u.id, adminId]);
    return Number(r.n);
  };
  assert.equal(await newCount(), 0);
  assert.equal(await arch.enqueueArchive(u.id, adminId, adminCtx), 'queued');
  await drain(u.id);
  assert.equal(Number((await one('SELECT books_count FROM lib_series WHERE id = $1', [u.id])).books_count), 3, 'three chapters came in');
  // Reintroduce by dropping the series_seen update after the archive's scan: this reads 3.
  assert.equal(await newCount(), 0, 'a back catalogue is not three new chapters');
  listed.set(u.ref, [1, 2, 3, 4]);
  const r = await updateSeries(u.id, 5);
  assert.deepEqual(r.landed.map((l) => l.number), [4]);
  const { persistScan } = await import('../src/lib/library');
  await persistScan();
  assert.equal(await newCount(), 1, 'the sweep\'s new release is still new');
});

test('the scheduler runs itself: the first look waits out its delay, even when an enqueue kicks it', { skip }, async () => {
  const s = await series('loop', A, [1, 2]);
  process.env.ARCHIVE_FIRST_RUN_MS = '1500';
  try {
    const t0 = Date.now();
    arch.startArchive({ busy: () => false, log: { info() {}, warn() {}, error() {} } });
    // An enqueue kicks the scheduler; a kick must not bring the first look after a boot forward.
    assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
    await new Promise((r) => setTimeout(r, 600));
    // Reintroduce by arming every kick at 250 ms: chapter one has started by now.
    assert.equal((await row(s.id)).last_at, null, 'nothing before the first look, however it was kicked');
    const deadline = Date.now() + 10_000;
    while (!(await row(s.id)).last_at && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok((await row(s.id)).last_at, 'the first look came, and started a chapter');
    assert.ok(Date.now() - t0 >= 1400, 'and not before its delay');
    await arch.archiveIdle();
    assert.deepEqual(onDiskNums(s.folder), [1]);
  } finally {
    delete process.env.ARCHIVE_FIRST_RUN_MS;
    await arch.archiveIdle();
    arch.resetArchiveMemory();
  }
});

test('deleting or merging a series drops its archive', { skip }, async () => {
  const { deleteSeries, mergeSeries } = await import('../src/lib/libraryAdmin');
  const d = await series('del', A, [1, 2]);
  assert.equal(await arch.enqueueArchive(d.id, adminId, adminCtx), 'queued');
  // Reintroduce by dropping the DELETE in deleteSeries: the row survives the soft delete.
  await deleteSeries(d.id);
  assert.equal(await row(d.id), null, 'deleted: its archive goes');
  const m1 = await series('m1', A, [1, 2]);
  const m2 = await series('m2', B, [1, 2]);
  assert.equal(await arch.enqueueArchive(m1.id, adminId, adminCtx), 'queued');
  await mergeSeries(m1.id, m2.id);
  assert.equal(await row(m1.id), null, 'merged away: its archive goes');
});

// ── #116 x #117: a renumber and the archive (the critic's "issue-116 vs issue-117") ─────────────────────────────

test('no archive chapter while a renumber is pending; queued behind one, its boundary waits for the new numbers', { skip }, async () => {
  const s = await series('renum', A, [1, 2, 3, 4]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await q(`UPDATE lib_series SET numbering_pending = 'posting_order' WHERE id = $1`, [s.id]);
  try {
    // Reintroduce by dropping the renumbering gate in tickOnce: chapter one starts under a number the pending
    // plan is about to move (the s13 review's reintroduction #5, which nothing caught).
    const t = await tick();
    assert.deepEqual(t.started, [], 'no archive chapter while a renumber is pending');
    assert.equal(t.waits[s.id]?.why, 'renumbering');
    await arch.archiveIdle();
    assert.deepEqual(onDiskNums(s.folder), []);

    // Queued while one is pending: no boundary yet, since one placed now would be in the numbers the renumber
    // replaces. Reintroduce by placing it anyway (enqueueArchive): this reads 4.001.
    await arch.archiveAct('stop', s.id, { userId: adminId, admin: true, ctx: adminCtx });
    assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
    assert.equal((await row(s.id)).boundary, null, 'queued behind a pending renumber: no boundary until it settles');
    // Settled: its first turn reads the listing in the numbers the series keeps, and places the boundary there.
    await q(`UPDATE lib_series SET numbering_pending = NULL WHERE id = $1`, [s.id]);
    const t2 = await tick();
    assert.deepEqual(t2.started.map((x) => `${x.seriesId}:${x.kind}`), [`${s.id}:listing`]);
    await arch.archiveIdle();
    assert.ok(Math.abs(Number((await row(s.id)).boundary) - 4.001) < 1e-4, 'placed once the numbers settled');
  } finally {
    await q(`UPDATE lib_series SET numbering_pending = NULL WHERE id = $1`, [s.id]);
  }
});

test('a renumber moves the archive: its direction is settled again from the renumbered listing', { skip }, async () => {
  // The commit remaps the boundary and the floor itself (lib/numbering.ts) and marks the row `renumbered`; which way
  // it fills is decided from the listing, which the commit deletes and the check after it writes again.
  const s = await series('redir', A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { held: [6, 7, 8, 9, 10] });
  await q(`INSERT INTO archive_queue (series_id, state, boundary, direction, note) VALUES ($1, 'queued', 6, 'up', $2::jsonb)`,
    [s.id, JSON.stringify({ renumbered: new Date(now).toISOString() })]);
  // Reintroduce by keeping the direction: this starts chapter 1, an interior hole under the held block.
  const t = await tick();
  const r = await row(s.id);
  assert.equal(r.direction, 'down', 'a renumber moves the archive: its direction follows the new numbers');
  assert.equal(r.note?.renumbered, undefined, 'settled once');
  assert.deepEqual(t.started.filter((x) => x.seriesId === s.id).map((x) => x.number), [5], 'down from the held block\'s own edge');
  await arch.archiveIdle();
});

test('a renumber moves a paused archive too: its direction is settled at the first look after the resume', { skip }, async () => {
  // A paused row is not looked at, so the `renumbered` mark a commit writes on it waits for the resume -- and the
  // resume replaced the note, mark and all, as a pause did to a mark no look had settled yet: the archive went on
  // filling in the direction of the old numbers (integration-2 review). Reintroduce by building the resume's note
  // without it (archiveAct): chapter 1 starts, below the held block, where 'up' begins.
  const mark = JSON.stringify({ renumbered: new Date(now).toISOString() });
  // Renumbered while paused, as the commit leaves the row (its note merged, the pause kept).
  const s = await series('redirp', A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { held: [6, 7, 8, 9, 10] });
  await q(`INSERT INTO archive_queue (series_id, state, boundary, direction, note) VALUES ($1, 'paused', 6, 'up', $2::jsonb || $3::jsonb)`,
    [s.id, JSON.stringify({ pausedAt: new Date(now).toISOString() }), mark]);
  // Renumbered while queued, and paused before any look settled it.
  const s2 = await series('redirq', B, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { held: [6, 7, 8, 9, 10] });
  await q(`INSERT INTO archive_queue (series_id, state, boundary, direction, note) VALUES ($1, 'queued', 6, 'up', $2::jsonb)`, [s2.id, mark]);
  assert.equal(await arch.archiveAct('pause', s2.id, { userId: adminId, admin: true, ctx: adminCtx }), 'ok');
  for (const id of [s.id, s2.id]) assert.equal(await arch.archiveAct('resume', id, { userId: adminId, admin: true, ctx: adminCtx }), 'ok');
  const t = await tick();
  assert.equal((await row(s.id)).direction, 'down', 'a renumber moves a paused archive too');
  assert.equal((await row(s2.id)).direction, 'down', 'and one paused before a look settled it');
  assert.deepEqual(t.started.map((x) => x.number), [5, 5], "down from the held block's own edge");
  await arch.archiveIdle();
});

test('a look between a renumber and its listing reads the listing, and never finishes the archive', { skip }, async () => {
  // A renumber deletes the series' listing, and the check that applied it writes the new one a moment later. A look in
  // between found no candidate and FINISHED the archive -- boundary lifted, floor cleared, the back catalogue left to
  // the sweep's five a night. Reintroduce by dropping `!listed.has` from needsListing: the series is finished.
  const s = await series('between', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await q('DELETE FROM series_listing WHERE series_id = $1', [s.id]);
  const t = await tick();
  assert.deepEqual(t.finished, [], 'a missing listing is not "nothing left"');
  assert.deepEqual(t.started.map((x) => `${x.seriesId}:${x.kind}`), [`${s.id}:listing`], 'it is read first, as a missing boundary is');
  await arch.archiveIdle();
  assert.equal((await row(s.id)).state, 'queued');
  const t2 = await step();
  assert.deepEqual(t2.started.filter((x) => x.seriesId === s.id).map((x) => x.number), [1], 'and its chapters go on from it');
});

test('a refresh that leaves no listing is a read that gave nothing', { skip }, async () => {
  // After a renumber deleted its listing, a source that answers with no chapters leaves none: the updater keeps the
  // last listing, and there is none to keep. Counted as read on the answer alone, the series was asked for its
  // listing again at every break. Reintroduce `got = true` for a refresh in runListing: no ladder on the row.
  const s = await series('emptyrefresh', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  assert.ok((await row(s.id)).boundary != null, 'a boundary, so its next read is a refresh');
  await q('DELETE FROM series_listing WHERE series_id = $1', [s.id]);
  listed.set(s.ref, []);
  const t = await tick({ rand: () => 0.99 });
  assert.deepEqual(t.started.map((x) => `${x.seriesId}:${x.kind}`), [`${s.id}:listing`]);
  await arch.archiveIdle();
  const note = (await row(s.id)).note;
  assert.equal(note?.listingFails, 1, 'a refresh that leaves no listing is a read that gave nothing');
  assert.ok(note?.listingRetryAt, 'read again on the ladder, not at the next break');
  assert.equal((await row(s.id)).state, 'queued');
});

/**
 * `run`, with every library scan held until it has answered: what it answers, or 'waited' when it did not answer
 * within a few seconds -- it waited for a scan. The scan is a walk of the whole library, and a request that waits on
 * one can outlive the proxy on a large library (integration-2 review); a scan it started runs once the hold is let go.
 */
async function answersWithoutAScan<T>(run: () => Promise<T>): Promise<T | 'waited'> {
  const { withScansHeld } = await import('../src/lib/library');
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  // Taken at once (no other hold is in place between these tests): a scan asked for from here on waits for `gate`.
  const held = withScansHeld(() => gate);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([run(), new Promise<'waited'>((r) => { timer = setTimeout(() => r('waited'), 5000); })]);
  } finally {
    clearTimeout(timer);
    open();
    await held;
  }
}

test('a chapter the archive landed and has not scanned yet is in the plan a renumber builds', { skip }, async () => {
  // The archive scans what it lands in batches; a plan is built from lib_books. A file with no row yet kept its old
  // name through the renames and was scanned in afterwards under a number that is another post's by then. The plan
  // starts that scan and says `busy` until it is done, without waiting for it.
  // Reintroduce by dropping the onBeforeRenumberPlan registration in lib/archive.ts: the plan is not busy, and no scan
  // is started (the plan after it has no book). Reintroduce the wait (the hook awaiting flushArchiveScan, and
  // beforePlan awaited): "a plan does not wait for the library scan".
  const { planFor } = await import('../src/lib/numbering');
  const s = await series('plan', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await pastFirst(s.id);
  await tick();
  await arch.archiveIdle();
  assert.deepEqual(onDiskNums(s.folder), [1]);
  assert.deepEqual(await q('SELECT id FROM lib_books WHERE series_id = $1', [s.id]), [], 'landed, and waiting for its batch scan');
  const first = await answersWithoutAScan(() => planFor(s.id, 'posting_order'));
  assert.notEqual(first, 'waited', 'a plan does not wait for the library scan');
  assert.ok(first !== 'waited' && first?.plan.reasons.includes('busy'), 'while what the archive landed is scanned in, the plan is busy');
  // The scan the plan started.
  await arch.archiveIdle();
  const books = await q<{ id: string; source_chapter_id: string | null }>('SELECT id, source_chapter_id FROM lib_books WHERE series_id = $1', [s.id]);
  assert.equal(books.length, 1, 'scanned in before the plan read the books');
  assert.equal(books[0].source_chapter_id, `${s.ref}/c1`, 'stamped with the chapter it came from, through setBookMeta');
  const p = await planFor(s.id, 'posting_order');
  assert.ok(p, 'a plan');
  assert.deepEqual(p!.plan.moves.map((m) => [m.bookId, m.how]), [[books[0].id, 'id']], 'and matched by that stamp');
  assert.equal(p!.plan.reasons.includes('busy'), false, 'nothing coming in any more');
});

test('a confirmed renumber scans in what the archive landed before its apply reads the books', { skip }, async () => {
  // The same rule at the apply itself (settleNumbering), which a confirmation reaches without anyone having read
  // the plan first: held (`busy`, as for a download into the folder) until the scan it started is done.
  // Reintroduce by dropping settleNumbering's beforePlan: the confirmation applies at once, with no book.
  const { requestNumbering } = await import('../src/lib/numbering');
  const s = await series('settle', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await pastFirst(s.id);
  await tick();
  await arch.archiveIdle();
  assert.deepEqual(onDiskNums(s.folder), [1]);
  assert.deepEqual(await q('SELECT id FROM lib_books WHERE series_id = $1', [s.id]), [], 'landed, and waiting for its batch scan');
  const held = await requestNumbering(s.id, 'posting_order', { confirm: true, userId: adminId });
  assert.ok(held?.state === 'pending' && held.plan?.reasons.includes('busy'), 'held while what the archive landed is scanned in');
  await arch.archiveIdle();
  const r = await requestNumbering(s.id, 'posting_order', { confirm: true, userId: adminId });
  assert.equal(r?.state, 'applied', JSON.stringify(r));
  const books = await q<{ id: string }>('SELECT id FROM lib_books WHERE series_id = $1', [s.id]);
  assert.equal(books.length, 1, 'scanned in before the apply read the books');
  assert.deepEqual(r?.plan?.moves.map((m: any) => m.bookId), [books[0].id], 'and moved with the rest');
});

test('a confirmation with chapters still coming in does not wait for the library scan', { skip }, async () => {
  // It answers `pending` (busy) at once and the scan goes on without it: a confirmation that waited on a scan of the
  // whole library inside its request spent its minute there on a large library. Reintroduce the wait (the hook
  // awaiting flushArchiveScan, and beforePlan awaited): 'waited'.
  const { requestNumbering } = await import('../src/lib/numbering');
  const s = await series('settlewait', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await pastFirst(s.id);
  await tick();
  await arch.archiveIdle();
  assert.deepEqual(await q('SELECT id FROM lib_books WHERE series_id = $1', [s.id]), [], 'PREMISE: landed, and waiting for its batch scan');
  const held = await answersWithoutAScan(() => requestNumbering(s.id, 'posting_order', { confirm: true, userId: adminId }));
  assert.notEqual(held, 'waited', 'a confirmation does not wait for the library scan');
  await arch.archiveIdle();
  assert.equal((await q('SELECT id FROM lib_books WHERE series_id = $1', [s.id])).length, 1, 'and the scan it started ran');
});

test('the first chapter an archive lands for a series is scanned in at once, and the rest wait for a batch', { skip }, async () => {
  // A batch is five chapters or twenty minutes, and until then the library does not hold what landed: a series added
  // with nothing but its archive read "0 chapters · none fetched yet" under a band saying "1 of 3", and Came in today
  // showed its tile with no cover (v0.49.1). Reintroduce by leaving the first chapter to the batch (drop the flush after
  // the first landing in runChapter): no book row.
  const s = await series('firstscan', A, [1, 2, 3]);
  const books = async () => (await q('SELECT number FROM lib_books WHERE series_id = $1 ORDER BY number', [s.id])).map((b: any) => Number(b.number));
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  assert.deepEqual((await step()).started.map((x) => x.number), [1]);
  assert.deepEqual(await books(), [1], 'the first chapter an archive lands is not in the library');
  assert.equal(Number((await one('SELECT books_count FROM lib_series WHERE id = $1', [s.id])).books_count), 1, 'and the series counts it');
  assert.deepEqual((await step()).started.map((x) => x.number), [2]);
  assert.deepEqual(onDiskNums(s.folder), [1, 2]);
  assert.deepEqual(await books(), [1], 'a later one waits for its batch');
});

test('the first chapter of a series the library already holds waits for its batch, as the rest do', { skip }, async () => {
  // Only a series the library holds nothing of has its first chapter scanned in at once: until then its page reads
  // "0 chapters". The scan walks the whole library, and it ran for every series' first chapter, one the library already
  // showed too -- a bulk enqueue lands one first chapter per series on each source's first pass, a full scan each
  // (v0.49.1 review). Reintroduce by leaving the library out (drop `in_library` in runChapter): a scan runs, and
  // chapter 3 is in the library before its batch.
  const { scanCount } = await import('../src/lib/library');
  const s = await series('inlibrary', A, [1, 2, 3, 4], { held: [4] });
  const books = async () => (await q('SELECT number FROM lib_books WHERE series_id = $1 ORDER BY number', [s.id])).map((b: any) => Number(b.number));
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  // Whether the downloads view keeps it out at its landing, before the count.
  let kept: boolean | null = null;
  arch.archiveHooks.afterLanding = (id, n) => { if (id === s.id) kept = arch.archiveScanPending(s.folder, n); };
  const scans = scanCount();
  try {
    assert.deepEqual((await step()).started.map((x) => x.number), [3], 'PREMISE: down from the chapter it holds');
  } finally {
    arch.archiveHooks.afterLanding = undefined;
  }
  assert.deepEqual(onDiskNums(s.folder), [3], 'PREMISE: chapter 3 landed');
  assert.equal(Number((await row(s.id)).done_count), 1, 'PREMISE: the first chapter this archive landed');
  assert.equal(scanCount(), scans, 'the first chapter of a series the library already holds was scanned in at once');
  assert.deepEqual(await books(), [4], 'and was in the library before its batch');
  assert.equal(kept, false, 'the downloads view kept it out at its landing, for a scan that is not coming');
});

test("a series' first chapter from the archive is listed in the downloads once the library holds it", { skip }, async () => {
  // Scanned in at once, but listed the moment it landed, while that scan still ran -- seconds on a large library:
  // Came in today drew its tile before there was a cover, and the series page re-read its chapters on the landing and
  // still found none (v0.49.1). Looked at twice, each at a moment of its own: stopped between its landing and its count
  // (archiveHooks.afterLanding), and once its turn is over with its scan held.
  // Reintroduce by listing it at once (drop `inLibrary` in routes/sources.ts activityFor), or by marking it only when
  // it is counted (drop the firstInFlight mark in runChapter): the first look lists it. By dropping `now` on its
  // unscanned item when it is counted: the second does.
  const { withScansHeld, scanCount } = await import('../src/lib/library');
  const { listActivity } = await import('../src/lib/downloadActivity');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  const s = await series('heldscan', A, [1, 2, 3]);
  const listed = async () => ((await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` } }))
    .json().activity.recent as Array<{ folder: string; number: number }>).filter((e) => e.folder === s.folder).map((e) => e.number);
  // Stopped between its landing and its count until `go`: there the day's list already has it, and nothing has said yet
  // whether it was the first.
  let reached = false;
  let there!: () => void, go!: () => void;
  const atLanding = new Promise<void>((r) => { there = r; });
  const gate = new Promise<void>((r) => { go = r; });
  arch.archiveHooks.afterLanding = async (id) => { if (id === s.id) { reached = true; there(); await gate; } };
  // Held from before the landing, so the scan it starts waits here. `open` is set once the hold has begun.
  let open: (() => void) | undefined;
  const held = withScansHeld(() => new Promise<void>((r) => { open = r; }));
  try {
    const scans = scanCount();
    assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
    assert.deepEqual((await tick()).started.map((x) => x.number), [1]);
    // The archive's runs end only past the gate: idle first means the chapter never landed.
    await Promise.race([atLanding, arch.archiveIdle()]);
    assert.ok(reached, 'PREMISE: chapter one reached its landing');
    assert.ok(listActivity().recent.some((e) => e.folder === s.folder && e.number === 1), 'PREMISE: chapter one landed');
    assert.equal(Number((await row(s.id)).done_count), 0, 'PREMISE: and is not counted yet');
    assert.deepEqual(await listed(), [], 'the first chapter is listed before the library holds it');
    go();
    // Waited for, not timed: the turn ends by itself, and the scan cannot start until the hold is let go.
    for (let i = 0; i < 1000 && arch.archiveBusy(s.folder); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(arch.archiveBusy(s.folder), false, 'PREMISE: its turn is over');
    assert.equal(Number((await row(s.id)).done_count), 1, 'PREMISE: counted');
    assert.equal(scanCount(), scans, 'PREMISE: and its scan is held');
    assert.deepEqual(await listed(), [], 'the first chapter is listed before the library holds it, once its turn is over');
  } finally {
    go();
    arch.archiveHooks.afterLanding = undefined;
    // A hold that had not begun yet begins and ends at once.
    for (let i = 0; i < 200 && !open; i++) await new Promise((r) => setTimeout(r, 10));
    open?.();
    await held;
  }
  try {
    await arch.archiveIdle();
    assert.equal(arch.archiveScanPending(s.folder, 1), false);
    assert.deepEqual(await listed(), [1], 'and listed once it does');
  } finally {
    await app.close();
  }
});

test('a stop scans in what it landed, and what landed is not counted as left', { skip }, async () => {
  const s = await series('stopscan', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await pastFirst(s.id);
  await tick();
  await arch.archiveIdle();
  // Reintroduce by answering the stored count (compose): "1 of 3" over chapter one on disk reads 3 left.
  const shown = (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === s.id);
  assert.equal(shown?.left, 2, 'left counts what is still to come');
  assert.deepEqual(await q('SELECT id FROM lib_books WHERE series_id = $1', [s.id]), []);
  // Reintroduce by waiting for the scan in archiveAct('stop') (`await flushArchiveScan()`): "a stop does not wait".
  const stopped = await answersWithoutAScan(() => arch.archiveAct('stop', s.id, { userId: adminId, admin: true, ctx: adminCtx }));
  assert.equal(stopped, 'ok', 'a stop does not wait for the library scan');
  // Reintroduce by dropping the flush in archiveAct('stop'): the series page reads 0 chapters for twenty minutes.
  await arch.archiveIdle();
  assert.equal((await q('SELECT id FROM lib_books WHERE series_id = $1', [s.id])).length, 1, 'a stop scans in what it landed');
});

test("a renumber's end is on the archive at once: what it remembered for the series is forgotten", { skip }, async () => {
  // After the commit the numbers the archive remembered for the series -- its waits, its stuck and landed numbers --
  // are in the numbers of before. Reintroduce by dropping the onRenumbered registration in lib/archive.ts: the view
  // says it waits for the renumber until the next look.
  const { requestNumbering } = await import('../src/lib/numbering');
  const s = await series('forget', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await q(`UPDATE lib_series SET numbering_pending = 'posting_order' WHERE id = $1`, [s.id]);
  assert.equal((await tick()).waits[s.id]?.why, 'renumbering');
  const shown = async () => (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === s.id);
  assert.equal((await shown())?.waiting?.why, 'renumbering');
  const r = await requestNumbering(s.id, 'posting_order', { confirm: true, userId: adminId });
  assert.equal(r?.state, 'applied', JSON.stringify(r));
  assert.notEqual((await shown())?.waiting?.why, 'renumbering', "a renumber's end is on the archive at once");
});

test('what the archive scans in is not left, and the view says so at once', { skip }, async () => {
  // The view counts `left` from the shared rows and subtracts what landed and is not scanned yet. Once the batch scan
  // has put a chapter in the library nothing is subtracted, so the rows are read again: a cached count read one
  // chapter too many until it expired. Reintroduce by dropping invalidateArchiveView() at the end of
  // flushArchiveScan: this reads 3 left.
  const s = await series('rescan', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await pastFirst(s.id);
  await tick();
  await arch.archiveIdle();
  const left = async () => (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === s.id)?.left;
  assert.equal(await left(), 2, 'landed, not scanned yet: not left');
  await arch.flushArchiveScan();
  assert.equal((await q('SELECT id FROM lib_books WHERE series_id = $1', [s.id])).length, 1, 'scanned in');
  assert.equal(await left(), 2, 'once it is scanned in, still not left');
});

test("what came in and what is left add up to the whole, from a first chapter's landing until its scan lets it go", { skip }, async () => {
  // The cover and its sheet say `done` of `done + left` (web/lib/archive.ts). A series' first chapter is scanned in at
  // once, and the scan puts it in the library before flushArchiveScan lets it go from what waits: rows read in between
  // no longer counted it in `left`, compose() took it off again, and Walk Gap read "1 of 13" of its 14 (v0.49.1 final
  // walk). Before that, taken as waiting before it was counted, it read "0 of 13" from its landing until its turn ended.
  // Looked at in each of those moments, each one held: at its landing (archiveHooks.afterLanding); counted, with its turn
  // held where it next writes its source's pace row and its scan not started (withScansHeld); in the library, with the
  // scan held on its last write before it lets the chapter go, the series' Updates row; and let go.
  // Reintroduce by noting it before the count (runChapter): "at its landing" reads 0 of 13. By dropping the
  // invalidateArchiveView() beside the count: "once counted" reads 0 of 13. By subtracting how many wait (compose): "in
  // the library and still waiting" reads 1 of 13.
  const { withScansHeld } = await import('../src/lib/library');
  const { pool } = await import('../src/lib/db');
  const s = await series('whole', A, Array.from({ length: 14 }, (_, i) => i + 1));
  await q(`INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, 0)
           ON CONFLICT (user_id, series_id) DO UPDATE SET seen_books_count = 0`, [adminId, s.id]);
  /** What its cover says: what came in, of what came in and what is left (web/lib/archive.ts archiveProgressText). */
  const cover = async () => {
    const v = (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === s.id);
    return v && v.left != null ? `${v.done} of ${v.done + v.left}` : JSON.stringify(v ?? null);
  };
  /** A row lock on a connection of its own: whatever writes that row waits there until it is let go. */
  const lockRow = async (sql: string, params: unknown[]) => {
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query(sql, params);
    let gone = false;
    return async () => { if (gone) return; gone = true; await c.query('ROLLBACK').catch(() => {}); c.release(); };
  };
  /** Waited for, not timed: a statement beginning `head` waits on a lock, so it got that far and no further. */
  const waitsAt = async (head: string) => {
    for (let i = 0; i < 500; i++) {
      const w = await one(`SELECT count(*)::int AS n FROM pg_stat_activity
                            WHERE datname = current_database() AND wait_event_type = 'Lock' AND ltrim(query) LIKE $1`, [`${head}%`]);
      if (w.n > 0) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  };
  let atLanding: string | undefined;
  let letTurnGo: (() => Promise<void>) | undefined;
  arch.archiveHooks.afterLanding = async (id) => {
    if (id !== s.id) return;
    atLanding = await cover();
    letTurnGo = await lockRow('SELECT 1 FROM archive_pace WHERE source_id = $1 FOR UPDATE', [A]);
  };
  const letScanGo = await lockRow('SELECT 1 FROM series_seen WHERE series_id = $1 FOR UPDATE', [s.id]);
  // Held from before the landing, so the scan it starts waits here. `open` is set once the hold has begun.
  let open: (() => void) | undefined;
  const held = withScansHeld(() => new Promise<void>((r) => { open = r; }));
  try {
    assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
    assert.deepEqual((await tick()).started.map((x) => x.number), [1]);
    assert.ok(await waitsAt('UPDATE archive_pace SET backoff_level'), 'PREMISE: its turn is held past its count');
    assert.equal(atLanding, '0 of 14', 'at its landing, before its count');
    assert.equal(Number((await row(s.id)).done_count), 1, 'PREMISE: counted');
    assert.deepEqual(await q('SELECT id FROM lib_books WHERE series_id = $1', [s.id]), [], 'PREMISE: and not in the library yet');
    assert.equal(await cover(), '1 of 14', 'once counted');

    for (let i = 0; i < 200 && !open; i++) await new Promise((r) => setTimeout(r, 10));
    open?.();
    assert.ok(await waitsAt('UPDATE series_seen'), 'PREMISE: its scan has put it in the library, and has not let it go');
    assert.deepEqual((await q('SELECT number FROM lib_books WHERE series_id = $1', [s.id])).map((b: any) => Number(b.number)), [1],
      'PREMISE: the library holds it');
    // Its turn ends, and its end has the view's rows read again, with the chapter in the library and not let go yet:
    // the read the walk's page was shown.
    await letTurnGo?.();
    for (let i = 0; i < 1000 && arch.archiveBusy(s.folder); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(arch.archiveBusy(s.folder), false, 'PREMISE: its turn is over');
    assert.equal(arch.archiveScanPending(s.folder, 1), true, 'PREMISE: and the archive still has it as waiting for its scan');
    assert.equal(await cover(), '1 of 14', 'in the library and still waiting, it is not taken off twice');

    await letScanGo();
    await arch.archiveIdle();
    assert.equal(arch.archiveScanPending(s.folder, 1), false, 'PREMISE: let go');
    assert.equal(await cover(), '1 of 14', 'let go');
  } finally {
    arch.archiveHooks.afterLanding = undefined;
    await letTurnGo?.();
    await letScanGo();
    for (let i = 0; i < 200 && !open; i++) await new Promise((r) => setTimeout(r, 10));
    open?.();
    await held;
  }
});

test('a turn after days of waiting is not a stall, in flight or refused once', { skip }, async () => {
  // Five hundred series on one site take days each to come round. Counted from when a turn STARTS, a chapter in
  // flight after such a wait read "stalled" until it landed, and one refusal until the next turn, days later (the
  // archfix review). Reintroduce the turn's start as the rule (compose: idleTurns 2 whenever last_at is after the
  // last progress): the in-flight assertion reads stalled.
  const shown = async (id: string) => (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === id);
  const s = await series('patient', A, [1, 2, 3, 4]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await tick();
  await arch.archiveIdle();
  now += 4 * DAY;
  const release = hold(`${s.ref}/c2`);
  try {
    assert.deepEqual((await tick()).started.map((x) => x.number), [2]);
    assert.equal((await shown(s.id))?.current?.number, 2);
    assert.equal((await shown(s.id))?.attention, undefined, 'its first turn after the wait is in flight, not stalled');
  } finally {
    release();
    await arch.archiveIdle();
  }
  assert.equal((await row(s.id)).note?.idleTurns, 0, 'a chapter in starts the count again');
});

test('one refusal after days of waiting is a bad hour, not a stall', { skip }, async () => {
  // The other half of the archfix review's finding: one failed turn after such a wait flagged the series until its
  // next turn, days away. Reintroduce `idleTurns >= 1` in attentionOf (or the turn's start as the rule): stalled.
  const shown = async (id: string) => (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === id);
  refusing.delete(R2);
  const r2 = await series('patientr', R2, [1, 2, 3]);
  try {
    assert.equal(await arch.enqueueArchive(r2.id, adminId, adminCtx), 'queued');
    await step();
  } finally { refusing.add(R2); }
  assert.deepEqual(onDiskNums(r2.folder), [1]);
  now += 4 * DAY;
  clearPace(); await clearBlock(R2);
  const t = await step();
  assert.deepEqual(t.started.filter((x) => x.seriesId === r2.id).map((x) => x.number), [2]);
  assert.equal((await row(r2.id)).note?.idleTurns, 1, 'a failed chapter is a turn with nothing to show');
  assert.equal((await shown(r2.id))?.attention, undefined, 'one refusal after the wait is one bad hour');
});

test('an alternate that refused on the way to a landing backs off too', { skip }, async () => {
  // The archfix review's reintroduction survived: nothing tested the landed path's backOffAlternates. R refuses,
  // R2 refuses, A serves the chapter. Reintroduce by dropping it on the landed path: R2 is not backed off.
  const s = await series('alt3', R, [1, 2]);
  listed.set('alt3-ref2', [1, 2]);
  listed.set('alt3-ref3', [1, 2]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, created_at) VALUES ($1, $2, 'alt3-ref2', now() - interval '1 minute'), ($1, $3, 'alt3-ref3', now())
           ON CONFLICT DO NOTHING`, [s.id, R2, A]);
  assert.equal((await updateSeries(s.id, 0)).outcome, 'ok');
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  const t = await tick({ rand: () => 0.99 });
  assert.deepEqual(t.started.map((x) => `${x.source}:${x.number}`), [`${R}:1`]);
  await arch.archiveIdle();
  assert.deepEqual(onDiskNums(s.folder), [1], 'the third site served it');
  assert.ok(asked.includes('alt3-ref2/c1') && asked.includes('alt3-ref3/c1'), 'both alternates were asked');
  assert.equal((await pace(R))?.backoff_level, 1, 'the chosen source refused');
  assert.equal((await pace(R2))?.backoff_level, 1, 'an alternate that refused on the way to a landing backs off too');
  const pa = await pace(A);
  assert.equal(pa?.backoff_level ?? 0, 0, 'the one that served it has no backoff');
  assert.ok(new Date(pa.next_at).getTime() >= now + 10 * MIN, 'and rests as long as the chosen one');
});

test('before its source has a running cycle, the estimate is what a typical chapter costs at the rate', { skip }, async () => {
  // The fallback is expectedCycleMs of a minute-long chapter (the web's own estimate assumes the same minute), not
  // the hour's bare share: at 30 an hour a chapter and its shortest break outrun two minutes. The archfix review's
  // integration note. Reintroduce the share in compose (cyc = 3_600_000 / perHour): four chapters read 8 minutes.
  const { expectedCycleMs } = await import('../src/lib/archivePace');
  const s = await series('etafast', A, [1, 2, 3, 4]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await arch.applyArchiveSettings({ archivePerHour: 30 });
  try {
    const shown = (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === s.id);
    const cycle = expectedCycleMs({ perHour: 30, chapterMs: 60_000, minBreakMs: 45_000 });
    assert.ok(cycle > 2 * MIN, `PREMISE: at 30 an hour a chapter and its break outrun the share (${Math.round(cycle / 1000)} s)`);
    assert.equal(shown?.etaMs, Math.round(4 * cycle), 'before its source has a running cycle, a typical chapter at the rate');
  } finally {
    await arch.applyArchiveSettings({ archivePerHour: 4 });
  }
});

test('with a time window, the estimate is calendar time', { skip }, async () => {
  // The running cycle leaves the hours outside the window out (outsideCycleMs), so an estimate from it alone is running
  // time. Reintroduce by dropping the window's share in compose: four chapters at 01-07 read a quarter of the time.
  const { expectedCycleMs } = await import('../src/lib/archivePace');
  const s = await series('eta', A, [1, 2, 3, 4]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await arch.applyArchiveSettings({ archiveWindowFrom: 1, archiveWindowTo: 7 });
  try {
    const shown = (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === s.id);
    // Before the source has a running cycle: what a typical minute-long chapter costs at four an hour (the web's too).
    const cycle = expectedCycleMs({ perHour: 4, chapterMs: 60_000, minBreakMs: 45_000 });
    assert.equal(shown?.etaMs, Math.round((4 * cycle) / (6 / 24)), 'with a time window, the estimate is calendar time');
  } finally {
    await arch.applyArchiveSettings({ archiveWindowFrom: null, archiveWindowTo: null });
  }
});

test("a missing source's day is kept on the row, so a restart does not start it again", { skip }, async () => {
  // In memory only, every restart started the day again -- and the desktop app restarts with the app, so its missing
  // source never reached a day (the archfix review). Reintroduce by dropping the goneSince note (tickOnce `wait`):
  // after the restart the series is not flagged.
  const s = await series('gone2', A, [1, 2]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await q(`UPDATE series_listing SET copies = (SELECT jsonb_agg(c || jsonb_build_object('source', $2::text)) FROM jsonb_array_elements(copies) c)
            WHERE series_id = $1`, [s.id, GONE]);
  assert.equal((await tick()).waits[s.id]?.why, 'source_missing');
  assert.ok((await row(s.id)).note?.goneSince, 'since when is on the row');
  arch.resetArchiveMemory();
  now += DAY;
  assert.equal((await tick()).waits[s.id]?.why, 'source_missing');
  const shown = (await arch.archiveView(() => true, adminId)).series.find((x) => x.seriesId === s.id);
  assert.equal(shown?.attention?.why, 'source_missing', 'a day on, restart or not, Needs attention shows it');
});

test('after Resume all the view no longer says paused, before any look', { skip }, async () => {
  // Reintroduce by answering the last look's wait as it is (archiveView): the view says paused after the resume.
  const s = await series('resumeall', A, [1, 2]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await arch.applyArchiveSettings({ archivePaused: true });
  try {
    assert.equal((await tick()).waiting?.why, 'paused');
    assert.equal((await arch.archiveView(() => true, adminId)).waiting?.why, 'paused');
  } finally {
    await arch.applyArchiveSettings({ archivePaused: false });
  }
  assert.equal((await arch.archiveView(() => true, adminId)).waiting, undefined, 'resumed: nothing says paused');
});

test('a listing ladder a failed refresh left ends once the listing reads fresh again', { skip }, async () => {
  // A failed REFRESH stamps the source as checked (updater.ts), so the listing reads fresh and chapters go on from it;
  // the ladder was left on the row and a failed read a week on resumed at its old rung (the archfix review).
  // Reintroduce by dropping the clearing in tickOnce: the ladder is still on the row.
  const s = await series('ladder', A, [1, 2]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  await q(`UPDATE archive_queue SET note = jsonb_build_object('listingFails', 2, 'listingRetryAt', $2::text) WHERE series_id = $1`,
    [s.id, new Date(now + 3 * HOUR).toISOString()]);
  const t = await tick();
  assert.deepEqual(t.started.filter((x) => x.seriesId === s.id).map((x) => x.number), [1], 'its chapters go on from the listing it has');
  await arch.archiveIdle();
  const note = (await row(s.id)).note ?? {};
  assert.equal(note.listingFails, undefined, 'the ladder is over');
  assert.equal(note.listingRetryAt, undefined);
});

test('a raised pace is held for hours, and the archive waits out only the hour after the 429 (v0.55.3)', { skip }, async () => {
  // A level comes off only as chapters land now (lib/pace.ts), and a waiting archive lands none: waiting for level 0, it
  // would have waited days. It waits the hour after a 429 and then goes on, never faster than the raised level.
  // Reintroduce `paced: paceLevel(src) > 0` in archive.ts stateOf: an hour on, the archive still waits on `pace`.
  const pace = await import('../src/lib/pace');
  const s = await series('paced', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  noteRateLimited(A);
  const t1 = await tick();
  assert.deepEqual(t1.started, [], 'nothing starts in the hour after a 429');
  assert.equal(t1.waits[s.id]?.why, 'pace');
  pace.setPaceClock(() => Date.now() + pace.PACE_HOLD_MS);
  try {
    assert.equal(pace.paceLevel(A), 1, 'an hour on, the level is still raised');
    const t2 = await tick();
    assert.notEqual(t2.waits[s.id]?.why, 'pace', 'and the archive no longer waits on it');
    assert.deepEqual(t2.started.filter((x) => x.seriesId === s.id).map((x) => x.number), [1], 'it takes its next chapter');
    await arch.archiveIdle();
  } finally {
    pace.setPaceClock(null);
  }
});

// ---- v0.55.4 (#158): one release on several sites, taken in turn --------------------------------------------------------

/** A series on `src` that also follows `also`, each listing the same numbers: the same release on each (no group named). */
async function rotating(key: string, src: string, also: string[], numbers: number[]) {
  const s = await series(key, src, numbers);
  for (const [i, other] of also.entries()) {
    listed.set(`${key}-ref-${other}`, numbers);
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, created_at) VALUES ($1, $2, $3, now() + $4 * interval '1 second')
             ON CONFLICT DO NOTHING`, [s.id, other, `${key}-ref-${other}`, i]);
  }
  assert.equal((await updateSeries(s.id, 0)).outcome, 'ok');
  return s;
}
const startedOn = (t: Awaited<ReturnType<typeof tick>>, id: string) => t.started.filter((x) => x.seriesId === id).map((x) => `${x.source}:${x.number}`);

test('a series rotates to a site that is not resting, and never to another group\'s copy (v0.55.4)', { skip }, async () => {
  // DannyDynamite39 (#158): aggregators carry the same scanlation, and taking them in turn is faster and gentler. The
  // chosen site wins the first turn (a tie: neither has had one); while it is in its break the next chapter comes from
  // the other. Reintroduce by keeping the chosen copy alone (tickOnce `options`): the second look waits out A's break.
  const rand = () => 0.99;
  const s = await rotating('rot', A, [C], [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  assert.deepEqual(startedOn(await tick({ rand }), s.id), [`${A}:1`], 'the chosen site goes first');
  await arch.archiveIdle();
  now += MIN;
  const t2 = await tick({ rand });
  assert.deepEqual(startedOn(t2, s.id), [`${C}:2`], 'a series rotates to a site that is not resting');
  await arch.archiveIdle();
  assert.ok(asked.includes(`rot-ref-${C}/c2`), 'chapter two came from the other site');
  assert.deepEqual(onDiskNums(s.folder), [1, 2]);
  now += MIN;
  const t3 = await tick({ rand });
  assert.deepEqual(t3.started, [], 'both sites are between chapters now');
  assert.equal(t3.waits[s.id]?.why, 'break');

  // Another group's copy of the same number is another release: never taken in turn, whatever the sites' rests say.
  // Reintroduce by passing every followed copy as an option (no sameRelease): this takes C's chapter.
  const g = await series('rotgroup', B, [1, 2, 3]);
  scanlated.set('rotgroup-ref', 'Group One');
  scanlated.set(`rotgroup-ref-${C}`, 'Group Two');
  listed.set(`rotgroup-ref-${C}`, [1, 2, 3]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [g.id, C, `rotgroup-ref-${C}`]);
  assert.equal((await updateSeries(g.id, 0)).outcome, 'ok');
  await q(`DELETE FROM archive_pace WHERE source_id LIKE 'arch-%'`);
  assert.equal(await arch.enqueueArchive(g.id, adminId, adminCtx), 'queued');
  assert.deepEqual(startedOn(await tick({ rand }), g.id), [`${B}:1`]);
  await arch.archiveIdle();
  now += MIN;
  const t5 = await tick({ rand });
  assert.deepEqual(startedOn(t5, g.id), [], "another group's copy is never taken in turn");
  assert.equal(t5.waits[g.id]?.why, 'break');
});

test('a group blocked after the archive picked it is refused at the final download boundary', { skip }, async () => {
  const group = 'Zz Archive Race Group';
  scanlated.set('blockrace-ref', group);
  const saved = (await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0]?.scanlator_prefs;
  await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1',
    [JSON.stringify({ priority: [group], blocked: [], patienceDays: 0 })]);
  const s = await series('blockrace', A, [1]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  let reached!: () => void;
  const atBoundary = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  arch.archiveHooks.beforeDownload = async (id, number) => {
    if (id !== s.id || number !== 1) return;
    reached();
    await held;
  };
  try {
    const report = await tick();
    assert.deepEqual(startedOn(report, s.id), [`${A}:1`], 'the archive did not pick the stale allowed copy');
    await atBoundary;
    await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1',
      [JSON.stringify({ priority: [group], blocked: [group], patienceDays: 0 })]);
    release();
    await arch.archiveIdle();
    assert.ok(!asked.includes('blockrace-ref/c1'), 'the newly blocked archive copy reached its source');
    assert.equal(existsSync(join(DL, s.folder, 'Chapter 1.cbz')), false, 'the newly blocked archive copy was written');
  } finally {
    release();
    arch.archiveHooks.beforeDownload = undefined;
    await arch.archiveIdle();
    await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(saved)]);
  }
});

test('two sources on one image server are one site to the archive: one chapter at a time, one rest (v0.55.4)', { skip }, async () => {
  // Natomanga and Mangakakalot share a CDN. Joined under one rate key (lib/pace.ts notePageHosts, which needs PUBLIC
  // hosts: `.invalid` joins nothing), a look used to start a series on each in the same breath -- the gate that would
  // hold the second is entered only once the first is under way -- and each kept its own rest, so the CDN was asked
  // twice as often as the pace allows.
  const pace = await import('../src/lib/pace');
  pace.notePageHosts({ id: A }, ['https://img-a.sharedcdn-arch.com/1.png']);
  pace.notePageHosts({ id: B }, ['https://img-b.sharedcdn-arch.com/1.png']);
  assert.equal(pace.rateKeyOf(B), pace.rateKeyOf(A), 'PREMISE: one image server, one key');
  const rand = () => 0.99;
  const x = await series('cdnx', A, [1, 2, 3]);
  const y = await series('cdny', B, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(x.id, adminId, adminCtx), 'queued');
  assert.equal(await arch.enqueueArchive(y.id, adminId, adminCtx), 'queued');
  // Reintroduce by claiming the SOURCE in tickOnce (`claimed.has(src)`, `flights.has(src)` for the slot and for inFlight):
  // both series start in this one look.
  const t1 = await tick({ rand });
  assert.equal(t1.started.length, 1, 'two sources on one image server both started in one look');
  assert.equal(t1.waits[y.id]?.why, 'turn');
  await arch.archiveIdle();
  now += MIN;
  // Reintroduce by reading the break per source (stateOf `paceRows.get(src)`): Y starts on B inside A's break.
  const t2 = await tick({ rand });
  assert.deepEqual(t2.started, [], "a site on the same image server rests with the one that was just asked");
  assert.equal(t2.waits[y.id]?.why, 'break');
  // And a series that follows both rotates between nothing: they are one site.
  const z = await rotating('cdnz', A, [B], [1, 2]);
  await q(`DELETE FROM archive_pace WHERE source_id LIKE 'arch-%'`);
  await arch.archiveAct('pause', x.id, { userId: adminId, admin: true, ctx: adminCtx });
  await arch.archiveAct('pause', y.id, { userId: adminId, admin: true, ctx: adminCtx });
  assert.equal(await arch.enqueueArchive(z.id, adminId, adminCtx), 'queued');
  assert.deepEqual(startedOn(await tick({ rand }), z.id), [`${A}:1`]);
  await arch.archiveIdle();
  now += MIN;
  const t4 = await tick({ rand });
  assert.deepEqual(t4.started, [], 'taking turns between two sources on one server');
  assert.equal(t4.waits[z.id]?.why, 'break');
});

test('a series that rotates backs off only when every site does, and its estimate is shared among them (v0.55.4)', { skip }, async () => {
  // One site refusing while the other carries on is not worth a look, and the series is not "left alone after
  // refusals": it goes on the other site after its break.
  const { expectedCycleMs } = await import('../src/lib/archivePace');
  const s = await rotating('rotoff', A, [C], [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  // A refused twice in a row; its backoff is over and it is between chapters for ten minutes. C is between chapters
  // for five, and has never refused.
  await q(`INSERT INTO archive_pace (source_id, next_at, backoff_level, backoff_until, last_at) VALUES ($1, $2, 2, $3, $4), ($5, $6, 0, NULL, $4)`,
    [A, new Date(now + 10 * MIN), new Date(now - MIN), new Date(now - 2 * MIN), C, new Date(now + 5 * MIN)]);
  arch.invalidateArchiveView();
  const t = await tick();
  assert.deepEqual(t.started, []);
  assert.equal(t.waits[s.id]?.why, 'break');
  let v = (await arch.archiveView(() => true, adminId)).series.find((r) => r.seriesId === s.id);
  // Reintroduce by reading the one source's row in compose (`pace?.backoff_level`): Needs attention reads backoff.
  assert.equal(v?.attention, undefined, 'backing off only when every site is');
  // Reintroduce by reading the one source's row for nextAt: ten minutes.
  assert.ok(v?.nextAt && Math.abs(Date.parse(v.nextAt) - (now + 5 * MIN)) < 2000, `it goes when the first site is free (${v?.nextAt})`);
  // Its estimate: the three chapters left at a typical chapter's cost, shared by the two sites.
  // Reintroduce by dropping the division by the keys in compose: twice this.
  const cycle = expectedCycleMs({ perHour: 4, chapterMs: 60_000, minBreakMs: 45_000 });
  assert.equal(v?.etaMs, Math.round((3 * cycle) / 2), 'the estimate is shared among the sites it rotates over');

  // A refuses again and is left alone for hours: the series still goes on C in five minutes.
  // Reintroduce by reporting the chosen copy's reason whatever it is (tickOnce `at = 0`): this reads backoff.
  await q(`UPDATE archive_pace SET backoff_until = $2 WHERE source_id = $1`, [A, new Date(now + 3 * HOUR)]);
  arch.invalidateArchiveView();
  const t2 = await tick();
  assert.equal(t2.waits[s.id]?.why, 'break', 'a series another site takes in minutes is between chapters, not backing off');
  assert.equal(t2.waits[s.id]?.source, `Arch ${C}`);

  // Now C refuses twice too: every site is backing off.
  await q(`UPDATE archive_pace SET backoff_level = 2, backoff_until = $2 WHERE source_id = $1`, [C, new Date(now + 3 * HOUR)]);
  arch.invalidateArchiveView();
  assert.equal((await tick()).waits[s.id]?.why, 'backoff');
  v = (await arch.archiveView(() => true, adminId)).series.find((r) => r.seriesId === s.id);
  assert.equal(v?.attention?.why, 'backoff', 'every site backing off is worth a look');
});

test('never onto an adult source: not on a clean series, and not past the enqueuer\'s cap (v0.55.4)', { skip }, async () => {
  // A rotated copy is held to what the chapter's alternates are (runChapter `allowed`): the sweep's adult rule and the
  // enqueuer's cap. Reintroduce by dropping the sweep's rule (tickOnce sweepRule): the clean series' second chapter
  // comes from the adult site.
  const rand = () => 0.99;
  const s = await rotating('rotclean', A, [NSFW], [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  assert.deepEqual(startedOn(await tick({ rand }), s.id), [`${A}:1`]);
  await arch.archiveIdle();
  now += MIN;
  const t2 = await tick({ rand });
  assert.deepEqual(startedOn(t2, s.id), [], 'a clean series rotated onto an adult source');
  assert.equal(t2.waits[s.id]?.why, 'break');

  // A capped member queued a series that followed only clean sites. Since then it follows an adult one and an admin has
  // rated it 18+, so the sweep's rule allows the adult site: the enqueuer's cap is what keeps it out.
  // Reintroduce by dropping capOk from the rotation's filter: the second chapter comes from the adult site.
  await q(`DELETE FROM archive_pace WHERE source_id LIKE 'arch-%'`);
  const memberId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating)
                              VALUES ('arch-capped','arch-capped','x','user','password',16) RETURNING id`))[0].id;
  const c = await series('rotcap', A, [1, 2, 3]);
  assert.equal(await arch.enqueueArchive(c.id, memberId, await viewCtxFor(memberId, 'user')), 'queued');
  listed.set(`rotcap-ref-${NSFW}`, [1, 2, 3]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $3)`, [c.id, NSFW, `rotcap-ref-${NSFW}`]);
  assert.equal((await updateSeries(c.id, 0)).outcome, 'ok');
  await q(`INSERT INTO series_overrides (series_id, age_rating) VALUES ($1, 18) ON CONFLICT (series_id) DO UPDATE SET age_rating = 18`, [c.id]);
  try {
    await arch.archiveAct('stop', s.id, { userId: adminId, admin: true, ctx: adminCtx });
    assert.deepEqual(startedOn(await tick({ rand }), c.id), [`${A}:1`]);
    await arch.archiveIdle();
    now += MIN;
    const t4 = await tick({ rand });
    assert.deepEqual(startedOn(t4, c.id), [], "a capped enqueuer's archive rotated onto an adult source");
    assert.equal(t4.waits[c.id]?.why, 'break');
  } finally {
    await q('DELETE FROM series_overrides WHERE series_id = $1', [c.id]);
  }
});

test('a series with its own source order never rotates (v0.55.4)', { skip }, async () => {
  // "Take this series from that site" is an explicit preference: the archive keeps to it. Reintroduce by dropping the
  // `rotates` check in tickOnce: the second chapter comes from C.
  const rand = () => 0.99;
  const s = await rotating('rotown', A, [C], [1, 2, 3]);
  await q(`UPDATE lib_series SET source_prefs = '{"priority":["arch-a"]}'::jsonb WHERE id = $1`, [s.id]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  assert.deepEqual(startedOn(await tick({ rand }), s.id), [`${A}:1`]);
  await arch.archiveIdle();
  now += MIN;
  const t2 = await tick({ rand });
  assert.deepEqual(startedOn(t2, s.id), [], 'a series with its own source order rotated');
  assert.equal(t2.waits[s.id]?.why, 'break');
});

test('an alternate on an image server the archive is resting is not asked (v0.55.4)', { skip }, async () => {
  // A chapter that fails turns to the same number on another followed site -- but a site whose pages come from the
  // server another site of the archive is resting on is that server asked on the side. Reintroduce by reading the
  // rests per source in alternatesOf: B is asked for chapter one.
  const pace = await import('../src/lib/pace');
  pace.notePageHosts({ id: A }, ['https://img-a.sharedcdn-arch.com/1.png']);
  pace.notePageHosts({ id: B }, ['https://img-b.sharedcdn-arch.com/1.png']);
  const s = await rotating('altkey', R, [B], [1, 2]);
  await q(`INSERT INTO archive_pace (source_id, next_at) VALUES ($1, $2)`, [A, new Date(now + 30 * MIN)]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
  assert.deepEqual(startedOn(await tick({ rand: () => 0.99 }), s.id), [`${R}:1`]);
  await arch.archiveIdle();
  assert.ok(asked.includes('altkey-ref/c1'), 'PREMISE: the chosen site was asked, and refused');
  assert.ok(!asked.includes(`altkey-ref-${B}/c1`), 'an alternate on a resting image server was asked');
  assert.equal((await row(s.id)).failed_count, 1);
});
