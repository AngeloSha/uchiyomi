// Who scanlates a series and which versions of each chapter exist, over the real routes.
//
// The figures come from two places -- the copies the sweep persisted and the group stamps on the live
// files -- and one aggregator (lib/groupStats.ts) turns them into the same numbers for the member-facing
// panel, the admin's editor and the add dialog (which alone reads a live chapter list, the one it already
// fetched). What is pinned here is the plumbing: that the sweep's copies reach the aggregator with their
// number, that the file stamps count, that the flags on a version (chosen / blocked / on disk) are read
// from the right rows, that a pre-v0.33.0 row degrades to an empty list rather than an error, that the
// admin's editor reads the same rows as the panel, and that the visibility gate is the series' own.
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
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-gv-'));
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UPDATER_LIST_TIMEOUT_MS = '300';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_gv';
const S = 's_gv_series', FOLDER = 'T!gv/Grouped Series';
const PRI = 'gv-pri', FOL = 'gv-fol';
const ADMIN = 'gv-admin', MEMBER = 'gv-member', WALLED = 'gv-walled';
let q: any, app: any, updateSeries: any;
let adminTok: string, memberTok: string, walledTok: string;
let savedGlobal: any;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ch = (n: number, group: string, extra: Record<string, unknown> = {}) =>
  ({ sourceId: `c/${n}/${group}`, number: n, title: `Chapter ${n}`, scanlator: group, ...extra });

/**
 * The primary: Group A ships weekly (1..4, chapter 4 jointly with Group B), Group B also has its own
 * chapter 3, and Spam Group -- blocked -- alone released 5. The follower lists Group C's Portuguese copies
 * of 4 and 6.
 */
function fake(id: string, list: () => any[]) {
  return {
    id, name: `${id} name`,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: 'Grouped Series' }; },
    async listChapters() { return list(); },
    async getPageUrls() { return []; },
    async latest() { return []; },
  };
}
const primaryList = () => [
  ch(1, 'Group A', { publishedAt: ago(28), pages: 20 }),
  ch(2, 'Group A', { publishedAt: ago(21), pages: 20 }),
  ch(3, 'Group A', { publishedAt: ago(14), pages: 20 }),
  ch(3, 'Group B', { publishedAt: ago(13), pages: 18 }),
  ch(4, 'Group A & Group B', { publishedAt: ago(7), pages: 22 }),
  ch(5, 'Spam Group', { publishedAt: ago(1) }),
];
const followerList = () => [
  ch(4, 'Group C', { publishedAt: ago(6), lang: 'pt-br' }),
  ch(6, 'Group C', { publishedAt: ago(2), lang: 'pt-br' }),
];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  await migrate();
  registerAdapter(fake(PRI, primaryList) as any);
  registerAdapter(fake(FOL, followerList) as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[PRI, FOL]]);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Grouped',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!gv','Grouped Series',$2,3,$3,$4,'pri-1',true)`, [S, FOLDER, LIB, PRI]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'fol-1')`, [S, FOL]);
  // On disk: 1 from Group A; 2 stamped as a joint A & B file (another version than the one listed); 3 with
  // no stamp at all (a file the scanner found); and a tombstone for 6, whose bytes are gone.
  const book = (id: string, n: number, group: string | null, source: string | null, pruned = false) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, scanlator, source_id, pruned_at)
        VALUES ($1,$2,'T!gv',$3,$4,$5,$6,$7,$8,$9)`,
      [id, S, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`, process.env.DL_ROOT, group, source, pruned ? new Date() : null]);
  await book('b_gv_1', 1, 'Group A', PRI);
  await book('b_gv_2', 2, 'Group A & Group B', PRI);
  await book('b_gv_3', 3, null, PRI);
  await book('b_gv_6', 6, 'Group C', FOL, true);

  savedGlobal = (await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0]?.scanlator_prefs;
  await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":[],"blocked":["Spam Group"],"patienceDays":2}'::jsonb WHERE id = 1`);

  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, WALLED]]);
  const mk = async (name: string, role: string) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  const adminId = await mk(ADMIN, 'admin');
  const memberId = await mk(MEMBER, 'user');
  const walledId = await mk(WALLED, 'user');
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [walledId, '']);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.register(adminRoutes);
  await app.register(sourceRoutes);
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
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, WALLED]]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[PRI, FOL]]).catch(() => {});
  if (savedGlobal !== undefined) await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(savedGlobal)]).catch(() => {});
});

const get = (url: string, tok = adminTok) => app.inject({ method: 'GET', url, headers: { authorization: tok } });
const groups = (tok = adminTok) => get(`/api/series/${S}/groups`, tok);
const versions = (tok = adminTok) => get(`/api/series/${S}/versions`, tok);

test('who scanlates this: releases, chapters, cadence and what is on disk, per group', { skip }, async (t) => {
  // maxNew 0: the listing is written before the loop, and nothing here has pages to download anyway.
  const sweep = await updateSeries(S, 0);
  assert.equal(sweep.outcome, 'ok', 'PREMISE: every test in this file reads the copies this sweep writes');
  const r = await groups();
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  const byName = new Map<string, any>(j.content.map((g: any) => [g.name, g]));

  await t.test('sorted by releases, a joint release counted for each of its groups', () => {
    // Releases are chapters, not copies: Group A's four are numbers 1-4, and were a follower to list them
    // again they would still be four (groupStats.test.ts pins that; here the fixture has no such copy).
    assert.deepEqual(j.content.map((g: any) => [g.name, g.releases]), [['Group A', 4], ['Group B', 2], ['Group C', 2], ['Spam Group', 1]]);
  });
  await t.test('chapters, range and last release from the persisted copies, with their number', () => {
    // Reintroduce by flattening `copies` without the row's number in GET /groups: every chapter list is
    // empty and `first` is null.
    const a = byName.get('Group A');
    assert.deepEqual(a.chapters, [1, 2, 3, 4]);
    assert.deepEqual([a.first, a.last], [1, 4]);
    assert.ok(a.lastReleaseAt && Math.abs(Date.parse(a.lastReleaseAt) - (Date.now() - 7 * DAY)) < 60_000, a.lastReleaseAt);
    assert.deepEqual(byName.get('Group B').chapters, [3, 4]);
    assert.deepEqual(byName.get('Group C').chapters, [4, 6], 'the follower\'s copies count too');
  });
  await t.test('cadence from the seeded dates', () => {
    const a = byName.get('Group A').cadence;
    assert.equal(a.kind, 'weekly', JSON.stringify(a));
    assert.equal(a.intervalDays, 7);
    assert.equal(a.daysSince, 7);
    assert.equal(a.quiet, false);
    assert.equal(byName.get('Spam Group').cadence.kind, 'unknown', 'one dated release');
  });
  await t.test('on disk is counted from the file stamps, split like a joint release, live rows only', () => {
    // Chapter 1 is A's; chapter 2's file is a joint A & B stamp; chapter 3 has no stamp and is nobody's;
    // chapter 6's tombstone is a file that is not here. Reintroduce by dropping `pruned_at IS NULL` from
    // the on-disk query in GET /groups: Group C reads 1.
    assert.equal(byName.get('Group A').onDisk, 2);
    assert.equal(byName.get('Group B').onDisk, 1);
    assert.equal(byName.get('Group C').onDisk, 0, 'a tombstone is not on this server');
  });
  await t.test('languages, when the source names them', () => {
    assert.deepEqual(byName.get('Group C').langs, ['pt-br']);
    assert.deepEqual(byName.get('Group A').langs, []);
  });
  await t.test('and says how old the answer is', () => {
    assert.ok(j.checkedAt && Date.now() - Date.parse(j.checkedAt) < 60_000, `checkedAt ${j.checkedAt}`);
  });
});

test('every version of every chapter, flagged chosen, blocked and on disk', { skip }, async (t) => {
  const r = await versions();
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  const byNumber = new Map<number, any[]>(j.content.map((e: any) => [e.number, e.copies]));

  await t.test('one entry per listed number, its copies keyed by source and id', () => {
    assert.deepEqual([...byNumber.keys()], [1, 2, 3, 4, 5, 6]);
    const three = byNumber.get(3)!;
    assert.deepEqual(three.map((c) => c.key), [`${PRI}:c/3/Group A`, `${PRI}:c/3/Group B`], 'chosen first');
    assert.deepEqual(
      { source: three[1].source, sourceName: three[1].sourceName, groups: three[1].groups, scanlator: three[1].scanlator, lang: three[1].lang, pages: three[1].pages },
      { source: PRI, sourceName: `${PRI} name`, groups: ['Group B'], scanlator: 'Group B', lang: null, pages: 18 },
    );
    assert.ok(three[1].publishedAt, 'dated');
  });
  await t.test('chosen is the copy the rules picked; a joint copy from the primary beats the follower\'s', () => {
    assert.deepEqual(byNumber.get(3)!.map((c) => c.chosen), [true, false]);
    const four = byNumber.get(4)!;
    assert.deepEqual(four.map((c) => [c.source, c.chosen]), [[PRI, true], [FOL, false]]);
    assert.deepEqual(four[0].groups, ['Group A', 'Group B']);
  });
  await t.test('blocked when every group on the copy is blocked, and a blocked number still lists its copy -- chosen by nobody', () => {
    // A blocked number keeps its first copy in the row's `chosen` for display only; the rules took nothing.
    // Reintroduce by dropping `r.status !== 'blocked'` from `chosen` in GET /versions: chapter 5 reads
    // [[true, true]] and the page shows the chosen AND blocked pills on one version.
    assert.deepEqual(byNumber.get(5)!.map((c) => [c.scanlator, c.blocked]), [['Spam Group', true]]);
    assert.deepEqual(byNumber.get(5)!.map((c) => c.chosen), [false], 'a blocked-only number has no chosen copy');
    assert.ok(byNumber.get(3)!.every((c) => !c.blocked));
  });
  await t.test('blocked is per copy, not per number', async () => {
    // Number 98 has a blocked copy beside an unblocked one and the row is `available` (the rules chose
    // Group A's). Self-contained: the sweep never lists 98, so the row is planted and removed here.
    // Reintroduce by reading `blocked: r.status === 'blocked'` from the row in GET /versions: [false, false]
    // -- Spam Group's copy loses its pill and reads fetchable-by-rule.
    const copy = (group: string) => ({ sourceId: `c/98/${group}`, source: PRI, groups: [group], scanlator: group, lang: null, pages: null, publishedAt: null });
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies) VALUES ($1, 98, $2, $3::jsonb, 'available', $4::jsonb)`,
      [S, PRI, JSON.stringify(ch(98, 'Group A')), JSON.stringify([copy('Group A'), copy('Spam Group')])]);
    try {
      const again = await versions();
      assert.equal(again.statusCode, 200, again.body);
      const copies = again.json().content.find((e: any) => e.number === 98)?.copies ?? [];
      assert.deepEqual(copies.map((c: any) => [c.scanlator, c.blocked, c.chosen]), [['Group A', false, true], ['Spam Group', true, false]]);
    } finally {
      await q('DELETE FROM series_listing WHERE series_id = $1 AND number = 98', [S]);
    }
  });
  await t.test('on disk: same source and same group stamp, or the chosen copy for a file with no stamp', () => {
    // Chapter 1's file is A's from the primary: that copy is on disk. Chapter 2's file is a joint A & B
    // stamp, which is not the A-only copy listed: "here from another copy", so not on disk. Chapter 3's
    // file has no stamp: only the chosen copy can be it. Reintroduce by dropping the `: chosen` fallback in
    // GET /versions: chapter 3 reads [false, false].
    assert.deepEqual(byNumber.get(1)!.map((c) => c.onDisk), [true]);
    assert.deepEqual(byNumber.get(2)!.map((c) => c.onDisk), [false]);
    assert.deepEqual(byNumber.get(3)!.map((c) => c.onDisk), [true, false]);
    assert.deepEqual(byNumber.get(6)!.map((c) => c.onDisk), [false], 'a tombstone is not on disk');
  });
  await t.test('a file with no stamp and no source is the chosen copy too', async () => {
    // A file the scanner found, or one from before v0.31.0, has NULL in BOTH columns (setBookMeta is the
    // only writer and stamps them together), which on an older install is most of the library. Number 97
    // is planted with such a file and one listed copy. Reintroduce by requiring `b.source_id === c.source`
    // ahead of the stamp check in GET /versions: [false], and the admin's Fetch this stays offered on the
    // very copy that is on disk.
    const copy = { sourceId: 'c/97/Group A', source: PRI, groups: ['Group A'], scanlator: 'Group A', lang: null, pages: null, publishedAt: null };
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies) VALUES ($1, 97, $2, $3::jsonb, 'available', $4::jsonb)`,
      [S, PRI, JSON.stringify(ch(97, 'Group A')), JSON.stringify([copy])]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, scanlator, source_id)
              VALUES ('b_gv_97', $1, 'T!gv', $2, 97, 'Chapter 97', $3, NULL, NULL)`, [S, `${FOLDER}/Chapter 97.cbz`, process.env.DL_ROOT]);
    try {
      const again = await versions();
      assert.equal(again.statusCode, 200, again.body);
      const copies = again.json().content.find((e: any) => e.number === 97)?.copies ?? [];
      assert.deepEqual(copies.map((c: any) => [c.chosen, c.onDisk]), [[true, true]]);
    } finally {
      await q(`DELETE FROM lib_books WHERE id = 'b_gv_97'`);
      await q('DELETE FROM series_listing WHERE series_id = $1 AND number = 97', [S]);
    }
  });
  await t.test('a number listed before v0.33.0 has an empty list, not an error', async () => {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status) VALUES ($1, 99, $2, $3::jsonb, 'available')`,
      [S, PRI, JSON.stringify(ch(99, 'Group A'))]);
    try {
      const again = await versions();
      assert.equal(again.statusCode, 200, again.body);
      assert.deepEqual(again.json().content.find((e: any) => e.number === 99), { number: 99, copies: [] });
    } finally {
      await q('DELETE FROM series_listing WHERE series_id = $1 AND number = 99', [S]);
    }
  });
});

test('a member who cannot open the series gets 404 from both, an unrestricted member reads them', { skip }, async () => {
  // Through the same gate as the series itself: who releases a series a member cannot see is not theirs
  // to learn, and the answer must not differ from "no such series". Reintroduce by dropping the
  // `komga.series` call from either route: the walled member reads 200.
  assert.equal((await groups(walledTok)).statusCode, 404);
  assert.equal((await versions(walledTok)).statusCode, 404);
  assert.equal((await get('/api/series/s_gv_nope/groups')).statusCode, 404);
  assert.equal((await groups(memberTok)).statusCode, 200);
  assert.equal((await versions(memberTok)).statusCode, 200);
});

test('the admin editor carries the same figures, plus listed and a row of zeros for a vanished name', { skip }, async () => {
  await q(`UPDATE lib_series SET scanlator_prefs = '{"priority":[],"blocked":["Vanished Group"],"patienceDays":null}'::jsonb WHERE id = $1`, [S]);
  try {
    const r = await get(`/api/admin/series/${S}/scanlators`);
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    const byName = new Map<string, any>(j.groups.map((g: any) => [g.name, g]));
    const a = byName.get('Group A');
    assert.ok(a, JSON.stringify(j.groups.map((g: any) => g.name)));
    assert.deepEqual([a.releases, a.listed, a.onDisk], [4, 4, 2], 'listed equals releases; on disk from the stamps');
    assert.deepEqual(a.chapters, [1, 2, 3, 4]);
    assert.equal(a.cadence.kind, 'weekly');
    assert.deepEqual(byName.get('Group C').langs, ['pt-br'], 'the follower\'s persisted copies count too');
    // Reintroduce by dropping `pruned_at IS NULL` from the admin route's on-disk query: 1 -- the admin's
    // card says "1 on this server" for the chapter the cleanup deleted while the member's says nothing.
    assert.equal(byName.get('Group C').onDisk, 0, 'a tombstone is not on this server for the admin either');
    assert.ok(j.checkedAt && Date.now() - Date.parse(j.checkedAt) < 60_000, `the editor says how old it is: ${j.checkedAt}`);
    const gone = byName.get('Vanished Group');
    assert.ok(gone, 'the blocked name is still a row');
    assert.deepEqual([gone.releases, gone.listed, gone.onDisk, gone.chapters, gone.cadence.kind], [0, 0, 0, [], 'unknown']);
    assert.equal((await get(`/api/admin/series/${S}/scanlators`, memberTok)).statusCode, 403);
  } finally {
    await q('UPDATE lib_series SET scanlator_prefs = NULL WHERE id = $1', [S]);
  }
});

test('the add dialog\'s detail names the groups and how many chapters have more than one version', { skip }, async () => {
  // From the chapter list the detail already fetched: no second source call, nothing on disk yet.
  // Reintroduce by counting `chosen` instead of `chapters` for `versions`: it reads 0.
  const r = await get(`/api/sources/detail?source=${PRI}&sourceId=pri-1`);
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.count, 4, 'PREMISE: one copy per number under the blocklist (5 is Spam Group\'s alone)');
  assert.deepEqual(j.groups.map((g: any) => [g.name, g.releases, g.onDisk]), [['Group A', 4], ['Group B', 2], ['Spam Group', 1]].map((x) => [...x, 0]));
  assert.equal(j.groups[0].cadence.kind, 'weekly');
  assert.deepEqual(j.groups[0].chapters, [1, 2, 3, 4]);
  assert.equal(j.versions, 1, 'chapter 3 comes in two versions on this source');
});
