// Health's Fix everything (v0.55.0, lib/autofix.ts), against a real scratch database, a real scratch disk and fake
// sources: one library with something wrong on every card the run can fix, one run, then what each phase did and
// what it would not do -- and apart from it, one run at a time, Stop, a solver that is down, and what only a person
// can fix reaching Needs you without ever being ignored. The extensions phase, which needs an engine, has its own file
// (autofixExtensions.int.test.ts).
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { istreveliaPosts, webtoonsNumbers } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-af-'));
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
  process.env.UPDATER_LIST_TIMEOUT_MS = '2000';
  process.env.REPAIR_PACE_MS = '0';
  process.env.SOURCE_TEST_TIMEOUT_MS = '3000';
  process.env.UCHIYOMI_PING_URL = '';
  delete process.env.SUWAYOMI_URL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

// ── the fake sources ────────────────────────────────────────────────────────────────────────────────────────────
// af-main: the library's working main source. af-good: a working source the Replace series follows. af-dead: a failing
// main source (it throws), which Replace moves its series off and turns off. af-unused: failing, and no series uses it.
// af-cool: works, but sits in a cooldown. af-down: failing at its page lists, the main of a series with a failed chapter.
// af-web: Webtoons-shaped posts for the numbering series. af-cf: behind Cloudflare, failing (the solver-down test).
const MAIN = 'af-main', GOOD = 'af-good', DEAD = 'af-dead', UNUSED = 'af-unused', COOL = 'af-cool', DOWN = 'af-down', WEB = 'af-web', CF = 'af-cf';
// af-held: in a cooldown, and failing its Test.
const HELD = 'af-held';
const SOURCES = [MAIN, GOOD, DEAD, UNUSED, COOL, DOWN, WEB, CF, HELD];
const BROKEN = new Set([DEAD, UNUSED, DOWN, CF, HELD]);
/** source -> title -> numbers it lists. */
const catalog = new Map<string, Map<string, number[]>>();
/** `${source}::${title}::${n}` -> pages its page list has (default 3). */
const pages = new Map<string, number>();
const cid = (src: string, title: string, n: number) => `${src}::${title}::${n}`;
const POSTS = DSN ? istreveliaPosts() : [];
const NUMS = DSN ? webtoonsNumbers(POSTS, false) : [];
const post = (k: number) => ({
  sourceId: `ist-${k}`, number: NUMS[k - 1].chapterNumber, title: NUMS[k - 1].name,
  publishedAt: new Date(POSTS[k - 1].uploadDate).toISOString(), order: k, url: POSTS[k - 1].url, pages: 1,
});
const istListing = () => POSTS.map((_: unknown, i: number) => post(i + 1)).sort((a: any, b: any) => a.number - b.number || a.order - b.order);

const adapter = (id: string) => ({
  id, name: `Fix ${id}`, lang: 'en', ...(id === CF ? { requiresCloudflare: true } : {}),
  async search(term: string) {
    if (BROKEN.has(id)) throw new Error('HTTP 500');
    const hits = [...catalog.get(id)!.keys()].filter((t) => t.toLowerCase().includes(term.toLowerCase()));
    return hits.map((t) => ({ sourceId: `${id}::${t}`, source: id, title: t }));
  },
  async getSeries(sid: string) {
    if (BROKEN.has(id)) throw new Error('HTTP 500');
    const title = sid.split('::')[1] ?? '';
    return { sourceId: sid, source: id, title };
  },
  async listChapters(sid: string) {
    if (id === WEB) return istListing();
    if (BROKEN.has(id) && id !== DOWN) throw new Error('HTTP 500');
    const title = sid.split('::')[1] ?? '';
    return (catalog.get(id)!.get(title) ?? []).map((n) => ({ sourceId: cid(id, title, n), number: n, title: `Chapter ${n}` }));
  },
  async getPageUrls(chapterId: string) {
    if (BROKEN.has(id)) throw new Error('HTTP 500');
    const n = id === WEB ? 1 : pages.get(chapterId) ?? 3;
    return Array.from({ length: n }, (_, i) => `https://example.invalid/${encodeURIComponent(chapterId)}/${i}.png`);
  },
  async latest() { return []; },
});

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 9)]);
const realFetch = globalThis.fetch;
let solverReady = true;
let solver: Server | null = null;

// ── the library ─────────────────────────────────────────────────────────────────────────────────────────────────
const LIB = 'lib_af';
const S = {
  repl: 's_af_repl', cool: 's_af_cool', failOk: 's_af_failok', failBad: 's_af_failbad', short: 's_af_short', gap: 's_af_gap',
  oddGap: 's_af_oddgap', oddMark: 's_af_oddmark', twice: 's_af_twice', twiceShort: 's_af_twiceshort', twiceMark: 's_af_twicemark',
  twicePartial: 's_af_twicepartial', held: 's_af_held',
  dupA: 's_af_dupa', dupB: 's_af_dupb', dupC: 's_af_dupc', dupD: 's_af_dupd', edA: 's_af_eda', edB: 's_af_edb',
  numClean: 's_af_numclean', numTracker: 's_af_numtracker', paused: 's_af_paused', cf: 's_af_cf',
};
const ALL = Object.values(S);
const T: Record<keyof typeof S, string> = {
  repl: 'Fix Replace', cool: 'Fix Cool', failOk: 'Fix Fail Ok', failBad: 'Fix Fail Bad', short: 'Fix Short', gap: 'Fix Gap',
  oddGap: 'Fix Odd Gap', oddMark: 'Fix Odd Mark', twice: 'Fix Twice', twiceShort: 'Fix Twice Short', twiceMark: 'Fix Twice Mark',
  twicePartial: 'Fix Twice Partial', held: 'Fix Held',
  dupA: 'Fix Twin', dupB: 'Fix Twin', dupC: 'Fix Alpha', dupD: 'Totally Unrelated', edA: 'Fix Edition', edB: 'Fix Edicion',
  numClean: 'Istrevelia', numTracker: 'Istrevelia', paused: 'Fix Paused', cf: 'Fix Cloudflare',
};
const folderOf = (k: keyof typeof S) => `T!af/${k}`;

let q: any, autofix: typeof import('../src/lib/autofix'), runtime: any, repair: any, find: any, updater: any, sources: any;
let adminId = '';

/** A chapter archive: `n` pages, and the series' title in its ComicInfo -- what the scan takes a series' title from. */
function cbz(abs: string, n: number, series?: string): void {
  const z = new AdmZip();
  for (let i = 0; i < n; i++) z.addFile(`${String(i + 1).padStart(4, '0')}.png`, PIXEL);
  if (series) z.addFile('ComicInfo.xml', Buffer.from(`<?xml version="1.0"?><ComicInfo><Series>${series}</Series></ComicInfo>`));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, z.toBuffer());
}
async function seedSeries(k: keyof typeof S, o: { source: string | null; auto?: boolean; lang?: string; floor?: number } = { source: MAIN }) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, lang)
           VALUES ($1,'T!af',$2,$3,0,$4,$5,$6,$7,$8)`,
    [S[k], T[k], folderOf(k), LIB, o.source, o.source ? `${o.source}::${T[k]}` : null, o.auto ?? true, o.lang ?? null]);
}
/** A chapter on disk with its row, as the scan would have it: pages counted, the downloader's own name for a whole number. */
async function seedBook(k: keyof typeof S, n: number, o: { pages?: number; src?: string | null; mtime?: number; name?: string } = {}) {
  const file = `${folderOf(k)}/${o.name ?? `Chapter ${n}.cbz`}`;
  cbz(join(DL, file), o.pages ?? 3, T[k]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, source_id, mtime)
           VALUES ($1,$2,'T!af',$3,$4,$5,$6,now(),$7,$8,$9)`,
    [`b_${S[k]}_${n}`, S[k], file, n, `Chapter ${n}`, o.pages ?? 3, DL, o.src === undefined ? MAIN : o.src, o.mtime ?? 1000]);
}
const failedAt = (stage: string) => JSON.stringify({ [stage]: { failAt: new Date().toISOString(), failBy: 'test', kind: 'error', error: 'HTTP 500' } });
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
/** series_listing rows as the sweep writes them: what the gap step sorts a hole's numbers by. */
async function seedListing(k: keyof typeof S, src: string, nums: number[]) {
  for (const n of nums) {
    const chosen = { sourceId: cid(src, T[k], n), source: src, number: n };
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, copies, status) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'available')`,
      [S[k], n, src, JSON.stringify(chosen), JSON.stringify([{ sourceId: cid(src, T[k], n), source: src, groups: [], scanlator: null, lang: null, pages: null, publishedAt: null }])]);
  }
}

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (url.includes('example.invalid')) return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.includes('127.0.0.1')) return realFetch(u, init);
    return new Response('', { status: 404 });
  }) as typeof fetch;
  solver = createServer((_req, res) => {
    if (!solverReady) { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ msg: 'FlareSolverr is ready', version: '3.3.21' }));
  });
  await new Promise<void>((go) => solver!.listen(0, '127.0.0.1', go));
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${(solver.address() as AddressInfo).port}`;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  sources = await import('../src/lib/sources');
  for (const id of SOURCES) { catalog.set(id, new Map()); sources.registerAdapter(adapter(id) as any); }
  autofix = await import('../src/lib/autofix');
  ({ runtime } = await import('../src/lib/runtime'));
  repair = await import('../src/lib/repair');
  find = await import('../src/lib/findSources');
  updater = await import('../src/lib/updater');
  find.setFindTiming({ paceMs: 0, quietMs: 20, busyMs: 50, wallMs: 5000 });
  autofix.setAutofixTiming({ quietMs: 20 });
  await q(`DELETE FROM users WHERE username = 'af-admin'`);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                      VALUES ('af-admin','af-admin','x','admin','password') RETURNING id`))[0].id;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Fix',$2) ON CONFLICT (id) DO NOTHING`, [LIB, DL]);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (solver) await new Promise<void>((go) => solver!.close(() => go()));
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [SOURCES]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'af-admin'`).catch(() => {});
});

const book = async (id: string) => (await q('SELECT pages, pruned_at, root FROM lib_books WHERE id = $1', [id]))[0];
const seriesRow = async (id: string) => (await q('SELECT source_id, merged_into, work_id, gaps_checked_at, numbering, numbering_pending FROM lib_series WHERE id = $1', [id]))[0];
const health = async (id: string) => (await q('SELECT status, disabled, blocked_until, stages FROM source_health WHERE source_id = $1', [id]))[0];

/** The one library every phase works on, and the run over it. */
let run: any = null;

test('Fix everything: one run over a library with something wrong on every card', { skip }, async (t) => {
  // ---- sources
  catalog.get(GOOD)!.set(T.repl, range(1, 4));
  catalog.get(MAIN)!.set(T.cool, range(1, 3));
  catalog.get(COOL)!.set('The Cool Series', range(1, 3)); // what a Test's search finds there
  catalog.get(COOL)!.set(T.cool, range(1, 3));
  catalog.get(MAIN)!.set(T.failOk, range(1, 3));
  catalog.get(MAIN)!.set(T.short, range(1, 3));
  catalog.get(GOOD)!.set(T.short, range(1, 3));
  pages.set(cid(GOOD, T.short, 2), 9);
  catalog.get(MAIN)!.set(T.gap, range(1, 5));
  catalog.get(MAIN)!.set(T.oddGap, range(1, 4));
  await q(`INSERT INTO source_health (source_id, status, stages) VALUES ($1,'ok',$2::jsonb), ($3,'ok',$4::jsonb), ($5,'ok',$6::jsonb)`,
    [DEAD, failedAt('chapters'), UNUSED, failedAt('chapters'), DOWN, failedAt('pages')]);
  await q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until, last_error) VALUES ($1,'rate_limited',2, now() + interval '30 minutes','HTTP 429'),
             ($2,'rate_limited',2, now() + interval '30 minutes','HTTP 429')`, [COOL, HELD]);

  // ---- series
  await seedSeries('repl', { source: DEAD });
  for (const n of [1, 2, 3]) await seedBook('repl', n, { src: DEAD });
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1,$2,$3,$4)`, [S.repl, GOOD, `${GOOD}::${T.repl}`, T.repl]);
  await seedSeries('cool', { source: COOL });
  for (const n of [1, 2]) await seedBook('cool', n, { src: COOL });
  await seedSeries('held', { source: HELD, auto: false });
  for (const n of [1, 2]) await seedBook('held', n, { src: HELD });
  // A failed chapter on a source that can be asked: reset and fetched. One on a source failing at its page lists: left.
  await seedSeries('failOk');
  for (const n of [1, 2]) await seedBook('failOk', n);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts, at) VALUES ($1, 3, $2, 'error', 3, now() - interval '1 hour')`, [S.failOk, MAIN]);
  await seedSeries('failBad', { source: DOWN });
  for (const n of [1, 2]) await seedBook('failBad', n, { src: DOWN });
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts, at) VALUES ($1, 3, $2, 'error', 3, now() - interval '1 hour')`, [S.failBad, DOWN]);
  // A short chapter a follower has nine pages of.
  await seedSeries('short');
  await seedBook('short', 1);
  await seedBook('short', 2, { pages: 1 });
  await seedBook('short', 3);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1,$2,$3,$4)`, [S.short, GOOD, `${GOOD}::${T.short}`, T.short]);
  // A gap its own source lists: fetched now, not left to the sweep.
  await seedSeries('gap');
  for (const n of [1, 2, 4, 5]) await seedBook('gap', n);
  await seedListing('gap', MAIN, range(1, 5));
  // A gap beside an impossible chapter number: the gap step leaves the series alone, and the files phase deletes the 9001.
  await seedSeries('oddGap');
  for (const n of [1, 2, 4]) await seedBook('oddGap', n);
  await seedBook('oddGap', 9001);
  // An impossible chapter number somebody bookmarked: kept, and said.
  await seedSeries('oddMark', { source: MAIN, auto: false });
  for (const n of [1, 2, 3]) await seedBook('oddMark', n);
  await seedBook('oddMark', 7777);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page, note) VALUES ($1,$2,$3,1,'mine')`, [adminId, `b_${S.oddMark}_7777`, S.oddMark]);
  // Saved twice: chapter 5 whole from af-main (10 pages), then 5.1 and 5.2 from af-good (4 + 4): the later copy goes.
  // Chapter 7 from af-main is 2 pages, the later 7.1 and 7.2 twelve: the kept copy is not the complete one, nothing goes.
  // And a later copy somebody bookmarked: kept.
  // And a kept copy saved with placeholder pages, however long: not complete, so nothing goes.
  for (const k of ['twice', 'twiceShort', 'twiceMark', 'twicePartial'] as const) await seedSeries(k, { source: MAIN, auto: false });
  for (const [k, n] of [['twice', 5], ['twiceShort', 7], ['twiceMark', 5], ['twicePartial', 5]] as const) {
    await seedBook(k, 1, { mtime: 500 });
    await seedBook(k, n, { pages: k === 'twiceShort' ? 2 : 10, mtime: 1000 });
    for (const part of [0.1, 0.2]) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, source_id, mtime)
               VALUES ($1,$2,'T!af',$3,$4,'part',$5,now(),$6,$7,2000)`,
        [`b_${S[k]}_${n + part}`, S[k], `${folderOf(k)}/Chapter ${n + part}.cbz`, n + part, k === 'twiceShort' ? 6 : 4, DL, GOOD]);
      cbz(join(DL, `${folderOf(k)}/Chapter ${n + part}.cbz`), k === 'twiceShort' ? 6 : 4, T[k]);
    }
  }
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page, note) VALUES ($1,$2,$3,1,'mine')`, [adminId, `b_${S.twiceMark}_5.1`, S.twiceMark]);
  await q(`UPDATE lib_books SET missing_pages = '{2,3}' WHERE id = $1`, [`b_${S.twicePartial}_5`]);
  // Duplicates: two copies agreeing on title and AniList (merged); two whose titles and chapters disagree (left apart);
  // the same work in two languages (linked as editions).
  await seedSeries('dupA'); for (const n of [1, 2, 3]) await seedBook('dupA', n);
  // Its main source is gone (no adapter by that id): the copy kept is the one that still updates, though this one holds
  // more chapters.
  await seedSeries('dupB', { source: 'af-gone' }); for (const n of [1, 2, 3, 4]) await seedBook('dupB', n, { src: 'af-gone' });
  await seedSeries('dupC'); for (const n of [1, 2, 3]) await seedBook('dupC', n);
  await seedSeries('dupD'); for (const n of [50, 51, 52]) await seedBook('dupD', n);
  await seedSeries('edA', { source: MAIN, lang: 'en' }); await seedBook('edA', 1);
  await seedSeries('edB', { source: MAIN, lang: 'es' }); await seedBook('edB', 1);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES ($1,'anilist','af-1'), ($2,'anilist','af-1'),
             ($3,'anilist','af-2'), ($4,'anilist','af-2'), ($5,'anilist','af-3'), ($6,'anilist','af-3')`,
    [S.dupA, S.dupB, S.dupC, S.dupD, S.edA, S.edB]);
  // Numbering: two Istrevelia-shaped series held for a renumber review -- one whose plan is clean, one whose plan would
  // push numbers to a tracker (not clean).
  const { chapterName } = await import('../src/lib/naming');
  for (const k of ['numClean', 'numTracker'] as const) {
    await seedSeries(k, { source: WEB, auto: false });
    await q(`UPDATE lib_series SET source_series_id = 'istrevelia' WHERE id = $1`, [S[k]]);
    for (const [raw, kk] of [[1, 1], [2, 21], [3, 46], [5, 85]] as const) {
      const file = `${folderOf(k)}/Chapter ${raw}.cbz`;
      cbz(join(DL, file), 3, T[k]);
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, chapter_name, source_id)
               VALUES ($1,$2,'T!af',$3,$4,$5,3,now(),$6,$7,$8)`,
        [`b_${S[k]}_${raw}`, S[k], file, raw, `Chapter ${raw}`, DL, chapterName(post(kk).title, post(kk).number), WEB]);
    }
    const held = await updater.updateSeries(S[k], 0);
    assert.equal(held.outcome, 'renumber_pending', `PREMISE: ${k} is held for a renumber review`);
  }
  await q(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES ($1,'mal','af-numbered')`, [S.numTracker]);
  // A paused series with a gap: nothing but a person fetches it.
  await seedSeries('paused', { source: MAIN, auto: false });
  for (const n of [1, 3]) await seedBook('paused', n);

  // ---- the run
  const started = autofix.startAutofix(adminId, { origin: 'manual' });
  assert.ok('runId' in started, 'it starts');
  await autofix.autofixSettled();
  run = await autofix.autofixRun((started as any).runId);
  assert.equal(run.status, 'done');

  await t.test('the record: kept in repair_runs as kind autofix, with every said line coded', async () => {
    const row = (await q(`SELECT kind, origin, status, by_user, step_ms, result FROM repair_runs WHERE id = $1`, [run.id]))[0];
    assert.equal(row.kind, 'autofix');
    assert.equal(row.origin, 'manual');
    assert.equal(row.by_user, adminId);
    assert.ok(row.step_ms.recheck >= 0, 'each phase timed');
    assert.equal(run.by, 'af-admin');
    const { englishOf } = await import('../src/lib/said');
    const lines = [...run.summary.done.flatMap((d: any) => [d.said, ...(d.items ?? [])]), ...run.summary.needsYou.map((n: any) => n.said),
      ...run.summary.clears.map((c: any) => c.said), ...run.log];
    for (const l of lines) assert.notEqual(englishOf(l), null, `${l.code} is a code the registry words`);
    const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'library.autofix' ORDER BY at DESC LIMIT 1`))[0];
    assert.equal(audit?.detail?.runId, run.id, 'and audited when it ends');
  });

  await t.test('sources: a failing main is Replaced by the working follower and turned off; an unused failing one is retired', async () => {
    assert.equal((await seriesRow(S.repl)).source_id, GOOD, 'the series moved to the source that works');
    assert.equal((await health(DEAD)).disabled, true, 'Replace with turnOff: nothing is left on it, so it is off');
    assert.equal((await health(UNUSED)).disabled, true, 'a failing source no series uses is retired');
    const done = run.summary.done.find((d: any) => d.kind === 'replaced');
    assert.ok(done && done.n >= 1, 'and the summary says what moved');
  });

  await t.test('sources: a block is cleared only after a passing Test', async () => {
    // Reintroduce by clearing every block in the sources phase (drop `r.smoke.ok &&`): af-held, which fails its Test,
    // loses its cooldown.
    const cool = await health(COOL);
    assert.equal(cool.blocked_until, null, 'af-cool passed its Test, and its block was cleared');
    assert.ok((await health(HELD)).blocked_until, 'a block is cleared only after a passing Test: af-held failed its own');
    const tests = await q(`SELECT detail FROM audit_log WHERE event = 'source.test' AND detail->>'runId' = $1`, [run.id]);
    const by = new Map(tests.map((x: any) => [x.detail.source, x.detail.ok]));
    assert.equal(by.get(COOL), true);
    assert.equal(by.get(DEAD), false, 'the failing main was tested and failed, which is why it was Replaced');
  });

  await t.test('chapters: the failures step resets only the sources that can be asked', async () => {
    const failOk = await q(`SELECT 1 FROM chapter_failures WHERE series_id = $1`, [S.failOk]);
    assert.deepEqual(failOk, [], 'the chapter its working source lists landed, and its row with it');
    assert.ok(existsSync(join(DL, folderOf('failOk'), 'Chapter 3.cbz')));
    const failBad = (await q(`SELECT attempts FROM chapter_failures WHERE series_id = $1`, [S.failBad]))[0];
    assert.equal(failBad?.attempts, 3, 'a source failing at its page lists is not asked three more times per chapter');
  });

  await t.test('chapters: a short chapter is replaced by a longer copy, and a listed gap is fetched now', async () => {
    assert.equal((await book(`b_${S.short}_2`)).pages, 9, 'the nine-page copy replaced the one-page file');
    assert.ok(existsSync(join(DL, folderOf('gap'), 'Chapter 3.cbz')), 'the gap its own source lists was fetched, not left to the sweep');
    assert.ok(run.summary.done.some((d: any) => d.kind === 'fetched' && d.n >= 1));
    assert.ok(run.summary.done.some((d: any) => d.kind === 'shortFixed' && d.n === 1));
  });

  await t.test('chapters: the gaps step leaves a series with an impossible number alone', async () => {
    assert.equal((await seriesRow(S.oddGap)).gaps_checked_at, null, 'not looked at: one chapter numbered 9001 is not a 9000-chapter gap');
    assert.equal(existsSync(join(DL, folderOf('oddGap'), 'Chapter 3.cbz')), false, 'and nothing was fetched for it');
  });

  await t.test('duplicates: copies that agree are merged, ones that do not are left, two languages are linked', async () => {
    const [a, b] = [await seriesRow(S.dupA), await seriesRow(S.dupB)];
    assert.equal(b.merged_into, S.dupA, 'the copy on the dead source merged into the one on a working source');
    assert.equal(a.merged_into, null);
    // Either way round: with the agreement test gone, the later copy is the one absorbed.
    for (const id of [S.dupC, S.dupD]) assert.equal((await seriesRow(id)).merged_into, null, 'titles and chapters that disagree are never merged');
    assert.ok(run.log.some((l: any) => l.code === 'autofix.item.notMerged'), 'and the log says why');
    const [ea, eb] = [await seriesRow(S.edA), await seriesRow(S.edB)];
    assert.ok(ea.work_id && ea.work_id === eb.work_id, 'the two languages are editions of one work now');
    const merged = run.summary.done.find((d: any) => d.kind === 'merged');
    assert.deepEqual(merged?.items?.[0], { code: 'autofix.item.merged', params: { from: T.dupB, into: T.dupA } }, 'each merge named with both titles');
  });

  await t.test('numbering: only a clean plan is applied', async () => {
    const clean = await seriesRow(S.numClean);
    assert.equal(clean.numbering, 'posting_order', 'the clean plan was applied');
    assert.equal(clean.numbering_pending, null);
    const tracked = await seriesRow(S.numTracker);
    assert.equal(tracked.numbering_pending, 'posting_order', 'a plan that would push numbers to a tracker waits for the admin');
    assert.ok(existsSync(join(DL, folderOf('numTracker'), 'Chapter 5.cbz')), 'and nothing of it was renamed');
    assert.ok(run.summary.needsYou.some((n: any) => n.check === 'numbering'), 'it is Needs you');
  });

  await t.test('files: a later copy is deleted only when the kept copy is complete, never a bookmarked one, and impossible numbers go', async () => {
    for (const part of [5.1, 5.2]) assert.ok((await book(`b_${S.twice}_${part}`)).pruned_at, `the later copy ${part} went: the kept chapter 5 is whole and longer`);
    assert.equal((await book(`b_${S.twice}_5`)).pruned_at, null, 'the copy kept is kept');
    for (const part of [7.1, 7.2]) assert.equal((await book(`b_${S.twiceShort}_${part}`)).pruned_at, null, 'a later copy is deleted only when the kept copy is as long');
    for (const part of [5.1, 5.2]) assert.equal((await book(`b_${S.twicePartial}_${part}`)).pruned_at, null, 'nor when the kept copy has pages missing');
    assert.equal((await book(`b_${S.twiceMark}_5.1`)).pruned_at, null, 'a bookmarked chapter is never deleted');
    assert.ok((await book(`b_${S.oddGap}_9001`)).pruned_at, 'the impossible number went');
    assert.equal((await book(`b_${S.oddMark}_7777`)).pruned_at, null, 'unless somebody bookmarked it');
  });

  await t.test('what is left reaches Needs you, each with its key, and nothing is ignored', async () => {
    const checks = run.summary.needsYou.map((n: any) => n.check);
    for (const c of ['outliers', 'saved-twice', 'duplicates', 'numbering', 'chapter-gaps']) assert.ok(checks.includes(c), `${c} is Needs you: ${checks.join(', ')}`);
    for (const n of run.summary.needsYou) assert.ok(n.action?.kind, `${n.check} has its one key`);
    // Fix everything never writes an ignore: what it cannot fix stays a finding, said.
    assert.deepEqual(await q('SELECT check_id, item_key FROM health_ignored'), [], 'Fix everything never presses Ignore');
    assert.equal(typeof run.summary.green, 'boolean');
  });
});

test('one Fix everything at a time, and never beside a repair, a Find or a sweep', { skip }, async () => {
  // Reintroduce by dropping a refusal: busyWith() in lib/autofix.ts (each `running` below), runtime.autofixing in
  // repair.ts runRepair ("a repair refuses beside it") or in findSources.ts startFind ("so does a Find").
  // A failed assertion must not leave a flag set: a run started under it would wait for a sweep forever.
  try {
    runtime.updating = true;
    assert.deepEqual(autofix.startAutofix(adminId), { busy: 'sweep' }, 'not beside a sweep');
    runtime.updating = false;
    repair.repairState.running = true;
    assert.deepEqual(autofix.startAutofix(adminId), { busy: 'repair' }, 'not beside a repair');
    repair.repairState.running = false;

    const first = autofix.startAutofix(adminId);
    assert.ok('runId' in first);
    assert.deepEqual(autofix.startAutofix(adminId), { busy: 'autofix' }, 'one at a time');
    assert.equal(repair.runRepair(undefined, { only: ['solver'], userId: adminId }), false, 'a repair refuses beside it');
    const { SYSTEM_CTX } = await import('../src/lib/visibility');
    assert.deepEqual(await find.startFind({ seriesIds: [S.gap] }, adminId, SYSTEM_CTX), { autofix: true }, 'so does a Find');
  } finally {
    runtime.updating = false;
    repair.repairState.running = false;
    autofix.stopAutofix();
    find.stopFind();
    await autofix.autofixSettled();
    await find.findSettled();
  }
  assert.equal(runtime.autofixing, false, 'and the lock goes with it');
});

test('Stop ends the run at a safe point, and it is recorded stopped', { skip }, async () => {
  const started = autofix.startAutofix(adminId);
  assert.ok('runId' in started);
  // Reintroduce by not honouring the stop between phases (drop `halted(a)` from runAll's loop): the run reads done.
  assert.equal(autofix.stopAutofix(), true);
  await autofix.autofixSettled();
  const r = await autofix.autofixRun(started.runId);
  assert.equal(r?.status, 'stopped');
  assert.ok(r?.log?.some((l: any) => l.code === 'autofix.item.skipped' && l.params?.why === 'stopped'), 'and its log says so');
  assert.ok(r?.summary, 'with a summary of what it did before the stop');
  assert.equal(autofix.stopAutofix(), false, 'nothing to stop once it has ended');
});

test('a solver that is down: the sources behind it are left alone, and it is Needs you', { skip }, async () => {
  // Reintroduce by Testing and Replacing whatever fails (drop solverSpeaksFor in lib/autofix.ts sources): af-cf is
  // tested and its series moved for a failure that is the solver's.
  solverReady = false;
  try {
    const { forgetSolverPing } = await import('../src/lib/sources/flaresolverr');
    forgetSolverPing();
    catalog.get(GOOD)!.set(T.cf, range(1, 3));
    await seedSeries('cf', { source: CF });
    await seedBook('cf', 1, { src: CF });
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1,$2,$3,$4)`, [S.cf, GOOD, `${GOOD}::${T.cf}`, T.cf]);
    await q(`INSERT INTO source_health (source_id, status, stages, last_error) VALUES ($1,'ok',$2::jsonb,'flaresolverr: connection refused')`, [CF, failedAt('chapters')]);
    const started = autofix.startAutofix(adminId);
    assert.ok('runId' in started);
    await autofix.autofixSettled();
    const r = await autofix.autofixRun(started.runId);
    assert.equal((await seriesRow(S.cf)).source_id, CF, 'a failure behind a solver that is down says nothing about the site: no Replace');
    const tested = await q(`SELECT 1 FROM audit_log WHERE event = 'source.test' AND detail->>'runId' = $1 AND detail->>'source' = $2`, [started.runId, CF]);
    assert.deepEqual(tested, [], 'and no Test');
    assert.ok(r?.log?.some((l: any) => l.code === 'autofix.item.skipped' && l.params?.why === 'solver_down'), 'the log says why');
    const solverNeed = r?.summary?.needsYou.find((n: any) => n.check === 'solver');
    assert.equal(solverNeed?.said.code, 'autofix.needs.solverDown', 'and the solver is Needs you');
    assert.deepEqual(solverNeed?.action, { kind: 'health', check: 'solver' });
  } finally {
    solverReady = true;
    const { forgetSolverPing } = await import('../src/lib/sources/flaresolverr');
    forgetSolverPing();
  }
});

test('the routes: start, follow, one run, stop, and the nightly choice', { skip }, async () => {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
  try {
    const start = await app.inject({ method: 'POST', url: '/api/admin/health/autofix', headers: auth, payload: {} });
    assert.equal(start.statusCode, 202, start.body);
    const { runId } = start.json();
    const again = await app.inject({ method: 'POST', url: '/api/admin/health/autofix', headers: auth, payload: {} });
    assert.equal(again.statusCode, 409);
    assert.deepEqual(again.json(), { error: 'busy', running: 'autofix' });
    const live = (await app.inject({ method: 'GET', url: '/api/admin/health/autofix', headers: auth })).json();
    assert.equal(live.run?.id, runId, 'the live run');
    assert.equal(live.run.status, 'running');
    const stop = await app.inject({ method: 'POST', url: '/api/admin/health/autofix/stop', headers: auth, payload: {} });
    assert.deepEqual(stop.json(), { ok: true, stopping: true });
    await autofix.autofixSettled();
    const after = (await app.inject({ method: 'GET', url: '/api/admin/health/autofix', headers: auth })).json();
    assert.equal(after.run, null);
    assert.equal(after.last?.id, runId, 'the newest finished run');
    assert.equal(after.last.status, 'stopped');
    const one = await app.inject({ method: 'GET', url: `/api/admin/health/autofix/${runId}`, headers: auth });
    assert.equal(one.json().id, runId);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/health/autofix/00000000-0000-0000-0000-000000000000', headers: auth })).statusCode, 404);
    // The nightly choice: the safe repair unless told otherwise, saved and read back.
    const s0 = (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth })).json();
    assert.equal(s0.nightlyMode, 'repair', 'the safe repair by default');
    const set = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth, payload: { nightlyMode: 'autofix' } });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth })).json().nightlyMode, 'autofix');
    // A value that is not a mode is refused (the server's error handler answers the ZodError 400; this bare app, 500).
    assert.notEqual((await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth, payload: { nightlyMode: 'everything' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth })).json().nightlyMode, 'autofix', 'and nothing is stored');
    await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth, payload: { nightlyMode: 'repair' } });
  } finally {
    await app.close();
  }
});

test('the nightly runs Fix everything when Settings chose it, and the safe repair otherwise', { skip }, async () => {
  // server.ts starts listening on import, so its scheduler is read, as findSources.int.test.ts reads its shutdown.
  // Reintroduce by dropping the `nightly_mode` branch from the repair tick: the first two assertions fail.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  const tick = src.slice(src.indexOf('SELECT repair_enabled, nightly_mode FROM server_settings'), src.indexOf('setRepairNext(Date.now() + next)'));
  assert.ok(tick.length > 0, 'the tick reads the nightly choice with the switch, every time');
  assert.match(tick, /nightly_mode === 'autofix'[\s\S]*startAutofix\(null, \{ origin: 'nightly'/, 'and starts Fix everything, as nobody, when it is chosen');
  assert.match(tick, /runRepair\(app\.log\)/, 'the safe repair otherwise, as before');
  assert.ok(tick.indexOf("repair_enabled === false") < tick.indexOf("nightly_mode === 'autofix'"), 'the nightly switch still turns either off');
});
