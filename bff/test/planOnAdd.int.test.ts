// #223 (v0.68.0): a series someone adds goes on their trackers as Plan to Read, when they asked for it (Profile →
// Connections → Progress tracking, app_settings `trackerPlanOnAdd`). lib/trackers.ts planSeriesOnAdd.
//
// The rules, each pinned below: off unless the person turned it on; only where their list has nothing for the series --
// an entry they already have, in any state, is never touched; only on a service the series is linked to; never under
// Incognito reading; each service in its own words (AniList PLANNING, MyAnimeList plan_to_read, Kitsu planned) at no
// progress. The add route's half is in addSeries.int.test.ts. Every guard names the edit that makes it fail again.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SERIES = 's_plan_on_add';
const USER = 'plan-on-add';

// ---- the three services, answered from the test ---------------------------------------------------------------
type Call = { method: string; url: URL; body: any };
const calls: Call[] = [];
/** This account's entry on each service, or null when the series is not on its list. */
let entries: Record<'anilist' | 'myanimelist' | 'kitsu', null | { status: string; progress: number }> = { anilist: null, myanimelist: null, kitsu: null };
const realFetch = globalThis.fetch;
const HOSTS = ['graphql.anilist.co', 'api.myanimelist.net', 'kitsu.app', 'kitsu.io'];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (u: any, init?: any) => {
  const url = new URL(String(u));
  if (!HOSTS.includes(url.hostname)) return realFetch(u, init);
  let body: any = init?.body ?? null;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* a form body stays a string */ } }
  const c = { method: String(init?.method ?? 'GET').toUpperCase(), url, body };
  calls.push(c);
  if (url.hostname === 'graphql.anilist.co') {
    if (/SaveMediaListEntry/.test(body?.query)) return json({ data: { SaveMediaListEntry: { id: 1, progress: body.variables.progress, status: body.variables.status } } });
    if (/mediaListEntry/.test(body?.query)) {
      const e = entries.anilist;
      return json({ data: { Media: { status: 'RELEASING', chapters: null, mediaListEntry: e ? { status: e.status, progress: e.progress } : null } } });
    }
    return json({ data: {} });
  }
  if (url.hostname === 'api.myanimelist.net') {
    if (c.method === 'PATCH') return json({ status: 'plan_to_read', num_chapters_read: 0 });
    const e = entries.myanimelist;
    return json({ id: 222, status: 'currently_publishing', num_chapters: 0, ...(e ? { my_list_status: { status: e.status, num_chapters_read: e.progress } } : {}) });
  }
  // Kitsu
  if (url.pathname.endsWith('/users')) return json({ data: [{ id: '9', attributes: { name: 'me' } }] });
  if (url.pathname.endsWith('/library-entries') && c.method === 'GET') {
    const e = entries.kitsu;
    return json({
      data: e ? [{ id: '55', attributes: { status: e.status, progress: e.progress, reconsuming: false } }] : [],
      included: [{ type: 'manga', id: '333', attributes: { status: 'current', chapterCount: null } }],
    });
  }
  return json({ data: { id: '56' } }, 201);
}) as typeof fetch;

const writes = () => calls.filter((c) =>
  (c.url.hostname === 'graphql.anilist.co' && /SaveMediaListEntry/.test(c.body?.query))
  || (c.url.hostname === 'api.myanimelist.net' && c.method === 'PATCH')
  || (/kitsu/.test(c.url.hostname) && (c.method === 'POST' || c.method === 'PATCH')));

let q: typeof import('../src/lib/db').q;
let trackers: typeof import('../src/lib/trackers');
let app: any;
let n = 0;
/** A fresh account for each case (each tracker lane is per account, and paced): every service connected. */
async function person(settings: Record<string, unknown> | null): Promise<string> {
  const name = `${USER}-${++n}`;
  await q('DELETE FROM users WHERE username = $1', [name]);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;
  for (const p of ['anilist', 'myanimelist', 'kitsu'] as const) {
    await trackers.saveConnection(uid, p, `tok-${p}`, `me-on-${p}`, new Date(Date.now() + 86_400_000));
  }
  if (settings) await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, $2::jsonb)`, [uid, JSON.stringify(settings)]);
  calls.length = 0;
  return uid;
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = await import('../src/lib/db'));
  trackers = await import('../src/lib/trackers');
  await migrate();
  await q('DELETE FROM series_trackers WHERE series_id = $1', [SERIES]);
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!plan','Plan Series',$2,1)`, [SERIES, `T!plan/${SERIES}`]);
  await trackers.linkSeries(SERIES, '111', 'Plan Series', null, 'anilist');
  await trackers.linkSeries(SERIES, '222', 'Plan Series', null, 'myanimelist');
  await trackers.linkSeries(SERIES, '333', 'Plan Series', null, 'kitsu');

  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM series_trackers WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE '${USER}-%'`).catch(() => {});
});

test('Plan to Read on add', { skip }, async (t) => {
  await t.test('off unless asked for: nothing is sent', async () => {
    // Reintroduce by dropping the setting check: AniList, MAL and Kitsu are each written to.
    entries = { anilist: null, myanimelist: null, kitsu: null };
    for (const settings of [null, { trackerPlanOnAdd: false }, { trackerPlanOnAdd: 'yes' }]) {
      const uid = await person(settings);
      await trackers.planSeriesOnAdd(uid, SERIES);
      assert.equal(calls.length, 0, `${JSON.stringify(settings)}: ${calls.map((c) => c.url.hostname).join(', ')} was asked`);
    }
  });

  await t.test('asked for: a series not on the list goes on every linked service as planned, at no progress', async () => {
    entries = { anilist: null, myanimelist: null, kitsu: null };
    const uid = await person({ trackerPlanOnAdd: true });
    await trackers.planSeriesOnAdd(uid, SERIES);
    const w = writes();
    assert.equal(w.length, 3, w.map((c) => `${c.method} ${c.url}`).join('\n'));
    const ani = w.find((c) => c.url.hostname === 'graphql.anilist.co')!;
    assert.deepEqual(ani.body.variables, { mediaId: 111, progress: 0, status: 'PLANNING' });
    const mal = w.find((c) => c.url.hostname === 'api.myanimelist.net')!;
    assert.match(mal.url.pathname, /\/manga\/222\/my_list_status$/);
    const form = new URLSearchParams(String(mal.body));
    assert.equal(form.get('status'), 'plan_to_read', 'MAL calls it plan_to_read: "planning" would be refused');
    assert.equal(form.get('num_chapters_read'), '0');
    const kitsu = w.find((c) => /kitsu/.test(c.url.hostname))!;
    assert.equal(kitsu.method, 'POST', 'no entry on this account: one is created');
    assert.deepEqual(kitsu.body.data.attributes, { progress: 0, status: 'planned' });
    assert.equal(kitsu.body.data.relationships.media.data.id, '333');
    const st = await q<{ provider: string; last_error: string | null }>(
      'SELECT provider, last_error FROM user_trackers WHERE user_id = $1 ORDER BY provider', [uid]);
    assert.ok(st.every((r) => r.last_error == null), JSON.stringify(st));
  });

  await t.test('an entry already on the list is left alone, whatever it is', async () => {
    // Reintroduce by writing over it (dropping the `state.entry` check in planOne): each is set to planned.
    for (const [status, progress] of [['CURRENT', 12], ['COMPLETED', 40], ['DROPPED', 3], ['PLANNING', 0]] as const) {
      entries = {
        anilist: { status, progress },
        myanimelist: { status: status === 'CURRENT' ? 'reading' : status.toLowerCase().replace('planning', 'plan_to_read'), progress },
        kitsu: { status: status === 'CURRENT' ? 'current' : status.toLowerCase().replace('planning', 'planned'), progress },
      };
      const uid = await person({ trackerPlanOnAdd: true });
      await trackers.planSeriesOnAdd(uid, SERIES);
      assert.equal(writes().length, 0, `${status}: ${writes().map((c) => `${c.method} ${c.url.hostname}`).join(', ')}`);
      assert.ok(calls.length >= 3, 'each service was asked what it holds first');
    }
  });

  await t.test('never under Incognito reading', async () => {
    // Reintroduce by dropping the incognitoOn check: the three services are written to.
    entries = { anilist: null, myanimelist: null, kitsu: null };
    const uid = await person({ trackerPlanOnAdd: true, incognito: true });
    await trackers.planSeriesOnAdd(uid, SERIES);
    assert.equal(calls.length, 0);
  });

  await t.test('a service the series is not linked to is not asked', async () => {
    entries = { anilist: null, myanimelist: null, kitsu: null };
    await q(`DELETE FROM series_trackers WHERE series_id = $1 AND provider = 'kitsu'`, [SERIES]);
    try {
      const uid = await person({ trackerPlanOnAdd: true });
      await trackers.planSeriesOnAdd(uid, SERIES);
      assert.ok(!calls.some((c) => /kitsu/.test(c.url.hostname)), 'Kitsu was asked about a series it was never matched to');
      assert.equal(writes().length, 2);
    } finally {
      await trackers.linkSeries(SERIES, '333', 'Plan Series', null, 'kitsu');
    }
  });

  await t.test('Plan to read on add must be on or off', async () => {
    // Reintroduce by accepting anything for `trackerPlanOnAdd` in PUT /api/settings: "yes" is saved and this reads 200.
    const uid = await person(null);
    const auth = await import('../src/lib/auth');
    const token = (await auth.issueApiToken(uid, 'plan', ['read', 'write'], null)).token;
    const H = { authorization: `Bearer ${token}` };
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { trackerPlanOnAdd: 'yes' } });
    assert.equal(bad.statusCode, 400, bad.payload);
    assert.equal(bad.json().error, 'bad_settings');
    const good = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { trackerPlanOnAdd: true } });
    assert.equal(good.statusCode, 200, good.payload);
    assert.equal(await trackers.planOnAddWanted(uid), true, 'the switch the server reads is the one the route saved');
  });
});

test('an add hands its person to the art lookup, which plans once it has run', () => {
  // The add route's own walk is in addSeries.int.test.ts (a series already here, added again). These are the other three
  // ways an add ends -- nothing downloaded yet, everything already held, a download -- each through artByTitle, which
  // links the series to AniList and THEN plans, so a fresh series is linked by the time it is asked about.
  const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'sources.ts'), 'utf8');
  const calls = src.match(/void artByTitle\([^)]*\);/g) ?? [];
  assert.equal(calls.length, 3, calls.join('\n'));
  for (const c of calls) assert.match(c, /, title, opts\.userId \?\? null\)/, `${c} does not say whose add it is`);
  const fn = src.slice(src.indexOf('async function artByTitle('), src.indexOf('/** Add one series from a source to the library'));
  assert.match(fn, /if \(seriesId\) planSeriesOnAddAsync\(addedBy, seriesId\);/);
  assert.ok(fn.indexOf('planSeriesOnAddAsync') > fn.indexOf('withAniListMutation'), 'it plans before the series is linked');
  assert.match(src, /if \(opts\.userId\) planSeriesOnAddAsync\(opts\.userId, existing\.id\);/, 'adding a series already here plans too');
});
