// One AniList quota for the whole server (v0.73.0, lib/anilistLimit.ts), driven where the owner met it: a freshly
// connected AniList account's backfill (POST /api/trackers/anilist/backfill) pushed fourteen series, met a 429, dropped
// the push, and left "anilist 429" on Profile → Connections.
//
// AniList is a scripted fetch that states its quota the way the real one does (`X-RateLimit-Limit` 30, as it says while
// degraded; `Retry-After` on a 429), and the limiter runs on a virtual clock: every wait it asks for passes at once and
// is counted, so a minute of spacing costs nothing and the calls can be held to "at most 30 in any minute".
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'aq-reader';
const N = 40;
const SERIES = Array.from({ length: N }, (_, i) => `s_aq_${i + 1}`);

/** The virtual clock: what the limiter reads and waits on. */
let now = Date.parse('2026-10-16T09:18:43Z');
/** Every AniList request, at the virtual time it was made, and what it asked. */
const calls: Array<{ at: number; save: boolean; media: number }> = [];
/** How the scripted AniList answers a save, request by request: 'ok', or a 429 with this many seconds to wait. */
let saves: Array<'ok' | number> = [];

const realFetch = globalThis.fetch;
function anilist(input: any, init?: any): Response | null {
  if (!String(input?.url ?? input).includes('graphql.anilist.co')) return null;
  const body = JSON.parse(String(init?.body ?? '{}'));
  const save = /SaveMediaListEntry/.test(body.query);
  const media = Number(body.variables?.mediaId ?? body.variables?.id ?? 0);
  calls.push({ at: now, save, media });
  const spent = calls.filter((c) => c.at > now - 60_000).length;
  const quota = { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': String(Math.max(0, 30 - spent)), 'content-type': 'application/json' };
  if (save) {
    const next = saves.length ? saves.shift()! : 'ok';
    if (next !== 'ok') {
      return new Response(JSON.stringify({ errors: [{ message: 'Too Many Requests.', status: 429 }] }),
        { status: 429, headers: { ...quota, 'x-ratelimit-remaining': '0', 'retry-after': String(next) } });
    }
    return new Response(JSON.stringify({ data: { SaveMediaListEntry: { id: 1, progress: body.variables.progress, status: body.variables.status } } }),
      { status: 200, headers: quota });
  }
  // The series' state and this account's entry (the push reads it first).
  return new Response(JSON.stringify({ data: { Media: { status: 'RELEASING', chapters: null, mediaListEntry: null } } }), { status: 200, headers: quota });
}

/** The most requests any 60 s window held. */
const busiestMinute = () => Math.max(0, ...calls.map((c) => calls.filter((d) => d.at >= c.at && d.at < c.at + 60_000).length));

test('one AniList quota: a backfill keeps under the live limit, waits out a 429 and says so gently', { skip }, async (t) => {
  globalThis.fetch = (async (input: any, init?: any) => anilist(input, init) ?? realFetch(input, init)) as typeof fetch;
  const L = await import('../src/lib/anilistLimit');
  const realClock = { ...L.anilistClock };
  L.anilistClock.now = () => now;
  L.anilistClock.sleep = async (ms: number) => { now += ms; };
  L.resetAniListQuota();
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const trackers = await import('../src/lib/trackers');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  const cleanup = async () => {
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
    await q('DELETE FROM series_trackers WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  };
  await cleanup();
  const user = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]))[0].id;
  for (const [i, id] of SERIES.entries()) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1, 'T!aq', $2, $1, 1)`, [id, `Zzz Aq ${i + 1}`]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1, $2, 'T!aq', $3, 1, 'Chapter 1', '/library')`,
      [`b_${id}`, id, `T!aq/${id}/ch1.cbz`]);
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, $2, $3, 1, true)`, [user, `b_${id}`, id]);
    await q(`INSERT INTO series_trackers (series_id, provider, external_id, linked_by) VALUES ($1, 'anilist', $2, $3)`, [id, String(7000 + i), user]);
  }
  await trackers.saveConnection(user, 'anilist', 'tok-anilist', 'me', new Date(Date.now() + 86_400_000));
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
  const H = { authorization: `Bearer ${app.jwt.sign({ sub: user, role: 'user' })}` };
  const pushed = async () => Number((await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM tracker_progress WHERE user_id = $1 AND provider = 'anilist'`, [user]))?.n ?? 0);
  const lastError = async () => (await one<{ e: string | null }>(
    `SELECT last_error AS e FROM user_trackers WHERE user_id = $1 AND provider = 'anilist'`, [user]))?.e ?? null;

  try {
    await t.test('a 40-series backfill keeps under 30 requests a minute, and pushes every series', async () => {
      // Reintroduce the spacing's absence (gap() answering 0 in lib/anilistLimit.ts): all 80 requests land in the same
      // virtual instant, and the busiest minute holds 80.
      const r = await app.inject({ method: 'POST', url: '/api/trackers/anilist/backfill', headers: H });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().series, N);
      for (let i = 0; i < 400 && (await pushed()) < N; i++) await new Promise((res) => setTimeout(res, 25));
      assert.equal(await pushed(), N, `only ${await pushed()} of ${N} series were pushed`);
      assert.equal(calls.length, 2 * N, 'each push is a read and a write');
      assert.ok(busiestMinute() <= 30, `${busiestMinute()} requests in one minute: over AniList's limit of 30`);
      assert.equal(await lastError(), null);
    });

    await t.test('a 429 is waited out for its Retry-After, and the same push then lands with nothing written as an error', async () => {
      // Reintroduce the old answer to a 429 -- as it comes, with no wait and no second try (`retries: 0` in
      // lib/trackerProviders.ts PUSH_WAIT): the save is made once and the push is dropped.
      await q(`DELETE FROM tracker_progress WHERE user_id = $1 AND series_id = $2`, [user, SERIES[0]]);
      calls.length = 0;
      saves = [30, 'ok'];
      await trackers.pushSeriesProgress(user, SERIES[0]);
      const tries = calls.filter((c) => c.save);
      assert.equal(tries.length, 2, 'the refused save was not made again');
      assert.ok(tries[1].at - tries[0].at >= 30_000, `asked again after ${tries[1].at - tries[0].at} ms, inside AniList's Retry-After`);
      assert.ok(await one('SELECT 1 FROM tracker_progress WHERE user_id = $1 AND series_id = $2', [user, SERIES[0]]), 'the push was dropped');
      assert.equal(await lastError(), null, 'a wait was written down as an error');
    });

    await t.test('a 429 that does not end reads "syncing slowly", never refused, and the next good push clears it', async () => {
      await q(`DELETE FROM tracker_progress WHERE user_id = $1 AND series_id = $2`, [user, SERIES[1]]);
      saves = [60, 60, 60, 60, 60, 60, 60];
      await trackers.pushSeriesProgress(user, SERIES[1]);
      assert.equal(await lastError(), trackers.RATE_LIMITED);
      const status = (await trackers.statusFor(user)).find((s) => s.provider === 'anilist')!;
      assert.equal(status.slowedDown, true);
      assert.equal(status.lastError, null, 'the wait reads as an error on Connections');
      assert.equal(status.needsReconnect, false, 'a rate limit asked for a new token');
      // Health's Tracker sync card (v0.72.0) is quiet about it too. Its sign-in is pushed past the card's heads-up first,
      // so nothing else about this connection is a finding.
      // Reintroduce by counting the wait in lib/healthTrackers.ts (`failed` reading any last_error): the member is listed.
      await q(`UPDATE user_trackers SET expires_at = now() + interval '300 days' WHERE user_id = $1`, [user]);
      const { trackerSync } = await import('../src/lib/healthTrackers');
      const card = await trackerSync();
      assert.equal(card.items.find((i) => i.key === `anilist:${user}`), undefined, "Health's Tracker sync card lists the wait as a finding");
      // What the push wrote before v0.73.0: read the same way at once, before any push has mended it.
      await q(`UPDATE user_trackers SET last_error = 'anilist 429' WHERE user_id = $1 AND provider = 'anilist'`, [user]);
      const legacy = (await trackers.statusFor(user)).find((s) => s.provider === 'anilist')!;
      assert.deepEqual([legacy.slowedDown, legacy.lastError], [true, null]);
      saves = [];
      await trackers.pushSeriesProgress(user, SERIES[1]);
      assert.equal(await lastError(), null, 'the next good push did not clear it');
    });

    await t.test('a person or an image is never held for a minute: they are told AniList is busy at once', async () => {
      // Reintroduce by holding every caller as long as AniList asks (no maxWaitMs): the Viewer request waits the minute.
      L.resetAniListQuota();
      calls.length = 0;
      saves = [60];
      const save = JSON.stringify({ query: 'mutation($mediaId:Int){SaveMediaListEntry(mediaId:$mediaId){id}}', variables: { mediaId: 1 } });
      const refused = await L.anilistFetch('https://graphql.anilist.co', { method: 'POST', body: save }, { retries: 0 });
      assert.equal(refused.status, 429, 'PREMISE: AniList asked us to wait a minute');
      const before = calls.length;
      const asked = now;
      await assert.rejects(
        L.anilistFetch('https://graphql.anilist.co', { method: 'POST', body: '{"query":"{ Viewer { id } }"}' }, { maxWaitMs: L.WAIT_INTERACTIVE_MS }),
        (e: unknown) => e instanceof L.AniListBusy && L.isRateLimit(e),
      );
      assert.equal(calls.length, before, 'the busy answer still asked AniList');
      assert.equal(now, asked, 'the person was held before being told');
    });
  } finally {
    Object.assign(L.anilistClock, realClock);
    L.resetAniListQuota();
    globalThis.fetch = realFetch;
    await app.close();
    await cleanup();
  }
});
