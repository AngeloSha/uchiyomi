// Chapter-level actions, driven through the real routes: fetching a ghost chapter, deleting a chapter's
// file from the server, and fetching one again.
//
// Three things here can lose data, and each is pinned against a real file on a real scratch disk: a fetch
// that trusted the body could pull any number from anywhere (the fill plan's hazard, now for ghosts); a
// delete that forgot which root it was in would remove a file from somebody's read library; and a refetch
// that dropped the old copy before the new one landed would turn a failed download into a missing chapter.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '', LIB_ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-act-'));
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
  process.env.MIN_FREE_GB = '0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '300';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const LIB = 'lib_act', OTHER_LIB = 'lib_act_x';
const S = 's_act_series', FOLDER = 'T!act/Act Series';
const OTHER = 's_act_other', OTHER_FOLDER = 'T!act/Other Series';
const SRC = 'act-src', FOL = 'act-fol';
const ADMIN = 'act-admin', MEMBER = 'act-member', NODL = 'act-nodl', CAPPED = 'act-capped';
const B = { one: 'b_act_1', two: 'b_act_2', three: 'b_act_3', lib: 'b_act_lib', odd: 'b_act_odd', other: 'b_act_other' };
let q: any, app: any, updateSeries: any, CHAPTER_RETRY_CAP: number;
let adminTok: string, memberTok: string, nodlTok: string, cappedTok: string, adminId: string;
let savedGlobal: any;
/** Every chapter id the source was asked pages for: which copy each action actually downloaded. */
const pageCalls: string[] = [];
/** Chapter ids whose page list throws (a download that fails), and ones that answer slowly (a job that is still running). */
const failPages = new Set<string>();
const slowPages = new Set<string>();
/** Chapter ids whose IMAGES the site refuses with a 403: the source itself saying no, which ends the job. */
const blockImages = new Set<string>();
/** While true the primary's chapter list throws: a source that does not answer, so no listing is refreshed. */
let listThrows = false;

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  if (String(u).includes('example.invalid')) {
    if ([...blockImages].some((id) => String(u).includes(`/${encodeURIComponent(id)}/`))) return new Response('go away', { status: 403 });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  return realFetch(u, init);
}) as typeof fetch;

const ch = (n: number, group: string, extra: Record<string, unknown> = {}) =>
  ({ sourceId: `c/${n}/${group}`, number: n, title: `Chapter ${n}`, scanlator: group, ...extra });

/**
 * 1, 2, 3 are on disk (2 also listed by Group B); 4 is fresh from Group A only, so it is held under a
 * priority for B; 5 only a blocked group released; 6 downloads slowly; 7 is a plain ghost; 8 fails; 9 is
 * in the read library; 10 is an owned file under a name the downloader would never write.
 */
const adapter = {
  id: SRC, name: 'Act Source',
  async search() { return []; },
  async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: 'Act Series' }; },
  async listChapters() {
    if (listThrows) throw new Error('site refused');
    return [
      ch(1, 'Group A'), ch(2, 'Group A'), ch(2, 'Group B'), ch(3, 'Group A'),
      ch(4, 'Group A', { publishedAt: new Date().toISOString() }),
      ch(5, 'Spam Group'), ch(6, 'Group A'), ch(7, 'Group A'), ch(8, 'Group A'), ch(9, 'Group A'), ch(10, 'Group A'),
    ];
  },
  async getPageUrls(id: string) {
    pageCalls.push(id);
    if (failPages.has(id)) throw new Error('pages gone');
    if (slowPages.has(id)) await new Promise((r) => setTimeout(r, 1500));
    return [`https://example.invalid/${encodeURIComponent(id)}/p1.png`];
  },
  async latest() { return []; },
};

/** A second site the series can follow; it alone lists chapter 20. */
const follower = {
  id: FOL, name: 'Act Follower',
  async search() { return []; },
  async getSeries(sid: string) { return { sourceId: sid, source: FOL, title: 'Act Series' }; },
  async listChapters() { return [ch(20, 'Group A')]; },
  async getPageUrls(id: string) { pageCalls.push(id); return [`https://example.invalid/${encodeURIComponent(id)}/p1.png`]; },
  async latest() { return []; },
};

/** A real one-page archive with a ComicInfo naming its group, as the downloader would have written it. */
function cbz(abs: string, group: string) {
  const z = new AdmZip();
  z.addFile('001.png', PIXEL);
  z.addFile('ComicInfo.xml', Buffer.from(`<?xml version="1.0"?><ComicInfo><Series>Act Series</Series><Translator>${group}</Translator></ComicInfo>`));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, z.toBuffer());
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries, CHAPTER_RETRY_CAP } = (await import('../src/lib/updater')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  await migrate();
  registerAdapter(adapter as any);
  registerAdapter(follower as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, FOL]]);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Act',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Act X',$1) ON CONFLICT (id) DO NOTHING`, [OTHER_LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, OTHER]]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!act','Act Series',$2,5,$3,$4,'act-1',true)`, [S, FOLDER, LIB, SRC]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!act','Other Series',$2,1,$3)`, [OTHER, OTHER_FOLDER, LIB]);

  // Rows written the way persistScan writes them (file relative to its root, root absolute), so the scans
  // the jobs run keep these ids -- which is the whole point of the refetch test.
  const book = (id: string, series: string, n: number, file: string, root: string, group: string | null) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, scanlator, source_id)
        VALUES ($1,$2,'T!act',$3,$4,$5,1,$6,$7,$8)`, [id, series, file, n, `Chapter ${n}`, root, group, group ? SRC : null]);
  for (const [id, n] of [[B.one, 1], [B.two, 2], [B.three, 3]] as const) {
    cbz(join(DL, FOLDER, `Chapter ${n}.cbz`), 'Group A');
    await book(id, S, n, `${FOLDER}/Chapter ${n}.cbz`, DL, 'Group A');
  }
  cbz(join(LIB_ROOT, FOLDER, 'Chapter 9.cbz'), 'Group A');
  await book(B.lib, S, 9, `${FOLDER}/Chapter 9.cbz`, LIB_ROOT, null);
  await book(B.odd, S, 10, `${FOLDER}/Chapter 10 - Title.cbz`, DL, 'Group A');
  await book(B.other, OTHER, 50, `${OTHER_FOLDER}/Chapter 50.cbz`, DL, null);
  await q('UPDATE lib_books SET page_dims = $2::jsonb WHERE id = $1', [B.two, JSON.stringify([{ w: 300, h: 400 }])]);
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, B.one]);
  // The other series has a listing of its own, so a number from it is listed SOMEWHERE.
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status) VALUES ($1, 50, $2, $3::jsonb, 'available')`,
    [OTHER, SRC, JSON.stringify(ch(50, 'Group A'))]);

  savedGlobal = (await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0]?.scanlator_prefs;
  await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":["Group B"],"blocked":["Spam Group"],"patienceDays":2}'::jsonb WHERE id = 1`);

  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, NODL, CAPPED]]);
  const mk = async (name: string, role: string, perms: any = null) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms) VALUES ($1,$1,'x',$2,'password',$3::jsonb) RETURNING id`,
      [name, role, JSON.stringify(perms ?? {})]))[0].id;
  adminId = await mk(ADMIN, 'admin');
  const memberId = await mk(MEMBER, 'user');
  const nodlId = await mk(NODL, 'user', { canDownload: false });
  // May download, but is granted only the OTHER library: walled off from the series under test.
  const cappedId = await mk(CAPPED, 'user');
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [cappedId, OTHER_LIB]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, $2, $3, 1, true), ($1, $4, $3, 0, false)`, [adminId, B.one, S, B.two]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
  memberTok = `Bearer ${app.jwt.sign({ sub: memberId, role: 'user' })}`;
  nodlTok = `Bearer ${app.jwt.sign({ sub: nodlId, role: 'user' })}`;
  cappedTok = `Bearer ${app.jwt.sign({ sub: cappedId, role: 'user' })}`;
});

// A cooldown is the one piece of state that leaks between tests in a way nothing here asserts on: a 403 in
// one test puts the fake source in a fifteen-minute cooldown, and the next test's 200 silently becomes a
// 409 `cooldown` with a message pointing nowhere near the cause. Cleared before every test, so a cascade
// starts where its cause is.
beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, FOL]]).catch(() => {});
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [[S, OTHER]]).catch(() => {});
  await q('DELETE FROM bookmarks WHERE series_id = ANY($1)', [[S, OTHER]]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [[S, OTHER]]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, OTHER]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, OTHER_LIB]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, NODL, CAPPED]]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[SRC, FOL]]).catch(() => {});
  if (savedGlobal !== undefined) await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(savedGlobal)]).catch(() => {});
});

const post = (url: string, payload: any, tok = adminTok) => app.inject({ method: 'POST', url, headers: { authorization: tok }, payload });
const fetchNums = (numbers: number[], tok = adminTok, seriesId = S) => post('/api/sources/fetch', { seriesId, numbers }, tok);
const del = (bookIds: string[], tok = adminTok, seriesId = S) => post(`/api/admin/series/${seriesId}/chapters/delete`, { bookIds }, tok);
const refetch = (bookIds: string[], tok = adminTok) => post(`/api/admin/series/${S}/chapters/refetch`, { bookIds }, tok);
const listing = (tok = adminTok) => app.inject({ method: 'GET', url: `/api/series/${S}/listing`, headers: { authorization: tok } });
/** The answer comes back before the work; poll the job strip rather than guess a duration. */
async function jobDone(folder = FOLDER): Promise<any> {
  let job: any = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: adminTok } })).json().content.find((x: any) => x.folder === folder);
    if (job && job.status !== 'downloading') return job;
  }
  return job;
}
const row = async (id: string) => (await q('SELECT id, number, file, pruned_at, scanlator, page_dims FROM lib_books WHERE id = $1', [id]))[0];
const files = () => readdirSync(join(DL, FOLDER)).sort();
const translator = (abs: string) => new AdmZip(abs).readAsText('ComicInfo.xml').match(/<Translator>([^<]*)<\/Translator>/)?.[1];

/**
 * Reintroduce by building `chapters` from the body in POST /api/sources/fetch -- `{ sourceId: 'c/' + n,
 * number: n, source: s.source_id }` per number, skipping the series_listing lookup: the first call below
 * answers 200 and starts a job for a number no source has been seen to list.
 */
test('a ghost is fetched only when the last listing had it', { skip }, async (t) => {
  await t.test('before any check, nothing is listed and nothing can be fetched', async () => {
    // The fetch refreshes the listing itself now, so the source is made to not answer: what is pinned is
    // that with no listing obtainable there is no authorisation, not that a check has to be run by hand.
    listThrows = true;
    try {
      const r = await fetchNums([7]);
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error, 'nothing_to_fetch');
      assert.deepEqual(r.json().skipped, [{ number: 7, reason: 'not_listed' }]);
      assert.match(r.json().message, /Check for new chapters/);
    } finally {
      listThrows = false;
    }
  });

  // maxNew 0: the listing is written before the download loop, and this file drives every download by hand.
  const sweep = await updateSeries(S, 0);
  assert.equal(sweep.outcome, 'ok', 'PREMISE: every later test in this file reads the listing this sweep writes; a failure here is the cause of everything after it');

  await t.test('after a check, the listed number is fetched from the copy the rules chose', async () => {
    const r = await fetchNums([7]);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual({ ok: r.json().ok, started: r.json().started, total: r.json().total, skipped: r.json().skipped },
      { ok: true, started: true, total: 1, skipped: [] });
    const job = await jobDone();
    assert.equal(job?.status, 'done', JSON.stringify(job));
    assert.ok(files().includes('Chapter 7.cbz'), `on disk: ${files()}`);
    const minted = await q('SELECT id, scanlator, source_id FROM lib_books WHERE series_id = $1 AND number = 7', [S]);
    assert.equal(minted.length, 1, 'the scan minted the row');
    assert.deepEqual({ scanlator: minted[0].scanlator, source_id: minted[0].source_id }, { scanlator: 'Group A', source_id: SRC }, 'stamped with what landed');
    assert.equal((await q('SELECT 1 FROM chapter_failures WHERE series_id = $1 AND number = 7', [S])).length, 0, 'nothing in the ledger');
  });

  await t.test('and a number now here is already_here, not fetched twice', async () => {
    const r = await fetchNums([7]);
    assert.equal(r.statusCode, 409);
    assert.deepEqual(r.json().skipped, [{ number: 7, reason: 'already_here' }]);
  });
});

test('a manual fetch ignores patience', { skip }, async () => {
  // Chapter 4 is fresh from Group A under a priority for Group B: the sweep holds it, and says so.
  const sweep = await updateSeries(S, 0);
  assert.equal(sweep.waiting, 1, 'PREMISE: the sweep is holding chapter 4');
  pageCalls.length = 0;
  const r = await fetchNums([4]);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().total, 1);
  const job = await jobDone();
  assert.equal(job?.status, 'done', JSON.stringify(job));
  assert.deepEqual(pageCalls, ['c/4/Group A'], 'the copy on offer today, Group A\'s, is what was fetched');
  assert.ok(files().includes('Chapter 4.cbz'));
});

/**
 * Reintroduce by deleting the `DELETE FROM chapter_failures` in POST /api/sources/fetch: the failure
 * below lands on top of the capped row, and "one attempt: the ledger started over" reads CAP + 1.
 */
test('a manual fetch resets the retry cap', { skip }, async () => {
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at)
           VALUES ($1, 8, $2, 'error', 'old', $3, now()) ON CONFLICT (series_id, number) DO UPDATE SET attempts = EXCLUDED.attempts`, [S, SRC, CHAPTER_RETRY_CAP]);
  failPages.add('c/8/Group A');
  try {
    const r = await fetchNums([8]);
    assert.equal(r.statusCode, 200, `a capped chapter is exactly what a manual fetch is for: ${r.body}`);
    const job = await jobDone();
    assert.equal(job?.status, 'error', JSON.stringify(job));
    const f = (await q('SELECT attempts FROM chapter_failures WHERE series_id = $1 AND number = 8', [S]))[0];
    assert.equal(Number(f?.attempts), 1, 'one attempt: the ledger started over');
  } finally {
    failPages.delete('c/8/Group A');
  }
});

test('a number only blocked groups released is refused', { skip }, async () => {
  // The blocklist is the one preference a manual fetch never overrides: there is no copy to fetch.
  const r = await fetchNums([5]);
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(r.json().skipped, [{ number: 5, reason: 'blocked_group' }]);
  assert.match(r.json().message, /Unblock/);
});

/**
 * The numbers are cast to `real[]` in the route's queries, and `finite()` alone let 1e308 through to
 * Postgres, which threw 22003 -- a 500 carrying the driver's message, for a client mistake. Reintroduce by
 * dropping `.min(0).max(1e6)` from the schema in POST /api/sources/fetch: the first call reads 500.
 */
test('a chapter number outside float range is a bad request, not a server error', { skip }, async () => {
  for (const n of [1e308, -1, 1e7]) {
    const r = await fetchNums([n]);
    assert.equal(r.statusCode, 400, `${n}: ${r.body}`);
    assert.equal(r.json().error, 'bad_request');
  }
});

/**
 * The gate is browsable() -- the per-library grant, the age cap, deleted/merged -- not a bare row lookup.
 * Reintroduce by replacing the browsable() lookup in POST /api/sources/fetch with a bare
 * `SELECT ... FROM lib_series WHERE id = $1` (as the fill route's getSeriesRow does): the capped member
 * fetches into, and learns the listed numbers of, a series they cannot see.
 */
test('a member walled off from the series gets 404, the same answer as for no series at all', { skip }, async () => {
  const walled = await fetchNums([7], cappedTok);
  assert.equal(walled.statusCode, 404, walled.body);
  const none = await fetchNums([7], adminTok, 's_act_nope');
  assert.equal(none.statusCode, 404);
  assert.equal(walled.body, none.body, 'the answer must not differ from "no such series"');
});

/**
 * Reintroduce by dropping the `r.root !== DL_ROOT` check in the delete route and resolving the path
 * against `r.root` (as the cleanup does for its own, already-filtered rows): the read library's file is
 * gone, its row is a tombstone, and nothing says not_owned.
 */
test('delete removes the file, keeps the row and the progress, skips the read library, moves the cover', { skip }, async (t) => {
  const libFile = join(LIB_ROOT, FOLDER, 'Chapter 9.cbz');
  // A set-aside copy from a refetch the process died in, beside the landed file: reapStaleTemp leaves that
  // pair alone, so only a delete can take it.
  writeFileSync(join(DL, FOLDER, 'Chapter 1.cbz.refetch-bak'), 'old one');
  // Chapter 3 has a bookmark in it: a page number inside a file that is about to go.
  await q('INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1, $2, $3, 0)', [adminId, B.three, S]);
  const r = await del([B.one, B.lib, 'b_act_nope', B.three]);
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();

  await t.test('one deleted, the others skipped by name', () => {
    assert.equal(j.applied, 1);
    assert.ok(j.bytes > 0, 'the bytes freed are reported');
    assert.deepEqual(j.skipped, [{ id: B.lib, reason: 'not_owned' }, { id: 'b_act_nope', reason: 'not_found' }, { id: B.three, reason: 'bookmarked' }]);
  });
  await t.test('the file is gone; the row and the reading progress are not', async () => {
    assert.ok(!existsSync(join(DL, FOLDER, 'Chapter 1.cbz')), 'the file is gone');
    const b = await row(B.one);
    assert.ok(b, 'the row survives');
    assert.ok(b.pruned_at, 'as a tombstone');
    assert.equal((await q('SELECT 1 FROM read_progress WHERE book_id = $1', [B.one])).length, 1, 'progress survives');
  });
  await t.test('a stray set-aside copy goes with the file', () => {
    // Reintroduce by dropping the `rm(abs + REFETCH_BAK)` in the delete route: the bak is still there, and
    // at the next boot reapStaleTemp puts it back as Chapter 1.cbz -- the chapter the admin deleted.
    assert.ok(!existsSync(join(DL, FOLDER, 'Chapter 1.cbz.refetch-bak')), 'the bak outlived the delete');
  });
  await t.test('a bookmarked chapter is skipped, and says so', async () => {
    // The same veto the cleanup applies: a bookmark points INTO the file. Reintroduce by dropping the
    // bookmarks lookup in the delete route: the file is gone and the bookmark points at nothing.
    assert.ok(existsSync(join(DL, FOLDER, 'Chapter 3.cbz')));
    assert.equal((await row(B.three)).pruned_at, null);
    await q('DELETE FROM bookmarks WHERE book_id = $1', [B.three]);
  });
  await t.test('the read library was not touched', async () => {
    assert.ok(existsSync(libFile), 'the read library\'s file is still there');
    assert.equal((await row(B.lib)).pruned_at, null);
  });
  await t.test('the cover moved to the lowest live chapter', async () => {
    assert.equal((await q('SELECT cover_book_id FROM lib_series WHERE id = $1', [S]))[0].cover_book_id, B.two);
  });
  await t.test('a second delete of the same chapter is already_pruned', async () => {
    const again = await del([B.one]);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json().skipped, [{ id: B.one, reason: 'already_pruned' }]);
    assert.equal(again.json().applied, 0);
  });
});

/**
 * The documented tombstone story, end to end: a chapter deleted from the server is fetched again onto the
 * SAME row. The route has a branch of its own for it (the rename of a file that is not there), and the
 * settle hook must keep the mark when the download fails -- the bytes are still gone -- and the scan must
 * clear it when it lands. Reintroduce by treating ENOENT on the set-aside rename as a skip
 * (`skipped.push({ id, reason: 'not_ours' })` in the catch): "fetch again on a tombstone" reads 409.
 */
test('delete from the server, then fetch again', { skip }, async (t) => {
  const abs = join(DL, FOLDER, 'Chapter 1.cbz');
  assert.ok((await row(B.one)).pruned_at, 'PREMISE: chapter 1 is the tombstone the delete test left');

  await t.test('a failed fetch-again leaves the tombstone as it was', async () => {
    failPages.add('c/1/Group A');
    try {
      const r = await refetch([B.one]);
      assert.equal(r.statusCode, 200, r.body);
      const job = await jobDone();
      assert.equal(job?.status, 'error', JSON.stringify(job));
    } finally {
      failPages.delete('c/1/Group A');
    }
    assert.ok(!existsSync(abs), 'no file appeared');
    assert.ok((await row(B.one)).pruned_at, 'the mark stays: the bytes are still gone');
    assert.ok(!files().some((f) => f.endsWith('.refetch-bak')), `no bak: ${files()}`);
  });

  await t.test('fetch again on a tombstone lands on the same row', async () => {
    const r = await refetch([B.one]);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual({ total: r.json().total, skipped: r.json().skipped }, { total: 1, skipped: [] });
    const job = await jobDone();
    assert.equal(job?.status, 'done', JSON.stringify(job));
    assert.ok(existsSync(abs), 'the file is back');
    const rows = await q('SELECT id, pruned_at FROM lib_books WHERE series_id = $1 AND number = 1', [S]);
    assert.equal(rows.length, 1, 'one row for chapter 1, not a second beside the tombstone');
    assert.equal(rows[0].id, B.one, 'the same row');
    assert.equal(rows[0].pruned_at, null, 'un-marked by the scan');
    assert.ok(!files().some((f) => f.endsWith('.refetch-bak')), `no bak: ${files()}`);
    const p = (await q('SELECT page, completed FROM read_progress WHERE user_id = $1 AND book_id = $2', [adminId, B.one]))[0];
    assert.deepEqual(p, { page: 1, completed: true }, 'the reader\'s progress rode through the delete and the fetch');
  });
});

/**
 * The file is missing AND so is its folder: that is the download volume not being mounted (the mount point
 * exists and is writable, so the preflight passes), not a chapter somebody removed. Reintroduce by dropping
 * the `stat(dirname(t.abs))` branch in the delete route: the row is marked deleted on the evidence of an
 * absent disk.
 */
test('a missing download folder is not a deleted chapter', { skip }, async () => {
  assert.ok(!existsSync(join(DL, OTHER_FOLDER)), 'PREMISE: the other series has a row and no folder');
  const r = await del([B.other], adminTok, OTHER);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().skipped, [{ id: B.other, reason: 'unlink_failed' }]);
  assert.equal(r.json().applied, 0);
  assert.equal((await row(B.other)).pruned_at, null, 'marked deleted while the file sits on an unmounted disk');
});

/**
 * containedPath accepts the root itself, and the rm is recursive. Nothing in the product writes such a row;
 * a hand-edited one must still not cost the whole download directory. Reintroduce by dropping the
 * `abs === root` half of the check in the delete route: DL is gone, and so is every test after this one.
 */
test('the download root itself is never a chapter', { skip }, async () => {
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ('b_act_root', $1, 'T!act', '.', 99, 'Root', 1, $2)`, [S, DL]);
  try {
    const r = await del(['b_act_root']);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().skipped, [{ id: 'b_act_root', reason: 'outside_root' }]);
    assert.ok(existsSync(join(DL, FOLDER, 'Chapter 2.cbz')), 'the download directory was removed');
    assert.equal((await refetch(['b_act_root'])).json().skipped[0].reason, 'not_ours', 'nor can it be set aside');
  } finally {
    await q(`DELETE FROM lib_books WHERE id = 'b_act_root'`);
  }
});

test('refetch replaces the file with the copy the rules choose now, on the same row', { skip }, async (t) => {
  // On disk: Group A's chapter 2, with measured page dims and a reader part-way through. The listing has
  // A and B, and B is the priority now.
  const before = await row(B.two);
  assert.equal(before.scanlator, 'Group A');
  assert.ok(before.page_dims, 'dims measured on the old copy -- the premise');
  pageCalls.length = 0;
  const r = await refetch([B.two]);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual({ total: r.json().total, skipped: r.json().skipped }, { total: 1, skipped: [] });
  const job = await jobDone();
  assert.equal(job?.status, 'done', JSON.stringify(job));

  await t.test('the same row, un-marked, now says Group B', async () => {
    const rows = await q('SELECT id, scanlator, pruned_at, page_dims FROM lib_books WHERE series_id = $1 AND number = 2', [S]);
    assert.equal(rows.length, 1, 'one row for chapter 2: the new file landed on the old row, not beside it');
    assert.equal(rows[0].id, B.two);
    assert.equal(rows[0].pruned_at, null, 'the mark the refetch set is cleared by the scan');
    assert.equal(rows[0].scanlator, 'Group B');
    assert.equal(rows[0].page_dims, null, 'the old copy\'s measurements are forgotten');
    assert.deepEqual(pageCalls, ['c/2/Group B'], 'B\'s copy is what was downloaded');
  });
  await t.test('the file on disk is B\'s, and the old copy is not left behind', () => {
    assert.equal(translator(join(DL, FOLDER, 'Chapter 2.cbz')), 'Group B');
    assert.ok(!files().some((f) => f.endsWith('.refetch-bak')), `no bak left: ${files()}`);
  });
  await t.test('the reader\'s progress is still attached', async () => {
    const p = (await q('SELECT page, completed FROM read_progress WHERE user_id = $1 AND book_id = $2', [adminId, B.two]))[0];
    assert.deepEqual(p, { page: 0, completed: false });
  });
});

/**
 * A preferences save never touches series_listing, so the row still names the copy the LAST sweep chose;
 * the docs promise the copy the rules choose NOW. Reintroduce by dropping the `updateSeries(id, 0)` refresh
 * in the refetch route (and the one in POST /api/sources/fetch for the fetch half): "B's copy is what was
 * downloaded" reads Group A.
 */
test('fetch again takes the copy the rules choose now, not the one the last check chose', { skip }, async (t) => {
  // On disk: Group B's chapter 2, and the listing (written under a priority for B) says B. The admin now
  // ranks Group A instead and clicks Fetch again without a check in between.
  assert.equal((await row(B.two)).scanlator, 'Group B', 'PREMISE: the last refetch landed B');
  await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":["Group A"],"blocked":["Spam Group"],"patienceDays":2}'::jsonb WHERE id = 1`);
  try {
    pageCalls.length = 0;
    const r = await refetch([B.two]);
    assert.equal(r.statusCode, 200, r.body);
    const job = await jobDone();
    assert.equal(job?.status, 'done', JSON.stringify(job));
    assert.deepEqual(pageCalls, ['c/2/Group A'], 'A\'s copy is what was downloaded: the ranking made a minute ago counts');
    assert.equal(translator(join(DL, FOLDER, 'Chapter 2.cbz')), 'Group A');
    assert.equal((await row(B.two)).scanlator, 'Group A');

    await t.test('and a plain fetch refreshes the listing the same way', async () => {
      // The listing row is the evidence: the refetch's refresh rewrote the chosen copy for every number.
      const l = (await q('SELECT scanlator FROM series_listing WHERE series_id = $1 AND number = 2', [S]))[0];
      assert.equal(l.scanlator, 'Group A', 'the listing now says A');
      // The ranking changes again; a fetch through POST /api/sources/fetch refreshes before it reads, so
      // the row says B afterwards even though the fetch itself had nothing to do (2 is already here).
      await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":["Group B"],"blocked":["Spam Group"],"patienceDays":2}'::jsonb WHERE id = 1`);
      const r2 = await fetchNums([2]);
      assert.equal(r2.statusCode, 409, r2.body);
      assert.deepEqual(r2.json().skipped, [{ number: 2, reason: 'already_here' }]);
      const l2 = (await q('SELECT scanlator FROM series_listing WHERE series_id = $1 AND number = 2', [S]))[0];
      assert.equal(l2.scanlator, 'Group B', 'the fetch refreshed the listing before reading it');
    });
  } finally {
    await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":["Group B"],"blocked":["Spam Group"],"patienceDays":2}'::jsonb WHERE id = 1`);
  }
});

/**
 * Reintroduce by removing the `onSettled` hook from the refetch route (or the rename back inside it):
 * the file is gone and "the old copy is back" fails on a missing file.
 */
test('a failed refetch puts the old file back', { skip }, async () => {
  const abs = join(DL, FOLDER, 'Chapter 3.cbz');
  const original = readFileSync(abs);
  failPages.add('c/3/Group A');
  try {
    const r = await refetch([B.three]);
    assert.equal(r.statusCode, 200, r.body);
    const job = await jobDone();
    assert.equal(job?.status, 'error', JSON.stringify(job));
  } finally {
    failPages.delete('c/3/Group A');
  }
  assert.ok(existsSync(abs), 'the old copy is back');
  assert.ok(readFileSync(abs).equals(original), 'byte for byte');
  assert.ok(!files().some((f) => f.endsWith('.refetch-bak')), `no bak left: ${files()}`);
  const b = await row(B.three);
  assert.equal(b.pruned_at, null, 'and the row is not a tombstone');
  assert.equal(b.scanlator, 'Group A', 'still the old copy\'s group');
});

/**
 * The job must settle every chapter it was given, including the ones it never reached: the source refuses
 * chapter 2's images (a 403 -- the source itself saying no, which ends a single-source job on the spot), so
 * chapter 3 is never attempted, and its file is sitting under .refetch-bak with its row marked. Reintroduce
 * by removing the tail `for (const ch of chapters) if (!settled.has(ch)) await settle(ch, false)` in
 * startDownloadJob: chapter 3's bak is left behind and its row stays a tombstone.
 */
test('a refetch the source refuses part-way puts back the chapters it never reached', { skip }, async () => {
  const two = join(DL, FOLDER, 'Chapter 2.cbz'), three = join(DL, FOLDER, 'Chapter 3.cbz');
  const before = { two: readFileSync(two), three: readFileSync(three) };
  blockImages.add('c/2/Group B');
  try {
    const r = await refetch([B.two, B.three]);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().total, 2);
    const job = await jobDone();
    assert.equal(job?.status, 'error', JSON.stringify(job));
  } finally {
    blockImages.delete('c/2/Group B');
    // The 403 put the source in a cooldown; beforeEach clears it too, but a reader of this test should not
    // have to know that.
    await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
  }
  assert.ok(existsSync(two), 'chapter 2, refused, is back');
  assert.ok(existsSync(three), 'chapter 3, never attempted, is back');
  assert.ok(readFileSync(two).equals(before.two), 'chapter 2 byte for byte');
  assert.ok(readFileSync(three).equals(before.three), 'chapter 3 byte for byte');
  assert.ok(!files().some((f) => f.endsWith('.refetch-bak')), `no bak left: ${files()}`);
  assert.deepEqual([(await row(B.two)).pruned_at, (await row(B.three)).pruned_at], [null, null], 'neither row is a tombstone');
});

/**
 * A restart mid-refetch kills the hook that would have put the old copy back. The boot-time sweeper does
 * it instead, for a bak whose original is missing -- and only for those: a bak beside a landed file is a
 * finished refetch whose tidy-up was lost, and the landed file wins. Reintroduce by dropping the
 * REFETCH_BAK branch from reapStaleTemp in lib/fsAtomic.ts: "the interrupted one is back" finds no file.
 *
 * And the row's mark is cleared right there, not "by the next scan" -- there is no boot scan, and the
 * restored chapter otherwise read as deleted for days. Reintroduce by dropping the UPDATE in
 * unpruneRestored (lib/chapterCleanup.ts): "the row is un-marked at boot" finds pruned_at set.
 */
test('an interrupted refetch is put back at boot', { skip }, async () => {
  const { reapStaleTemp } = await import('../src/lib/fsAtomic');
  const { unpruneRestored } = await import('../src/lib/chapterCleanup');
  const dir = join(DL, FOLDER);
  writeFileSync(join(dir, 'Chapter 11.cbz.refetch-bak'), 'old eleven');
  writeFileSync(join(dir, 'Chapter 12.cbz'), 'new twelve');
  writeFileSync(join(dir, 'Chapter 12.cbz.refetch-bak'), 'old twelve');
  // The refetch marked chapter 11's row before it died.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, pruned_at) VALUES ('b_act_11', $1, 'T!act', $2, 11, 'Chapter 11', 1, $3, now())`,
    [S, `${FOLDER}/Chapter 11.cbz`, DL]);
  try {
    const { restored } = await reapStaleTemp(DL);
    assert.equal(readFileSync(join(dir, 'Chapter 11.cbz'), 'utf8'), 'old eleven', 'the interrupted one is back');
    assert.ok(!existsSync(join(dir, 'Chapter 11.cbz.refetch-bak')));
    assert.equal(readFileSync(join(dir, 'Chapter 12.cbz'), 'utf8'), 'new twelve', 'a landed file is never overwritten by its bak');
    assert.ok(existsSync(join(dir, 'Chapter 12.cbz.refetch-bak')), 'and the bak beside it is left for a person');
    assert.deepEqual(restored, [`${FOLDER}/Chapter 11.cbz`], 'reported relative to the root, the way lib_books.file is');
    // What server.ts does with the report at boot.
    assert.equal(await unpruneRestored(DL, restored), 1);
    assert.equal((await row('b_act_11')).pruned_at, null, 'the row is un-marked at boot');
  } finally {
    await q(`DELETE FROM lib_books WHERE id = 'b_act_11'`);
    for (const f of ['Chapter 11.cbz', 'Chapter 11.cbz.refetch-bak', 'Chapter 12.cbz', 'Chapter 12.cbz.refetch-bak']) rmSync(join(dir, f), { force: true });
  }
});

test('refetch refuses a chapter it did not download', { skip }, async () => {
  const r = await refetch([B.lib, B.odd, B.other]);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'nothing_to_fetch');
  assert.deepEqual(r.json().skipped, [
    { id: B.lib, reason: 'not_owned' },   // the read library is never touched
    { id: B.odd, reason: 'not_ours' },    // a file under a name the downloader would not write cannot land on the same row
    { id: B.other, reason: 'not_found' }, // another series' chapter
  ]);
  assert.ok(existsSync(join(LIB_ROOT, FOLDER, 'Chapter 9.cbz')));
});

test('a running job for the folder refuses a second one', { skip }, async () => {
  slowPages.add('c/6/Group A');
  try {
    const first = await fetchNums([6]);
    assert.equal(first.statusCode, 200, first.body);
    const second = await fetchNums([6]);
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(second.json().error, 'busy');
    const again = await refetch([B.two]);
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(again.json().error, 'busy');
    const job = await jobDone();
    assert.equal(job?.status, 'done', JSON.stringify(job));
  } finally {
    slowPages.delete('c/6/Group A');
  }
});

test('a member cannot reach the admin routes', { skip }, async () => {
  assert.equal((await del([B.two], memberTok)).statusCode, 403);
  assert.equal((await refetch([B.two], memberTok)).statusCode, 403);
  assert.ok(existsSync(join(DL, FOLDER, 'Chapter 2.cbz')));
});

test('a user who may not download cannot fetch', { skip }, async () => {
  // The plugin-wide gate, not a check of this route's own: canDownload:false removes the whole surface.
  const r = await fetchNums([5], nodlTok);
  assert.equal(r.statusCode, 403, r.body);
  assert.equal((await fetchNums([5], memberTok)).statusCode, 409, 'a member who may download reaches the route and gets the real answer');
});

test('a number from another series is refused', { skip }, async () => {
  // 50 is listed -- for the OTHER series. Naming it under this one has nothing to fetch from.
  const r = await fetchNums([50]);
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(r.json().skipped, [{ number: 50, reason: 'not_listed' }]);
  assert.equal((await fetchNums([1], adminTok, 's_act_nope')).statusCode, 404, 'an unknown series is 404');
});

/**
 * A listing row is the authorisation for a fetch, and the rows are otherwise rewritten only by the series'
 * next successful check. Reintroduce the first half by dropping the `DELETE FROM series_listing` in the
 * unfollow route: "its ghost is gone from the page at once" still finds 20. Reintroduce the second by
 * dropping the `followed` check in either stateOf: the stale row starts a download from a source the admin
 * removed.
 */
test('unfollowing a source takes its listing rows with it, and a stale row never authorises', { skip }, async (t) => {
  // Followed directly rather than through the plan route: what is under test is the unfollow, not the gate.
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'fol-1')`, [S, FOL]);
  const sweep = await updateSeries(S, 0);
  assert.equal(sweep.outcome, 'ok', 'PREMISE: both sources answered');
  const ghost20 = async () => (await listing()).json().content.find((g: any) => g.number === 20);
  assert.equal((await ghost20())?.sourceId, FOL, 'PREMISE: chapter 20 is listed, through the follower');

  const un = await app.inject({ method: 'DELETE', url: `/api/admin/series/${S}/sources/${FOL}`, headers: { authorization: adminTok } });
  assert.equal(un.statusCode, 200, un.body);

  await t.test('its ghost is gone from the page at once', async () => {
    assert.equal(await ghost20(), undefined, 'the row the follower carried is still listed');
    assert.equal((await q('SELECT 1 FROM series_listing WHERE series_id = $1 AND source_id = $2', [S, FOL])).length, 0);
  });

  await t.test('a stale listing row never authorises a source the series does not follow', async () => {
    // The row the unfollow should have taken is planted back, and the primary is made to not answer so
    // the refresh the fetch runs cannot rewrite it: the only thing between a member and a download from
    // the removed source is the check.
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status) VALUES ($1, 20, $2, $3::jsonb, 'available')`,
      [S, FOL, JSON.stringify(ch(20, 'Group A'))]);
    cbz(join(DL, FOLDER, 'Chapter 20.cbz'), 'Group A');
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, scanlator, source_id) VALUES ('b_act_20', $1, 'T!act', $2, 20, 'Chapter 20', 1, $3, 'Group A', $4)`,
      [S, `${FOLDER}/Chapter 20.cbz`, DL, FOL]);
    listThrows = true;
    pageCalls.length = 0;
    try {
      const re = await refetch(['b_act_20']);
      assert.equal(re.statusCode, 409, re.body);
      assert.deepEqual(re.json().skipped, [{ id: 'b_act_20', reason: 'source_unavailable' }], 'fetch again');
      await q(`DELETE FROM lib_books WHERE id = 'b_act_20'`);
      rmSync(join(DL, FOLDER, 'Chapter 20.cbz'), { force: true });
      const r = await fetchNums([20]);
      assert.equal(r.statusCode, 409, r.body);
      assert.deepEqual(r.json().skipped, [{ number: 20, reason: 'source_unavailable' }], 'fetch');
      assert.deepEqual(pageCalls, [], 'nothing was asked of the removed source');
    } finally {
      listThrows = false;
      await q(`DELETE FROM lib_books WHERE id = 'b_act_20'`);
      await q('DELETE FROM series_listing WHERE series_id = $1 AND source_id = $2', [S, FOL]);
      rmSync(join(DL, FOLDER, 'Chapter 20.cbz'), { force: true });
    }
  });
});
