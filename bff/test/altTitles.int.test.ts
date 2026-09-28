// A series' other names (lib/altTitles.ts, v0.49.1; @TIGamingTV's list and parsing, PR #119), against real rows and
// the real routes: where they come from, what an admin may do with them, and every search that now asks under them.
//
//   - kept: from the main source's description at add time and whenever that source's details are read, from a
//     tracker import's synonyms when the import adds the series, and typed by an admin (the routes);
//   - carried by a merge, erased by a forget (forgetSeries.int.test.ts's coverage test holds the table list);
//   - asked under, EXACTLY: the add-time auto-follow, the nightly hunt, borrowed chapter names and the fill scan --
//     and a match through an other name is measured both ways, because a sequel's page can list its parent's name.
//
// The work here is "Northern Sword", which one site files as "Northern Blade Chronicle"; another carries "Northern
// Blade Chronicle Part Two", which CONTAINS that name and must never be taken for it.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.SCAN_CONCURRENCY = '1';
  process.env.SCAN_FIRST_ANSWER_MS = '60000';
  process.env.SCAN_SEARCH_MS = '2000';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_an';
const ADMIN = 'an-admin', MEMBER = 'an-member';
const OWN = 'an-own', ALT = 'an-alt', SEQUEL = 'an-sequel', LONG = 'an-long';
const TITLE = 'Northern Sword', OTHER = 'Northern Blade Chronicle', PART2 = 'Northern Blade Chronicle Part Two';
const DESCRIPTION = `A swordsman from the north.\n\nAlternative Titles: ${OTHER}; 북검전기; Hero`;
const R = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** What each site carries, and what its own series page calls it. */
const SITES: Record<string, Array<{ title: string; nums: number[]; page?: string; summary?: string }>> = {
  [OWN]: [
    { title: TITLE, nums: R(1, 12), summary: DESCRIPTION },
    { title: 'Detail Read Tale', nums: R(1, 12), summary: 'Plot.\n\nOther Names: Detail Read Other Name' },
    { title: 'Imported Tale', nums: R(1, 12) },
  ],
  [SEQUEL]: [{ title: PART2, nums: R(1, 30) }],
  // Files the work under its other name, and would line up either way -- but lists far past us, so a match
  // through an other name, measured both ways, refuses it.
  [LONG]: [{ title: OTHER, nums: R(1, 40) }],
  [ALT]: [
    { title: OTHER, nums: R(1, 12) },
    // A donor for borrowed names: found by the title in its search, but its own page calls the work the other name.
    { title: TITLE, nums: R(1, 12), page: OTHER },
  ],
};
const ORDER: Record<string, number> = { [OWN]: 0, [SEQUEL]: 1, [LONG]: 2, [ALT]: 3 };
const searches: string[] = [];
/** Which of an-alt's two entries its search answers with: the other name (hunt, fill, add) or the donor. */
let altServesDonor = false;

function site(id: string) {
  const entries = () => (id === ALT ? SITES[ALT].filter((e) => !!e.page === altServesDonor) : SITES[id]);
  return {
    id, name: `Site ${id}`, lang: 'en', preferredOrder: ORDER[id],
    async search(term: string) {
      searches.push(`${id}:${term}`);
      const k = norm(term);
      return entries().filter((e) => norm(e.title).includes(k) || k.includes(norm(e.title)))
        .map((e) => ({ sourceId: `${id}|${e.title}`, source: id, title: e.title }));
    },
    async getSeries(sid: string) {
      const e = SITES[id].find((x) => `${id}|${x.title}` === sid);
      return e ? { sourceId: sid, source: id, title: e.page ?? e.title, summary: e.summary ?? 'No other names here.' } : null;
    },
    async listChapters(sid: string) {
      const e = SITES[id].find((x) => `${id}|${x.title}` === sid);
      return (e?.nums ?? []).map((n) => ({ sourceId: `${sid}#${n}`, number: n, title: `Chapter ${n}: ${id} name ${n}`, lang: 'en' }));
    },
    async getPageUrls() { return []; },
  };
}

let q: any, app: any, adminAuth: Record<string, string>, memberAuth: Record<string, string>, adminId = '';
const S = (k: string) => `s_an_${k}`;

/** A series of `own`'s entry `title`, holding chapters 1..8 and listing 1..12. */
async function series(key: string, title: string) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!an',$2,$1,8,$3,$4,$5,true)`, [S(key), title, LIB, OWN, `${OWN}|${title}`]);
  for (const n of R(1, 8)) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1,$2,'T!an',$3,$4,$5,5)`,
      [`${S(key)}_b${n}`, S(key), `${S(key)}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  for (const n of R(1, 12)) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,$3,$4::jsonb)`,
      [S(key), n, OWN, JSON.stringify({ sourceId: `c${n}`, number: n, source: OWN })]);
  }
}
const names = async (id: string) =>
  (await q('SELECT title, origin, added_by FROM series_alt_titles WHERE series_id = $1 ORDER BY title', [id])) as Array<{ title: string; origin: string; added_by: string | null }>;
const until = async (cond: () => Promise<boolean>, what: string, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  for (const id of Object.keys(SITES)) registerAdapter(site(id) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'AN',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const memberId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','member','password') RETURNING id`, [MEMBER]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  adminAuth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
  memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: memberId, role: 'member' })}` };
});

beforeEach(async () => {
  if (!DSN) return;
  searches.length = 0;
  altServesDonor = false;
  (await import('../src/routes/sources')).clearDetailCache();
  await q('DELETE FROM lib_series WHERE library_id = $1 OR folder LIKE $2', [LIB, `Site ${OWN}/%`]);
  await q(`DELETE FROM source_health WHERE source_id LIKE 'an-%'`);
  await q('UPDATE server_settings SET auto_follow_on_failure = true, borrow_names = false WHERE id = 1');
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_series WHERE library_id = $1 OR folder LIKE $2', [LIB, `Site ${OWN}/%`]).catch(() => {});
  await q('DELETE FROM import_batches WHERE user_id = $1', [adminId]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]).catch(() => {});
  await q(`DELETE FROM source_health WHERE source_id LIKE 'an-%'`).catch(() => {});
  await q('UPDATE server_settings SET borrow_names = false WHERE id = 1').catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test("a series' other names: read, add, remove, and every refusal", { skip }, async () => {
  await series('r', TITLE);
  const url = `/api/admin/series/${S('r')}/alt-titles`;
  const get = async () => (await app.inject({ method: 'GET', url, headers: adminAuth })).json();
  const add = (title: unknown, headers = adminAuth) => app.inject({ method: 'POST', url, headers, payload: { title } });
  assert.deepEqual(await get(), { titles: [] });

  const r = await add('  Northern Blade Chronicle ');
  assert.equal(r.statusCode, 200, r.body);
  const [t] = r.json().titles;
  assert.deepEqual({ ...t, createdAt: typeof t.createdAt }, {
    title: OTHER, norm: 'northernbladechronicle', origin: 'admin', addedBy: ADMIN, createdAt: 'string',
  });
  const stored = await names(S('r'));
  assert.equal(stored[0].added_by, adminId, 'stored by account id, answered by name');

  // Refused before anything is written. Reintroduce by dropping refuseName from the route: "Hero" is kept.
  assert.deepEqual([(await add('Hero')).statusCode, (await add('Hero')).json().error], [400, 'too_short']);
  assert.deepEqual([(await add('북검전기')).statusCode, (await add('북검전기')).json().error], [400, 'non_latin']);
  assert.deepEqual([(await add('NORTHERN blade-chronicle!')).statusCode, (await add('x').then(() => 'ok'))], [409, 'ok'], 'the same key is the same name');
  assert.equal((await add(TITLE)).json().error, 'exists', 'the series already goes by its own title');
  assert.equal((await add('')).statusCode, 400);
  assert.equal((await add('x'.repeat(201))).statusCode, 400);
  assert.equal((await add('Something Longer', memberAuth)).statusCode, 403, 'admins only');
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/series/s_an_nobody/alt-titles', headers: adminAuth })).statusCode, 404);
  assert.equal((await names(S('r'))).length, 1);

  const del = await app.inject({ method: 'DELETE', url: `${url}/northernbladechronicle`, headers: adminAuth });
  assert.deepEqual(del.json(), { titles: [] });
  assert.deepEqual((await app.inject({ method: 'DELETE', url: `${url}/northernbladechronicle`, headers: adminAuth })).json(), { titles: [] }, 'idempotent');
  const audit = await q(`SELECT event FROM audit_log WHERE event LIKE 'series.alt_title.%' AND detail->>'id' = $1 ORDER BY at`, [S('r')]);
  assert.deepEqual(audit.map((a: any) => a.event).slice(0, 2), ['series.alt_title.add', 'series.alt_title.remove']);
});

test("an add keeps the names its source's description lists, and the add's auto-follow matches a candidate under one", { skip }, async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/sources/add', headers: adminAuth,
    payload: { source: OWN, sourceId: `${OWN}|${TITLE}`, chapterFrom: 'none', alsoFollow: [{ source: ALT, sourceId: `${ALT}|${OTHER}` }] },
  });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().seriesId;
  // Reintroduce by dropping learnAltTitles from the nothing-yet branch: nothing is kept.
  assert.deepEqual((await names(id)).map((n) => [n.title, n.origin, n.added_by]), [[OTHER, 'description', null]],
    'the Latin name, not the Korean one, not the one too short to be an identity');
  // The candidate's own page calls the work by that other name: followed. Reintroduce by dropping the stored names
  // from autoFollow (`opts.altTitles ?? []`): title_differs.
  const folder = r.json().folder;
  let card: any;
  await until(async () => {
    const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json();
    card = jobs.content.find((c: any) => c.folder === folder);
    return !!card?.autoFollow?.done;
  }, 'the auto-follow judgement');
  assert.deepEqual(card.autoFollow.results.map((x: any) => [x.source, x.why]), [[ALT, 'followed']]);
});

test("a read of a series' main source keeps the names its description lists", { skip }, async () => {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
           VALUES ($1,'T!an','Detail Read Tale',$1,0,$2,$3,$4)`, [S('d'), LIB, OWN, `${OWN}|Detail Read Tale`]);
  const r = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${OWN}&sourceId=${encodeURIComponent(`${OWN}|Detail Read Tale`)}`, headers: adminAuth });
  assert.equal(r.statusCode, 200, r.body);
  // Detached from the read: waited for here. Reintroduce by dropping learnFromMainSource from seriesAndChapters.
  await until(async () => (await names(S('d'))).length > 0, 'the names of the details read');
  assert.deepEqual((await names(S('d'))).map((n) => [n.title, n.origin]), [['Detail Read Other Name', 'description']]);
});

test("an import that adds a series keeps its tracker's other names", { skip }, async () => {
  const batch = (await q(`INSERT INTO import_batches (user_id, origin, state, total) VALUES ($1, 'tracker', 'review', 1) RETURNING id`, [adminId]))[0].id;
  await q(`INSERT INTO import_candidates (batch_id, ord, backup_title, decision, match_source, match_source_id, alt_titles)
           VALUES ($1, 0, 'Imported Tale', 'auto', $2, $3, $4)`, [batch, OWN, `${OWN}|Imported Tale`, ['Imported Tale Romaji', 'Tiny', '임포트']]);
  const r = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batch}/run`, headers: adminAuth });
  assert.equal(r.statusCode, 200, r.body);
  await until(async () => (await q(`SELECT status FROM import_candidates WHERE batch_id = $1`, [batch]))[0].status !== null, 'the import');
  const [{ id }] = await q(`SELECT id FROM lib_series WHERE source_series_id = $1`, [`${OWN}|Imported Tale`]);
  // Reintroduce by dropping the recordAltTitles call from the import's 'added' branch: nothing is kept.
  assert.deepEqual((await names(id)).map((n) => [n.title, n.origin, n.added_by]), [['Imported Tale Romaji', 'import', adminId]]);
  await q('DELETE FROM import_batches WHERE id = $1', [batch]);
});

test('a merge carries the other names to the survivor', { skip }, async () => {
  const { mergeSeries } = await import('../src/lib/libraryAdmin');
  const { recordAltTitles } = await import('../src/lib/altTitles');
  await series('keep', 'Merge Keep');
  await series('gone', 'Merge Gone');
  await recordAltTitles(S('keep'), ['Keep Other Name'], 'admin', { userId: adminId });
  await recordAltTitles(S('gone'), ['Gone Other Name', 'Keep Other Name'], 'description');
  // A name that is the survivor's own title is not an OTHER name of it (written straight in: the writer refuses it).
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1, 'mergekeep', 'Merge Keep', 'import')`, [S('gone')]);
  await mergeSeries(S('gone'), S('keep'));
  // Reintroduce by dropping carryAltTitles from mergeSeries: the survivor has only its own name.
  assert.deepEqual((await names(S('keep'))).map((n) => [n.title, n.origin]), [['Gone Other Name', 'description'], ['Keep Other Name', 'admin']],
    "the survivor keeps its own row where both had a name, and its own title is not carried");
  assert.deepEqual(await names(S('gone')), [], 'the names left the absorbed row');
});

test('a match through an other name is measured both ways', { skip }, async () => {
  const { judgeCandidate } = await import('../src/lib/autoFollow');
  const numbers = R(1, 12);
  // LONG files the work under the other name and lists 1..40. Under the MAIN title an exact match on twelve
  // numbers is trusted one way (it is the same book, further along) -- under an other name it must also be mostly
  // inside us. Reintroduce by trusting any exact match one way (autoFollow.ts `oneWay`): this reads ok.
  const viaAlt = await judgeCandidate({ title: TITLE, altTitles: [OTHER], numbers }, { source: LONG, sourceId: `${LONG}|${OTHER}` });
  assert.equal(viaAlt.why, 'numbering_differs');
  assert.equal(viaAlt.coverage, 0.3);
  const viaMain = await judgeCandidate({ title: OTHER, altTitles: [], numbers }, { source: LONG, sourceId: `${LONG}|${OTHER}` });
  assert.equal(viaMain.why, 'ok', 'the main title keeps its one-way trust');
  // And the sequel whose title merely contains the other name is not this series at all.
  const sequel = await judgeCandidate({ title: TITLE, altTitles: [OTHER], numbers }, { source: SEQUEL, sourceId: `${SEQUEL}|${PART2}` });
  assert.equal(sequel.why, 'title_differs');
});

test('the hunt searches under the other names, exactly, and follows what they find', { skip }, async () => {
  const { huntSource } = await import('../src/lib/sourceHunt');
  const { recordAltTitles } = await import('../src/lib/altTitles');
  await series('h', TITLE);
  await recordAltTitles(S('h'), [OTHER], 'admin', { userId: adminId });
  const r = await huntSource(S('h'), 12, { allowed: () => true, budget: { left: 5 } });
  // Reintroduce by searching the title alone (sourceHunt.ts huntCandidates): no source carries "Northern Sword".
  assert.equal(r.why, 'followed', JSON.stringify(r));
  assert.equal(r.followed?.source, ALT);
  assert.ok(searches.includes(`${ALT}:${OTHER}`));
  // The sequel answered the other name with a title that CONTAINS it: never taken, so never followed; and LONG,
  // judged both ways, was refused before ALT was reached.
  const rows = await q('SELECT source_id FROM series_sources WHERE series_id = $1', [S('h')]);
  assert.deepEqual(rows.map((x: any) => x.source_id), [ALT]);
});

test('borrowed chapter names come from a donor whose own page calls the work by an other name', { skip }, async () => {
  const { borrowNamesFor } = await import('../src/lib/borrowNames');
  const { recordAltTitles } = await import('../src/lib/altTitles');
  await q('UPDATE server_settings SET borrow_names = true WHERE id = 1');
  altServesDonor = true;
  await series('b', TITLE);
  await q(`UPDATE lib_books SET chapter_name = NULL WHERE series_id = $1`, [S('b')]);
  await recordAltTitles(S('b'), [OTHER], 'admin', { userId: adminId });
  const r = await borrowNamesFor(S('b'), { force: true });
  // Reintroduce by passing no names into PrimaryFacts (borrowNames.ts): the donor reads title_differs, no_donor.
  assert.equal(r.donor, ALT, JSON.stringify(r));
  assert.equal(r.named, 8);
});

test('the fill scan searches under the other names, exactly', { skip }, async () => {
  const { recordAltTitles } = await import('../src/lib/altTitles');
  await series('f', TITLE);
  await recordAltTitles(S('f'), [OTHER], 'admin', { userId: adminId });
  const r = await app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: adminAuth, payload: { seriesId: S('f') } });
  assert.equal(r.statusCode, 200, r.body);
  const plan = r.json();
  assert.equal(plan.done, true);
  const found = plan.candidates.filter((c: any) => !c.pinned && c.sourceSeriesId).map((c: any) => c.source).sort();
  // Reintroduce by searching the title and the typed name alone: neither ALT nor LONG is found. By matching an other
  // name with pickBest: the sequel is found by containment.
  assert.deepEqual(found, [ALT, LONG].sort());
  assert.ok(searches.includes(`${ALT}:${OTHER}`));
  assert.ok(searches.includes(`${SEQUEL}:${OTHER}`), 'the sequel was asked, and its containing title refused');
});
