// The nightly library repair, against a real scratch database, a real scratch disk and fake sources.
//
// Every one of these is a place where "it fixed it" and "it broke it" look the same from the outside, so
// each test pins the DECISION rather than the outcome: a copy is downloaded only after a page count proved
// it longer, a chapter is called "really two pages" only after every copy answered, a source is followed
// only when it brackets the hole, and nothing at all is removed, tombstoned, merged or renumbered.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '', LIB_ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-rep-'));
  DL = join(ROOT, 'dl');
  LIB_ROOT = join(ROOT, 'lib');
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = LIB_ROOT;
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0';
  process.env.MIN_FREE_GB = '0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '300';
  process.env.REPAIR_PACE_MS = '0';
  // Two, so the count step's cap is observable at all: three files, two counted, one left for tomorrow.
  process.env.REPAIR_COUNT_MAX = '2';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const LIB = 'lib_rep';
// rp-d is the fourth source: with a primary and MAX_FOLLOWERS two, a series can follow three, and the
// short step asks REPAIR_SHORT_COPIES = 3 of them -- so a fourth is what makes "a source the cap left
// unasked" reachable at all. It lists nothing unless a test gives it a catalogue.
const A = 'rp-a', B = 'rp-b', C = 'rp-c', D = 'rp-d', BLAMER = 'rp-blamer';
const SOURCES = [A, B, C, D];
const SHORT = 's_rep_short', GAP = 's_rep_gap', NOFILL = 's_rep_nofill', WANTS = 's_rep_wants';
const LISTED = 's_rep_listed', COUNT = 's_rep_count', HAVE = 's_rep_have', FAIL = 's_rep_fail';
const SPARES = ['s_rep_g1', 's_rep_g2'];
const MINE = [SHORT, GAP, NOFILL, WANTS, LISTED, COUNT, HAVE, FAIL, ...SPARES];
const T = {
  short: 'Repair Short', gap: 'Repair Gap', nofill: 'Repair Nofill', wants: 'Repair Wants',
  listed: 'Repair Listed', fail: 'Repair Fail',
};

let q: any, pool: any, runRepair: any, repairState: any, runtime: any, haveNumbers: any, HAVE_SQL: any;
let persistScan: any, gapsOf: any, clearPace: () => void;
let repairLiveSnapshot: any, listRuns: any, busyFolders: Set<string>, runHealthChecks: any;

// ── the fake sources ────────────────────────────────────────────────────────────────────────────────────
/** source -> title -> the chapter numbers that source lists for it. A title it has no entry for is unknown. */
const catalog = new Map<string, Map<string, number[]>>();
/** chapter id -> how many pages its page list has. Default 2, which is what a "short chapter" looks like. */
const pagesFor = new Map<string, number>();
/** Chapter ids whose page list throws: a source that did not answer, which can never be part of a proof. */
const throwPages = new Set<string>();
/** Chapter ids one source lists TWICE, as a second scanlation group: one listing row, two copies, one source. */
const twoGroups = new Set<string>();
/** `chapterId/index` pairs the site answers 404 for, so a download arrives nearly whole. */
const missingPage = new Set<string>();
/** Every page list asked for, and every search: what the run actually cost the sources. */
let pageCalls: string[] = [];
let searches: string[] = [];
/** A page list that waits: `reached` fires when it is asked, and it answers once `open` resolves. */
let pageGate: { id: string; reached: () => void; open: Promise<void> } | null = null;
/** Whether the stub solver says it is ready. */
let solverReady = true;
let solver: Server | null = null;

const cid = (src: string, title: string, n: number) => `${src}::${title}::${n}`;
const setCatalog = (src: string, title: string, nums: number[]) => catalog.get(src)!.set(title, nums);

const adapter = (id: string) => ({
  id, name: `Repair ${id}`,
  async search(term: string) {
    searches.push(`${id}:${term}`);
    return catalog.get(id)!.has(term) ? [{ sourceId: `${id}::${term}`, source: id, title: term }] : [];
  },
  async getSeries(sid: string) {
    const title = sid.split('::')[1] ?? '';
    return catalog.get(id)!.has(title) ? { sourceId: sid, source: id, title } : null;
  },
  async listChapters(sid: string) {
    const title = sid.split('::')[1] ?? '';
    const out: Array<{ sourceId: string; number: number; title: string; scanlator?: string }> = [];
    for (const n of catalog.get(id)!.get(title) ?? []) {
      out.push({ sourceId: cid(id, title, n), number: n, title: `Chapter ${n}` });
      // A re-upload by a second group on the SAME site: two copies of one number under one source, which
      // is what `series_listing.copies` holds live and what the short step must not mistake for two sources.
      if (twoGroups.has(cid(id, title, n))) {
        out.push({ sourceId: `${cid(id, title, n)}#b`, number: n, title: `Chapter ${n}`, scanlator: 'Second Group' });
      }
    }
    return out;
  },
  async getPageUrls(chapterId: string) {
    pageCalls.push(chapterId);
    if (pageGate?.id === chapterId) { pageGate.reached(); await pageGate.open; }
    if (throwPages.has(chapterId)) throw new Error('the site did not answer');
    const n = pagesFor.get(chapterId) ?? 2;
    return Array.from({ length: n }, (_, i) => `https://example.invalid/${encodeURIComponent(chapterId)}/${i}.png`);
  },
  async latest() { return []; },
});

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 9)]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = String(u);
  if (url.includes('example.invalid')) {
    const m = url.match(/example\.invalid\/([^/]+)\/(\d+)\.png$/);
    if (m && missingPage.has(`${decodeURIComponent(m[1])}/${m[2]}`)) return new Response('gone', { status: 404 });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  return realFetch(u, init);
}) as typeof fetch;

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const GAP_HAVE = [...range(1, 10), ...range(14, 20)]; // gap 11-13, and seventeen numbers, so an exact
                                                      // title is judged one way (ONE_WAY_MIN_LISTED = 10)

function cbz(abs: string, pages: number): void {
  const z = new AdmZip();
  for (let i = 0; i < pages; i++) z.addFile(`${String(i + 1).padStart(4, '0')}.png`, PIXEL);
  z.addFile('ComicInfo.xml', Buffer.from('<?xml version="1.0"?><ComicInfo><Series>Repair</Series></ComicInfo>'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, z.toBuffer());
}

const folderOf = (title: string) => `T!rep/${title}`;

async function seedSeries(id: string, title: string, opts: { source?: string | null; auto?: boolean } = {}): Promise<void> {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!rep',$2,$3,0,$4,$5,$6,$7)`,
    [id, title, folderOf(title), LIB, opts.source ?? null, opts.source ? `${opts.source}::${title}` : null, opts.auto ?? false]);
}

/** A chapter row with its file, the way persistScan writes them: file relative to root, root absolute. */
async function seedBook(bookId: string, seriesId: string, title: string, n: number, opts: { pages?: number; root?: string; file?: string; src?: string | null; mtime?: number } = {}): Promise<void> {
  const root = opts.root ?? DL;
  const file = opts.file ?? `${folderOf(title)}/Chapter ${n}.cbz`;
  if (opts.pages !== undefined && opts.pages > 0) cbz(join(root, file), opts.pages);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, source_id, mtime)
           VALUES ($1,$2,'T!rep',$3,$4,$5,$6,$7,$8,$9)`,
    [bookId, seriesId, file, n, `Chapter ${n}`, opts.pages ?? 0, root, opts.src ?? null, opts.mtime ?? 1000]);
}

/** series_listing rows as the sweep writes them, so huntCandidates has numbers to judge against. */
async function seedListing(seriesId: string, src: string, title: string, nums: number[], status = 'available'): Promise<void> {
  for (const n of nums) {
    const chosen = { sourceId: cid(src, title, n), source: src, number: n };
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, copies, status)
             VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
             ON CONFLICT (series_id, number) DO UPDATE SET chosen = EXCLUDED.chosen, copies = EXCLUDED.copies, status = EXCLUDED.status`,
      [seriesId, n, src, JSON.stringify(chosen), JSON.stringify([{ sourceId: cid(src, title, n), source: src, groups: [], scanlator: null, lang: null, pages: null, publishedAt: null }]), status]);
  }
}

/** The listings the sweep would have left behind. Re-seeded per test: the gap step rewrites them for real. */
async function seedAllListings(): Promise<void> {
  await q('DELETE FROM series_listing WHERE series_id = ANY($1)', [MINE]);
  await seedListing(GAP, A, T.gap, GAP_HAVE);
  await seedListing(NOFILL, A, T.nofill, GAP_HAVE);
  await seedListing(WANTS, A, T.wants, GAP_HAVE);
  await seedListing(LISTED, A, T.listed, range(1, 20));
  await seedListing(SHORT, A, T.short, range(1, 9));
}

function resetCatalog(): void {
  for (const id of SOURCES) catalog.set(id, new Map());
  setCatalog(A, T.short, range(1, 9));
  setCatalog(B, T.short, range(1, 9));
  setCatalog(A, T.gap, GAP_HAVE);
  setCatalog(B, T.gap, range(1, 20));
  setCatalog(A, T.nofill, GAP_HAVE);
  setCatalog(C, T.nofill, range(1, 10)); // ten of our seventeen: 59 %, refused as numbering_differs
  setCatalog(A, T.wants, GAP_HAVE);
  setCatalog(C, T.wants, GAP_HAVE);       // is this series, and holds nothing we are missing
  setCatalog(A, T.listed, [...range(1, 10), ...range(12, 20)]);
  setCatalog(A, T.fail, range(1, 5));
  setCatalog(B, T.fail, range(1, 5));
  pagesFor.clear();
  throwPages.clear();
  twoGroups.clear();
  missingPage.clear();
}

before(async () => {
  if (!DSN) return;
  // The stub solver comes up FIRST, on a port the system picks, and FLARESOLVERR_URL names it before any module
  // that reads it at load (lib/sources/flaresolverr.ts) is imported. A fixed port hung every other run that
  // shared the network namespace (the lanes' int suites all run beside one Postgres container).
  solver = createServer((_req, res) => {
    if (!solverReady) { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ msg: 'FlareSolverr is ready', version: '3.3.21' }));
  });
  await new Promise<void>((go) => solver!.listen(0, '127.0.0.1', go));
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${(solver.address() as AddressInfo).port}`;
  const { migrate } = await import('../src/lib/migrate');
  ({ q, pool } = (await import('../src/lib/db')) as any);
  const sources = await import('../src/lib/sources');
  await migrate();
  resetCatalog();
  for (const id of SOURCES) sources.registerAdapter(adapter(id) as any);
  ({ runRepair, repairState, repairLiveSnapshot } = (await import('../src/lib/repair')) as any);
  ({ listRuns } = (await import('../src/lib/downloadJobs')) as any);
  ({ busyFolders } = (await import('../src/lib/bulkNewest')) as any);
  ({ runHealthChecks } = (await import('../src/lib/health')) as any);
  ({ runtime } = await import('../src/lib/runtime'));
  ({ haveNumbers, HAVE_SQL } = (await import('../src/lib/libraryNumbers')) as any);
  ({ persistScan } = (await import('../src/lib/library')) as any);
  ({ gapsOf } = await import('../src/lib/fill'));
  ({ clearPace } = await import('../src/lib/pace'));

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Repair',$2) ON CONFLICT (id) DO NOTHING`, [LIB, DL]);
  await seedSeries(SHORT, T.short, { source: A });
  await seedSeries(GAP, T.gap, { source: A, auto: true });
  await seedSeries(NOFILL, T.nofill, { source: A, auto: true });
  await seedSeries(WANTS, T.wants, { source: A, auto: true });
  await seedSeries(LISTED, T.listed, { source: A, auto: true });
  await seedSeries(FAIL, T.fail, { source: A, auto: true });
  await seedSeries(COUNT, 'Repair Count');
  await seedSeries(HAVE, 'Repair Have');
  for (const id of SPARES) await seedSeries(id, `Repair Spare ${id.slice(-1)}`, { auto: true });

  // The gap series and what each of them holds.
  for (const n of GAP_HAVE) {
    // Three pages, not one: a one-page chapter is a SHORT chapter, and these would then be candidates
    // for the step next door -- twenty of them, which is exactly REPAIR_SHORT_MAX.
    await seedBook(`b_gap_${n}`, GAP, T.gap, n, { pages: 3, src: A });
    await seedBook(`b_nofill_${n}`, NOFILL, T.nofill, n, { pages: 3, src: A });
    await seedBook(`b_wants_${n}`, WANTS, T.wants, n, { pages: 3, src: A });
  }
  for (const n of [...range(1, 10), ...range(12, 20)]) await seedBook(`b_listed_${n}`, LISTED, T.listed, n, { pages: 3, src: A });
  // Two-chapter holes: smaller than the three the fillable series have, bigger than the one Repair Listed
  // has, so "the emptiest first" and the cap of five are both observable.
  for (const id of SPARES) {
    for (const n of [1, 2, 3, 4, 7]) await seedBook(`b_${id}_${n}`, id, `Repair Spare ${id.slice(-1)}`, n, { pages: 3 });
  }
  await seedAllListings();

  // The have-set fixture: a deliberate deletion, a file that simply went, and a renumbered chapter.
  for (const n of [1, 2, 3, 4, 5, 6]) await seedBook(`b_have_${n}`, HAVE, 'Repair Have', n, { pages: 3 });
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = 'b_have_4'`);
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'missing' WHERE id = 'b_have_5'`);
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ('b_have_6', 8)`);

});

beforeEach(async () => {
  if (!DSN) return;
  resetCatalog();
  pageCalls = []; searches = []; solverReady = true;
  clearPace();
  runtime.stopping = false;
  runtime.updating = false;
  repairState.running = false;
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[...SOURCES, BLAMER]]);
  await q('DELETE FROM chapter_failures');
  await q('DELETE FROM series_sources WHERE series_id = ANY($1)', [MINE]);
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [MINE]);
  await q('DELETE FROM lib_books WHERE series_id = $1', [SHORT]);
  // The gap test fills Repair Gap's hole for real, on disk and in the listing. Put the library back, so
  // every test below starts from the same shelf rather than from whichever ones ran before it.
  await q('DELETE FROM lib_books WHERE series_id = $1 AND number = ANY($2::real[])', [GAP, [11, 12, 13]]);
  for (const n of [11, 12, 13]) rmSync(join(DL, folderOf(T.gap), `Chapter ${n}.cbz`), { force: true });
  await seedAllListings();
  await q('UPDATE lib_series SET source_hunt_at = NULL, gaps_checked_at = NULL, gaps_result = NULL WHERE id = ANY($1)', [MINE]);
  await q('UPDATE server_settings SET repair_enabled = true, auto_follow_on_failure = true WHERE id = 1');
  // Rows that belong to OTHER test files share this scratch database, and the count step's queue and the
  // gap step's candidate list are both library-wide. Stamped out of the way so a cap of two means two of
  // MINE; both columns are new in v0.41.0 and nothing else reads them.
  await q('UPDATE lib_books SET pages_checked_at = now() WHERE pages_checked_at IS NULL AND series_id <> ALL($1)', [MINE]);
  await q('UPDATE lib_series SET gaps_checked_at = now() WHERE id <> ALL($1)', [MINE]);
});

after(async () => {
  if (solver) await new Promise<void>((go) => solver!.close(() => go()));
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM chapter_failures').catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [MINE]).catch(() => {});
  await q('DELETE FROM series_sources WHERE series_id = ANY($1)', [MINE]).catch(() => {});
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE id = ANY($1)', [MINE]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [MINE]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [MINE]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[...SOURCES, BLAMER]]).catch(() => {});
});

const book = async (id: string) =>
  (await q('SELECT id, pages, pages_checked_at, page_dims, short_confirmed_at, missing_pages, source_id, mtime FROM lib_books WHERE id = $1', [id]))[0];
const series = async (id: string) => (await q('SELECT gaps_checked_at, gaps_result FROM lib_series WHERE id = $1', [id]))[0];
const audits = (event: string) => q('SELECT detail FROM audit_log WHERE event = $1 ORDER BY at DESC LIMIT 5', [event]);
const entries = (abs: string) => Object.keys(new AdmZip(abs).getEntries().reduce((a: any, e: any) => (a[e.entryName] = 1, a), {})).sort();
const blockSource = (id: string, minutes = 30) =>
  q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until, last_error, updated_at)
     VALUES ($1,'rate_limited',1, now() + ($2 || ' minutes')::interval, 'busy', now())
     ON CONFLICT (source_id) DO UPDATE SET status = 'rate_limited', blocked_until = now() + ($2 || ' minutes')::interval`,
    [id, String(minutes)]);

// ── the held numbers (lib/libraryNumbers.ts) ────────────────────────────────────────────────────────────

test('a deliberate deletion is not a gap, a file that simply went is, and a renumbered chapter counts under its new number', { skip }, async () => {
  // Reintroduce by returning the old query (a bare SELECT number over every row, no override join and no
  // heldBooks): the two assertions below read the deleted chapter as missing and chapter 6 as present.
  const have = await haveNumbers(HAVE);
  assert.deepEqual([...have].sort((a: number, b: number) => a - b), [1, 2, 3, 4, 8],
    'held: 1-3 live, 4 deleted on purpose (still held), 5 gone without anyone deciding (not held), 6 renumbered to 8');
  assert.deepEqual(gapsOf(have).map((g: any) => `${g.lo}-${g.hi}`), ['5-7'],
    'the hole starts at the file that went missing, not at the chapter somebody deleted');
  assert.ok(HAVE_SQL('x').includes('x.series_id = $1'), 'the SELECT takes the books alias a caller slots it under');
});

// ── (a) page counts ─────────────────────────────────────────────────────────────────────────────────────

test('page counts are stamped newest first, a corrupt archive counts zero and is never read again, and the cap leaves the rest for tomorrow', { skip }, async () => {
  // Reintroduce by stamping only a non-zero count (`if (pages) UPDATE ...`): the corrupt archive keeps a
  // NULL pages_checked_at, the queue never drains past it, and the same unreadable files are opened again
  // every night while the rest of the library stays uncounted.
  await seedBook('b_count_1', COUNT, 'Repair Count', 1, { pages: 3, mtime: 3000 });
  await seedBook('b_count_2', COUNT, 'Repair Count', 2, { mtime: 2000 });
  writeFileSync(join(DL, folderOf('Repair Count'), 'Chapter 2.cbz'), Buffer.from('not a zip at all'));
  await seedBook('b_count_3', COUNT, 'Repair Count', 3, { pages: 4, root: LIB_ROOT, mtime: 1000 });
  // The rows say "never counted"; the files say three, nothing readable, and four.
  await q(`UPDATE lib_books SET pages = 0 WHERE id = 'b_count_3'`);
  await q(`UPDATE lib_books SET pages = 0, page_dims = '[{"w":1,"h":2}]'::jsonb WHERE id = 'b_count_1'`);

  const first = await runRepair(undefined, { only: ['count'], userId: null });
  assert.equal(first.counted, 2, 'REPAIR_COUNT_MAX stopped it at two files');
  assert.equal(first.uncounted, 1, 'and said how many are still waiting');
  assert.equal((await book('b_count_1')).pages, 3);
  assert.ok((await book('b_count_1')).pages_checked_at, 'stamped, so the queue drains');
  assert.deepEqual((await book('b_count_1')).page_dims, [{ w: 1, h: 2 }],
    'page_dims is a cache of every page size and this step measures none of them');
  assert.equal((await book('b_count_2')).pages, 0, 'an archive that cannot be read is zero pages');
  assert.ok((await book('b_count_2')).pages_checked_at, 'and is stamped anyway, or it is re-opened every night forever');
  assert.equal((await book('b_count_3')).pages_checked_at, null, 'the third file was over the cap');

  const second = await runRepair(undefined, { only: ['count'], userId: null });
  assert.equal(second.counted, 1);
  assert.equal(second.uncounted, 0);
  assert.equal((await book('b_count_3')).pages, 4, 'a read-library chapter is counted too: the count is about our own disk');
  await q('DELETE FROM lib_books WHERE series_id = $1', [COUNT]);
});

test('a reader who opens the chapter first keeps their page count', { skip }, async () => {
  // Reintroduce by dropping `AND pages = 0` from the UPDATE in stepCount: the assertion below reads 3,
  // the count this job took from a file a reader had already measured and stamped.
  await seedBook('b_count_race', COUNT, 'Repair Count', 7, { pages: 3, mtime: 9000 });
  await q(`UPDATE lib_books SET pages = 0 WHERE id = 'b_count_race'`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM lib_books WHERE id = $1 FOR UPDATE', ['b_count_race']);
    const running = runRepair(undefined, { only: ['count'], userId: null });
    await new Promise((r) => setTimeout(r, 250)); // the job is now blocked on this row's UPDATE
    await client.query('UPDATE lib_books SET pages = 7, pages_checked_at = now() WHERE id = $1', ['b_count_race']);
    await client.query('COMMIT');
    await running;
  } finally {
    client.release();
  }
  assert.equal((await book('b_count_race')).pages, 7, 'the reader measured the same file and got there first');
  await q('DELETE FROM lib_books WHERE series_id = $1', [COUNT]);
});

// ── (b) short chapters ──────────────────────────────────────────────────────────────────────────────────

/** Another source the short series follows, the way series_sources holds it. */
const follow = (src: string) =>
  q('INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [SHORT, src, `${src}::${T.short}`]);

/**
 * Make these sources list chapter `n` of the short series as well as its usual 1-9. The short step rebuilds
 * the listing from the sources before it reads the copies, so a number no source lists has no copies to ask.
 */
const listsShort = (srcs: string[], n: number) => { for (const s of srcs) setCatalog(s, T.short, [...range(1, 9), n]); };

/** One short chapter on disk, followed on rp-a (its own source) and rp-b, and listed by both. */
async function shortBook(n: number, pages = 2): Promise<string> {
  const id = `b_short_${n}`;
  await seedBook(id, SHORT, T.short, n, { pages, src: A, mtime: 1000 + n });
  await follow(B);
  listsShort([A, B], n);
  return id;
}

test('a follower with more pages replaces a short chapter, and everyone keeps their place in it', { skip }, async () => {
  const id = await shortBook(3);
  pagesFor.set(cid(A, T.short, 3), 2);
  pagesFor.set(cid(B, T.short, 3), 12);
  const user = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                         VALUES ('rep-reader','rep-reader','x','user','password') RETURNING id`))[0].id;
  await q('INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,2,true)', [user, id, SHORT]);

  const r = await runRepair(undefined, { only: ['short'], userId: null });
  assert.deepEqual(r.short, { looked: 1, replaced: 1, confirmed: 0, left: 0 });
  assert.equal((await book(id)).pages, 12, 'the row carries the count of the bytes that landed');
  assert.equal(entries(join(DL, folderOf(T.short), 'Chapter 3.cbz')).filter((n) => n.endsWith('.png')).length, 12);
  const prog = (await q('SELECT page, completed FROM read_progress WHERE book_id = $1', [id]))[0];
  assert.deepEqual(prog, { page: 2, completed: true }, 'a reader who finished the two-page notice keeps their mark');
  const a = (await audits('book.short_fixed'))[0]?.detail;
  assert.deepEqual(a?.pages, [2, 12], 'the audit row says what it was and what it is');
  assert.equal(a?.to, B);
  assert.equal(a?.readers, 1, 'and how many people had a position in it');
  await q('DELETE FROM read_progress WHERE book_id = $1', [id]);
  await q('DELETE FROM users WHERE id = $1', [user]);
});

test('a shorter copy never replaces what is already on disk', { skip }, async () => {
  // Reintroduce by downloading whatever the copies answered (dropping `n > best` in stepShort): the
  // byte-identity assertion below finds the file rewritten with one page.
  const id = await shortBook(4);
  const abs = join(DL, folderOf(T.short), 'Chapter 4.cbz');
  const before = readFileSync(abs);
  pagesFor.set(cid(A, T.short, 4), 1);
  pagesFor.set(cid(B, T.short, 4), 1);
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.replaced, 0, 'nothing on offer beat two pages');
  assert.ok(before.equals(readFileSync(abs)), 'the file was not touched at all');
  assert.equal((await book(id)).pages, 2, 'and neither was its count');
});

test('every copy answering two pages or fewer, and no other source anywhere, is what confirms a short chapter', { skip }, async () => {
  const id = await shortBook(5);
  pagesFor.set(cid(A, T.short, 5), 2);
  pagesFor.set(cid(B, T.short, 5), 2);
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.confirmed, 1);
  assert.ok((await book(id)).short_confirmed_at, 'the Health page stops reporting it');
  const again = await runRepair(undefined, { only: ['short'], userId: null });
  assert.equal(again.short.looked, 0, 'a confirmed chapter is not investigated again');
});

test('a copy that did not answer is not a proof', { skip }, async () => {
  // Reintroduce by treating a throw as an answer (dropping `silent = true` when ask() returns null):
  // "nothing was proven" below finds the chapter confirmed on the strength of two sources that threw.
  const id = await shortBook(6);
  throwPages.add(cid(A, T.short, 6));
  throwPages.add(cid(B, T.short, 6));
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.left, 1);
  assert.equal(r.short.confirmed, 0);
  assert.equal((await book(id)).short_confirmed_at, null, 'nothing was proven, so nothing was claimed');
});

test('a page list that came back empty is a parse failure, not a two-page chapter', { skip }, async () => {
  // Reintroduce by counting an empty list as an answer (`return urls.length` in ask()): the assertion
  // below finds the chapter confirmed short on the strength of two sources that answered nothing at all.
  // This is how a moved domain reads from here -- the 404 page parses to zero images rather than throwing
  // -- and a confirmation is never looked at again.
  const id = await shortBook(12);
  pagesFor.set(cid(A, T.short, 12), 0);
  pagesFor.set(cid(B, T.short, 12), 0);
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.confirmed, 0);
  assert.equal(r.short.left, 1, 'left for tomorrow, when the site may be itself again');
  assert.equal((await book(id)).short_confirmed_at, null,
    'no site serves a zero-page chapter, so zero pages is the site not answering');
  assert.equal((await book(id)).pages, 2, 'and nothing was written over it');
});

test('two copies from one source never crowd another source out of the page counts', { skip }, async () => {
  // Reintroduce by slicing the copies of the listing row itself (`ranked.slice(0, REPAIR_SHORT_COPIES)`,
  // no group-by-source): rp-a's two scanlation groups take two of the three asks, rp-c is never asked,
  // and the assertions below find its twelve-page copy still unfetched and the chapter called short.
  const id = await shortBook(13);
  await follow(C);
  listsShort([C], 13);
  twoGroups.add(cid(A, T.short, 13)); // rp-a lists chapter 13 twice, as two groups
  pagesFor.set(cid(C, T.short, 13), 12);
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.replaced, 1, 'the third source had a longer copy, and it was asked');
  assert.equal((await book(id)).pages, 12);
  const asked = pageCalls.filter((c) => c.includes(`::${T.short}::13`));
  assert.deepEqual([...asked.slice(0, 3)].sort(), [cid(A, T.short, 13), cid(B, T.short, 13), cid(C, T.short, 13)],
    'one page list per SOURCE, the cap counts sources, and the re-upload was never a second ask');
  assert.equal(asked.length, 4, 'and the only call after the three page counts is the download of the one that won');
});

test('a followed source the cap left unasked is silence, not a proof', { skip }, async () => {
  // Reintroduce by starting the proof with `let silent = false` (dropping the `unasked` test): the
  // assertion below finds the chapter stamped "confirmed short at the source" although the fourth source
  // this series follows was never asked anything.
  const id = await shortBook(14);
  for (const src of [C, D]) await follow(src);
  listsShort([C, D], 14);
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.confirmed, 0);
  assert.equal(r.short.left, 1);
  assert.equal((await book(id)).short_confirmed_at, null,
    'a copy we chose not to ask has said nothing, and silence is never a proof');
  const asked = new Set(pageCalls.filter((c) => c.includes(`::${T.short}::14`)).map((c) => c.split('::')[0]));
  assert.equal(asked.size, 3, 'and the cap still holds: four followed sources, three page lists');
});

test('a source in a cooldown is silence, not an answer', { skip }, async () => {
  // Reintroduce by asking a source in a cooldown anyway (dropping the `blockedNow` test in ask()): the
  // last assertion sees the request go out, and a refusal would be the third strike on a source that is
  // already refusing us.
  const id = await shortBook(7);
  await blockSource(A);
  await blockSource(B);
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.confirmed, 0);
  assert.equal((await book(id)).short_confirmed_at, null, 'a source we did not dare ask has said nothing');
  assert.deepEqual(pageCalls.filter((c) => c.includes(`::${T.short}::7`)), [], 'and it was not asked');
});

test('when the followed sources have nothing longer, another site is searched, and its copy is the last one asked', { skip }, async () => {
  const id = await shortBook(8);
  pagesFor.set(cid(A, T.short, 8), 2);
  pagesFor.set(cid(B, T.short, 8), 2);
  setCatalog(C, T.short, range(1, 9));
  pagesFor.set(cid(C, T.short, 8), 12);
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.replaced, 1);
  assert.equal((await book(id)).pages, 12);
  const asked = pageCalls.filter((c) => c.endsWith(`::${T.short}::8`));
  assert.equal(asked[asked.length - 1], cid(C, T.short, 8), 'the hunted copy is asked after the followed ones, never before');
  const follow = (await audits('series.follow_source'))[0]?.detail;
  assert.equal(follow?.reason, 'short_chapter', 'the audit row says what the follow was for');
  assert.equal(follow?.source, C);
});

test('a copy that arrives with one page missing still replaces a two-page chapter, and the row says which page', { skip }, async () => {
  const id = await shortBook(9);
  pagesFor.set(cid(A, T.short, 9), 2);
  pagesFor.set(cid(B, T.short, 9), 10);
  missingPage.add(`${cid(B, T.short, 9)}/4`);
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.replaced, 1, 'nine real pages beat two');
  assert.deepEqual((await book(id)).missing_pages, [5], 'and the one placeholder is on the row, 1-based');
  assert.equal((await book(id)).pages, 10, 'the file is ten pages long, one of them a placeholder');
});

test('a chapter in the read library, and one under a name the downloader would never write, are never replaced', { skip }, async () => {
  // Reintroduce by dropping `b.root = $1` from the candidate query in stepShort: the assertion below finds
  // one candidate, and a re-fetch of it would land at a DIFFERENT (root, file) -- a second row for the same
  // chapter, with everybody's reading history left on the first.
  await seedBook('b_short_lib', SHORT, T.short, 10, { pages: 2, root: LIB_ROOT, src: A, mtime: 5000 });
  await seedBook('b_short_odd', SHORT, T.short, 11, { pages: 2, src: A, mtime: 5001, file: `${folderOf(T.short)}/Chapter 11 - Title.cbz` });
  const r = await runRepair(undefined, { only: ['short'], userId: null });
  assert.equal(r.short.looked, 0, 'neither file is ours to replace: a re-fetch could not even land on the same row');
});

test('while a short chapter is being asked about, the status names the step, the chapter and the phase', { skip }, async () => {
  // v0.49.0: one live object, written by the steps and read by the status route and the run's card.
  // Reintroduce by removing the `at('asking', ...)` call before each copy's page list in stepShort: the
  // phase below reads 'listing' (the series-level line), and "which source is it asking" is gone.
  const id = await shortBook(3);
  let reached!: () => void;
  const atGate = new Promise<void>((go) => { reached = go; });
  let open!: () => void;
  pageGate = { id: cid(A, T.short, 3), reached, open: new Promise<void>((go) => { open = go; }) };
  const running = runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  try {
    await atGate;
    const snap = repairLiveSnapshot();
    assert.equal(snap.kind, 'fix_short');
    assert.equal(snap.target.label, T.short, 'the target is named once, at the start');
    assert.equal(snap.step, 'short');
    assert.equal(snap.current?.bookId, id, 'the chapter it is on');
    assert.equal(snap.current?.phase, 'asking', 'and what it is doing with it');
    assert.equal(snap.current?.sourceId, A, 'asking whom: its own source first');
    assert.equal(snap.planned.short, 1, 'the step sized itself');
    assert.deepEqual(snap.budget, { left: 5, of: 5 }, 'no search spent yet');
    assert.deepEqual(snap.shortReserve, { left: 2, of: 2 }, "and the short step's share of them");
    // The card on Library -> Downloads reads the same assignments, so the two never disagree.
    const card = listRuns().find((c: any) => c.kind === 'repair');
    assert.equal(card.step, 'short');
    assert.deepEqual(card.current, { id: SHORT, title: T.short });
    assert.equal(card.label, T.short, 'the card says which series a one-row fix is about');
    assert.equal(card.downloads, undefined, 'a Fix may download, so it may turn the ring');
  } finally {
    open();
    pageGate = null;
    await running;
  }
  assert.equal(repairLiveSnapshot(), null, 'and it is gone when the run ends');
});

test('a scoped run that cannot download never turns the Library ring', { skip }, async () => {
  // Reintroduce by dropping `card.downloads = false` in runRepair: the card below says it may download, and
  // every "Reset the solver" pressed on Health turns the ring as if chapters were coming in.
  await runRepair(undefined, { only: ['solver'], userId: null });
  const card = listRuns().find((c: any) => c.kind === 'repair');
  assert.equal(card.downloads, false);
  assert.equal(card.label, undefined, 'an untargeted run has no one thing to name');
});

test('a Fix on a chapter whose folder is busy says so, and one on a chapter it will not touch says why', { skip }, async () => {
  // Reintroduce by reverting to the silent `continue` on a busy folder in stepShort: the run reads as one
  // that found nothing, which is what "Fix did nothing" looked like before v0.49.0.
  const id = await shortBook(4);
  pagesFor.set(cid(B, T.short, 4), 12);
  busyFolders.add(folderOf(T.short));
  try {
    const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
    assert.equal(r.short.looked, 0);
    assert.deepEqual(r.skips?.map((k: any) => [k.step, k.why, k.target?.bookId]), [['short', 'folder_busy', id]]);
  } finally {
    busyFolders.delete(folderOf(T.short));
  }
  // Saved with a placeholder page: the chapter sweep re-fetches those, and the short step leaves them alone.
  await q('UPDATE lib_books SET missing_pages = ARRAY[2] WHERE id = $1', [id]);
  const partial = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.deepEqual(partial.skips?.map((k: any) => [k.why, k.detail]), [['not_eligible', 'partial']]);
  assert.equal((await book(id)).pages, 2, 'and nothing was replaced');
});

test('a short chapter left unfixed records when and why, and Health says it', { skip }, async () => {
  // Reintroduce by dropping the short_result write in stepShort's "left" branch: the column stays null and
  // the Health row carries no outcome.
  const id = await shortBook(12);
  pagesFor.set(cid(A, T.short, 12), 2);
  throwPages.add(cid(B, T.short, 12));
  const t0 = Date.now();
  const r = await runRepair(undefined, { only: ['short'], bookId: id, userId: null });
  assert.equal(r.short.left, 1);
  const res = (await q('SELECT short_result FROM lib_books WHERE id = $1', [id]))[0].short_result;
  assert.equal(res?.why, 'source_silent', 'a copy did not answer, so nothing could be proven');
  assert.equal(res.asked, 2);
  assert.equal(res.answered, 1);
  assert.ok(Date.parse(res.at) >= t0 - 1000, 'and it says when');
  const item = (await runHealthChecks()).checks.find((c: any) => c.id === 'short-chapters').items.find((i: any) => i.bookId === id);
  assert.equal(item.outcome?.kind, 'short');
  assert.equal(item.outcome?.why, 'source_silent', 'the page reads it back');
});

// ── (c) gaps ────────────────────────────────────────────────────────────────────────────────────────────

test('a source that brackets the hole is followed and the missing chapters are fetched, while one that cannot fill it is not', { skip }, async () => {
  // Reintroduce by following the first candidate that is this series (a `wants` of `() => true`): the
  // "nobody was followed" assertion for Repair Wants finds rp-c followed for a series it cannot help.
  const r = await runRepair(undefined, { only: ['gaps'], userId: null });
  assert.equal(r.gaps.series, 5, 'five series a night, and every one of them stamped');

  const gap = await series(GAP);
  assert.equal(gap.gaps_result.why, 'followed');
  assert.equal(gap.gaps_result.followed, B);
  assert.ok(gap.gaps_checked_at, 'stamped, and stamped before the search');
  assert.equal((await q('SELECT source_id FROM series_sources WHERE series_id = $1', [GAP]))[0]?.source_id, B);
  const got = (await q('SELECT number::float8 AS number FROM lib_books WHERE series_id = $1 AND number = ANY($2::real[])', [GAP, [11, 12, 13]]))
    .map((x: any) => Number(x.number)).sort((a: number, b: number) => a - b);
  assert.deepEqual(got, [11, 12, 13], 'the hole is filled from the source that brackets it');
  assert.deepEqual(await q('SELECT number FROM chapter_failures WHERE series_id = $1', [GAP]), [], 'and nothing failed');
  const follow = (await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1 ORDER BY at DESC LIMIT 1`, [GAP]))[0];
  assert.equal(follow?.detail?.reason, 'gap');
  assert.deepEqual(follow?.detail?.numbers, [11, 12, 13]);

  const nofill = await series(NOFILL);
  assert.equal(nofill.gaps_result.why, 'no_candidate', 'a source that lists three fifths of us is not this series');
  assert.equal(nofill.gaps_result.followed, null);
  assert.deepEqual(nofill.gaps_result.unfillable, ['11-13'], 'and the finding says so, in ranges');

  const wants = await series(WANTS);
  assert.equal(wants.gaps_result.why, 'no_candidate');
  assert.deepEqual(await q('SELECT source_id FROM series_sources WHERE series_id = $1', [WANTS]), [],
    'nobody was followed for a series whose only candidate holds nothing we are missing');
});

test('a gap a followed source already lists is the ordinary sweep\'s job, and costs no search at all', { skip }, async () => {
  await q('UPDATE lib_series SET gaps_checked_at = now() WHERE id = ANY($1) AND id <> $2', [MINE, LISTED]);
  const r = await runRepair(undefined, { only: ['gaps'], userId: null });
  assert.equal(r.gaps.series, 1);
  assert.equal(r.gaps.sweep, 1, 'chapter 11 is listed: the sweep will fetch it');
  assert.equal(r.gaps.followed, 0);
  assert.deepEqual(searches, [], 'not one source was asked anything');
  assert.equal((await series(LISTED)).gaps_result.why, 'listed');
});

test('at most five series a night, the emptiest first, and a series checked today is skipped until it is named', { skip }, async () => {
  const first = await runRepair(undefined, { only: ['gaps'], userId: null });
  assert.equal(first.gaps.series, 5, 'REPAIR_GAPS_MAX, whatever the library is holding');
  const checked = await q('SELECT id FROM lib_series WHERE gaps_checked_at IS NOT NULL AND id = ANY($1)', [MINE]);
  const ids = checked.map((x: any) => x.id);
  assert.ok(ids.includes(GAP) && ids.includes(NOFILL) && ids.includes(WANTS), 'the three-chapter holes came first');
  assert.equal(ids.includes(LISTED), false, 'and the one-chapter hole waited its turn');

  const second = await runRepair(undefined, { only: ['gaps'], userId: null });
  assert.equal(second.gaps.series, 1, 'only the one series nobody has checked today');

  const forced = await runRepair(undefined, { only: ['gaps'], seriesId: GAP, userId: null });
  assert.equal(forced.gaps.series, 1, 'naming a series is a person asking now, so the daily stamp does not apply');
});

test('a series the run has no search left for keeps its place in the queue instead of being stamped', { skip }, async () => {
  // Reintroduce by stamping gaps_checked_at before the budget is tested (moving that UPDATE back above
  // the listed/capped/unlisted split, or dropping the break): the last two assertions find a series
  // stamped "checked today" and stored with why 'cooldown' -- which the Health page renders as "searched
  // too recently to search again" about a series nothing ever searched -- and skipped until tomorrow.
  //
  // The short step runs first and hunts for its own chapter, so the run reaches the gap step with fewer
  // searches than it has series to spend them on: that is the whole shape of the bug.
  await shortBook(3);
  for (const [i, id] of SPARES.entries()) await seedListing(id, A, `Repair Spare ${i + 1}`, [1, 2, 3, 4, 7]);

  const r = await runRepair(undefined, { only: ['short', 'gaps'], userId: null });
  assert.equal(r.gaps.series, 4, 'four series had a search, the fifth had none, and the step stopped there');
  const unstamped = await q('SELECT id FROM lib_series WHERE id = ANY($1) AND gaps_checked_at IS NULL', [SPARES]);
  assert.equal(unstamped.length, 1, 'the one it could not search is still unchecked, so tomorrow starts with it');
  const stored = await q(`SELECT gaps_result->>'why' AS why FROM lib_series WHERE id = ANY($1) AND gaps_result IS NOT NULL`, [MINE]);
  assert.deepEqual(stored.filter((x: any) => x.why === 'cooldown'), [],
    'and nothing claims it was "searched too recently" on the strength of a search that never ran');
});

test('Fill now fetches a gap a followed source already lists, even with updates paused', { skip }, async () => {
  // Reintroduce by putting `s.auto_update AND` back for a named series (nothing is looked at), or by dropping
  // `opts.seriesId && sweepable.length` from the fetch (nothing is fetched and the row ends "listed").
  await q('UPDATE lib_series SET auto_update = false WHERE id = $1', [LISTED]);
  setCatalog(A, T.listed, range(1, 20)); // the followed source lists 11, which the library lacks
  try {
    const r = await runRepair(undefined, { only: ['gaps'], seriesId: LISTED, userId: null });
    assert.equal(r.gaps.series, 1, 'a paused series is still looked at when a person names it');
    assert.equal(r.gaps.fetched, 1, 'and its listed gap is fetched now, not left to a sweep that never comes');
    assert.deepEqual(searches, [], 'from the source it follows: no search');
    assert.equal(r.gaps.sweep, 0, 'nothing is left for the sweep');
    const got = await q('SELECT id FROM lib_books WHERE series_id = $1 AND number = 11 AND pruned_at IS NULL', [LISTED]);
    assert.equal(got.length, 1, 'chapter 11 is on the shelf');
    const g = (await series(LISTED)).gaps_result;
    assert.equal(g.fetched, 1);
    assert.equal(g.sweep, 0);
    // The nightly is unchanged: it still skips a paused series and still leaves a listed gap to the sweep.
    const item = (await runHealthChecks()).checks.find((c: any) => c.id === 'chapter-gaps').items.find((i: any) => i.seriesId === LISTED);
    assert.equal(item, undefined, 'the hole is closed');
  } finally {
    await q('UPDATE lib_series SET auto_update = true WHERE id = $1', [LISTED]);
    await q('DELETE FROM lib_books WHERE series_id = $1 AND number = 11', [LISTED]);
    rmSync(join(DL, folderOf(T.listed), 'Chapter 11.cbz'), { force: true });
  }
});

test('Fill now on a series with nothing to fill, or one that is gone, says so', { skip }, async () => {
  const NOGAP = 's_rep_nogap';
  await seedSeries(NOGAP, 'Repair No Gap');
  try {
    for (const n of [1, 2, 3]) await seedBook(`b_nogap_${n}`, NOGAP, 'Repair No Gap', n);
    const none = await runRepair(undefined, { only: ['gaps'], seriesId: NOGAP, userId: null });
    assert.deepEqual(none.skips?.map((k: any) => k.why), ['no_gaps'], 'the hole closed since the page loaded');
    const gone = await runRepair(undefined, { only: ['gaps'], seriesId: 's_rep_no_such', userId: null });
    assert.deepEqual(gone.skips?.map((k: any) => [k.why, k.detail]), [['not_eligible', 'gone']]);
  } finally {
    await q('DELETE FROM lib_books WHERE series_id = $1', [NOGAP]);
    await q('DELETE FROM lib_series WHERE id = $1', [NOGAP]);
  }
});

// ── (d) download failures ───────────────────────────────────────────────────────────────────────────────

const ledger = (seriesId: string, number: number, attempts: number, ageDays: number, source = A) =>
  q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at)
     VALUES ($1,$2,$3,'rate_limited','429',$4, now() - ($5 || ' days')::interval)`, [seriesId, number, source, attempts, String(ageDays)]);

test('a chapter parked at the retry cap a week ago gets another chance; a fresh one and an uncapped one do not', { skip }, async () => {
  await ledger(FAIL, 1, 3, 9);
  await ledger(FAIL, 2, 3, 1);
  await ledger(FAIL, 3, 1, 30);
  const r = await runRepair(undefined, { only: ['failures'], userId: null });
  assert.equal(r.failures.reset, 1, 'only the one that is both capped and old');
  assert.equal(r.failures.retried, undefined, 'the nightly resets and lets the sweep decide when to try');
  const rows = await q('SELECT number::float8 AS number, attempts FROM chapter_failures WHERE series_id = $1 ORDER BY number', [FAIL]);
  assert.deepEqual(rows.map((x: any) => [Number(x.number), x.attempts]), [[1, 0], [2, 3], [3, 1]]);
});

test('naming a source resets its ledger whatever the age and re-checks the series behind it', { skip }, async () => {
  await ledger(FAIL, 1, 3, 0);
  await ledger(FAIL, 2, 1, 0);
  const r = await runRepair(undefined, { only: ['failures'], sourceId: A, userId: null });
  assert.equal(r.failures.reset, 2, 'a person asking about this source means all of it, not the week-old part');
  assert.equal(r.failures.retried?.series, 1);
  assert.ok(searches.length === 0, 'a re-check is the ordinary sweep for that series, not a search');
});

test('a source in a cooldown has its ledger reset but nothing is re-checked behind it, and the run says why', { skip }, async () => {
  // Reintroduce by deleting the skip() beside the cooldown's early return in stepFailures: `skips` is empty
  // and "Retry now" on a cooling source reads as a retry that found nothing.
  await ledger(FAIL, 1, 3, 0);
  await blockSource(A);
  const r = await runRepair(undefined, { only: ['failures'], sourceId: A, userId: null });
  assert.equal(r.failures.reset, 1);
  assert.equal(r.failures.retried, undefined, 'asking a source that is refusing us would just be a second refusal');
  assert.equal(r.skips?.length, 1);
  assert.equal(r.skips[0].why, 'source_cooling_down');
  assert.equal(r.skips[0].target?.sourceId, A);
  assert.ok(Date.parse(r.skips[0].until) > Date.now(), 'with when the cooldown ends');
});

test('Retry now keeps when the chapter first failed', { skip }, async () => {
  // Rows as v0.48.4 wrote them: no first_at, and `at` the latest attempt. Chapter 40 and 41: no source lists
  // them, so the re-check behind the reset cannot land them (a landed chapter clears its own ledger row).
  // Reintroduce by removing `first_at = COALESCE(...)` from the ledger's ON CONFLICT in lib/chapterFailures.ts
  // (chapter 40's first_at stays null), or from the reset UPDATE in stepFailures (chapter 41's does, and its
  // "since" becomes the moment of the reset).
  const { noteChapterFailure } = await import('../src/lib/chapterFailures');
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at)
           VALUES ($1, 40, $2, 'error', '429', 1, now() - interval '9 days'),
                  ($1, 41, $2, 'error', '429', 1, now() - interval '9 days')`, [FAIL, A]);
  const nineDays = (await q(`SELECT at FROM chapter_failures WHERE series_id = $1 AND number = 41`, [FAIL]))[0].at;
  const iso = (d: any) => (d ? new Date(d).toISOString() : null);
  const row = async (n: number) => (await q('SELECT first_at, at, attempts FROM chapter_failures WHERE series_id = $1 AND number = $2', [FAIL, n]))[0];

  await noteChapterFailure({ seriesId: FAIL, title: T.fail, number: 40, sourceId: A, err: new Error('429') });
  const again = await row(40);
  assert.equal(again.attempts, 2);
  assert.equal(iso(again.first_at), iso(nineDays), 'a later failure keeps the first one, even on a row older than the column');

  await runRepair(undefined, { only: ['failures'], sourceId: A, userId: null });
  const reset = await row(41);
  assert.equal(reset.attempts, 0, 'reset');
  assert.equal(iso(reset.first_at), iso(nineDays), 'the reset keeps when it first failed');
  assert.ok(new Date(reset.at).getTime() > Date.now() - 60_000, 'while `at` is the reset itself');

  const item = (await runHealthChecks()).checks.find((c: any) => c.id === 'chapter-failures').items.find((i: any) => i.sourceId === A);
  assert.equal(item.outcome?.firstAt, iso(nineDays), 'Health reads "since" from the first failure');
  assert.match(item.detail, new RegExp(`since ${iso(nineDays)!.slice(0, 10)}`));
  assert.equal(item.outcome?.resetPending, true, 'and knows the reset is waiting for a try');
});

test("Fix all issues tries every source's failures now, never hunting, and never for a source that is switched off", { skip }, async () => {
  // The Health page's page-wide Fix all (v0.48.3) sends `now`. Reintroduce by re-checking every series whose
  // rows were reset: the one failing on a switched-off source is asked for its listing anyway.
  const { setDisabled } = await import('../src/lib/sourceHealth');
  await ledger(FAIL, 1, 3, 0);       // capped today: the nightly would wait a week for this one
  await ledger(FAIL, 2, 1, 0);       // not capped: reset all the same, as one source's Retry now does
  await ledger(LISTED, 11, 3, 0, B); // failing on a source that is switched off
  await setDisabled(B, true);
  try {
    const r = await runRepair(undefined, { only: ['failures'], now: true, userId: null });
    assert.equal(r.failures.reset, 3, 'every row of every source, whatever its age');
    assert.equal(r.failures.retried?.series, 1, 'a series was re-checked on behalf of a source that is switched off');
    assert.deepEqual(searches, [], 'Fix all spent the search budget the gaps step needs');
    assert.equal((await audits('library.repair'))[0]?.detail?.now, true, 'the audit does not say it was everything, now');
  } finally {
    await setDisabled(B, false);
  }
});

// ── (e) the solver ──────────────────────────────────────────────────────────────────────────────────────

test('when the solver answers and sources blame it, what this process remembers about it is cleared with their cooldowns', { skip }, async () => {
  await q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until, last_error, updated_at)
           VALUES ($1,'blocked',3, now() + interval '1 hour', 'FlareSolverr timeout after 90000ms', now())`, [BLAMER]);
  const r = await runRepair(undefined, { only: ['solver'], userId: null });
  assert.equal(r.solver.reset, true);
  assert.equal(r.solver.unblocked, 1);
  const h = (await q('SELECT status, blocked_until, consecutive FROM source_health WHERE source_id = $1', [BLAMER]))[0];
  assert.equal(h.status, 'ok');
  assert.equal(h.blocked_until, null, 'the cooldown its failure earned goes with the state that caused it');
});

test('nothing is cleared while the solver itself is not answering', { skip }, async () => {
  // Reintroduce by resetting whenever sources blame the solver (dropping `ping.ok` from the test): the
  // assertion below finds the cooldown cleared and every source sent straight back at a site it cannot reach.
  solverReady = false;
  await q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until, last_error, updated_at)
           VALUES ($1,'blocked',3, now() + interval '1 hour', 'FlareSolverr returned 500', now())`, [BLAMER]);
  const r = await runRepair(undefined, { only: ['solver'], userId: null });
  assert.equal(r.solver.reset, false);
  assert.equal(r.solver.unblocked, 0);
  assert.ok((await q('SELECT blocked_until FROM source_health WHERE source_id = $1', [BLAMER]))[0].blocked_until,
    'the cooldown stands: the solve that would re-earn the cookies cannot happen');
});

test('a cooldown that lapsed more than a day ago loses its escalation memory; one that lapsed an hour ago keeps it', { skip }, async () => {
  // Reintroduce by widening the window to `blocked_until < now()`: the second assertion finds the source
  // that refused us an hour ago starting its next cooldown at fifteen minutes instead of seventy-five.
  //
  // #115: the reset erases ESCALATION memory and nothing else. A failed Test's evidence on A must survive it, and
  // survive Clear block too, or Health goes back to "All good" overnight while the source still fails its search.
  // Reintroduce by adding `stages = '{}'` or `live_state = NULL` to the lapsed UPDATE (repair.ts stepSolver) or to
  // clearBlock: the evidence assertions fail.
  const stages = { search: { failAt: new Date(Date.now() - 3600_000).toISOString(), failBy: 'test', kind: 'error', error: 'suwayomi: boom' } };
  await q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until, updated_at, stages, live_state, live_stage, live_at, live_by)
           VALUES ($1,'blocked',5, now() - interval '2 days', now(), $3::jsonb, 'fail', 'search', now() - interval '1 hour', 'test'),
                  ($2,'blocked',5, now() - interval '1 hour', now(), '{}'::jsonb, NULL, NULL, NULL, NULL)`, [A, B, JSON.stringify(stages)]);
  const r = await runRepair(undefined, { only: ['solver'], userId: null });
  assert.equal(r.solver.expired, 1);
  const rows = await q('SELECT source_id, status, consecutive FROM source_health WHERE source_id = ANY($1) ORDER BY source_id', [[A, B]]);
  assert.deepEqual(rows.map((x: any) => [x.source_id, x.status, x.consecutive]), [[A, 'ok', 0], [B, 'blocked', 5]]);
  const evidence = async () => (await q('SELECT stages, live_state, live_stage FROM source_health WHERE source_id = $1', [A]))[0];
  let a = await evidence();
  assert.deepEqual(a.stages, stages, 'the lapsed reset leaves the evidence alone');
  assert.equal(a.live_state, 'fail');
  const { clearBlock } = await import('../src/lib/sourceHealth');
  await clearBlock(A);
  a = await evidence();
  assert.deepEqual(a.stages, stages, 'so does Clear block');
  assert.equal(a.live_stage, 'search');
  // And Health still lists it: A is a registered source here, so its evidence counts.
  const { runHealthChecks } = await import('../src/lib/health');
  const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources')!;
  const it = c.items.find((i: any) => i.sourceId === A);
  assert.ok(it && !it.info, `still a finding after both erasers (${c.summary})`);
  assert.match(it.detail, /^Search failing since/);
});

// ── the run itself ──────────────────────────────────────────────────────────────────────────────────────

test('one repair at a time, never beside a sweep, and a scoped run is kept in the history, not on the Tasks line', { skip }, async () => {
  // Reintroduce by making isFullRun answer true for every run (the pre-v0.49.0 unconditional write): the
  // "untouched" assertions below find a one-step run's result on the Tasks line and the nightly moved.
  await q(`UPDATE server_settings SET repair_last_run = '2026-01-02T03:04:05Z', repair_last_result = '{"ok":true,"counted":7}'::jsonb WHERE id = 1`);
  const running = runRepair(undefined, { only: ['solver'], userId: null });
  assert.equal(runRepair(undefined, { only: ['solver'], userId: null }), false, 'a second run is refused, synchronously');
  const r = await running;
  assert.equal(repairState.running, false);
  assert.match(String(r.run), /^[0-9a-f-]{36}$/, 'the run has an id');
  const rec = (await q('SELECT kind, status, origin, ms, result, finished_at FROM repair_runs WHERE id = $1', [r.run]))[0];
  assert.equal(rec?.kind, 'steps:solver');
  assert.equal(rec.status, 'done');
  assert.equal(rec.origin, 'manual', 'a run somebody asked for, even with no account behind it');
  assert.equal(rec.result.ms, r.ms, 'kept, so the Health page still has it after a restart');
  assert.ok(rec.finished_at);
  assert.deepEqual(repairState.last, { id: r.run, finishedAt: repairState.last.finishedAt, status: 'done', kind: 'steps:solver' });
  const row = (await q('SELECT repair_last_run, repair_last_result FROM server_settings WHERE id = 1'))[0];
  assert.equal(row.repair_last_result.counted, 7, "a scoped run leaves the full run's result on the Tasks line");
  assert.equal(new Date(row.repair_last_run).toISOString(), '2026-01-02T03:04:05.000Z', "and the nightly's schedule where it was");

  runtime.updating = true;
  try {
    assert.equal(runRepair(undefined, { only: ['solver'], userId: null }), false, 'and refused outright while a sweep is downloading');
  } finally {
    runtime.updating = false;
  }
});

test('a shutdown between two chapters ends the run, and the reason is what gets persisted', { skip }, async () => {
  const id = await shortBook(3);
  pagesFor.set(cid(B, T.short, 3), 12);
  runtime.stopping = true;
  try {
    const r = await runRepair(undefined, { only: ['short', 'gaps'], userId: null });
    assert.equal(r.stopped, 'shutdown');
    assert.equal(r.short.looked, 0, 'nothing was started that could not be finished');
    const rec = (await q('SELECT status, result FROM repair_runs WHERE id = $1', [r.run]))[0];
    assert.equal(rec.status, 'stopped');
    assert.equal(rec.result.stopped, 'shutdown', 'the reason is what the history keeps');
  } finally {
    runtime.stopping = false;
  }
  assert.equal((await book(id)).pages, 2);
});

test('the nightly switch stops the scheduled run and not a person pressing the button', { skip }, async () => {
  await q('UPDATE server_settings SET repair_enabled = false WHERE id = 1');
  const nightly = await runRepair(undefined, { only: ['solver'] });
  assert.equal(nightly.skipped, 'disabled');
  const asked = await runRepair(undefined, { only: ['solver'], userId: null });
  assert.equal(asked.skipped, undefined, 'nothing this job does is destructive, so a deliberate press runs');
});

test('a full run is the Tasks line, and it survives a restart', { skip }, async () => {
  // A full nightly the switch turned away: the one full run this file can make without asking MangaDex and
  // AniList for reading directions. Reintroduce by dropping the UPDATE of repair_last_run/repair_last_result
  // in runRepair: the persisted assertion finds the row still holding the planted result, and a restart
  // would report the job as never run.
  await q(`UPDATE server_settings SET repair_enabled = false, repair_last_run = NULL, repair_last_result = '{"ok":true,"counted":7}'::jsonb WHERE id = 1`);
  const r = await runRepair(undefined);
  assert.equal(r.skipped, 'disabled');
  const row = (await q('SELECT repair_last_run, repair_last_result FROM server_settings WHERE id = 1'))[0];
  assert.ok(row.repair_last_run, 'a full run moves the Tasks line');
  assert.equal(row.repair_last_result.skipped, 'disabled', 'with its own result');
  assert.equal(repairState.lastResult?.run, r.run, 'in memory too');
  const rec = (await q('SELECT kind, status, origin FROM repair_runs WHERE id = $1', [r.run]))[0];
  assert.deepEqual([rec.kind, rec.status, rec.origin], ['full', 'skipped', 'nightly']);
});

test('a scan that finds the same file leaves a confirmed-short chapter confirmed, and one that finds new bytes does not', { skip }, async () => {
  // Reintroduce by dropping the CASE from persistScan's upsert in lib/library.ts (always NULL): the first
  // assertion finds the confirmation gone, and the whole library un-confirms itself on the next scan.
  const id = await shortBook(3);
  // The seeded row carries a made-up mtime; one scan makes it the file's, so the next one is comparing
  // the same file against itself rather than against the fixture.
  await persistScan();
  await q('UPDATE lib_books SET short_confirmed_at = now() WHERE id = $1', [id]);
  await persistScan();
  assert.ok((await book(id)).short_confirmed_at, 'the same file is the same chapter, and the proof was about it');
  const abs = join(DL, folderOf(T.short), 'Chapter 3.cbz');
  cbz(abs, 6);
  utimesSync(abs, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  await persistScan();
  assert.equal((await book(id)).short_confirmed_at, null, 'different bytes were never proven to be anything');
});

test('the history deletes nothing but its own old rows', { skip }, () => {
  // lib/repairRuns.ts holds the one DELETE the repair's bookkeeping needs (the prune), which is why it is not
  // in repair.ts. Reintroduce by deleting from any other table there: this names the statement.
  const src = read(join(__dirname, '..', 'src', 'lib', 'repairRuns.ts'), 'utf8');
  const deletes = [...src.matchAll(/\bDELETE\s+FROM\s+(\w+)/gi)].map((m) => m[1]);
  assert.ok(deletes.length >= 1, 'the prune is there');
  assert.deepEqual([...new Set(deletes)], ['repair_runs'], `lib/repairRuns.ts deletes from ${deletes.join(', ')}`);
  for (const pattern of [/\brm\(/, /unlink/, /rename\(/, /mergeSeries/, /tombstoneBooks/, /pruned_at\s*=/, /book_overrides/]) {
    assert.equal(pattern.test(src), false, `lib/repairRuns.ts matches ${pattern}`);
  }
});

test('old runs are pruned, but never below fifty and never inside ninety days', { skip }, async () => {
  // Reintroduce by pruning on age alone: a quiet install loses its whole history after three months.
  const { pruneRuns, HISTORY_KEEP } = await import('../src/lib/repairRuns');
  await q('DELETE FROM repair_runs');
  for (let i = 0; i < HISTORY_KEEP + 2; i++) {
    await q(`INSERT INTO repair_runs (id, started_at, origin, kind, status) VALUES (gen_random_uuid(), now() - ($1 || ' days')::interval, 'nightly', 'full', 'done')`,
      [String(100 + i)]);
  }
  await q(`INSERT INTO repair_runs (id, started_at, origin, kind, status) VALUES (gen_random_uuid(), now() - interval '1 day', 'manual', 'fill', 'done')`);
  await pruneRuns();
  const left = await q('SELECT kind, started_at FROM repair_runs ORDER BY started_at DESC');
  assert.equal(left.length, HISTORY_KEEP, 'the newest fifty stay, however old; the three oldest go');
  assert.equal(left[0].kind, 'fill', 'and a young row is never one of them');
  await q('DELETE FROM repair_runs');
});

test('the nightly cannot delete, merge or renumber anything', { skip }, () => {
  // Reintroduce by having repair.ts call any one of these: this test names the call and the file.
  const src = read(join(__dirname, '..', 'src', 'lib', 'repair.ts'), 'utf8');
  // Every table, not only lib_books: a DELETE against read_progress or bookmarks takes away the one thing
  // this job promises never to touch, and `book_overrides` is how a renumber is written.
  const bad = [
    /\brm\(/, /unlink/, /rename\(/, /\bDELETE\s+FROM\b/i, /mergeSeries/, /tombstoneBooks/,
    /merged_into/, /pruned_at\s*=/, /pruned_reason/, /book_overrides/,
  ];
  for (const pattern of bad) {
    assert.equal(pattern.test(src), false,
      `lib/repair.ts matches ${pattern}. The nightly is allowed to be reversible or provable and nothing `
      + 'else: removing a file, deleting any row at all (a reader\'s progress and bookmarks least of all), '
      + 'writing a tombstone, merging two series and renumbering a chapter stay one-click actions an admin '
      + 'confirms, because they are the ones this project cannot undo.');
  }
});
