// Find other sources (lib/findSources.ts, v0.49.1; the idea is @TIGamingTV's, PR #119), through the real routes.
//
// The case it was built for: a main source that serves only "temporarily offline" (aqua, 195 series), and a person
// who wants every one of its series to follow another source without doing it 189 times by hand. Every rule the run
// keeps is asserted by what the fake sites were asked and what was written:
//
//   - the main source is never asked, nor a source the series already follows, a disabled or cooling one, or an
//     adult one for a clean series; a series numbered by posting order, or already at the cap, is not searched;
//   - sources are asked in scan order under the hunt's slots, a series stops once its free slots are filled or three
//     sources carried the title, and an other name matches exactly;
//   - judgeCandidate decides, followJudged writes with the admin as added_by, and a search that fails reports
//     nothing to source health;
//   - one run at a time, paced, waiting on a sweep, stoppable, `not_tried` for whatever time or a stop cut short,
//     `interrupted` after a restart (every series it never reached listed as not tried, by the run itself on a
//     shutdown or by the next boot), the newest 20 kept, a card under Server tasks for admins, and Health's button;
//   - every other outcome is named for what it was: too few numbers, no source to ask, no answer, a refusal, a
//     source it follows already, or no match.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  // One search at a time, so "asked in scan order" and "stopped before asking" are exact.
  process.env.SCAN_CONCURRENCY = '1';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_fs', ADULT_LIB = 'lib_fs_adult';
const MAIN = 'fs-main', GONE = 'fs-gone';
const ADMIN = 'fs-admin', MEMBER = 'fs-member';
const S = (k: string) => `s_fs_${k}`;
const R = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** What each fake site carries: title and chapter numbers. */
const CATALOGUE: Record<string, Array<{ title: string; nums: number[] }>> = {
  'fs-a': [{ title: 'Alpha Tale', nums: R(1, 14) }],
  'fs-b': [{ title: 'Alpha Tale', nums: R(1, 13) }, { title: 'Gamma Legend', nums: R(1, 12) }],
  'fs-c': [{ title: 'Alpha Tale', nums: R(1, 12) }, { title: 'Zeta Wrong', nums: R(40, 55) }],
  'fs-d': [{ title: 'Zeta Wrong', nums: R(60, 75) }],
  'fs-e': [{ title: 'Zeta Wrong', nums: R(80, 95) }],
  // Would line up -- and is never asked: three sources carried the title before its turn.
  'fs-f': [{ title: 'Zeta Wrong', nums: R(1, 12) }],
  'fs-throws': [],
  'fs-cool': [{ title: 'Alpha Tale', nums: R(1, 12) }],
  'fs-off': [{ title: 'Alpha Tale', nums: R(1, 12) }],
  'fs-adult': [{ title: 'Eta Adult', nums: R(1, 12) }, { title: 'Alpha Tale', nums: R(1, 12) }, { title: 'Epsilon Nothing', nums: R(1, 12) }],
  // Carries it in its search, and its chapter list never loads: a candidate that cannot be judged.
  'fs-nolist': [{ title: 'Iota Unlisted', nums: R(1, 12) }],
  // Carries it and lines up, and the series is deleted while this lists its chapters (the judgement's read).
  'fs-vanish': [{ title: 'Mu Vanishing', nums: R(1, 12) }],
};
const ORDER: Record<string, number> = {
  'fs-adult': 0, 'fs-a': 1, 'fs-b': 2, 'fs-c': 3, 'fs-d': 4, 'fs-e': 5, 'fs-f': 6, 'fs-throws': 7, 'fs-cool': 8, 'fs-off': 9,
  'fs-nolist': 10, 'fs-vanish': 11,
};
/** Every search asked, as `source:term`. */
const searches: string[] = [];
/** When set, fs-a's searches wait on it: a run that stays running while a test looks at it. */
let gate: Promise<void> | null = null;
let openGate: () => void = () => {};

function fake(id: string) {
  return {
    id, name: `Name ${id}`, lang: 'en', preferredOrder: ORDER[id], ...(id === 'fs-adult' ? { isNsfw: true } : {}),
    async search(term: string) {
      searches.push(`${id}:${term}`);
      if (id === 'fs-throws') throw new Error('fs-throws: the site refused the search');
      if (gate && id === 'fs-a') await gate;
      const k = norm(term);
      return CATALOGUE[id].filter((c) => norm(c.title).includes(k) || k.includes(norm(c.title)))
        .map((c) => ({ sourceId: `${id}|${c.title}`, source: id, title: c.title }));
    },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid.split('|')[1] }; },
    async listChapters(sid: string) {
      if (id === 'fs-nolist') throw new Error('fs-nolist: the chapter list did not load');
      if (id === 'fs-vanish') await q(`UPDATE lib_series SET deleted_at = now() WHERE title = 'Mu Vanishing'`);
      const c = CATALOGUE[id].find((x) => x.title === sid.split('|')[1]);
      return (c?.nums ?? []).map((n) => ({ sourceId: `${sid}#${n}`, number: n }));
    },
    async getPageUrls() { return []; },
  };
}

let q: any, app: any, adminAuth: Record<string, string>, memberAuth: Record<string, string>, adminId = '';
let fsLib: typeof import('../src/lib/findSources');
let runtime: typeof import('../src/lib/runtime').runtime;
let summaryAsks = 0;

/** A series of the down main source, listing 1..12 there. */
async function series(key: string, title: string, o: { library?: string; numbering?: string; source?: string } = {}) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, numbering)
           VALUES ($1,'T!fs',$2,$1,0,$3,$4,$5,true,$6)`,
    [S(key), title, o.library ?? LIB, o.source ?? MAIN, `${o.source ?? MAIN}|${title}`, o.numbering ?? null]);
  for (const n of R(1, 12)) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,$3,$4::jsonb)`,
      [S(key), n, o.source ?? MAIN, JSON.stringify({ sourceId: `c${n}`, number: n, source: o.source ?? MAIN })]);
  }
}

const post = (payload: unknown, headers = adminAuth) => app.inject({ method: 'POST', url: '/api/admin/sources/find', headers, payload });
const state = async (qs = '?adult=1') => {
  const r = await app.inject({ method: 'GET', url: `/api/admin/sources/find${qs}`, headers: adminAuth });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  const { siteOffline } = await import('../src/lib/sources/offline');
  registerAdapter({
    id: MAIN, name: 'Main Down', lang: 'en', preferredOrder: 0,
    async search(term: string) { searches.push(`${MAIN}:${term}`); throw siteOffline('Main Down is temporarily offline'); },
    async getSeries() { throw siteOffline('Main Down is temporarily offline'); },
    async listChapters() { throw siteOffline('Main Down is temporarily offline'); },
    async getPageUrls() { throw siteOffline('Main Down is temporarily offline'); },
  } as any);
  for (const id of Object.keys(CATALOGUE)) registerAdapter(fake(id) as any);
  fsLib = await import('../src/lib/findSources');
  ({ runtime } = await import('../src/lib/runtime'));
  (await import('../src/lib/healthSummary')).setSummaryRefresh(async () => { summaryAsks++; }, { everyMs: 1 });

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'FS',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'FS adult',$1, 18) ON CONFLICT (id) DO UPDATE SET age_rating = 18`, [ADULT_LIB]);
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
  await fsLib.findSettled();
  searches.length = 0;
  gate = null;
  runtime.updating = false;
  fsLib.setFindTiming({ paceMs: 0, wallMs: 10_000, quietMs: 20 });
  await q('DELETE FROM lib_series WHERE library_id = ANY($1)', [[LIB, ADULT_LIB]]);
  await q('DELETE FROM source_find_runs');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'fs-%'`);
  await q(`DELETE FROM audit_log WHERE event IN ('source.find', 'source.find.stop') OR (event = 'series.follow_source' AND detail->>'via' = 'find_sources')`);
  (await import('../src/lib/downloadJobs')).clearRuns();
});

after(async () => {
  if (!DSN) return;
  await fsLib?.findSettled();
  fsLib?.setFindTiming();
  (await import('../src/lib/healthSummary')).setSummaryRefresh();
  await app?.close();
  await q('DELETE FROM lib_series WHERE library_id = ANY($1)', [[LIB, ADULT_LIB]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, ADULT_LIB]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]).catch(() => {});
  await q(`DELETE FROM source_health WHERE source_id LIKE 'fs-%'`).catch(() => {});
  await q('DELETE FROM source_find_runs').catch(() => {});
  // The pool's idle clients would otherwise hold the process half a minute past the last test.
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('a run over a down source follows other sources for each of its series, by every rule', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('b', 'Beta Story');
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,'fs-x1','x1'), ($1,'fs-x2','x2')`, [S('b')]);
  await series('c', 'Gamma Saga');
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1,'gammalegend','Gamma Legend','admin')`, [S('c')]);
  await series('d', 'Delta Order', { numbering: 'posting_order' });
  await series('e', 'Epsilon Nothing');
  await series('f', 'Zeta Wrong');
  await series('h', 'Eta Adult', { library: ADULT_LIB });
  await q(`INSERT INTO source_health (source_id, blocked_until) VALUES ('fs-cool', now() + interval '1 hour')`);
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('fs-off', true)`);
  const asked = summaryAsks;

  const r = await post({ sourceId: MAIN });
  assert.equal(r.statusCode, 202, r.body);
  const { runId, total } = r.json();
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.equal(total, 7, 'every series whose main source it is');
  await fsLib.findSettled();

  const st = await state();
  assert.equal(st.running, false);
  const run = st.run;
  assert.equal(run.id, runId);
  assert.equal(run.status, 'done');
  assert.deepEqual([run.total, run.done, run.followed], [7, 7, 4]);
  assert.equal(run.startedBy, ADMIN, 'the account by name, never its id');
  assert.equal(run.sourceId, MAIN);
  assert.equal(run.sourceName, 'Main Down');
  assert.equal(st.recent[0].id, runId);
  assert.equal('results' in st.recent[0], false, 'recent is summaries');
  const by = Object.fromEntries(run.results.map((x: any) => [x.seriesId, x]));
  // The order: series that follow nothing first, then by title; B already follows two, so it is last.
  assert.deepEqual(run.results.map((x: any) => x.title),
    ['Alpha Tale', 'Delta Order', 'Epsilon Nothing', 'Eta Adult', 'Gamma Saga', 'Zeta Wrong', 'Beta Story']);

  // A: the first two sources in scan order carry it and line up; its two free slots are filled, and the third
  // carrier is never asked. Reintroduce by dropping `ok >= free` from enough(): fs-c is searched for it.
  assert.deepEqual(by[S('a')].followed, [{ sourceId: 'fs-a', name: 'Name fs-a', chapters: 14 }, { sourceId: 'fs-b', name: 'Name fs-b', chapters: 13 }]);
  assert.equal('why' in by[S('a')], false);
  assert.equal(searches.includes('fs-c:Alpha Tale'), false, 'a series stops asking once its free slots are filled');
  // B: already at the cap -- not searched. Reintroduce by dropping the `free <= 0` return: it is searched.
  assert.equal(by[S('b')].why, 'full');
  assert.equal(searches.some((x) => x.endsWith(':Beta Story')), false);
  // C: carried only under its other name, matched exactly.
  assert.deepEqual(by[S('c')].followed.map((f: any) => f.sourceId), ['fs-b']);
  assert.ok(searches.includes('fs-b:Gamma Legend'));
  // D: posting order -- never searched. Reintroduce by dropping the posting_order return: it is searched.
  assert.equal(by[S('d')].why, 'posting_order');
  assert.equal(searches.some((x) => x.endsWith(':Delta Order')), false);
  // E: nobody that answered carries it (the adult source that does may not be asked for a clean series).
  assert.equal(by[S('e')].why, 'no_match');
  // F: three sources carried the title, each numbered another way: refused, and the fourth never asked.
  // Reintroduce by dropping `carriers >= FIND_CARRIERS` from enough(): fs-f is asked, lines up, and is followed.
  assert.equal(by[S('f')].why, 'refused');
  assert.ok(['fs-c', 'fs-d', 'fs-e'].every((id) => searches.includes(`${id}:Zeta Wrong`)));
  assert.equal(searches.includes('fs-f:Zeta Wrong'), false, 'the three-source stop');
  // H: an adult series may reach the adult source.
  assert.deepEqual(by[S('h')].followed.map((f: any) => f.sourceId), ['fs-adult']);

  // Never asked: the main source (it is the one that is down), a cooling or disabled source, the adult source for a
  // clean series. Reintroduce by dropping `id === row.source_id` from the order filter: the main source is searched.
  assert.equal(searches.filter((x) => x.startsWith(`${MAIN}:`)).length, 0, 'the main source is excluded always');
  assert.equal(searches.filter((x) => x.startsWith('fs-cool:') || x.startsWith('fs-off:')).length, 0);
  assert.deepEqual(searches.filter((x) => x.startsWith('fs-adult:')), ['fs-adult:Eta Adult'], 'the adult source only for the adult series');

  // Written by followJudged under the admin's name; nothing else followed.
  const rows = await q(`SELECT series_id, source_id, added_by FROM series_sources WHERE series_id = ANY($1) AND source_id NOT LIKE 'fs-x%' ORDER BY series_id, source_id`,
    [[S('a'), S('c'), S('f'), S('h'), S('e')]]);
  assert.deepEqual(rows.map((x: any) => `${x.series_id}:${x.source_id}`), [`${S('a')}:fs-a`, `${S('a')}:fs-b`, `${S('c')}:fs-b`, `${S('h')}:fs-adult`]);
  assert.ok(rows.every((x: any) => x.added_by === adminId), 'added_by is the admin who started the run');

  // A search that threw reported nothing: no cooldown, no evidence. Reintroduce by reporting it (reportFail or
  // noteStage in searchByNames): fs-throws has a health row.
  assert.deepEqual(await q(`SELECT source_id FROM source_health WHERE source_id = 'fs-throws'`), []);

  // The audit: the run once with its scope and counts, each follow with the run's id.
  const [audit] = await q(`SELECT detail FROM audit_log WHERE event = 'source.find'`);
  assert.deepEqual(
    { ...audit.detail, runId: undefined },
    { runId: undefined, scope: { sourceId: MAIN }, status: 'done', total: 7, done: 7, followed: 4, series: 3 },
  );
  const follows = await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'via' = 'find_sources'`);
  assert.equal(follows.length, 4);
  assert.ok(follows.every((f: any) => f.detail.runId === runId));

  // The paced refresh of every series that gained a follower: its followers were asked for their listing.
  // Reintroduce by dropping scheduleFindRefresh: checked_at stays empty.
  const checked = await q(`SELECT series_id, source_id FROM series_sources WHERE checked_at IS NOT NULL AND series_id = ANY($1) ORDER BY 1, 2`,
    [[S('a'), S('c'), S('h')]]);
  assert.deepEqual(checked.map((x: any) => `${x.series_id}:${x.source_id}`), [`${S('a')}:fs-a`, `${S('a')}:fs-b`, `${S('c')}:fs-b`, `${S('h')}:fs-adult`]);
  // And the Health summary is asked to catch up.
  await until(() => summaryAsks > asked, 'a Health summary refresh');

  // The run card is its admin's, and says so; it downloads nothing.
  const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json();
  const card = jobs.runs.find((x: any) => x.kind === 'find_sources');
  assert.deepEqual([card.status, card.done, card.total, card.followed, card.downloads, card.mine], ['done', 7, 7, 4, false, true]);
});

test('one run at a time; the scope must name something; a stop ends it at once, the rest not tried', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('e', 'Epsilon Nothing');
  assert.equal((await post({})).statusCode, 400, 'no scope');
  assert.equal((await post({})).json().error, 'empty_scope');
  assert.equal((await post({ seriesIds: [] })).json().error, 'empty_scope');
  assert.equal((await post({ seriesIds: ['s_fs_nobody'] })).json().error, 'empty_scope', 'nothing named is a series');
  assert.equal((await post({ sourceId: 'fs-nothing-from-here' })).json().error, 'empty_scope');
  assert.equal((await post({ seriesIds: [S('a')], sourceId: MAIN })).json().error, 'bad_request', 'one scope or the other');
  assert.equal((await post({ sourceId: MAIN }, memberAuth)).statusCode, 403, 'admins only');

  gate = new Promise<void>((r) => { openGate = r; });
  const r = await post({ seriesIds: [S('a'), S('e')] });
  assert.equal(r.statusCode, 202, r.body);
  const { runId } = r.json();
  await until(() => searches.includes('fs-a:Alpha Tale'), 'the first search');

  // Reintroduce by checking `active` alone in startFind (not the claim): a second POST in the same turn starts two.
  const busy = await post({ sourceId: MAIN });
  assert.equal(busy.statusCode, 409);
  assert.deepEqual(busy.json(), { error: 'busy', runId, message: busy.json().message });

  const live = await state();
  assert.equal(live.running, true);
  assert.equal(live.run.status, 'running');
  assert.deepEqual(live.run.current, { seriesId: S('a'), title: 'Alpha Tale' });
  // The card under Server tasks: admins only, never a member, whoever started it.
  const adminJobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json();
  const card = adminJobs.runs.find((x: any) => x.kind === 'find_sources');
  assert.deepEqual([card.status, card.done, card.total, card.followed], ['running', 0, 2, 0]);
  assert.deepEqual(card.current, { id: S('a'), title: 'Alpha Tale' });
  const memberJobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: memberAuth })).json();
  assert.equal(memberJobs.runs.some((x: any) => x.kind === 'find_sources'), false);
  // Its starter, no longer an admin, does not keep it either. Reintroduce by dropping the kind test from the jobs
  // route's filter: the starter's own-run rule hands it over.
  const demoted = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'member' })}` };
  const demotedJobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: demoted })).json();
  assert.equal(demotedJobs.runs.some((x: any) => x.kind === 'find_sources'), false, 'a find_sources card is an admin\'s alone');

  const stop = await app.inject({ method: 'POST', url: '/api/admin/sources/find/stop', headers: adminAuth });
  assert.deepEqual(stop.json(), { stopped: true });
  // It does not wait for the search in flight: the gate stays shut for three seconds, and the stop is over well before.
  // Reintroduce by awaiting the series whole (dropping the race against `a.stopped`): the stop takes the three seconds.
  const opener = setTimeout(() => openGate(), 3000);
  const t0 = Date.now();
  await fsLib.findSettled();
  assert.ok(Date.now() - t0 < 2500, `the stop waited ${Date.now() - t0} ms for the search in flight`);
  clearTimeout(opener);
  openGate();
  const st = await state();
  assert.equal(st.running, false);
  assert.equal(st.run.status, 'stopped');
  assert.equal(st.run.done, 1, 'the series in flight is settled; the one never reached is not');
  // "Not tried", never "not found": the series the stop cut short, and the one it never reached.
  assert.deepEqual(st.run.results.map((x: any) => [x.seriesId, x.why]), [[S('a'), 'not_tried'], [S('e'), 'not_tried']]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1`, [S('a')]))[0].n, 0, 'nothing followed after the stop');
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/admin/sources/find/stop', headers: adminAuth })).json(), { stopped: false });
  const card2 = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json().runs.find((x: any) => x.kind === 'find_sources');
  assert.equal(card2.status, 'cancelled');
});

test('it waits while a sweep runs, and says so', { skip }, async () => {
  await series('a', 'Alpha Tale');
  const card = async () => (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json().runs
    .find((x: any) => x.kind === 'find_sources');
  runtime.updating = true;
  // The sweep ends whatever the assertions say: a run left waiting on it would hold the file's last findSettled.
  try {
    assert.equal((await post({ seriesIds: [S('a')] })).statusCode, 202);
    await new Promise((r) => setTimeout(r, 100));
    const waiting = await state();
    // Reintroduce by dropping waitQuiet: fs-a is searched during the sweep.
    assert.equal(waiting.run.waiting, 'sweep');
    assert.equal(waiting.run.done, 0);
    assert.deepEqual(searches, [], 'nothing is asked while the sweep runs');
    // Server tasks says why too, on the run's card. Reintroduce by leaving the card out of waitQuiet: no `waiting`.
    assert.equal((await card()).waiting, 'sweep', 'the card says what the run waits on');
  } finally {
    runtime.updating = false;
  }
  await fsLib.findSettled();
  assert.equal((await state()).run.done, 1);
  assert.equal('waiting' in (await card()), false, 'and nothing once it no longer waits');
});

test('series decided without a search are not paced; series that searched are', { skip }, async () => {
  await series('b', 'Beta Story');
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,'fs-x1','x1'), ($1,'fs-x2','x2')`, [S('b')]);
  await series('d', 'Delta Order', { numbering: 'posting_order' });
  await series('e', 'Epsilon Nothing');
  fsLib.setFindTiming({ paceMs: 4000, wallMs: 10_000, quietMs: 20 });
  const t0 = Date.now();
  await post({ seriesIds: [S('b'), S('d'), S('e')] });
  await fsLib.findSettled();
  // Reintroduce by pausing after every series (dropping `outcome?.asked`): two 4 s pauses.
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);

  fsLib.setFindTiming({ paceMs: 300, wallMs: 10_000, quietMs: 20 });
  await series('f', 'Zeta Wrong');
  const stamps: number[] = [];
  const t1 = Date.now();
  await post({ seriesIds: [S('e'), S('f')] });
  await fsLib.findSettled();
  stamps.push(Date.now() - t1);
  // Reintroduce by dropping the pause: the two searched series take a few milliseconds.
  assert.ok(stamps[0] >= 300, `two searched series took ${stamps[0]} ms, under one pause`);
});

test('each series says why it gained nothing: too few numbers, a source it follows already, no answer, no source to ask', { skip }, async () => {
  // Two numbers: nothing to measure a candidate against, so nothing is searched -- `too_few`, not a refusal.
  await series('t', 'Theta Few');
  await q('DELETE FROM series_listing WHERE series_id = $1 AND number > 2', [S('t')]);
  // Nothing that answers lists it, and it follows a source already -- which does: not "no other source lists it".
  await series('y', 'Epsilon Nothing');
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,'fs-x1','x1')`, [S('y')]);
  // Only fs-nolist carries it, and its chapter list does not load: a source that did not answer, not the wall.
  await series('i', 'Iota Unlisted');
  await post({ seriesIds: [S('t'), S('y'), S('i')] });
  await fsLib.findSettled();
  const whys = async () => Object.fromEntries((await state()).run.results.map((x: any) => [x.seriesId, x.why]));
  // Reintroduce `refused` for too few numbers, drop the followed_already line, or put `cut = true` back for a
  // candidate that could not be judged: the reason read here is the old one.
  assert.deepEqual(await whys(), { [S('t')]: 'too_few', [S('y')]: 'followed_already', [S('i')]: 'no_answer' }, 'each for what it was');
  assert.equal(searches.some((x) => x.endsWith(':Theta Few')), false, 'too few numbers: nothing searched');
  assert.ok(searches.includes('fs-nolist:Iota Unlisted'), 'the carrier was asked');
  assert.equal((await q(`SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1`, [S('i')]))[0].n, 0, 'and nothing it could not judge was followed');

  // Every other source turned off but the one that throws: it was asked, and nothing answered. Reintroduce
  // `not_tried` for `!answered`: it reads not_tried.
  await series('n', 'Nu Nowhere');
  await q(`INSERT INTO source_health (source_id, disabled) SELECT unnest($1::text[]), true`, [Object.keys(CATALOGUE).filter((id) => id !== 'fs-throws')]);
  searches.length = 0;
  await post({ seriesIds: [S('n')] });
  await fsLib.findSettled();
  assert.deepEqual(await whys(), { [S('n')]: 'no_answer' }, 'asked, and nothing answered, is no_answer');
  assert.deepEqual(searches, ['fs-throws:Nu Nowhere'], 'the one source left was asked');
  // That one turned off too: nothing is left to ask. Reintroduce `not_tried` for an empty order: it reads not_tried.
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('fs-throws', true) ON CONFLICT (source_id) DO UPDATE SET disabled = true`);
  searches.length = 0;
  await post({ seriesIds: [S('n')] });
  await fsLib.findSettled();
  assert.deepEqual(await whys(), { [S('n')]: 'no_source' }, 'nothing left to ask is no_source');
  assert.deepEqual(searches, [], 'nothing asked');
});

test('a series deleted while its search runs ends not tried, never no_match', { skip }, async () => {
  // fs-vanish carries it and lines up, and the series is deleted while fs-vanish lists its chapters for the
  // judgement: the follow finds nothing to follow onto. Reintroduce by breaking out of the follows without `gone`:
  // it reads no_match -- a source that lines up was found.
  await series('m', 'Mu Vanishing');
  await post({ seriesIds: [S('m')] });
  await fsLib.findSettled();
  const [{ results }] = await q('SELECT results FROM source_find_runs ORDER BY started_at DESC LIMIT 1');
  assert.deepEqual(results.map((x: any) => [x.seriesId, x.why]), [[S('m'), 'not_tried']], 'deleted mid-series is not tried');
  assert.ok(searches.includes('fs-vanish:Mu Vanishing'));
  assert.equal((await q('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1', [S('m')]))[0].n, 0, 'nothing followed');
});

test('a restart lists every series the run never reached as not tried, from the ids it resolved to', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('e', 'Epsilon Nothing');
  await series('f', 'Zeta Wrong');
  const { runId } = (await post({ sourceId: MAIN })).json();
  await fsLib.findSettled();
  // A run over a source keeps the ids it resolved to, in its order, as a run over a selection does. Reintroduce by
  // storing {sourceId} alone: no seriesIds, and a run closed after a restart could not name what it never reached.
  const [done] = await q('SELECT scope FROM source_find_runs WHERE id = $1', [runId]);
  assert.deepEqual(done.scope, { sourceId: MAIN, seriesIds: [S('a'), S('e'), S('f')] }, 'the scope keeps the ids it resolved to');

  // The same run as a process that went away under it leaves it: still running, its first series settled.
  const settled = { seriesId: S('a'), title: 'Alpha Tale', followed: [{ sourceId: 'fs-a', name: 'Name fs-a', chapters: 14 }] };
  const [{ id }] = await q(
    `INSERT INTO source_find_runs (started_by, status, scope, total, done, followed, results)
     SELECT started_by, 'running', scope, total, 1, 1, $2::jsonb FROM source_find_runs WHERE id = $1 RETURNING id`,
    [runId, JSON.stringify([settled])]);
  // What the next boot does (server.ts). Reintroduce by setting the status alone: e and f are missing.
  await fsLib.closeInterruptedFindRuns();
  const read = async () => (await q('SELECT status, done, results FROM source_find_runs WHERE id = $1', [id]))[0];
  const row = await read();
  assert.equal(row.status, 'interrupted');
  assert.deepEqual(row.results.map((x: any) => [x.seriesId, x.title, x.why ?? null, x.followed.length]), [
    [S('a'), 'Alpha Tale', null, 1],
    [S('e'), 'Epsilon Nothing', 'not_tried', 0],
    [S('f'), 'Zeta Wrong', 'not_tried', 0],
  ], 'every series it never reached is not tried, in the run\'s order, with its title');
  assert.equal(row.done, 1, 'listed, not counted as done');
  // Once: the row is no longer running, so a second close (every read and every start closes) adds nothing.
  await fsLib.closeInterruptedFindRuns();
  assert.equal((await read()).results.length, 3);
  // And as the web reads it: exactly what a stopped run answers.
  const st = await state();
  assert.equal(st.run.id, id);
  assert.equal(st.run.status, 'interrupted');
  assert.deepEqual(st.run.results.filter((x: any) => x.why === 'not_tried').map((x: any) => x.seriesId), [S('e'), S('f')]);
});

test('a shutdown lets the run close its own row: interrupted, the rest not tried, within FIND_SHUTDOWN_MS', { skip }, async () => {
  await series('e', 'Epsilon Nothing');
  await series('a', 'Alpha Tale');
  // A pause after a series that searched: the shutdown comes while the run waits between two series. Seconds, not a
  // minute: the pause's timer outlives the stop, and a longer one only holds the file open at its end.
  fsLib.setFindTiming({ paceMs: 5_000, wallMs: 10_000, quietMs: 20 });
  const { runId } = (await post({ seriesIds: [S('e'), S('a')] })).json();
  const row = async () => (await q('SELECT status, done, results FROM source_find_runs WHERE id = $1', [runId]))[0];
  await until(async () => (await row())?.done === 1, 'the first series settled');
  runtime.stopping = true; // what SIGTERM sets, before server.ts waits on findSettledWithin
  try {
    const t0 = Date.now();
    await fsLib.findSettledWithin();
    const took = Date.now() - t0;
    assert.ok(took < fsLib.FIND_SHUTDOWN_MS, `the run took ${took} ms to close`);
    const r = await row();
    assert.equal(r.status, 'interrupted', 'closed by the run itself, not left running for the next boot');
    assert.deepEqual(r.results.map((x: any) => [x.seriesId, x.why]), [[S('e'), 'no_match'], [S('a'), 'not_tried']]);
    const [audit] = await q(`SELECT detail FROM audit_log WHERE event = 'source.find' AND detail->>'runId' = $1`, [runId]);
    assert.equal(audit?.detail.status, 'interrupted', 'and its audit line written');
  } finally {
    runtime.stopping = false;
  }
});

test("server.ts's shutdown waits for the run to close its own row", () => {
  // Static, so it holds without a database: the SIGTERM/SIGINT handler sets runtime.stopping, then waits on
  // findSettledWithin (bounded) beside app.close() before it exits. Reintroduce by dropping it from the Promise.all:
  // this fails, and a run cut short by an update is left `running` for the next boot to close.
  // Comments stripped: the ones above the handler name the call this looks for.
  const server = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const at = server.indexOf('process.once(sig');
  assert.ok(at > 0, 'no shutdown handler in server.ts');
  const handler = server.slice(at, server.indexOf('});', at));
  assert.match(handler, /runtime\.stopping = true;[\s\S]*findSettledWithin\(\)[\s\S]*process\.exit\(0\)/,
    'the shutdown handler does not wait for the Find other sources run');
});

test("a restart's running row reads interrupted, and only the newest 20 runs are kept", { skip }, async () => {
  await q(`INSERT INTO source_find_runs (started_by, status, scope, total, started_at) VALUES ($1, 'running', '{"sourceId":"x"}', 5, now() - interval '1 hour')`, [adminId]);
  // Reintroduce by dropping closeInterruptedFindRuns from findState: the row reads running for ever.
  const st = await state();
  assert.equal(st.running, false);
  assert.equal(st.run.status, 'interrupted');
  assert.ok(st.run.finishedAt);

  for (let i = 0; i < 24; i++) {
    await q(`INSERT INTO source_find_runs (started_by, status, scope, total, started_at, finished_at)
             VALUES ($1, 'done', '{}', 1, now() - make_interval(days => $2), now() - make_interval(days => $2))`, [adminId, i + 2]);
  }
  await series('d', 'Delta Order', { numbering: 'posting_order' });
  const r = await post({ seriesIds: [S('d')] });
  await fsLib.findSettled();
  // Reintroduce by dropping the prune: 26 rows.
  const rows = await q('SELECT id FROM source_find_runs ORDER BY started_at DESC');
  assert.equal(rows.length, 20);
  assert.equal(rows[0].id, r.json().runId, 'the newest is kept');
  assert.equal((await state()).recent.length, 20);
});

test('an admin who hides 18+ reads no adult title in a run', { skip }, async () => {
  await series('h', 'Eta Adult', { library: ADULT_LIB });
  await series('e', 'Epsilon Nothing');
  await post({ sourceId: MAIN });
  await fsLib.findSettled();
  // Reintroduce by answering results as stored: the adult title is read with the hide on.
  const hidden = await state('');
  const h = hidden.run.results.find((x: any) => x.seriesId === S('h'));
  assert.equal('title' in h, false, 'the entry stays, its title goes');
  assert.equal(h.followed.length, 1);
  assert.equal(hidden.run.results.find((x: any) => x.seriesId === S('e')).title, 'Epsilon Nothing');
  assert.equal((await state('?adult=1')).run.results.find((x: any) => x.seriesId === S('h')).title, 'Eta Adult');
});

test("Health offers Find other sources on a failing source's row and on the series that can no longer update", { skip }, async () => {
  const { runHealthChecks } = await import('../src/lib/health');
  for (const [k, t] of [['a', 'Alpha Tale'], ['e', 'Epsilon Nothing'], ['f', 'Zeta Wrong']]) await series(k, t);
  // A confirmed failure at search: the daily check saw the site's own offline notice.
  const at = new Date().toISOString();
  await q(`INSERT INTO source_health (source_id, status, stages) VALUES ($1, 'ok', $2::jsonb)`,
    [MAIN, JSON.stringify({ search: { failAt: at, failBy: 'sweep', streak: 1, kind: 'site_offline', error: 'site_offline: the site says it is offline ("Main Down is temporarily offline")' } })]);
  // A series whose source is no longer installed at all.
  await series('g', 'Gone Source Tale', { source: GONE });

  const report = await runHealthChecks();
  const row = report.checks.find((c) => c.id === 'sources')!.items.find((i) => i.sourceId === MAIN)!;
  // Reintroduce by dropping `findHere` from the row's actions: the chip is missing.
  assert.ok(row.actions!.includes('find_sources'), JSON.stringify(row.actions));
  assert.equal(row.findSeries, 3, 'every series whose MAIN source it is');
  assert.equal(row.diagnosis!.code, 'site_offline');
  const frozen = report.checks.find((c) => c.id === 'frozen-series')!.items.find((i) => i.seriesId === S('g'))!;
  // Reintroduce by dropping the frozen card's action: only Ignore is offered.
  assert.ok(frozen.actions!.includes('find_sources'), JSON.stringify(frozen.actions));
  assert.deepEqual([frozen.sourceId, frozen.findSeries], [GONE, 1]);
  // A source used by nothing, or only as a follower, has no series to search for and no chip.
  await q(`INSERT INTO source_health (source_id, status, consecutive, last_error, last_fail_at, blocked_until)
           VALUES ('fs-d', 'down', 3, 'boom', now(), now() + interval '1 hour')`);
  const idle = (await runHealthChecks()).checks.find((c) => c.id === 'sources')!.items.find((i) => i.sourceId === 'fs-d')!;
  assert.equal(idle.actions!.includes('find_sources'), false);
});
