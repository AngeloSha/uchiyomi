// Find other sources, and a series a source files under a name of its own (v0.95.0, #316).
//
// TIGamingTV's "Revenge of the Iron-Blooded Sword Hound" is "Revenge of the Baskerville Bloodhound" on Atsumaru, Manga
// Ball and MangaFire. Each answered with it first for the title and for the series' other names, and the run said it
// found nothing, because no name of the series is that title. Chapter numbers cannot say it is the same series (any
// two 185-chapter series number 1..185), so the rule is a person's call:
//
//   - an automatic run never follows such a result, and no other name is kept;
//   - a review-first run proposes it amber (`their_name`) when the source gave it first under two or more of the
//     series' names and its chapter numbers line up both ways -- never on one name's first result, never when the
//     numbers do not line up -- and it is not a carrier, so the sources after it are still asked;
//   - following the proposal follows exactly that series and keeps the source's name as the admin's own.
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
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_tn';
const MAIN = 'tn-main';
const ADMIN = 'tn-admin';
const S = 's_tn_hound';
const TITLE = 'Iron-Blooded Sword Hound';
const OTHER = 'Cheolhyeol Geomga Sanyanggae';
const THEIRS = 'Baskerville Bloodhound';
const R = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Each fake site: what its search answers for a term, and what each of its series lists.
 *   tn-a: files the series under its own name, and answers with it for the series' title and its other name -- first,
 *         ahead of an unrelated one. It lines up: 1..12, as the series does.
 *   tn-b: answers every search with the same long-running series first. Tied under both names, and its numbers do not
 *         line up (1..200 against our 1..12): never proposed.
 *   tn-c: answers the title alone with a series that would line up. One name's first result is never enough.
 */
const LISTS: Record<string, Record<string, number[]>> = {
  'tn-a': { [THEIRS]: R(1, 12), 'Sword Clan Story': R(1, 40) },
  'tn-b': { 'Popular Giant': R(1, 200) },
  'tn-c': { 'One Name Wonder': R(1, 12) },
};
function answer(id: string, term: string): string[] {
  const k = norm(term);
  if (id === 'tn-a') return [norm(TITLE), norm(OTHER), norm(THEIRS)].includes(k) ? [THEIRS, 'Sword Clan Story'] : [];
  if (id === 'tn-b') return ['Popular Giant'];
  if (id === 'tn-c') return k === norm(TITLE) ? ['One Name Wonder'] : [];
  return [];
}
const searches: string[] = [];
function fake(id: string, order: number) {
  return {
    id, name: `Name ${id}`, lang: 'en', preferredOrder: order,
    async search(term: string) {
      searches.push(`${id}:${term}`);
      return answer(id, term).map((title) => ({
        sourceId: `${id}|${title}`, source: id, title, coverUrl: `https://${id}.example/${norm(title)}.jpg`, url: `https://${id}.example/${norm(title)}`,
      }));
    },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid.split('|')[1] }; },
    async listChapters(sid: string) {
      return (LISTS[id][sid.split('|')[1]] ?? []).map((n) => ({ sourceId: `${sid}#${n}`, number: n }));
    },
    async getPageUrls() { return []; },
  };
}

let q: any, app: any, adminAuth: Record<string, string>, adminId = '';
let fsLib: typeof import('../src/lib/findSources');

const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/admin/sources/find', headers: adminAuth, payload });
const state = async () => {
  const r = await app.inject({ method: 'GET', url: '/api/admin/sources/find?adult=1', headers: adminAuth });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const run = async (payload: Record<string, unknown>) => {
  const r = await post({ seriesIds: [S], ...payload });
  assert.equal(r.statusCode, 202, r.body);
  await fsLib.findSettled();
  return r.json().runId as string;
};
const followers = async () => (await q('SELECT source_id, source_series_id FROM series_sources WHERE series_id = $1 ORDER BY 1', [S]))
  .map((x: any) => `${x.source_id}:${x.source_series_id}`);
const names = async () => (await q('SELECT title, origin, added_by FROM series_alt_titles WHERE series_id = $1 AND removed_at IS NULL ORDER BY title', [S]))
  .map((x: any) => `${x.title}:${x.origin}:${x.added_by === adminId ? 'admin' : x.added_by}`);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  const { siteOffline } = await import('../src/lib/sources/offline');
  registerAdapter({
    id: MAIN, name: 'Main Down', lang: 'en', preferredOrder: 0,
    async search() { throw siteOffline('Main Down is temporarily offline'); },
    async getSeries() { throw siteOffline('Main Down is temporarily offline'); },
    async listChapters() { throw siteOffline('Main Down is temporarily offline'); },
    async getPageUrls() { throw siteOffline('Main Down is temporarily offline'); },
  } as any);
  registerAdapter(fake('tn-a', 1) as any);
  registerAdapter(fake('tn-b', 2) as any);
  registerAdapter(fake('tn-c', 3) as any);
  fsLib = await import('../src/lib/findSources');
  (await import('../src/lib/healthSummary')).setSummaryRefresh(async () => {}, { everyMs: 1 });

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'TN',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  adminAuth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
});

beforeEach(async () => {
  if (!DSN) return;
  await fsLib.findSettled();
  searches.length = 0;
  fsLib.setFindTiming({ paceMs: 0, wallMs: 10_000, quietMs: 20 });
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
  await q('DELETE FROM source_find_runs');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'tn-%'`);
  (await import('../src/lib/downloadJobs')).clearRuns();
  // The series of the down main source, listing 1..12 there, with one other name.
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!tn',$2,$1,0,$3,$4,$5,true)`, [S, TITLE, LIB, MAIN, `${MAIN}|${TITLE}`]);
  for (const n of R(1, 12)) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,$3,$4::jsonb)`,
      [S, n, MAIN, JSON.stringify({ sourceId: `c${n}`, number: n, source: MAIN })]);
  }
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1,$2,$3,'description')`, [S, norm(OTHER), OTHER]);
});

after(async () => {
  if (!DSN) return;
  await fsLib?.findSettled();
  fsLib?.setFindTiming();
  (await import('../src/lib/healthSummary')).setSummaryRefresh();
  await app?.close();
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await q(`DELETE FROM source_health WHERE source_id LIKE 'tn-%'`).catch(() => {});
  await q('DELETE FROM source_find_runs').catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('an automatic run never follows a name only the source gives it', { skip }, async () => {
  // Reintroduce by judging `tied` in an automatic run and following it (dropping `a.review` from its guard in findFor
  // and `tied.has(i)` from the follows): tn-a is followed under a name nobody confirmed.
  await run({});
  const result = (await state()).run.results[0];
  assert.deepEqual([result.followed, result.why], [[], 'no_match']);
  assert.deepEqual(await followers(), []);
  assert.deepEqual(await names(), [`${OTHER}:description:null`], 'no name is kept without a person');
});

test('a review-first run proposes it amber, on two names and numbers that line up, and asks the sources after it', { skip }, async () => {
  // Reintroduce by taking one name's first result (tiedFirst answering firsts[0]): tn-c's "One Name Wonder" is proposed.
  // Reintroduce by trusting a match through an other name one way (judgeCandidate's `oneWay` without its main-title
  // test): tn-b's "Popular Giant", 1..200 over our 1..12, is proposed.
  const runId = await run({ review: true });
  const result = (await state()).run.results.find((x: any) => x.seriesId === S);
  assert.deepEqual(result.proposals.map((p: any) => [p.sourceId, p.title, p.verdict, p.amber, p.ours.lined, p.theirs.lined, p.coverUrl]),
    [['tn-a', THEIRS, 'amber', 'their_name', 12, 12, `https://tn-a.example/${norm(THEIRS)}.jpg`]]);
  // Not a carrier: tn-b and tn-c are still asked under every name.
  for (const id of ['tn-b', 'tn-c']) assert.ok(searches.includes(`${id}:${TITLE}`), `${id} was not asked after tn-a`);
  assert.deepEqual(await followers(), [], 'a review follows nothing');
  assert.ok(runId);
});

test('following a source\'s own name follows exactly that series and keeps the name', { skip }, async () => {
  // Reintroduce by dropping the recordAltTitles call in decide(): the name list is unchanged after the follow.
  const runId = await run({ review: true });
  const r = await app.inject({ method: 'POST', url: `/api/admin/sources/find/${runId}/follow`, headers: adminAuth, payload: { seriesId: S, sourceId: 'tn-a' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(await followers(), [`tn-a:tn-a|${THEIRS}`]);
  assert.deepEqual(await names(), [`${THEIRS}:admin:admin`, `${OTHER}:description:null`]);
  const [audit] = await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'via' = 'find_review' AND detail->>'id' = $1`, [S]);
  assert.deepEqual([audit.detail.source, audit.detail.amber, audit.detail.theirTitle], ['tn-a', 'their_name', THEIRS]);
});
