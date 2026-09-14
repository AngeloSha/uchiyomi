// The persisted listing: the sweep writes what the sources listed, and the series page reads back the
// chapters this library lacks with the reason each is absent.
//
// Until this existed the reasons died with the sweep. A chapter held for a preferred group, one the sweep
// had given up on, one only a blocked group had released, one below the Latest-N floor -- every one was a
// silent "0 added" on the series page, and "3 behind" named none of the three. The rows here are what the
// ghost rows on the page are drawn from, and what a manual fetch is authorised against.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-lst-'));
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UPDATER_LIST_TIMEOUT_MS = '300';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_lst';
const S = 's_lst_series', FOLDER = 'T!lst/Listed Series';
const PRI = 'lst-pri', FOL = 'lst-fol';
const ADMIN = 'lst-admin', MEMBER = 'lst-member', WALLED = 'lst-walled';
let q: any, app: any, updateSeries: any, CHAPTER_RETRY_CAP: number;
let adminTok: string, memberTok: string, walledTok: string;
/** Flipped by the tests, per adapter: a source in `throwing` did not answer; one in `empty` answered with nothing. */
const throwing = new Set<string>();
const empty = new Set<string>();
let savedGlobal: any;

const ch = (n: number, extra: Record<string, unknown> = {}) => ({ sourceId: `c/${n}/${extra.scanlator ?? ''}`, number: n, title: `Chapter ${n}`, ...extra });

function fake(id: string, list: () => any[]) {
  return {
    id, name: `${id} name`,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: 'Listed Series' }; },
    async listChapters() {
      if (throwing.has(id)) throw new Error('site refused');
      if (empty.has(id)) return [];
      return list();
    },
    async getPageUrls() { return []; },
    async latest() { return [];  },
  };
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries, CHAPTER_RETRY_CAP } = (await import('../src/lib/updater')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  await migrate();

  // The primary lists 1..6, chapter 3 from two groups and chapter 5 from group A only, released just now.
  // The follower lists 7, from a group the second test blocks.
  registerAdapter(fake(PRI, () => [
    ch(1), ch(2),
    ch(3, { scanlator: 'Group A' }), ch(3, { scanlator: 'Group B' }),
    ch(4),
    ch(5, { scanlator: 'Group A', publishedAt: new Date().toISOString() }),
    ch(6),
  ]) as any);
  registerAdapter(fake(FOL, () => [ch(7, { scanlator: 'Blocked Group' })]) as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[PRI, FOL]]);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Listed',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!lst','Listed Series',$2,2,$3,$4,'pri-1',true)`, [S, FOLDER, LIB, PRI]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'fol-1')`, [S, FOL]);
  for (const n of [3, 4]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root)
             VALUES ($1,$2,'T!lst',$3,$4,$5,'/library')`, [`b_lst_${n}`, S, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  savedGlobal = (await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0]?.scanlator_prefs;
  await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":[],"blocked":[],"patienceDays":2}'::jsonb WHERE id = 1`);

  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, WALLED]]);
  const mk = async (name: string, role: string) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  const adminId = await mk(ADMIN, 'admin');
  const memberId = await mk(MEMBER, 'user');
  const walledId = await mk(WALLED, 'user');
  // Restricted to no library at all: one row naming the empty id, which no library can have.
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [walledId, '']);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
  memberTok = `Bearer ${app.jwt.sign({ sub: memberId, role: 'user' })}`;
  walledTok = `Bearer ${app.jwt.sign({ sub: walledId, role: 'user' })}`;
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {}); // series_listing and series_sources cascade
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, WALLED]]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[PRI, FOL]]).catch(() => {});
  if (savedGlobal !== undefined) await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(savedGlobal)]).catch(() => {});
});

const listing = (tok: string) => app.inject({ method: 'GET', url: `/api/series/${S}/listing`, headers: { authorization: tok } });
const rows = () => q('SELECT number, source_id, status, groups, scanlator, chosen FROM series_listing WHERE series_id = $1 ORDER BY number', [S]);

test('the sweep writes what the sources listed', { skip }, async () => {
  // maxNew 0: the listing is written before the loop, and nothing here has pages to download anyway.
  const r = await updateSeries(S, 0);
  assert.equal(r.outcome, 'ok', 'both sources answered');
  const l = await rows();
  assert.deepEqual(l.map((x: any) => Number(x.number)), [1, 2, 3, 4, 5, 6, 7], 'one row per number across both sources, the ones on disk included');
  const three = l.find((x: any) => Number(x.number) === 3);
  assert.deepEqual(three.groups, ['Group A', 'Group B'], 'every group that released chapter 3');
  assert.equal(l.find((x: any) => Number(x.number) === 7).source_id, FOL, 'a number only the follower lists is fetched through the follower');
  assert.equal(three.source_id, PRI);
  assert.equal(typeof three.chosen.sourceId, 'string', 'the chosen copy is stored whole, for the downloader');
  assert.ok(l.every((x: any) => x.status === 'available'), 'nothing held or blocked without preferences');
});

test('the listing route returns only what this library lacks, with the reason', { skip }, async (t) => {
  await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":["Group B"],"blocked":["Blocked Group"],"patienceDays":2}'::jsonb WHERE id = 1`);
  await q('UPDATE lib_series SET chapter_floor = 3 WHERE id = $1', [S]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at)
           VALUES ($1, 6, $2, 'incomplete', '94/95 pages from cdn.example.invalid', $3, now())
           ON CONFLICT (series_id, number) DO UPDATE SET attempts = EXCLUDED.attempts, reason = EXCLUDED.reason`, [S, PRI, CHAPTER_RETRY_CAP]);
  const r = await updateSeries(S, 0);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.waiting, 1, 'chapter 5 is being held for Group B -- the premise of the held row');

  const res = await listing(adminTok);
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();
  const why = Object.fromEntries(j.content.map((g: any) => [g.number, g.why]));

  await t.test('numbers on disk are not ghosts', () => {
    assert.ok(!(3 in why) && !(4 in why), `3 and 4 are here: ${JSON.stringify(why)}`);
  });
  await t.test('each ghost carries its reason', () => {
    assert.deepEqual(why, { 1: 'floor', 2: 'floor', 5: 'held', 6: 'failed', 7: 'blocked' });
  });
  await t.test('a failed chapter says how many tries, a blocked one who released it', () => {
    const six = j.content.find((g: any) => g.number === 6);
    assert.equal(six.attempts, CHAPTER_RETRY_CAP);
    const seven = j.content.find((g: any) => g.number === 7);
    assert.deepEqual(seven.groups, ['Blocked Group']);
    assert.equal(seven.sourceId, FOL);
    assert.equal(seven.sourceName, `${FOL} name`, 'the adapter\'s display name, as the sources line shows it');
    assert.equal(j.content.find((g: any) => g.number === 5).scanlator, 'Group A', 'the copy on offer today');
  });
  await t.test('and says how old the answer is', () => {
    assert.ok(j.checkedAt && Date.now() - Date.parse(j.checkedAt) < 60_000, `checkedAt ${j.checkedAt}`);
  });
});

/**
 * Reintroduce by moving the replaceListing call in updateSeries above the `if (!answered)` early return:
 * `tagged` is empty there, the listing is replaced with nothing, and "the previous listing stands" reads 0.
 */
test('when no source answered the previous listing stands', { skip }, async () => {
  throwing.add(PRI).add(FOL);
  try {
    const r = await updateSeries(S, 0);
    assert.equal(r.outcome, 'source_error', 'PREMISE: neither source answered');
  } finally {
    throwing.clear();
  }
  assert.equal((await rows()).length, 7, 'the previous listing stands: stale beats empty');
  const j = (await listing(adminTok)).json();
  assert.equal(j.content.length, 5, 'and the page still has its ghosts');
});

/**
 * A moved domain serving a 404 page, a parser regression, a challenge page: every one resolves the chapter
 * list to `[]` rather than throwing, and counts as a source that spoke. Written through, that would empty
 * a two-hundred-row listing -- every ghost gone, every manual fetch not_listed -- for as long as the
 * source stays broken. Reintroduce by dropping the `tagged.length` guard on replaceListing in updateSeries:
 * "the previous listing stands" reads 0.
 */
test('a source that answered with nothing leaves the previous listing standing', { skip }, async () => {
  empty.add(PRI).add(FOL);
  try {
    const r = await updateSeries(S, 0);
    assert.equal(r.outcome, 'ok', 'PREMISE: both sources answered, with nothing');
    assert.equal(r.available, 0);
  } finally {
    empty.clear();
  }
  assert.equal((await rows()).length, 7, 'the previous listing stands: an empty answer is no answer');
  assert.equal((await listing(adminTok)).json().content.length, 5, 'and the page still has its ghosts');
});

/**
 * The accepted limitation, pinned so a test name cannot contradict it: with ONE of two sources erroring,
 * the listing is rewritten from the source that answered, and the numbers the dead source alone carried
 * are not ghosts (and are not_listed to a manual fetch) until it answers again. USAGE.md says so for a
 * cooldown; it is equally true of an error. Keeping a per-source memory of the last listing would be the
 * fix, and is not this release's.
 */
test('one source erroring while another answers rewrites the listing from the one that answered', { skip }, async () => {
  throwing.add(PRI);
  try {
    const r = await updateSeries(S, 0);
    assert.equal(r.outcome, 'ok', 'PREMISE: the follower answered');
  } finally {
    throwing.clear();
  }
  assert.deepEqual((await rows()).map((x: any) => Number(x.number)), [7], 'only what the follower lists');
  // Put the listing back for the tests after this one: both answer again.
  assert.equal((await updateSeries(S, 0)).outcome, 'ok');
  assert.equal((await rows()).length, 7);
});

test('a tombstone is not a ghost', { skip }, async () => {
  // The cleanup deleted chapter 6's file and kept its row. The series page shows THAT row with its badge;
  // listing 6 as a ghost too would offer it twice, once to fetch and once to fetch again.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, pruned_at)
           VALUES ('b_lst_6', $1, 'T!lst', $2, 6, 'Chapter 6', $3, now())`, [S, `${FOLDER}/Chapter 6.cbz`, process.env.DL_ROOT]);
  try {
    const j = (await listing(adminTok)).json();
    assert.ok(!j.content.some((g: any) => g.number === 6), `6 has a row, so it is not a ghost: ${JSON.stringify(j.content.map((g: any) => g.number))}`);
    assert.equal(j.content.length, 4);
  } finally {
    await q(`DELETE FROM lib_books WHERE id = 'b_lst_6'`);
  }
});

test('a member who cannot open the series gets 404', { skip }, async () => {
  // Through the same gate as the series itself: a walled-off member must not learn what a series they
  // cannot see is missing, and the answer must not differ from "no such series".
  const res = await listing(walledTok);
  assert.equal(res.statusCode, 404, res.body);
  assert.equal((await listing(memberTok)).statusCode, 200, 'an unrestricted member reads it');
});

test('the failure reason is shown to admins only', { skip }, async () => {
  // The downloader's error text names hosts and paths. Reintroduce by dropping the `opts.admin` guard in
  // listingFor: the member's ghost carries `reason`.
  const six = (tok: string) => (listing(tok)).then((r: any) => r.json().content.find((g: any) => g.number === 6));
  const a = await six(adminTok);
  assert.match(a.reason, /cdn\.example\.invalid/, 'the admin sees the downloader\'s text');
  const m = await six(memberTok);
  assert.equal(m.why, 'failed', 'the member still sees that it failed');
  assert.equal(m.attempts, CHAPTER_RETRY_CAP, 'and how many times');
  assert.ok(!('reason' in m), `the member must not see the text: ${JSON.stringify(m)}`);
});
