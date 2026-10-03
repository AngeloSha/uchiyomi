// The same-language guard (v0.52.0, #123), against real rows and the real routes.
//
// p3t3t3 asked for MangaDex in Spanish beside the English, and the one thing that must not follow is a mixed series:
// the updater merges every followed source into one list, one copy per number, so an English series following a
// Spanish source reads each chapter in whichever language won that number. Every AUTOMATIC path that follows a source
// now keeps to the series' language (lib/seriesLang.ts), and each is asserted here by what the fake sites were
// asked and what was written:
//
//   - the add's auto-follow refuses the Spanish source as `language_differs` without asking it anything;
//   - the hunt never searches it, even when it is the only source listing the number it wants;
//   - Find other sources never searches it (a series with nothing else to ask is `no_source`), and a review's stored
//     match in another language is refused at the follow;
//   - Find missing chapters never asks it, and the manual follow refuses a stale plan's Spanish source with both
//     languages and the edition to add instead;
//   - borrowed names come in the series' OWN language, stated, not its main source's;
//   - a Spanish series follows the Spanish source, and the unstated language decides for sites that declare none.
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
  // A scan's whole answer from POST (v0.48.4 answers after SCAN_FIRST_ANSWER_MS with what it has).
  process.env.SCAN_FIRST_ANSWER_MS = '60000';
  process.env.SCAN_SEARCH_MS = '2000';
  process.env.SCAN_CONCURRENCY = '1';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_lg';
const TITLE = 'Guarded Tale';
const EN = 'lg-en';       // the series' own source, English, 1..12
const ES = 'lg-es';       // MangaDex (ES-419)'s shape: Spanish, the same work, 1..13 -- the one that lists 13
const EN2 = 'lg-en2';     // another English source, 1..12
const SITE = 'lg-site';   // an add-a-site engine: declares no language, 1..12
const ADMIN = 'lg-admin';
const S = (k: string) => `s_lg_${k}`;
const R = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Searches and chapter-list asks, per source: whether a source was ASKED at all. */
const searches: Record<string, number> = {};
const asks: Record<string, number> = {};

function fake(id: string, lang: string | undefined, nums: number[], name: (n: number) => string = (n) => `Chapter ${n}`) {
  return {
    id, name: `Name ${id}`, ...(lang ? { lang } : {}),
    async search() {
      searches[id] = (searches[id] ?? 0) + 1;
      return [{ sourceId: `${id}|s`, source: id, title: TITLE }];
    },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: TITLE }; },
    async listChapters() {
      asks[id] = (asks[id] ?? 0) + 1;
      return nums.map((n) => ({ sourceId: `${id}-c${n}`, number: n, title: name(n) }));
    },
    async getPageUrls() { return []; },
    async latest() { return []; },
  };
}

let q: any, app: any, auth: Record<string, string>, adminId = '';
let autoFollow: any, huntSource: any, borrowNamesFor: any, setUnstatedLang: any, findLib: any;

/** A series of `own` holding and listing 1..12, in `lang` when it is stated. */
async function series(key: string, o: { own?: string; lang?: string | null } = {}) {
  const own = o.own ?? EN;
  await q('DELETE FROM lib_series WHERE id = $1', [S(key)]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, lang)
           VALUES ($1,'T!lg',$2,$1,12,$3,$4,$5,true,$6)`, [S(key), TITLE, LIB, own, `${own}|s`, o.lang ?? null]);
  for (const n of R(1, 12)) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!lg',$3,$4,$5,'/library')`,
      [`${S(key)}_b${n}`, S(key), `${S(key)}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,$3,$4::jsonb)`,
      [S(key), n, own, JSON.stringify({ sourceId: `${own}-c${n}`, number: n, source: own })]);
  }
}
const followed = async (key: string) =>
  (await q('SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY source_id', [S(key)])).map((r: any) => r.source_id);
const candidate = (source: string) => ({ source, sourceId: `${source}|s` });

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter(fake(EN, 'en', R(1, 12)) as any);
  registerAdapter(fake(ES, 'es-419', R(1, 13), (n) => `Chapter ${n}: Nombre ${n}`) as any);
  registerAdapter(fake(EN2, 'en', R(1, 12), (n) => `Chapter ${n}: Name ${n}`) as any);
  registerAdapter(fake(SITE, undefined, R(1, 12)) as any);
  ({ autoFollow } = (await import('../src/lib/autoFollow')) as any);
  ({ huntSource } = (await import('../src/lib/sourceHunt')) as any);
  ({ borrowNamesFor } = (await import('../src/lib/borrowNames')) as any);
  ({ setUnstatedLang } = (await import('../src/lib/lang')) as any);
  findLib = await import('../src/lib/findSources');

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Guard',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
});

beforeEach(async () => {
  if (!DSN) return;
  for (const k of Object.keys(searches)) delete searches[k];
  for (const k of Object.keys(asks)) delete asks[k];
  setUnstatedLang('en');
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
  await q(`DELETE FROM source_health WHERE source_id LIKE 'lg-%'`);
  await q('DELETE FROM source_find_runs');
  await q('UPDATE server_settings SET auto_follow_on_failure = true, borrow_names = false WHERE id = 1');
});

after(async () => {
  if (!DSN) return;
  setUnstatedLang('en');
  await findLib?.findSettled();
  await app?.close();
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await q(`DELETE FROM source_health WHERE source_id LIKE 'lg-%'`).catch(() => {});
  await q('DELETE FROM source_find_runs').catch(() => {});
  await q('UPDATE server_settings SET borrow_names = false WHERE id = 1').catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('auto-follow refuses a source in another language, without asking it anything', { skip }, async () => {
  await series('add');
  const results = await autoFollow(S('add'), [candidate(ES), candidate(EN2)]);
  const why = Object.fromEntries(results.map((r: any) => [r.source, r.why]));
  // Reintroduce by dropping the language check in judgeCandidate: the Spanish source is asked and followed.
  assert.equal(why[ES], 'language_differs');
  assert.equal(asks[ES] ?? 0, 0, 'the Spanish source was asked for its chapters');
  assert.equal(why[EN2], 'followed', 'the English source is followed as before');
  assert.deepEqual(await followed('add'), [EN2]);
});

test('a Spanish series follows the Spanish source, and refuses the English one', { skip }, async () => {
  await series('es', { lang: 'es-419' });
  const results = await autoFollow(S('es'), [candidate(ES), candidate(EN2)]);
  assert.deepEqual(results.map((r: any) => [r.source, r.why]), [[ES, 'followed'], [EN2, 'language_differs']]);
  assert.deepEqual(await followed('es'), [ES]);
});

test('a site that declares no language is in the unstated language, English unless the admin says otherwise', { skip }, async () => {
  await series('site', { own: SITE });
  const first = await autoFollow(S('site'), [candidate(ES), candidate(EN2)]);
  assert.deepEqual(first.map((r: any) => [r.source, r.why]), [[ES, 'language_differs'], [EN2, 'followed']]);
  // Admin -> Providers' "Sites that do not say their language are in": Spanish. Now the site's series is Spanish.
  await q('DELETE FROM series_sources WHERE series_id = $1', [S('site')]);
  setUnstatedLang('es');
  const flipped = await autoFollow(S('site'), [candidate(ES), candidate(EN2)]);
  assert.deepEqual(flipped.map((r: any) => [r.source, r.why]), [[ES, 'followed'], [EN2, 'language_differs']]);
});

test('the hunt never searches a source in another language, even the only one listing the number', { skip }, async () => {
  await series('hunt');
  const r = await huntSource(S('hunt'), 13, { allowed: () => true, budget: { left: 5 } });
  // Reintroduce by dropping the guard's filter in huntCandidates: the Spanish source is searched (and then refused).
  assert.equal(searches[ES] ?? 0, 0, 'the Spanish source was searched');
  assert.equal(r.chapter, null, 'chapter 13 came from a source in another language');
  assert.ok((searches[EN2] ?? 0) > 0, 'the English sources were searched: the hunt ran');
  assert.ok(!(await followed('hunt')).includes(ES));
});

test('a Find other sources run never searches a source in another language', { skip }, async () => {
  await series('find');
  // Every other English source is off, so the Spanish one is all there would be to ask.
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ($1, true), ($2, true)`, [EN2, SITE]);
  const r = await app.inject({ method: 'POST', url: '/api/admin/sources/find', headers: auth, payload: { seriesIds: [S('find')] } });
  assert.equal(r.statusCode, 202, r.body);
  await findLib.findSettled();
  const st = (await app.inject({ method: 'GET', url: '/api/admin/sources/find', headers: auth })).json();
  // Reintroduce by dropping the guard's filter in findFor: the Spanish source is searched, and the series reads
  // no_answer (the judgement refused it) instead of no_source.
  assert.equal(searches[ES] ?? 0, 0, 'the Spanish source was searched');
  assert.deepEqual(st.run.results.map((x: any) => [x.seriesId, x.why]), [[S('find'), 'no_source']]);
});

test('a review\'s match in another language is refused at the follow, by name', { skip }, async () => {
  await series('review');
  // A review-first run kept from before the guard: it proposed the Spanish source for the English series.
  const proposal = {
    sourceId: ES, sourceName: `Name ${ES}`, sourceSeriesId: `${ES}|s`, title: TITLE, chapters: 13,
    ours: { lined: 12, of: 12 }, theirs: { lined: 12, of: 13 }, coverage: 1, verdict: 'green',
  };
  const [{ id }] = await q(
    `INSERT INTO source_find_runs (started_by, status, scope, total, done, followed, results)
     VALUES ($1, 'done', $2::jsonb, 1, 1, 0, $3::jsonb) RETURNING id`,
    [adminId, JSON.stringify({ seriesIds: [S('review')], review: true }), JSON.stringify([{ seriesId: S('review'), title: TITLE, followed: [], proposals: [proposal] }])]);
  const r = await app.inject({ method: 'POST', url: `/api/admin/sources/find/${id}/follow`, headers: auth, payload: { seriesId: S('review'), sourceId: ES } });
  // Reintroduce by dropping the guard in decideProposal: 200, and the series follows the Spanish source.
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'language_differs');
  // What has both is an edition, as the manual follow's refusal says (the web offers "Add it as an edition" from it).
  // Reintroduce by refusing without `edition`: the review's Follow has no way on.
  assert.deepEqual(r.json().edition, { of: S('review'), lang: 'es-419' }, 'the add route\'s own edition shape');
  assert.deepEqual(await followed('review'), []);
});

test('Find missing chapters never asks a source in another language', { skip }, async () => {
  await series('fill');
  const r = await app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: auth, payload: { seriesId: S('fill') } });
  assert.equal(r.statusCode, 200, r.body);
  // Reintroduce by dropping the guard's filter in runFillScan: the Spanish source is searched and offered.
  assert.equal(searches[ES] ?? 0, 0, 'the Spanish source was searched');
  assert.ok(!r.json().candidates.some((c: any) => c.source === ES), 'the Spanish source was offered');
  assert.ok(r.json().candidates.some((c: any) => c.source === EN2), 'the English source is offered as before');
});

test('the manual follow refuses a stale plan\'s source in another language, and says how to have both', { skip }, async () => {
  // The plan was made while the series was stated Spanish, so it offers the Spanish source; then an admin set the
  // series back to English. Following from that plan is what the backstop is for.
  await series('manual', { lang: 'es-419' });
  const scan = (await app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: auth, payload: { seriesId: S('manual') } })).json();
  const es = scan.candidates.find((c: any) => c.source === ES);
  assert.ok(es, `the Spanish series' scan offers the Spanish source: ${JSON.stringify(scan.candidates.map((c: any) => c.source))}`);
  await q('UPDATE lib_series SET lang = $2 WHERE id = $1', [S('manual'), 'en']);
  const r = await app.inject({
    method: 'POST', url: `/api/admin/series/${S('manual')}/sources`, headers: auth,
    payload: { planId: scan.planId, source: ES, sourceSeriesId: es.sourceSeriesId },
  });
  // Reintroduce by dropping the route's guard: 200, and the English series follows the Spanish source.
  assert.equal(r.statusCode, 409, r.body);
  const body = r.json();
  assert.equal(body.error, 'language_differs');
  assert.deepEqual(body.messageSaid, { code: 'follow.languageDiffers', params: { theirs: 'es-419', ours: 'en' } });
  assert.match(body.message, /^That source is in Latin American Spanish and this series is in English\. Add it as an edition/);
  assert.deepEqual(body.edition, { of: S('manual'), lang: 'es-419' }, 'the add route\'s own edition shape');
  assert.deepEqual(await followed('manual'), []);
});

test('the refusal points at the edition the work holds in that language, the manual follow\'s and the review\'s', { skip }, async () => {
  // The v0.52.0 check pass: an English series whose work holds a Spanish edition was told "Add it as an edition in
  // Spanish instead", and the add then ended on "already in your library". That edition can follow the source, so
  // the refusal says so and carries it, and the web's key opens it. A plan from while the series was Spanish, as above.
  await series('both', { lang: 'es-419' });
  const scan = (await app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: auth, payload: { seriesId: S('both') } })).json();
  const es = scan.candidates.find((c: any) => c.source === ES);
  assert.ok(es, `the Spanish series' scan offers the Spanish source: ${JSON.stringify(scan.candidates.map((c: any) => c.source))}`);
  await q('UPDATE lib_series SET lang = $2 WHERE id = $1', [S('both'), 'en']);
  // Its Spanish edition, on the Spanish source, in one work with it.
  await series('both-es', { own: ES, lang: 'es-419' });
  await q('UPDATE lib_series SET work_id = $2 WHERE id = ANY($1)', [[S('both'), S('both-es')], '5a1e0000-0000-4000-8000-00000052c0d1']);
  const there = { of: S('both'), lang: 'es-419', existing: { id: S('both-es'), lang: 'es-419' } };
  const r = await app.inject({
    method: 'POST', url: `/api/admin/series/${S('both')}/sources`, headers: auth,
    payload: { planId: scan.planId, source: ES, sourceSeriesId: es.sourceSeriesId },
  });
  assert.equal(r.statusCode, 409, r.body);
  const body = r.json();
  assert.equal(body.error, 'language_differs');
  // Reintroduce by dropping editionFollowing from the manual follow's refusal: no `existing`, a second edition offered.
  assert.deepEqual(body.edition, there, 'the manual follow does not point at the Spanish edition');
  assert.deepEqual(body.messageSaid, { code: 'follow.languageDiffersEdition', params: { theirs: 'es-419', ours: 'en', edition: 'es-419' } });
  assert.equal(body.message, 'That source is in Latin American Spanish and this series is in English. Follow it on the Latin American Spanish edition instead.');
  // The review's Follow, the same way.
  const proposal = {
    sourceId: ES, sourceName: `Name ${ES}`, sourceSeriesId: `${ES}|s`, title: TITLE, chapters: 13,
    ours: { lined: 12, of: 12 }, theirs: { lined: 12, of: 13 }, coverage: 1, verdict: 'green',
  };
  const [{ id }] = await q(
    `INSERT INTO source_find_runs (started_by, status, scope, total, done, followed, results)
     VALUES ($1, 'done', $2::jsonb, 1, 1, 0, $3::jsonb) RETURNING id`,
    [adminId, JSON.stringify({ seriesIds: [S('both')], review: true }), JSON.stringify([{ seriesId: S('both'), title: TITLE, followed: [], proposals: [proposal] }])]);
  const rr = await app.inject({ method: 'POST', url: `/api/admin/sources/find/${id}/follow`, headers: auth, payload: { seriesId: S('both'), sourceId: ES } });
  assert.equal(rr.statusCode, 409, rr.body);
  // Reintroduce by dropping it from decideProposal's refusal: the review offers a second Spanish edition.
  assert.deepEqual(rr.json().edition, there, 'the review does not point at the Spanish edition');
  assert.deepEqual(await followed('both'), []);
});

test('names are borrowed in the series\' own language, stated, not its main source\'s', { skip }, async () => {
  // A Spanish title that came in through the English adapter's fallback: its main source says English, the series
  // says Spanish (the v0.52.0 data migration, or an admin).
  await q('UPDATE server_settings SET borrow_names = true WHERE id = 1');
  await series('names', { lang: 'es-419' });
  const r = await borrowNamesFor(S('names'), { force: true });
  // Reintroduce the main source's declared language as `want`: the English donor names the chapters in English.
  assert.equal(r.donor, ES, JSON.stringify(r));
  const b3 = (await q('SELECT chapter_name, chapter_name_source FROM lib_books WHERE id = $1', [`${S('names')}_b3`]))[0];
  assert.deepEqual([b3.chapter_name, b3.chapter_name_source], ['Nombre 3', ES]);
  assert.equal(searches[EN2] ?? 0, 0, 'an English source was asked for a Spanish series\' names');
});

test('Replace never promotes a follower in another language: it is passed over, and the series is searched for', { skip }, async () => {
  // v0.54.0: an English series that somehow follows the Spanish source (a follow from before the guard) whose main source
  // is replaced. Reintroduce by dropping the language test in lib/replaceSource.ts rankFollowers: the Spanish follower
  // becomes the series' main source.
  await series('rep');
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $3)`, [S('rep'), ES, `${ES}|s`]);
  // The series' own source is switched off; the other English one carries it.
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ($1, true), ($2, true)`, [EN, SITE]);
  const r = await app.inject({ method: 'POST', url: '/api/admin/sources/find', headers: auth, payload: { sourceId: EN, mode: 'replace' } });
  assert.equal(r.statusCode, 202, r.body);
  await findLib.findSettled();
  const res = (await app.inject({ method: 'GET', url: '/api/admin/sources/find', headers: auth })).json().run.results[0];
  assert.deepEqual(res.skipped, [{ sourceId: ES, name: `Name ${ES}`, why: 'language' }], 'the Spanish follower is passed over');
  assert.deepEqual([res.promoted?.to, res.promoted?.via], [EN2, 'search'], 'and the series is searched for, and moved to the English source');
  assert.equal((await q('SELECT source_id FROM lib_series WHERE id = $1', [S('rep')]))[0].source_id, EN2);
  assert.equal(searches[ES] ?? 0, 0, 'the Spanish source was never searched');
});
