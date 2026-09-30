// Find other sources (lib/findSources.ts; the idea and the review are @TIGamingTV's, PR #119), through the real
// routes: a search that PROPOSES, a review, and the follows an admin confirms.
//
// The case it was built for: a main source that serves only "temporarily offline", and a person who wants every one
// of its series to follow another source without doing it one by one. Every rule is asserted by what the fake sites
// were asked and what was written:
//
//   - the search follows nothing; the main source is never asked, nor a source the series already follows, or a
//     disabled or cooling one; an extension that flags itself adult IS asked for a clean series (the admin confirms
//     every follow, and most manhwa extensions carry the flag); a series numbered by posting order, or already at
//     the cap, is in the run but never searched;
//   - sources are asked in scan order under the hunt's slots, a series stops asking once its free slots are filled
//     by green candidates, an other name matches exactly, and a failed search reports nothing to source health;
//   - a name that matches exactly with chapter numbers that do not line up is an amber candidate: never followed in
//     bulk, followed one at a time only, judged again, its audit an override;
//   - a follow is insert-only, under the lock, with posting order re-read; stale candidates close;
//   - one search at a time, paced, waiting on a sweep, stoppable and resumable, `interrupted` after a shutdown or a
//     restart; the listing refreshes after a follow are paced and dropped beside a sweep;
//   - a card under Server tasks for admins, and Health's button.
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
  'fs-throws': [],
  'fs-cool': [{ title: 'Alpha Tale', nums: R(1, 12) }],
  'fs-off': [{ title: 'Alpha Tale', nums: R(1, 12) }],
  'fs-adult': [{ title: 'Eta Adult', nums: R(1, 12) }, { title: 'Epsilon Nothing', nums: R(1, 12) }],
};
const ORDER: Record<string, number> = {
  'fs-a': 1, 'fs-b': 2, 'fs-c': 3, 'fs-d': 4, 'fs-throws': 5, 'fs-cool': 6, 'fs-off': 7, 'fs-adult': 8,
};
/** Every search asked, as `source:term`. */
const searches: string[] = [];
/** When set, fs-a's searches wait on it: a run that stays searching while a test looks at it. */
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
      const c = CATALOGUE[id].find((x) => x.title === sid.split('|')[1]);
      return (c?.nums ?? []).map((n) => ({ sourceId: `${sid}#${n}`, number: n }));
    },
    async getPageUrls() { return []; },
  };
}

let q: any, app: any, adminAuth: Record<string, string>, memberAuth: Record<string, string>, adminId = '';
let fsLib: typeof import('../src/lib/findSources');
let runtime: typeof import('../src/lib/runtime').runtime;
const refreshed: string[] = [];

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
const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers: adminAuth, ...(payload ? { payload } : {}) });
const state = async () => {
  const r = await call('GET', '/api/admin/sources/find');
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const review = async (runId: string, qs = '?adult=1') => {
  const r = await call('GET', `/api/admin/sources/find/${runId}${qs}`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const card = async () => (await call('GET', '/api/sources/jobs')).json().runs.find((x: any) => x.kind === 'find_sources');
const followers = async (key: string) =>
  (await q(`SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY source_id`, [S(key)])).map((r: any) => r.source_id);
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** Start a run over these series and wait for its search to end. */
const searched = async (keys: string[]) => {
  const r = await post({ seriesIds: keys.map(S) });
  assert.equal(r.statusCode, 202, r.body);
  await fsLib.findSettled();
  return r.json().runId as string;
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
  (await import('../src/lib/healthSummary')).setSummaryRefresh(async () => {}, { everyMs: 1 });

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
  fsLib._resetFindState();
  searches.length = 0;
  refreshed.length = 0;
  gate = null;
  runtime.updating = false;
  runtime.repairing = false;
  runtime.stopping = false;
  fsLib.setFindTiming({ paceMs: 0, wallMs: 10_000, quietMs: 20, refresh: async (id) => { refreshed.push(id); } });
  await q('DELETE FROM lib_series WHERE library_id = ANY($1)', [[LIB, ADULT_LIB]]);
  await q('DELETE FROM source_find_runs');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'fs-%'`);
  await q(`DELETE FROM audit_log WHERE event LIKE 'source.find%' OR (event = 'series.follow_source' AND detail->>'via' = 'find_sources')`);
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

test('a run over a down source proposes candidates for each series, and follows nothing', { skip }, async () => {
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

  const r = await post({ sourceId: MAIN });
  assert.equal(r.statusCode, 202, r.body);
  const { runId, total, skipped } = r.json();
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.equal(total, 7, 'every series whose main source it is');
  assert.equal(skipped, 2, 'posting order and the full one are in the run, unsearched');
  await fsLib.findSettled();

  const st = await state();
  assert.equal(st.running, false);
  assert.equal(st.run.id, runId);
  assert.equal(st.run.status, 'review', 'candidates wait for a person');
  assert.deepEqual([st.run.total, st.run.done, st.run.followed], [7, 7, 0]);
  assert.equal(st.run.found, 5);
  assert.equal(st.run.startedBy, ADMIN, 'the account by name, never its id');
  assert.deepEqual([st.run.sourceId, st.run.sourceName], [MAIN, 'Main Down']);

  const rv = await review(runId);
  const by = Object.fromEntries(rv.items.map((x: any) => [x.seriesId, x]));
  const cands = (k: string) => by[S(k)].candidates.map((c: any) => `${c.source}:${c.verdict}`).sort();
  // A: the first two sources in scan order carry it and line up: its two free slots are filled by green candidates,
  // and the third carrier is never asked. Reintroduce by dropping `ok >= free` from done(): fs-c is searched for it.
  assert.deepEqual(cands('a'), ['fs-a:ok', 'fs-b:ok']);
  assert.equal(searches.includes('fs-c:Alpha Tale'), false, 'a series stops asking once its free slots are filled');
  assert.deepEqual([by[S('a')].freeSlots, by[S('a')].primary], [2, { source: MAIN, name: 'Main Down' }]);
  // B: already at the cap, D: posting order -- skipped, never searched.
  assert.deepEqual([by[S('b')].state, by[S('b')].note], ['skipped', 'full']);
  assert.deepEqual([by[S('d')].state, by[S('d')].note], ['skipped', 'posting_order']);
  assert.equal(searches.some((x) => x.endsWith(':Beta Story') || x.endsWith(':Delta Order')), false);
  // C: carried only under its other name, matched exactly, and the review says which name did it.
  assert.deepEqual(cands('c'), ['fs-b:ok']);
  assert.equal(by[S('c')].candidates[0].theirName, 'Gamma Legend');
  assert.ok(searches.includes('fs-b:Gamma Legend'));
  // E: only an extension that flags itself adult carries it, and it is asked for this clean series too: the admin
  // confirms every follow. Reintroduce the hunt's sweepAllowedFor: E has nothing, and on a library of manhwa
  // extensions every series reads "no other source could be asked".
  assert.deepEqual(cands('e'), ['fs-adult:ok']);
  // F: the same name, numbered another way: amber candidates, kept because the name matched exactly.
  assert.deepEqual(cands('f'), ['fs-c:numbering_differs', 'fs-d:numbering_differs']);
  // H: an adult series may reach the adult source.
  assert.deepEqual(cands('h'), ['fs-adult:ok']);

  // Never asked: the main source, a cooling or disabled source.
  assert.equal(searches.filter((x) => x.startsWith(`${MAIN}:`)).length, 0, 'the main source is never searched');
  assert.equal(searches.filter((x) => x.startsWith('fs-cool:') || x.startsWith('fs-off:')).length, 0);
  assert.ok(searches.includes('fs-adult:Epsilon Nothing'), 'an adult-flagged extension is not asked for a clean series');
  // A source whose search failed is not asked the next name: fs-throws is asked once for C, not under Gamma Legend.
  assert.equal(searches.filter((x) => x === 'fs-throws:Gamma Legend').length, 0);

  // Nothing is followed by the search. Reintroduce a follow in the search: rows appear.
  const rows = await q(`SELECT series_id FROM series_sources WHERE series_id = ANY($1) AND source_id NOT LIKE 'fs-x%'`,
    [['a', 'c', 'e', 'f', 'h'].map(S)]);
  assert.deepEqual(rows, [], 'the search followed a source');
  // A search that threw reported nothing: no cooldown, no evidence.
  assert.deepEqual(await q(`SELECT source_id FROM source_health WHERE source_id = 'fs-throws'`), []);

  const [audit] = await q(`SELECT detail FROM audit_log WHERE event = 'source.find'`);
  assert.deepEqual({ ...audit.detail, runId: undefined }, { runId: undefined, status: 'review', total: 7, done: 7, found: 5 });
  // The run card is its admin's, and says so; it downloads nothing, and names its review.
  const c = await card();
  assert.deepEqual([c.status, c.done, c.total, c.found, c.downloads, c.runId], ['done', 7, 7, 5, false, runId]);
});

test('only green candidates are followed in bulk: insert-only, under the cap, the refresh paced; amber ones one at a time', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('f', 'Zeta Wrong');
  const runId = await searched(['a', 'f']);
  const rv = await review(runId);
  const all = rv.items.flatMap((i: any) => i.candidates);
  const green = all.filter((c: any) => c.verdict === 'ok');
  const amber = all.filter((c: any) => c.verdict !== 'ok');
  assert.equal(green.length, 2);
  assert.equal(amber.length, 2);

  // Amber alone: refused as a whole. Reintroduce a bulk override: they are followed.
  const onlyAmber = await call('POST', `/api/admin/sources/find/${runId}/follow`, { candidateIds: amber.map((c: any) => c.id) });
  assert.equal(onlyAmber.statusCode, 409);
  assert.equal(onlyAmber.json().error, 'not_followable');

  // A follower gained elsewhere since the search: its candidate is closed, never re-pointed.
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,'fs-b','elsewhere')`, [S('a')]);
  const r = await call('POST', `/api/admin/sources/find/${runId}/follow`, { candidateIds: all.map((c: any) => c.id) });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().total, r.json().held], [1, 2], 'one green left open, the ambers held');
  await fsLib.findSettled();
  await until(() => refreshed.length === 1, 'the refresh');
  assert.deepEqual(await followers('a'), ['fs-a', 'fs-b']);
  const pointed = (await q(`SELECT source_series_id, added_by FROM series_sources WHERE series_id = $1 ORDER BY source_id`, [S('a')]));
  assert.equal(pointed[1].source_series_id, 'elsewhere', 'an old candidate re-pointed a follower gained since');
  assert.equal(pointed[0].added_by, adminId, 'added_by is the admin who confirmed it');
  assert.deepEqual(refreshed, [S('a')]);
  assert.deepEqual(await followers('f'), [], 'a bulk follow took an amber candidate');

  const after = await review(runId);
  const status = Object.fromEntries(after.items.flatMap((i: any) => i.candidates).map((c: any) => [c.source + '/' + c.itemId.slice(0, 4), c.status]));
  assert.ok(Object.values(status).includes('linked'));
  assert.ok(Object.values(status).includes('already_followed'), 'the stale candidate is closed');
  assert.equal(after.run.status, 'review', 'the ambers are still open');
  assert.deepEqual([after.run.followed], [1]);

  // One amber, on its own: only with a confirmation, judged again, and its audit says it was an override.
  const one = amber.find((c: any) => c.source === 'fs-c');
  assert.equal((await call('POST', `/api/admin/sources/find/candidates/${one.id}/follow`, {})).statusCode, 400, 'no confirmation');
  const ok = await call('POST', `/api/admin/sources/find/candidates/${one.id}/follow`, { confirm: true });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(await followers('f'), ['fs-c']);
  const [audit] = await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1`, [S('f')]);
  assert.deepEqual([audit.detail.via, audit.detail.override, audit.detail.runId], ['find_sources', true, runId]);
  const twice = await call('POST', `/api/admin/sources/find/candidates/${one.id}/follow`, { confirm: true });
  assert.deepEqual([twice.statusCode, twice.json().error], [409, 'closed']);
});

test('a follow is insert-only, re-reads posting order under the lock, and keeps the cap', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('g', 'Gamma Saga');
  const c = (source: string, sid = `${source}|Alpha Tale`) => ({ source, sourceSeriesId: sid, theirTitle: 'Alpha Tale', coverage: 1 });
  assert.equal(await fsLib.followConfirmed(S('a'), c('fs-a'), adminId), 'inserted');
  // Reintroduce the upsert: this reads 'inserted' and the follower points at another entry.
  assert.equal(await fsLib.followConfirmed(S('a'), c('fs-a', 'another'), adminId), 'already_followed');
  assert.equal(await fsLib.followConfirmed(S('a'), c(MAIN), adminId), 'primary');
  assert.equal(await fsLib.followConfirmed(S('a'), c('fs-b'), adminId), 'inserted');
  assert.equal(await fsLib.followConfirmed(S('a'), c('fs-c'), adminId), 'cap');
  // Renumbered after the review: the follow must still refuse.
  await q(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = $1`, [S('g')]);
  assert.equal(await fsLib.followConfirmed(S('g'), c('fs-a'), adminId), 'posting_order');
});

test('a hand pick is judged by the same rule, and refused before any lookup where a follow would be', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('d', 'Delta Order', { numbering: 'posting_order' });
  await series('e', 'Epsilon Nothing');
  const runId = await searched(['a', 'd', 'e']);
  const rv = await review(runId);
  const item = (k: string) => rv.items.find((i: any) => i.seriesId === S(k));
  const pick = (k: string, payload: unknown) => call('POST', `/api/admin/sources/find/items/${item(k).id}/candidates`, payload);

  searches.length = 0;
  const po = await pick('d', { source: 'fs-a', sourceSeriesId: 'fs-a|Alpha Tale' });
  assert.deepEqual([po.statusCode, po.json().error], [409, 'posting_order']);
  const own = await pick('e', { source: MAIN, sourceSeriesId: `${MAIN}|Epsilon Nothing` });
  assert.deepEqual([own.statusCode, own.json().error], [409, 'already_followed'], 'its own main source');
  const wrong = await pick('e', { source: 'fs-a', sourceSeriesId: 'fs-a|Alpha Tale' });
  assert.deepEqual([wrong.statusCode, wrong.json().error, wrong.json().theirTitle], [409, 'title_differs', 'Alpha Tale']);
  const right = await pick('e', { source: 'fs-adult', sourceSeriesId: 'fs-adult|Epsilon Nothing', cover: 'http://x/c.jpg' });
  assert.equal(right.statusCode, 200, right.body);
  assert.deepEqual([right.json().candidate.verdict, right.json().candidate.manual, right.json().candidate.cover], ['ok', true, 'http://x/c.jpg']);
  assert.equal(searches.length, 0, 'a pick searches nothing');

  // Its chapters, beside the series' own.
  const ch = await call('GET', `/api/admin/sources/find/items/${item('a').id}/chapters?source=fs-a&sourceSeriesId=${encodeURIComponent('fs-a|Alpha Tale')}`);
  assert.equal(ch.statusCode, 200, ch.body);
  assert.deepEqual([ch.json().count, ch.json().ourCount, ch.json().shared, ch.json().missing], [14, 12, 12, []]);
  assert.deepEqual(ch.json().chapters.filter((c: any) => !c.ours).map((c: any) => c.number), [13, 14]);
});

test('one search at a time; the scope must name something; a stop keeps what it found, and a resume goes on', { skip }, async () => {
  await series('a', 'Alpha Tale');
  await series('e', 'Epsilon Nothing');
  assert.equal((await post({})).json().error, 'empty_scope');
  assert.equal((await post({ seriesIds: [] })).json().error, 'empty_scope');
  assert.equal((await post({ seriesIds: ['s_fs_nobody'] })).json().error, 'empty_scope', 'nothing named is a series');
  assert.equal((await post({ seriesIds: [S('a')], sourceId: MAIN })).json().error, 'bad_request', 'one scope or the other');
  assert.equal((await post({ seriesIds: Array.from({ length: 501 }, (_, i) => `x${i}`) })).json().error, 'too_many');
  assert.equal((await post({ sourceId: MAIN }, memberAuth)).statusCode, 403, 'admins only');

  gate = new Promise<void>((r) => { openGate = r; });
  const r = await post({ seriesIds: [S('a'), S('e')] });
  assert.equal(r.statusCode, 202, r.body);
  const { runId } = r.json();
  await until(() => searches.includes('fs-a:Alpha Tale'), 'the first search');
  const busy = await post({ sourceId: MAIN });
  assert.deepEqual([busy.statusCode, busy.json().error, busy.json().runId], [409, 'busy', runId]);
  const live = await state();
  assert.deepEqual([live.running, live.run.status, live.run.current], [true, 'running', { seriesId: S('a'), title: 'Alpha Tale' }]);
  const memberJobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: memberAuth })).json();
  assert.equal(memberJobs.runs.some((x: any) => x.kind === 'find_sources'), false, 'a member sees no find card');
  assert.equal((await call('POST', `/api/admin/sources/find/${runId}/follow`, { candidateIds: [runId] })).json().error, 'still_searching');

  assert.deepEqual((await call('POST', '/api/admin/sources/find/stop')).json(), { stopped: true });
  // It does not wait for the search in flight.
  const opener = setTimeout(() => openGate(), 3000);
  const t0 = Date.now();
  await fsLib.findSettled();
  assert.ok(Date.now() - t0 < 2500, `the stop waited ${Date.now() - t0} ms for the search in flight`);
  clearTimeout(opener);
  openGate();
  gate = null;
  const stopped = await review(runId);
  assert.equal(stopped.run.status, 'stopped');
  assert.deepEqual(stopped.items.map((i: any) => i.state), ['pending', 'pending'], 'the series in flight stays unsearched');
  assert.equal((await card()).status, 'cancelled');

  const again = await call('POST', `/api/admin/sources/find/${runId}/resume`);
  assert.equal(again.statusCode, 202, again.body);
  await fsLib.findSettled();
  const done = await review(runId);
  assert.equal(done.run.status, 'review');
  assert.deepEqual(done.items.map((i: any) => i.state), ['done', 'done']);
  assert.equal((await call('POST', `/api/admin/sources/find/${runId}/resume`)).json().error, 'not_resumable');

  // Discarded: gone, and its candidates with it.
  assert.equal((await call('DELETE', `/api/admin/sources/find/${runId}`)).statusCode, 200);
  assert.equal((await call('GET', `/api/admin/sources/find/${runId}`)).statusCode, 404);
  assert.equal((await call('GET', '/api/admin/sources/find/not-a-uuid')).statusCode, 404);
});

test('it waits while a sweep runs, and says so', { skip }, async () => {
  await series('a', 'Alpha Tale');
  runtime.updating = true;
  try {
    assert.equal((await post({ seriesIds: [S('a')] })).statusCode, 202);
    await new Promise((r) => setTimeout(r, 100));
    const waiting = await state();
    // Reintroduce by dropping waitQuiet: fs-a is searched during the sweep.
    assert.equal(waiting.run.waiting, 'sweep');
    assert.equal(waiting.run.done, 0);
    assert.deepEqual(searches, [], 'nothing is asked while the sweep runs');
    assert.equal((await card()).waiting, 'sweep', 'the card says what the run waits on');
  } finally {
    runtime.updating = false;
  }
  await fsLib.findSettled();
  assert.equal((await state()).run.done, 1);
  assert.equal('waiting' in (await card()), false, 'and nothing once it no longer waits');
});

test('series decided without a search are not paced; series that searched are', { skip }, async () => {
  await series('d', 'Delta Order', { numbering: 'posting_order' });
  await series('e', 'Epsilon Nothing');
  await series('t', 'Theta Few');
  await q('DELETE FROM series_listing WHERE series_id = $1 AND number > 2', [S('t')]);
  fsLib.setFindTiming({ paceMs: 4000, wallMs: 10_000, quietMs: 20 });
  const t0 = Date.now();
  const runId = await searched(['d', 't', 'e']);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  const notes = (await review(runId)).items.map((i: any) => [i.state, i.note]);
  assert.deepEqual(notes, [['skipped', 'posting_order'], ['skipped', 'too_few'], ['done', null]]);

  fsLib.setFindTiming({ paceMs: 300, wallMs: 10_000, quietMs: 20 });
  await series('f', 'Zeta Wrong');
  const t1 = Date.now();
  await searched(['e', 'f']);
  assert.ok(Date.now() - t1 >= 300, `two searched series took ${Date.now() - t1} ms, under one pause`);
});

test('a shutdown leaves the run interrupted and resumable; a restart closes a searching row; refreshes skip a sweep', { skip }, async () => {
  await series('e', 'Epsilon Nothing');
  await series('a', 'Alpha Tale');
  fsLib.setFindTiming({ paceMs: 5_000, wallMs: 10_000, quietMs: 20 });
  const { runId } = (await post({ seriesIds: [S('e'), S('a')] })).json();
  const row = async () => (await q('SELECT status, done FROM source_find_runs WHERE id = $1', [runId]))[0];
  await until(async () => (await row())?.done === 1, 'the first series settled');
  runtime.stopping = true;
  try {
    const t0 = Date.now();
    await fsLib.findSettledWithin();
    assert.ok(Date.now() - t0 < fsLib.FIND_SHUTDOWN_MS);
    assert.equal((await row()).status, 'interrupted', 'closed by the run itself');
  } finally {
    runtime.stopping = false;
  }
  fsLib.setFindTiming({ paceMs: 0, wallMs: 10_000, quietMs: 20, refresh: async (id) => { refreshed.push(id); } });
  assert.equal((await call('POST', `/api/admin/sources/find/${runId}/resume`)).statusCode, 202);
  await fsLib.findSettled();
  assert.equal((await row()).status, 'review');

  // A row still searching after a restart reads interrupted.
  await q(`INSERT INTO source_find_runs (started_by, status, total) VALUES ($1, 'running', 3)`, [adminId]);
  const st = await state();
  assert.equal(st.running, false);
  assert.equal(st.recent.find((x: any) => x.total === 3).status, 'interrupted');

  // The refreshes after a follow are dropped, not deferred, beside a sweep.
  runtime.updating = true;
  fsLib.queueRefresh([S('a'), S('e')]);
  await new Promise((r) => setTimeout(r, 50));
  runtime.updating = false;
  assert.deepEqual(refreshed, [], 'a listing was refreshed beside a sweep');
  assert.deepEqual(fsLib.pendingRefreshes(), []);
});

test('an admin who hides 18+ does not read the adult series in a run', { skip }, async () => {
  await series('h', 'Eta Adult', { library: ADULT_LIB });
  await series('e', 'Epsilon Nothing');
  const { runId } = (await post({ sourceId: MAIN })).json();
  await fsLib.findSettled();
  const hidden = await review(runId, '');
  assert.deepEqual([hidden.items.map((i: any) => i.title), hidden.hidden], [['Epsilon Nothing'], 1]);
  assert.equal((await review(runId, '?adult=1')).items.length, 2);
});

test("server.ts's shutdown waits for the run to close its own row", () => {
  // Static, so it holds without a database: the SIGTERM/SIGINT handler sets runtime.stopping, then waits on
  // findSettledWithin (bounded) beside app.close() before it exits.
  const server = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const at = server.indexOf('process.once(sig');
  assert.ok(at > 0, 'no shutdown handler in server.ts');
  const handler = server.slice(at, server.indexOf('});', at));
  assert.match(handler, /runtime\.stopping = true;[\s\S]*findSettledWithin\(\)[\s\S]*process\.exit\(0\)/,
    'the shutdown handler does not wait for the Find other sources run');
});

test("Health offers Find other sources on a failing source's row and on the series that can no longer update", { skip }, async () => {
  const { runHealthChecks } = await import('../src/lib/health');
  for (const [k, t] of [['a', 'Alpha Tale'], ['e', 'Epsilon Nothing'], ['f', 'Zeta Wrong']]) await series(k, t);
  const at = new Date().toISOString();
  await q(`INSERT INTO source_health (source_id, status, stages) VALUES ($1, 'ok', $2::jsonb)`,
    [MAIN, JSON.stringify({ search: { failAt: at, failBy: 'sweep', streak: 1, kind: 'site_offline', error: 'site_offline: the site says it is offline ("Main Down is temporarily offline")' } })]);
  await series('g', 'Gone Source Tale', { source: GONE });

  const report = await runHealthChecks();
  const row = report.checks.find((c) => c.id === 'sources')!.items.find((i) => i.sourceId === MAIN)!;
  assert.ok(row.actions!.includes('find_sources'), JSON.stringify(row.actions));
  assert.equal(row.findSeries, 3, 'every series whose MAIN source it is');
  const frozen = report.checks.find((c) => c.id === 'frozen-series')!.items.find((i) => i.seriesId === S('g'))!;
  assert.ok(frozen.actions!.includes('find_sources'), JSON.stringify(frozen.actions));
  assert.deepEqual([frozen.sourceId, frozen.findSeries], [GONE, 1]);
  await q(`DELETE FROM source_health WHERE source_id = $1`, [MAIN]);
});
