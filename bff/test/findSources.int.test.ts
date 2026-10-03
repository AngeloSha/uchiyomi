// Find other sources (lib/findSources.ts, v0.49.1; the idea is @TIGamingTV's, PR #119), through the real routes.
//
// The case it was built for: a main source that serves only "temporarily offline" (aqua, 195 series), and a person
// who wants every one of its series to follow another source without doing it 189 times by hand. Every rule the run
// keeps is asserted by what the fake sites were asked and what was written:
//
//   - the main source is never asked, nor a source the series already follows, or a disabled or cooling one; a
//     source that flags itself adult IS asked for a clean series (the admin's reach, #132); a series numbered by
//     posting order, or already at the cap, is not searched;
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
  // v0.51.0: a title that contains ours, numbered past it -- a sequel's shape, which a review never proposes.
  'fs-d': [{ title: 'Zeta Wrong', nums: R(60, 75) }, { title: 'Kappa Story Season Two', nums: R(1, 40) }],
  'fs-e': [{ title: 'Zeta Wrong', nums: R(80, 95) }],
  // Would line up -- and is never asked: three sources carried the title before its turn.
  'fs-f': [{ title: 'Zeta Wrong', nums: R(1, 12) }],
  'fs-throws': [],
  'fs-cool': [{ title: 'Alpha Tale', nums: R(1, 12) }],
  'fs-off': [{ title: 'Alpha Tale', nums: R(1, 12) }],
  // Flags itself adult, as most manhwa extensions do, and is the only one that carries a clean series' title.
  'fs-adult': [{ title: 'Eta Adult', nums: R(1, 12) }, { title: 'Omega Manhwa', nums: R(1, 12) }],
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
/** When set, fs-a's chapter lists wait on it: a check that stays inside its series (v0.54.0, Replace's `busy`). */
let listGate: Promise<void> | null = null;
let openList: () => void = () => {};

function fake(id: string) {
  return {
    id, name: `Name ${id}`, lang: 'en', preferredOrder: ORDER[id], ...(id === 'fs-adult' ? { isNsfw: true } : {}),
    async search(term: string) {
      searches.push(`${id}:${term}`);
      if (id === 'fs-throws') throw new Error('fs-throws: the site refused the search');
      if (gate && id === 'fs-a') await gate;
      const k = norm(term);
      return CATALOGUE[id].filter((c) => norm(c.title).includes(k) || k.includes(norm(c.title)))
        .map((c) => ({ sourceId: `${id}|${c.title}`, source: id, title: c.title, coverUrl: `https://${id}.example/${norm(c.title)}.jpg`, url: `https://${id}.example/${norm(c.title)}` }));
    },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid.split('|')[1] }; },
    async listChapters(sid: string) {
      if (listGate && id === 'fs-a') await listGate;
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
  listGate = null;
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
  await series('o', 'Omega Manhwa');
  await q(`INSERT INTO source_health (source_id, blocked_until) VALUES ('fs-cool', now() + interval '1 hour')`);
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('fs-off', true)`);
  const asked = summaryAsks;

  const r = await post({ sourceId: MAIN });
  assert.equal(r.statusCode, 202, r.body);
  const { runId, total } = r.json();
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.equal(total, 8, 'every series whose main source it is');
  await fsLib.findSettled();

  const st = await state();
  assert.equal(st.running, false);
  const run = st.run;
  assert.equal(run.id, runId);
  assert.equal(run.status, 'done');
  assert.deepEqual([run.total, run.done, run.followed], [8, 8, 5]);
  assert.equal(run.startedBy, ADMIN, 'the account by name, never its id');
  assert.equal(run.sourceId, MAIN);
  assert.equal(run.sourceName, 'Main Down');
  assert.equal(st.recent[0].id, runId);
  assert.equal('results' in st.recent[0], false, 'recent is summaries');
  // Automatic mode is unchanged by v0.51.0's review first: no mode on the run, no proposals on a result.
  assert.equal('review' in run, false);
  assert.ok(run.results.every((x: any) => !('proposals' in x)), 'an automatic run keeps proposals');
  const by = Object.fromEntries(run.results.map((x: any) => [x.seriesId, x]));
  // The order: series that follow nothing first, then by title; B already follows two, so it is last.
  assert.deepEqual(run.results.map((x: any) => x.title),
    ['Alpha Tale', 'Delta Order', 'Epsilon Nothing', 'Eta Adult', 'Gamma Saga', 'Omega Manhwa', 'Zeta Wrong', 'Beta Story']);

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
  // E: nobody that answered carries it.
  assert.equal(by[S('e')].why, 'no_match');
  // F: three sources carried the title, each numbered another way: refused, and the fourth never asked.
  // Reintroduce by dropping `carriers >= FIND_CARRIERS` from enough(): fs-f is asked, lines up, and is followed.
  assert.equal(by[S('f')].why, 'refused');
  assert.ok(['fs-c', 'fs-d', 'fs-e'].every((id) => searches.includes(`${id}:Zeta Wrong`)));
  assert.equal(searches.includes('fs-f:Zeta Wrong'), false, 'the three-source stop');
  // H: an adult series reaches the adult source.
  assert.deepEqual(by[S('h')].followed.map((f: any) => f.sourceId), ['fs-adult']);
  // O: a clean series reaches it too -- the admin's reach, not the hunt's adult rule (#132): most manhwa extensions
  // flag themselves adult, and a run that skipped them had no source to ask on a typical library. Reintroduce the
  // hunt's sweepAllowedFor in findFor: O reads no_match.
  assert.deepEqual(by[S('o')].followed.map((f: any) => f.sourceId), ['fs-adult'], 'an adult-flagged source is asked for a clean series');

  // Never asked: the main source (it is the one that is down), a cooling or disabled source. Reintroduce by dropping
  // `id === row.source_id` from the order filter: the main source is searched.
  assert.equal(searches.filter((x) => x.startsWith(`${MAIN}:`)).length, 0, 'the main source is excluded always');
  assert.equal(searches.filter((x) => x.startsWith('fs-cool:') || x.startsWith('fs-off:')).length, 0);
  assert.ok(searches.includes('fs-adult:Omega Manhwa'));

  // Written by followJudged under the admin's name; nothing else followed.
  const rows = await q(`SELECT series_id, source_id, added_by FROM series_sources WHERE series_id = ANY($1) AND source_id NOT LIKE 'fs-x%' ORDER BY series_id, source_id`,
    [[S('a'), S('c'), S('f'), S('h'), S('e'), S('o')]]);
  assert.deepEqual(rows.map((x: any) => `${x.series_id}:${x.source_id}`),
    [`${S('a')}:fs-a`, `${S('a')}:fs-b`, `${S('c')}:fs-b`, `${S('h')}:fs-adult`, `${S('o')}:fs-adult`]);
  assert.ok(rows.every((x: any) => x.added_by === adminId), 'added_by is the admin who started the run');

  // A search that threw reported nothing: no cooldown, no evidence. Reintroduce by reporting it (reportFail or
  // noteStage in searchByNames): fs-throws has a health row.
  assert.deepEqual(await q(`SELECT source_id FROM source_health WHERE source_id = 'fs-throws'`), []);

  // The audit: the run once with its scope and counts, each follow with the run's id.
  const [audit] = await q(`SELECT detail FROM audit_log WHERE event = 'source.find'`);
  assert.deepEqual(
    { ...audit.detail, runId: undefined },
    { runId: undefined, scope: { sourceId: MAIN }, status: 'done', total: 8, done: 8, followed: 5, series: 4 },
  );
  const follows = await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'via' = 'find_sources'`);
  assert.equal(follows.length, 5);
  assert.ok(follows.every((f: any) => f.detail.runId === runId));

  // The paced refresh of every series that gained a follower: its followers were asked for their listing.
  // Reintroduce by dropping scheduleFindRefresh: checked_at stays empty.
  const checked = await q(`SELECT series_id, source_id FROM series_sources WHERE checked_at IS NOT NULL AND series_id = ANY($1) ORDER BY 1, 2`,
    [[S('a'), S('c'), S('h'), S('o')]]);
  assert.deepEqual(checked.map((x: any) => `${x.series_id}:${x.source_id}`),
    [`${S('a')}:fs-a`, `${S('a')}:fs-b`, `${S('c')}:fs-b`, `${S('h')}:fs-adult`, `${S('o')}:fs-adult`]);
  // And the Health summary is asked to catch up.
  await until(() => summaryAsks > asked, 'a Health summary refresh');

  // The run card is its admin's, and says so; it downloads nothing.
  const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json();
  const card = jobs.runs.find((x: any) => x.kind === 'find_sources');
  assert.deepEqual([card.status, card.done, card.total, card.followed, card.downloads, card.mine], ['done', 8, 8, 5, false, true]);
});

test('a series with no other name stored is searched under the ones its description lists', { skip }, async () => {
  // Names are kept when a series is added or its main source looked up, so one added before v0.49.1 -- or on an
  // install whose series_alt_titles could not be read -- has none, and was searched under its own title alone.
  // Reintroduce by dropping learnNames from findFor: P reads no_match, and fs-adult is never asked for Omega Manhwa.
  await series('p', 'Pi Original Title');
  await q(`UPDATE lib_series SET summary = $2 WHERE id = $1`, [S('p'), 'A story.\nAlternative Titles: Omega Manhwa; 오메가\nStatus: Ongoing']);
  await post({ seriesIds: [S('p')] });
  await fsLib.findSettled();
  const r = (await state()).run.results[0];
  assert.deepEqual(r.followed.map((f: any) => f.sourceId), ['fs-adult'], JSON.stringify(r));
  assert.ok(searches.includes('fs-adult:Omega Manhwa'), 'searched under the name its description lists');
  const kept = await q(`SELECT title, origin FROM series_alt_titles WHERE series_id = $1 AND removed_at IS NULL`, [S('p')]);
  assert.deepEqual(kept.map((x: any) => [x.title, x.origin]), [['Omega Manhwa', 'description']], 'kept as a description name');
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
  // v0.52.0: the series the stop caught was not searched through, so it is not counted either -- the card read "1 of 4
  // series" with none searched. Reintroduce by counting every series settled in runAll: this reads 1.
  assert.equal(st.run.done, 0, 'the series a stop caught in flight counts as searched');
  // "Not tried", never "not found": the series the stop cut short, and the one it never reached.
  assert.deepEqual(st.run.results.map((x: any) => [x.seriesId, x.why]), [[S('a'), 'not_tried'], [S('e'), 'not_tried']]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1`, [S('a')]))[0].n, 0, 'nothing followed after the stop');
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/admin/sources/find/stop', headers: adminAuth })).json(), { stopped: false });
  const card2 = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json().runs.find((x: any) => x.kind === 'find_sources');
  assert.equal(card2.status, 'cancelled');
  assert.equal(card2.done, 0, 'the card counts the series a stop caught in flight as searched');
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

/* ---- v0.51.0: review first (#132; the idea is @TIGamingTV's, PR #133) ---- */

/** A review-first run over these series, settled; its id. */
async function reviewRun(ids: string[]): Promise<string> {
  const r = await post({ seriesIds: ids, review: true });
  assert.equal(r.statusCode, 202, r.body);
  await fsLib.findSettled();
  return r.json().runId;
}
const decide = (runId: string, kind: 'follow' | 'dismiss', seriesId: string, sourceId: string, headers = adminAuth) =>
  app.inject({ method: 'POST', url: `/api/admin/sources/find/${runId}/${kind}`, headers, payload: { seriesId, sourceId } });
const followers = async (ids: string[]) => (await q(
  `SELECT series_id, source_id, source_series_id, added_by FROM series_sources WHERE series_id = ANY($1) AND source_id NOT LIKE 'fs-x%' ORDER BY 1, 2`, [ids]))
  .map((x: any) => `${x.series_id}:${x.source_id}:${x.source_series_id}:${x.added_by === adminId ? 'admin' : x.added_by}`);

test('a review-first run follows nothing, and keeps each candidate with its cover, its counts and a verdict', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('c', 'Gamma Saga');
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1,'gammalegend','Gamma Legend','admin')`, [S('c')]);
  await series('f', 'Zeta Wrong');
  await series('k', 'Kappa Story');
  await series('h', 'Eta Adult', { library: ADULT_LIB });
  const runId = await reviewRun([S('a'), S('c'), S('f'), S('k'), S('h')]);

  // The same search as an automatic run, and nothing written. Reintroduce by dropping the review branch in findFor
  // (and its guard on the follows): A, C and H follow their sources, and "nothing is followed" fails.
  assert.deepEqual(await followers([S('a'), S('c'), S('f'), S('k'), S('h')]), [], 'nothing is followed');
  assert.equal(searches.includes('fs-c:Alpha Tale'), false, 'the same stop once the free slots are filled');
  const st = await state();
  const run = st.run;
  assert.deepEqual([run.id, run.status, run.review, run.followed, st.recent[0].review], [runId, 'done', true, 0, true]);
  const by = Object.fromEntries(run.results.map((x: any) => [x.seriesId, x]));
  // A: both sources the automatic run would follow, green, in scan order -- with the cover and page its search gave,
  // what it lists, and the line-up both ways (12 of our 12; we list 12 of its 14).
  assert.deepEqual(by[S('a')].proposals[0], {
    sourceId: 'fs-a', sourceName: 'Name fs-a', sourceSeriesId: 'fs-a|Alpha Tale', url: 'https://fs-a.example/alphatale',
    title: 'Alpha Tale', coverUrl: 'https://fs-a.example/alphatale.jpg', chapters: 14,
    ours: { lined: 12, of: 12 }, theirs: { lined: 12, of: 14 }, coverage: 1, verdict: 'green',
  });
  assert.deepEqual(by[S('a')].proposals.map((p: any) => [p.sourceId, p.verdict]), [['fs-a', 'green'], ['fs-b', 'green']]);
  assert.deepEqual([by[S('a')].followed, 'why' in by[S('a')]], [[], false]);
  // C: it lines up, but only under another name of the series -- amber, for a person to look at.
  assert.deepEqual(by[S('c')].proposals.map((p: any) => [p.sourceId, p.verdict, p.amber, p.title]), [['fs-b', 'amber', 'other_name', 'Gamma Legend']]);
  // F: the exact title, and numbers that do not line up -- amber, with the counts that say so.
  assert.deepEqual(by[S('f')].proposals.map((p: any) => [p.sourceId, p.amber, p.ours.lined, p.theirs.of]),
    [['fs-c', 'numbering', 0, 16], ['fs-d', 'numbering', 0, 16], ['fs-e', 'numbering', 0, 16]]);
  // K: a title that merely contains ours, numbered past it, is a sequel's shape (PR #133's rule): never proposed.
  // Reintroduce by keeping numbering_differs whatever matched: K is proposed, amber.
  assert.deepEqual([by[S('k')].why, 'proposals' in by[S('k')]], ['refused', false], 'a sequel is proposed');
  // H: an adult series' proposal names it as plainly as its title, so an admin hiding 18+ reads neither. Reintroduce
  // by answering results as stored (shown() in routes/findSources.ts): its candidate's title and cover are read.
  const hid = (await state('')).run.results.find((x: any) => x.seriesId === S('h'));
  assert.deepEqual(hid.proposals.map((p: any) => [p.sourceId, p.verdict, 'title' in p, 'coverUrl' in p, 'url' in p]), [['fs-adult', 'green', false, false, false]],
    'an admin hiding 18+ reads the candidate of an adult series');
  assert.equal(by[S('h')].proposals[0].title, 'Eta Adult');
  const [audit] = await q(`SELECT detail FROM audit_log WHERE event = 'source.find'`);
  assert.deepEqual([audit.detail.review, audit.detail.proposed, audit.detail.followed], [true, 4, 0]);
});

test('following a proposal follows exactly that one, under the cap, the posting-order rule and what it follows', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('c', 'Gamma Saga');
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1,'gammalegend','Gamma Legend','admin')`, [S('c')]);
  await series('f', 'Zeta Wrong');
  await series('o', 'Omega Manhwa');
  const runId = await reviewRun([S('a'), S('c'), S('f'), S('o')]);
  assert.equal((await decide(runId, 'follow', S('a'), 'fs-b', memberAuth)).statusCode, 403, 'admins only');

  // Exactly the one named, written by the follow path with the admin as its author; its result says so.
  const r = await decide(runId, 'follow', S('a'), 'fs-b');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(await followers([S('a'), S('c'), S('f')]), [`${S('a')}:fs-b:fs-b|Alpha Tale:admin`]);
  assert.deepEqual(r.json().result.followed, [{ sourceId: 'fs-b', name: 'Name fs-b', chapters: 13 }]);
  assert.deepEqual(r.json().result.proposals.map((p: any) => [p.sourceId, p.state ?? null]), [['fs-a', null], ['fs-b', 'followed']]);
  const run = (await state()).run;
  assert.equal(run.followed, 1);
  assert.equal(run.results.find((x: any) => x.seriesId === S('a')).proposals[1].state, 'followed', 'the run keeps the decision');
  const [audit] = await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'via' = 'find_review'`);
  assert.deepEqual([audit.detail.runId, audit.detail.source, audit.detail.verdict], [runId, 'fs-b', 'green']);
  assert.equal((await decide(runId, 'follow', S('a'), 'fs-b')).json().error, 'decided', 'one follow per proposal');
  assert.equal((await decide(runId, 'follow', S('a'), 'fs-c')).statusCode, 404, 'no such proposal: nothing on trust');

  // Numbered by posting order since the run: refused as the manual route refuses it. Reintroduce by dropping the
  // postingOrderSeries check in decide(): C follows fs-b.
  await q(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = $1`, [S('c')]);
  const po = await decide(runId, 'follow', S('c'), 'fs-b');
  assert.deepEqual([po.statusCode, po.json().error], [409, 'posting_order'], 'a series numbered by posting order is followed');
  // A source the series follows already, another way since, is never re-pointed (PR #133's rule).
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,'fs-c','fs-c|Elsewhere')`, [S('f')]);
  assert.equal((await decide(runId, 'follow', S('f'), 'fs-c')).json().error, 'already_followed', 'a source it follows is re-pointed');
  // At the cap: followJudged's own refusal. Reintroduce by dropping its `cap` arm in decide(): it reads not_found.
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,'fs-x1','x1')`, [S('f')]);
  const full = await decide(runId, 'follow', S('f'), 'fs-d');
  assert.deepEqual([full.statusCode, full.json().error], [409, 'full'], 'a series at the cap is not said to be full');
  assert.deepEqual(await followers([S('c'), S('f')]), [`${S('f')}:fs-c:fs-c|Elsewhere:null`], 'nothing else was written');
  assert.equal((await state()).run.results.find((x: any) => x.seriesId === S('f')).proposals.every((p: any) => !p.state), true,
    'a refused follow decides nothing');

  // An adult-flagged source proposed for a clean series is followed: the deciding admin's reach, the run's own rule.
  // Reintroduce the hunt's sweepAllowedFor in decide(): it reads source_unavailable.
  const o = await decide(runId, 'follow', S('o'), 'fs-adult');
  assert.equal(o.statusCode, 200, o.body);
  assert.deepEqual(await followers([S('o')]), [`${S('o')}:fs-adult:fs-adult|Omega Manhwa:admin`]);
});

test('a dismissed proposal stays dismissed', { skip }, async () => {
  await series('a', 'Alpha Tale');
  const runId = await reviewRun([S('a')]);
  const d = await decide(runId, 'dismiss', S('a'), 'fs-a');
  assert.equal(d.statusCode, 200, d.body);
  assert.deepEqual(d.json().result.proposals.map((p: any) => p.state ?? null), ['dismissed', null]);
  // Reintroduce by dropping the `decided` refusal in decide(): the dismissed source is followed.
  const again = await decide(runId, 'follow', S('a'), 'fs-a');
  assert.deepEqual([again.statusCode, again.json().error, again.json().state], [409, 'decided', 'dismissed'], 'a dismissed proposal is followed');
  assert.deepEqual(await followers([S('a')]), [], 'nothing followed');
  assert.equal((await state()).run.results[0].proposals[0].state, 'dismissed');
});

test('an earlier search opens by its id, and its matches can still be decided there', { skip }, async () => {
  // v0.52.0: only the newest run was read in full, so a review-first run with matches still to decide could not be
  // reopened once another search had run after it.
  await series('a', 'Alpha Tale');
  await series('e', 'Epsilon Nothing');
  const older = await reviewRun([S('a')]);
  const newer = (await post({ seriesIds: [S('e')] })).json().runId;
  await fsLib.findSettled();
  assert.equal((await state()).run.id, newer, 'the newest run is the default');
  // Reintroduce by reading the newest whatever is asked (findState ignoring runId): this reads the newer run.
  const opened = await state(`?runId=${older}`);
  assert.equal(opened.run.id, older, 'an earlier search does not open');
  assert.deepEqual([opened.run.review, opened.run.results[0].proposals.map((p: any) => p.sourceId)], [true, ['fs-a', 'fs-b']]);
  assert.deepEqual(opened.recent.map((r: any) => r.id), [newer, older], 'the kept runs, as for the newest');
  const d = await decide(older, 'follow', S('a'), 'fs-a');
  assert.equal(d.statusCode, 200, d.body);
  assert.equal((await state(`?runId=${older}`)).run.results[0].proposals[0].state, 'followed', 'the decision reads back on the earlier run');
  const gone = await app.inject({ method: 'GET', url: '/api/admin/sources/find?runId=00000000-0000-0000-0000-000000000000', headers: adminAuth });
  assert.deepEqual([gone.statusCode, gone.json().error], [404, 'not_found']);
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

// ---- v0.54.0: Replace ------------------------------------------------------------------------------------------
//
// The owner, after a full Find run left all 195 aqua series on aqua: "i have to go one by one test and find replacement
// sources". A Replace run moves every series of one source off it: its best working follower becomes its main source
// with no search, and only a series with none is searched for, followed and then promoted.

/** Follows for a series, in this order: `fresh` answered with 12 numbers just now; `coverage` the follow-time share. */
async function follows(key: string, list: Array<[string, { fresh?: boolean; coverage?: number }?]>) {
  for (const [i, [source, o]] of list.entries()) {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, coverage, checked_at, chapters, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 hour' + $7 * interval '1 minute')`,
      [S(key), source, `${source}|${key}`, o?.coverage ?? null, o?.fresh ? new Date() : null, o?.fresh ? 12 : null, i]);
  }
}
const mainOf = async (key: string) => (await q('SELECT source_id FROM lib_series WHERE id = $1', [S(key)]))[0]?.source_id;
const followersOf = async (key: string) =>
  (await q('SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id', [S(key)])).map((r: any) => r.source_id);
const promote = (runId: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/admin/sources/find/${runId}/promote`, headers: adminAuth, payload });
const resultsBy = (run: any) => Object.fromEntries(run.results.map((x: any) => [x.seriesId, x]));

test("Replace promotes each series' best working follower without searching, drops the replaced source, and reports from and to", { skip }, async () => {
  // Each series' `to` is the ranking's (lib/replaceSource.ts rankFollowers). Reintroduce by dropping the health tier:
  // Rho Two takes the cooling fs-cool. The tenths of coverage: Rho Three takes fs-d. The source order: Rho Four takes fs-e.
  const { invalidateSourcePrefs } = await import('../src/lib/sourcePrefs');
  await series('r1', 'Rho One'); await follows('r1', [['fs-off', { fresh: true }], ['fs-a', { fresh: true }]]);
  await series('r2', 'Rho Two'); await follows('r2', [['fs-cool', { fresh: true }], ['fs-b']]);
  await series('r3', 'Rho Three'); await follows('r3', [['fs-d', { fresh: true, coverage: 0.5 }], ['fs-c', { fresh: true, coverage: 1 }]]);
  await series('r4', 'Rho Four'); await follows('r4', [['fs-e', { fresh: true, coverage: 1 }], ['fs-f', { fresh: true, coverage: 1 }]]);
  await series('r5', 'Rho Five', { numbering: 'posting_order' }); await follows('r5', [['fs-a', { fresh: true }]]);
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('fs-off', true)`);
  await q(`INSERT INTO source_health (source_id, status, blocked_until) VALUES ('fs-cool', 'rate_limited', now() + interval '1 hour')`);
  const [{ source_prefs: prefsWas }] = await q('SELECT source_prefs FROM server_settings WHERE id = 1');
  await q(`UPDATE server_settings SET source_prefs = '{"priority":["fs-f"]}'::jsonb WHERE id = 1`);
  invalidateSourcePrefs();
  try {
    const r = await post({ sourceId: MAIN, mode: 'replace' });
    assert.equal(r.statusCode, 202, r.body);
    assert.equal(r.json().total, 5);
    await fsLib.findSettled();
    const run = (await state()).run;
    assert.deepEqual([run.mode, run.status, run.promoted, run.left, run.turnedOff], ['replace', 'done', 4, 1, false], 'the run says what it moved and what is left');
    const by = resultsBy(run);
    assert.deepEqual(['r1', 'r2', 'r3', 'r4'].map((k) => by[S(k)].promoted?.to), ['fs-a', 'fs-b', 'fs-c', 'fs-f'], "each series' best working follower");
    assert.deepEqual(by[S('r1')].promoted, { from: MAIN, fromName: 'Main Down', to: 'fs-a', toName: 'Name fs-a', via: 'follower', old: 'dropped' });
    assert.equal('why' in by[S('r1')], false, 'a promoted series says no why');
    assert.deepEqual(by[S('r1')].skipped, [{ sourceId: 'fs-off', name: 'Name fs-off', why: 'off' }], 'the switched-off follower was passed over');
    assert.deepEqual(by[S('r2')].skipped, [{ sourceId: 'fs-cool', name: 'Name fs-cool', why: 'cooling' }], 'and the cooling one, ranked last');
    assert.equal(by[S('r5')].why, 'posting_order', 'a series numbered by posting order is left alone');
    for (const [k, to] of [['r1', 'fs-a'], ['r2', 'fs-b'], ['r3', 'fs-c'], ['r4', 'fs-f'], ['r5', MAIN]]) assert.equal(await mainOf(k), to, `${k}'s main source`);
    assert.deepEqual(await followersOf('r1'), ['fs-off'], 'the replaced source is dropped, the rest stay');
    assert.deepEqual(await followersOf('r5'), ['fs-a'], 'the posting-order series is untouched');
    assert.deepEqual(searches, [], 'nothing was searched: every series was decided from its followers');
    const audits = await q(`SELECT detail FROM audit_log WHERE event = 'series.main_source' AND detail->>'runId' = $1`, [run.id]);
    assert.equal(audits.length, 4, 'each switch audited');
    assert.ok(audits.every((x: any) => x.detail.via === 'replace' && x.detail.from === MAIN));
    const find = (await q(`SELECT detail FROM audit_log WHERE event = 'source.find' AND detail->>'runId' = $1`, [run.id]))[0].detail;
    assert.deepEqual([find.mode, find.promoted, find.left, find.turnedOff], ['replace', 4, 1, false]);
    // The recent list counts what each run promoted, from its results.
    assert.deepEqual([(await state()).recent[0].mode, (await state()).recent[0].promoted], ['replace', 4]);
  } finally {
    await q('UPDATE server_settings SET source_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(prefsWas)]);
    invalidateSourcePrefs();
  }
});

test('a Replace run names the source it replaces, on its card and in its summary', { skip }, async () => {
  // A Replace dialog opened again for a source while its run goes shows that run, not the offer to start one: the web
  // finds it by the run's source (components/ReplaceDialog.tsx), on Admin → Sources, on Health, or after a reload.
  // Reintroduce by leaving the source off the card (startFind): the card names no source. By dropping it from scopeOf:
  // the summary does not.
  await series('a', 'Alpha Tale');
  gate = new Promise<void>((r) => { openGate = r; });
  const r = await post({ sourceId: MAIN, mode: 'replace' });
  assert.equal(r.statusCode, 202, r.body);
  try {
    await until(() => searches.length > 0, 'the run to reach its search');
    const card = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json().runs
      .find((x: any) => x.kind === 'find_sources');
    assert.deepEqual([card.status, card.mode, card.sourceId, card.sourceName], ['running', 'replace', MAIN, 'Main Down'],
      'the card names the source it replaces');
    const going = await state();
    assert.deepEqual([going.running, going.run.mode, going.run.sourceId, going.run.sourceName], [true, 'replace', MAIN, 'Main Down'],
      'the running run names it');
    assert.deepEqual([going.recent[0].sourceId, going.recent[0].sourceName], [MAIN, 'Main Down'], 'and so does its summary');
  } finally {
    openGate();
    gate = null;
  }
  await fsLib.findSettled();
  const ended = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: adminAuth })).json().runs
    .find((x: any) => x.kind === 'find_sources');
  assert.deepEqual([ended.status, ended.sourceId, ended.sourceName], ['done', MAIN, 'Main Down'], 'an ended card still names it');
});

test('a series with no working follower is searched, followed and promoted; one with nothing to follow says why', { skip }, async () => {
  // Reintroduce by not promoting after a follow: Alpha Tale stays on the replaced source. By counting its dead
  // followers against the cap: it is `full` and never searched.
  await series('a', 'Alpha Tale'); await follows('a', [['fs-nowhere'], ['fs-off']]);
  await series('e', 'Epsilon Nothing');
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('fs-off', true)`);
  const r = await post({ sourceId: MAIN, mode: 'replace' });
  assert.equal(r.statusCode, 202, r.body);
  await fsLib.findSettled();
  const run = (await state()).run;
  const by = resultsBy(run);
  assert.deepEqual(by[S('a')].promoted, { from: MAIN, fromName: 'Main Down', to: 'fs-a', toName: 'Name fs-a', via: 'search', old: 'dropped' },
    'a series with no working follower is searched, followed and promoted');
  assert.deepEqual(by[S('a')].followed.map((f: any) => f.sourceId), ['fs-a', 'fs-b']);
  assert.deepEqual(by[S('a')].dropped, [{ sourceId: 'fs-nowhere', name: 'fs-nowhere' }, { sourceId: 'fs-off', name: 'Name fs-off' }],
    'its dead followers made room, the one not loaded first');
  assert.equal(await mainOf('a'), 'fs-a');
  assert.deepEqual(await followersOf('a'), ['fs-b'], 'the other source it followed stays a follower');
  assert.ok(searches.includes('fs-a:Alpha Tale'));
  assert.equal(by[S('e')].why, 'no_match', 'the search said why it found nothing');
  assert.equal(await mainOf('e'), MAIN, 'and that series stays where it was');
  assert.equal(run.promoted, 1);
});

test('review first moves nothing, proposes what it would promote, and promote does exactly that', { skip }, async () => {
  // Reintroduce by dropping the review branch in replaceFor: Rho One moves during the run.
  await series('r1', 'Rho One'); await follows('r1', [['fs-off', { fresh: true }], ['fs-a', { fresh: true, coverage: 1 }]]);
  await series('a', 'Alpha Tale');
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('fs-off', true)`);
  const both = await post({ sourceId: MAIN, mode: 'replace', review: true, turnOff: true });
  assert.deepEqual([both.statusCode, both.json().error], [400, 'bad_request'], 'a review never turns a source off');
  assert.equal((await post({ sourceId: MAIN, turnOff: true })).statusCode, 400, 'only Replace does');
  assert.equal((await post({ seriesIds: [S('r1')], mode: 'replace' })).statusCode, 400, 'and Replace names its source');
  const r = await post({ sourceId: MAIN, mode: 'replace', review: true });
  assert.equal(r.statusCode, 202, r.body);
  const runId = r.json().runId;
  await fsLib.findSettled();
  const run = (await state()).run;
  assert.deepEqual([run.review, run.mode, run.promoted], [true, 'replace', 0], 'review first moves nothing');
  assert.equal(await mainOf('r1'), MAIN, 'review first moves nothing');
  assert.equal(await mainOf('a'), MAIN);
  assert.deepEqual(await followersOf('a'), [], 'and follows nothing');
  const by = resultsBy(run);
  const fol = by[S('r1')].proposals;
  assert.deepEqual(fol.map((p: any) => [p.kind, p.sourceId, p.promote ?? false, p.verdict, p.standing]), [['follower', 'fs-a', true, 'green', 'usable']],
    'its working follower, marked as the one to promote');
  assert.deepEqual(by[S('r1')].skipped, [{ sourceId: 'fs-off', name: 'Name fs-off', why: 'off' }]);
  const found = by[S('a')].proposals;
  assert.deepEqual(found.map((p: any) => [p.kind, p.sourceId, p.promote ?? false]), [['search', 'fs-a', true], ['search', 'fs-b', false]],
    'what the search found, the first green one marked');

  const one = await promote(runId, { seriesId: S('r1'), sourceId: 'fs-a' });
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(one.json().result.promoted.to, 'fs-a');
  assert.equal(one.json().result.proposals[0].state, 'promoted');
  assert.equal(await mainOf('r1'), 'fs-a', 'promote does exactly that');
  const again = await promote(runId, { seriesId: S('r1'), sourceId: 'fs-a' });
  assert.deepEqual([again.statusCode, again.json().error, again.json().state], [409, 'decided', 'promoted'], 'and only once');
  // A search's match is followed first, then made the main source.
  const two = await promote(runId, { seriesId: S('a'), sourceId: 'fs-a' });
  assert.equal(two.statusCode, 200, two.body);
  assert.deepEqual([two.json().result.promoted.via, two.json().result.followed.map((f: any) => f.sourceId)], ['search', ['fs-a']]);
  assert.equal(await mainOf('a'), 'fs-a');
  assert.deepEqual(await followersOf('a'), [], 'the replaced source dropped, nothing else followed');
  assert.equal((await promote(runId, { seriesId: S('a'), sourceId: 'fs-c' })).statusCode, 404, 'a source never proposed');
  assert.equal((await state(`?runId=${runId}`)).run.promoted, 2, 'the run counts what was promoted from it');
});

test('turnOff turns the replaced source off only when no series is left on it, and drops its follows elsewhere', { skip }, async () => {
  // Reintroduce by not checking `left` before turning it off: the first run turns it off with Rho Five still on it.
  const { isDisabled } = await import('../src/lib/sourceHealth');
  await series('r1', 'Rho One'); await follows('r1', [['fs-a', { fresh: true }]]);
  await series('r5', 'Rho Five', { numbering: 'posting_order' }); await follows('r5', [['fs-b', { fresh: true }]]);
  // A series that only follows the replaced source: that follow goes when it is turned off, with its listing rows.
  await series('x', 'Xi Follower', { source: 'fs-c' });
  await follows('x', [[MAIN]]);
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1, 13, $2, '{}'::jsonb)`, [S('x'), MAIN]);
  const first = await post({ sourceId: MAIN, mode: 'replace', turnOff: true });
  assert.equal(first.statusCode, 202, first.body);
  await fsLib.findSettled();
  let run = (await state()).run;
  assert.deepEqual([run.promoted, run.left, run.turnedOff], [1, 1, false], 'a series is left on it: it stays on');
  assert.equal(await isDisabled(MAIN), false, 'turnOff turns the replaced source off only when no series is left on it');
  assert.deepEqual(await followersOf('x'), [MAIN], 'and its follows stay');

  await q('UPDATE lib_series SET numbering = NULL WHERE id = $1', [S('r5')]);
  const second = await post({ sourceId: MAIN, mode: 'replace', turnOff: true });
  assert.equal(second.statusCode, 202, second.body);
  await fsLib.findSettled();
  run = (await state()).run;
  assert.deepEqual([run.promoted, run.left, run.turnedOff], [1, 0, true], 'nothing left: turned off');
  assert.equal(await isDisabled(MAIN), true);
  assert.deepEqual(await followersOf('x'), [], 'its follows elsewhere dropped');
  assert.equal((await q('SELECT count(*)::int AS n FROM series_listing WHERE series_id = $1 AND source_id = $2', [S('x'), MAIN]))[0].n, 0,
    'with their listing rows');
  const retire = (await q(`SELECT detail FROM audit_log WHERE event = 'source.retire' AND detail->>'runId' = $1`, [run.id]))[0]?.detail;
  assert.deepEqual([retire?.source, retire?.done, retire?.via], [MAIN, 'turned_off', 'replace']);
});

test('a series being checked is waited for; past the wait it is busy', { skip }, async () => {
  // Reintroduce by not waiting (drop waitOut's loop): the series is switched under the check it waited for.
  const { updateSeries, runsInside } = await import('../src/lib/updater');
  fsLib.setFindTiming({ paceMs: 0, wallMs: 10_000, quietMs: 20, busyMs: 300 });
  await series('b1', 'Beta One'); await follows('b1', [['fs-a', { fresh: true }]]);
  listGate = new Promise<void>((r) => { openList = r; });
  let check = updateSeries(S('b1'), 0);
  try {
    await until(() => runsInside(S('b1')) > 0, 'the check to be inside the series');
    assert.equal((await post({ sourceId: MAIN, mode: 'replace' })).statusCode, 202);
    await fsLib.findSettled();
    const busy = resultsBy((await state()).run)[S('b1')];
    assert.equal(busy.why, 'busy', 'past the wait it is busy');
    assert.equal(await mainOf('b1'), MAIN, 'and untouched');
  } finally { openList(); listGate = null; await check; }

  // The check ends within the wait: the series is replaced as soon as it has.
  fsLib.setFindTiming({ paceMs: 0, wallMs: 10_000, quietMs: 20, busyMs: 10_000 });
  listGate = new Promise<void>((r) => { openList = r; });
  check = updateSeries(S('b1'), 0);
  try {
    await until(() => runsInside(S('b1')) > 0, 'the second check');
    assert.equal((await post({ sourceId: MAIN, mode: 'replace' })).statusCode, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await mainOf('b1'), MAIN, 'not while the check is inside it');
    openList();
    await fsLib.findSettled();
    assert.equal(resultsBy((await state()).run)[S('b1')].promoted?.to, 'fs-a', 'a series being checked is waited for');
  } finally { openList(); listGate = null; await check; }
});

test('a stop leaves every series either replaced or untouched', { skip }, async () => {
  const { updateSeries, runsInside } = await import('../src/lib/updater');
  fsLib.setFindTiming({ paceMs: 0, wallMs: 10_000, quietMs: 20, busyMs: 10_000 });
  for (const k of ['t1', 't2', 't3', 't4']) { await series(k, `Tau ${k}`); await follows(k, [['fs-a', { fresh: true }]]); }
  // The third waits on a check inside it, and the stop comes while it waits.
  listGate = new Promise<void>((r) => { openList = r; });
  const check = updateSeries(S('t3'), 0);
  try {
    await until(() => runsInside(S('t3')) > 0, 'the check');
    assert.equal((await post({ sourceId: MAIN, mode: 'replace' })).statusCode, 202);
    await until(async () => (await state()).run?.current?.seriesId === S('t3'), 'the run to wait on the third series');
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/sources/find/stop', headers: adminAuth })).json().stopped, true);
    // Let the check go once the run has ended: the listing refreshes after it list through fs-a too.
    await until(async () => !(await state()).running, 'the run to end');
    openList();
    await fsLib.findSettled();
  } finally { openList(); listGate = null; await check; }
  const run = (await state()).run;
  assert.equal(run.status, 'stopped');
  const by = resultsBy(run);
  for (const k of ['t1', 't2', 't3', 't4']) {
    const main = await mainOf(k);
    const fols = await followersOf(k);
    if (by[S(k)].promoted) assert.deepEqual([main, fols], ['fs-a', []], `${k}: replaced, all of it`);
    else assert.deepEqual([main, fols, by[S(k)].why], [MAIN, ['fs-a'], 'not_tried'], `${k}: untouched, and says so`);
  }
  assert.deepEqual(['t1', 't2', 't3', 't4'].map((k) => !!by[S(k)].promoted), [true, true, false, false], 'a stop leaves every series either replaced or untouched');
});

test('Find and Replace share one run; the preview says so', { skip }, async () => {
  await series('a', 'Alpha Tale');
  gate = new Promise<void>((r) => { openGate = r; });
  try {
    assert.equal((await post({ sourceId: MAIN })).statusCode, 202, 'a Find run');
    const busy = await post({ sourceId: MAIN, mode: 'replace' });
    assert.deepEqual([busy.statusCode, busy.json().error], [409, 'busy'], 'Find and Replace share one run');
    const preview = await app.inject({ method: 'GET', url: `/api/admin/sources/${MAIN}/replace-preview`, headers: adminAuth });
    assert.equal(preview.json().busy, true, 'and the preview says one is going');
  } finally {
    openGate(); gate = null;
    await app.inject({ method: 'POST', url: '/api/admin/sources/find/stop', headers: adminAuth });
    await fsLib.findSettled();
  }
});

test("a live-shaped library: 195 series on a switched-off main, 184 with a working follower -- the preview says 184 and 11, and the run promotes the 184 without one search", { skip }, async () => {
  const { setDisabled } = await import('../src/lib/sourceHealth');
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           SELECT 's_fs_live' || i, 'T!fs', 'Live ' || lpad(i::text, 3, '0'), 's_fs_live' || i, 0, $1, $2::text, $2::text || '|live' || i, true
             FROM generate_series(1, 195) i`, [LIB, MAIN]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, checked_at, chapters)
           SELECT 's_fs_live' || i, 'fs-a', 'fs-a|live' || i, now(), 12 FROM generate_series(1, 184) i`);
  // The eleven with nothing to follow list twelve numbers, so they are searched for (MIN_HAVE).
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen)
           SELECT 's_fs_live' || i, n, $1::text, '{}'::jsonb FROM generate_series(185, 195) i, generate_series(1, 12) n`, [MAIN]);
  await setDisabled(MAIN, true);
  const preview = await app.inject({ method: 'GET', url: `/api/admin/sources/${MAIN}/replace-preview`, headers: adminAuth });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json(), { main: 195, withBackup: 184, toSearch: 11, postingOrder: 0, busy: false }, 'the preview says 184 and 11');
  const r = await post({ sourceId: MAIN, mode: 'replace' });
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(r.json().total, 195);
  await fsLib.findSettled();
  const run = (await state()).run;
  assert.deepEqual([run.status, run.promoted, run.left], ['done', 184, 11]);
  const searched = new Set(searches.map((x) => x.slice(x.indexOf(':') + 1)));
  const lone = Array.from({ length: 11 }, (_, i) => `Live ${String(185 + i).padStart(3, '0')}`);
  assert.deepEqual([...searched].sort(), lone, 'only the eleven with no working follower were searched for: the 184 without one search');
  assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE library_id = $1 AND source_id = 'fs-a'`, [LIB]))[0].n, 184);
  // The run lists them followers-first: every promotion before the first search.
  assert.ok(run.results.slice(0, 184).every((x: any) => x.promoted?.via === 'follower'), 'the instant promotions land first');
});

test('a series moved off the source after the run started is left alone, and says so', { skip }, async () => {
  // Reintroduce by dropping the `moved` check at the top of replaceFor: Alpha Tale is searched for and follows two sources.
  const { updateSeries, runsInside } = await import('../src/lib/updater');
  fsLib.setFindTiming({ paceMs: 0, wallMs: 10_000, quietMs: 20, busyMs: 10_000 });
  await series('m1', 'Mu One'); await follows('m1', [['fs-a', { fresh: true }]]);
  await series('m2', 'Alpha Tale');
  listGate = new Promise<void>((r) => { openList = r; });
  const check = updateSeries(S('m1'), 0);
  try {
    await until(() => runsInside(S('m1')) > 0, 'the check');
    assert.equal((await post({ sourceId: MAIN, mode: 'replace' })).statusCode, 202);
    await until(async () => (await state()).run?.current?.seriesId === S('m1'), 'the run to wait on the first series');
    // Moved by hand while the run waits: Make main, or another run.
    await q(`UPDATE lib_series SET source_id = 'fs-c', source_series_id = 'fs-c|m2' WHERE id = $1`, [S('m2')]);
    openList();
    await fsLib.findSettled();
  } finally { openList(); listGate = null; await check; }
  const by = resultsBy((await state()).run);
  assert.equal(by[S('m1')].promoted?.to, 'fs-a');
  assert.equal(by[S('m2')].why, 'moved', 'a series moved off the source after the run started is left alone');
  assert.equal(searches.some((x) => x.endsWith(':Alpha Tale')), false, 'and not searched for');
  assert.deepEqual(await followersOf('m2'), []);
});
