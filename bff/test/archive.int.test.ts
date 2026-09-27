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
      return (listed.get(sid) ?? []).map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${sid}/c${n}` }));
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
  for (const id of [A, B, R, R2]) registerAdapter(adapter(id) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Arch',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`DELETE FROM users WHERE username = 'arch-admin'`);
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
  await q(`DELETE FROM users WHERE username = 'arch-admin'`);
  await q('UPDATE server_settings SET archive_min_free_gb = 20 WHERE id = 1');
  const { pool } = await import('../src/lib/db');
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
});

test('a restart keeps its place and its break', { skip }, async () => {
  const s = await series('restart', A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(await arch.enqueueArchive(s.id, adminId, adminCtx), 'queued');
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
