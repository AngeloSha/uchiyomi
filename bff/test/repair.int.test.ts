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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
/** The stub solver's port. Fixed rather than ephemeral because FLARESOLVERR_URL is read at module load. */
const SOLVER_PORT = 18291;
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
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${SOLVER_PORT}`;
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
  const { migrate } = await import('../src/lib/migrate');
  ({ q, pool } = (await import('../src/lib/db')) as any);
  const sources = await import('../src/lib/sources');
  await migrate();
  resetCatalog();
  for (const id of SOURCES) sources.registerAdapter(adapter(id) as any);
  ({ runRepair, repairState } = (await import('../src/lib/repair')) as any);
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

  solver = createServer((_req, res) => {
    if (!solverReady) { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ msg: 'FlareSolverr is ready', version: '3.3.21' }));
  });
  await new Promise<void>((go) => solver!.listen(SOLVER_PORT, '127.0.0.1', go));
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

test('a source in a cooldown has its ledger reset but nothing is re-checked behind it', { skip }, async () => {
  await ledger(FAIL, 1, 3, 0);
  await blockSource(A);
  const r = await runRepair(undefined, { only: ['failures'], sourceId: A, userId: null });
  assert.equal(r.failures.reset, 1);
  assert.equal(r.failures.retried, undefined, 'asking a source that is refusing us would just be a second refusal');
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
  await q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until, updated_at)
           VALUES ($1,'blocked',5, now() - interval '2 days', now()), ($2,'blocked',5, now() - interval '1 hour', now())`, [A, B]);
  const r = await runRepair(undefined, { only: ['solver'], userId: null });
  assert.equal(r.solver.expired, 1);
  const rows = await q('SELECT source_id, status, consecutive FROM source_health WHERE source_id = ANY($1) ORDER BY source_id', [[A, B]]);
  assert.deepEqual(rows.map((x: any) => [x.source_id, x.status, x.consecutive]), [[A, 'ok', 0], [B, 'blocked', 5]]);
});

// ── the run itself ──────────────────────────────────────────────────────────────────────────────────────

test('one repair at a time, never beside a sweep, and the last result survives a restart', { skip }, async () => {
  // Reintroduce by dropping the UPDATE of repair_last_run/repair_last_result in runRepair: the persisted
  // assertion below finds the row empty and a restart would report the job as never run.
  const running = runRepair(undefined, { only: ['solver'], userId: null });
  assert.equal(runRepair(undefined, { only: ['solver'], userId: null }), false, 'a second run is refused, synchronously');
  const r = await running;
  assert.equal(repairState.running, false);
  const row = (await q('SELECT repair_last_run, repair_last_result FROM server_settings WHERE id = 1'))[0];
  assert.ok(row.repair_last_run);
  assert.equal(row.repair_last_result.ms, r.ms, 'persisted, so the Tasks panel still has it after a restart');

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
    assert.equal((await q('SELECT repair_last_result FROM server_settings WHERE id = 1'))[0].repair_last_result.stopped, 'shutdown');
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
