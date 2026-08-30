// Who may reach a source, and how long one is allowed to take, driven over HTTP.
//
// Two holes this file exists to keep closed, both found in production:
//
//  1. `canDownload: false` was enforced in exactly ONE place in the whole server -- POST /api/sources/add.
//     Every GET the Discover page uses was ungated, so a denied account could list every source, search
//     them, browse their newest pages and read full series detail. It only met a wall on the last button.
//
//  2. Nothing anywhere consulted `max_age_rating` for sources. On the install this was written against, 36
//     of 44 enabled sources are adult and 8 of the 10 English ones are, so a 6+ account's Discover page was
//     mostly adult covers. The signal to filter on was arriving from Suwayomi the whole time (`isNsfw` in
//     SOURCES_Q) and being discarded.
//
// It must be driven over HTTP rather than by calling the library. The web app is a static export, so a
// filter that only ran in the UI would leave `GET /api/sources/latest?source=<adult-id>` serving 24 adult
// covers as JSON to a capped child account, with the ids enumerable from `GET /api/sources`.
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
  // The real default is 8s. A test that waits 8s for a deliberately hung adapter is 8s nobody gets back.
  process.env.SOURCE_LATEST_TIMEOUT_MS = '400';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const CLEAN = 't-clean';
const ADULT = 't-adult';
const SLOW = 't-slow';
const EMPTY = 't-empty';
const USERS = ['sa-admin', 'sa-plain', 'sa-capped', 'sa-nodl', 'sa-emptyperms', 'sa-yesdl', 'sa-adminnodl'];

/** Counts calls so the cache can be shown to be doing something rather than assumed to be. */
const calls = { [CLEAN]: 0, [ADULT]: 0, [SLOW]: 0, [EMPTY]: 0 } as Record<string, number>;

function fake(id: string, name: string, opts: { isNsfw?: boolean; hang?: boolean; empty?: boolean } = {}) {
  const series = (n: number) => ({ sourceId: `${id}-${n}`, source: id, title: `${name} Title ${n}` });
  return {
    id, name, isNsfw: opts.isNsfw,
    async search() { calls[id]++; return [series(1)]; },
    async getSeries(sid: string) { return { ...series(1), sourceId: sid }; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
    async latest() {
      calls[id]++;
      if (opts.hang) return new Promise<any[]>(() => { /* never settles, like a site behind a challenge */ });
      // An adapter whose Cloudflare challenge failed: no throw, just nothing. Real, and common.
      if (opts.empty) return [];
      return [series(1), series(2)];
    },
  };
}

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { registerAdapter } = await import('../src/lib/sources');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;

  await migrate();
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);

  registerAdapter(fake(CLEAN, 'Clean Source') as any);
  registerAdapter(fake(ADULT, 'Adult Source', { isNsfw: true }) as any);
  registerAdapter(fake(SLOW, 'Slow Source', { hang: true }) as any);
  registerAdapter(fake(EMPTY, 'Empty Source', { empty: true }) as any);

  const mk = async (username: string, role: string, perms: any, cap: number | null) =>
    (await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
       VALUES ($1,$1,'x',$2,'password',$3,$4) RETURNING id`,
      [username, role, JSON.stringify(perms), cap],
    ))[0].id;

  const ids = {
    admin: await mk('sa-admin', 'admin', {}, null),
    plain: await mk('sa-plain', 'user', {}, null),
    capped: await mk('sa-capped', 'user', {}, 13),
    nodl: await mk('sa-nodl', 'user', { canDownload: false }, null),
    emptyperms: await mk('sa-emptyperms', 'user', {}, null),
    yesdl: await mk('sa-yesdl', 'user', { canDownload: true }, null),
    adminnodl: await mk('sa-adminnodl', 'admin', { canDownload: false }, null),
  };

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.ready();

  const tok = (id: string, role = 'user') => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  return { app, q, ids, tok };
}

/** Every route in sources.ts, as the URL a client actually calls. */
const ROUTES: Array<{ method: 'GET' | 'POST'; url: string; payload?: any }> = [
  { method: 'GET', url: '/api/sources' },
  { method: 'GET', url: `/api/sources/latest?source=${CLEAN}` },
  { method: 'GET', url: `/api/sources/search?source=${CLEAN}&q=title` },
  { method: 'GET', url: '/api/sources/search-all?q=title' },
  { method: 'GET', url: '/api/sources/find?q=title' },
  { method: 'GET', url: `/api/sources/detail?source=${CLEAN}&sourceId=${CLEAN}-1` },
  { method: 'GET', url: '/api/sources/jobs' },
  { method: 'GET', url: '/api/discover/trending' },
  { method: 'POST', url: '/api/sources/add', payload: { source: CLEAN, sourceId: `${CLEAN}-1` } },
];

test('sources: who may reach them, and how long they get', { skip }, async (t) => {
  const { app, q, ids, tok } = await setup();

  try {
    // ------------------------------------------------------------------ adult sources
    await t.test('an adult source is not even listed for a capped account', async () => {
      const seen = async (who: string, role = 'user') => {
        const r = await app.inject({ method: 'GET', url: '/api/sources', headers: tok(who, role) });
        assert.equal(r.statusCode, 200);
        return new Set(r.json().content.map((s: any) => s.id));
      };
      const capped = await seen(ids.capped);
      assert.equal(capped.has(ADULT), false, 'a 13+ account was handed the adult source id');
      assert.equal(capped.has(CLEAN), true, 'the clean source vanished too -- the filter is too wide');

      // The rule is "a limit BELOW 18", not "any limit at all", and not "everyone".
      assert.equal((await seen(ids.plain)).has(ADULT), true, 'an uncapped account lost the adult source');
      assert.equal((await seen(ids.admin, 'admin')).has(ADULT), true, 'an admin lost the adult source');
    });

    await t.test('every by-id route refuses the adult source for a capped account', async () => {
      const urls = [
        `/api/sources/latest?source=${ADULT}`,
        `/api/sources/search?source=${ADULT}&q=title`,
        `/api/sources/detail?source=${ADULT}&sourceId=${ADULT}-1`,
      ];
      for (const url of urls) {
        const r = await app.inject({ method: 'GET', url, headers: tok(ids.capped) });
        assert.equal(r.statusCode, 403, `${url} answered ${r.statusCode} for a 13+ account`);
        // Not merely "empty": the point is that no adult title crosses the wire at all.
        assert.equal(JSON.stringify(r.json()).includes('Adult Source Title'), false, `${url} leaked content`);
      }
      const add = await app.inject({
        method: 'POST', url: '/api/sources/add', headers: tok(ids.capped),
        payload: { source: ADULT, sourceId: `${ADULT}-1` },
      });
      assert.equal(add.statusCode, 403, 'a capped account could add from an adult source');
    });

    await t.test('the same routes still work for an uncapped account', async () => {
      const r = await app.inject({ method: 'GET', url: `/api/sources/latest?source=${ADULT}`, headers: tok(ids.plain) });
      assert.equal(r.statusCode, 200);
      assert.ok(r.json().content.length > 0, 'an uncapped account got an empty adult wall');
      const d = await app.inject({
        method: 'GET', url: `/api/sources/detail?source=${ADULT}&sourceId=${ADULT}-1`, headers: tok(ids.plain),
      });
      assert.equal(d.statusCode, 200);
    });

    await t.test('the fan-outs drop the adult source instead of failing', async () => {
      // A fan-out has no single source to refuse, so the right answer is "nobody has it", not a 403.
      const r = await app.inject({
        method: 'GET', url: `/api/sources/find?q=Adult%20Source%20Title&sources=${ADULT},${CLEAN}`,
        headers: tok(ids.capped),
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().content.some((x: any) => x.source === ADULT), false, 'find returned the adult source');

      const all = await app.inject({ method: 'GET', url: '/api/sources/search-all?q=Adult', headers: tok(ids.capped) });
      assert.equal(all.statusCode, 200);
      const providers = all.json().content.flatMap((g: any) => g.providers.map((p: any) => p.source));
      assert.equal(providers.includes(ADULT), false, 'search-all returned the adult source');
    });

    await t.test('`used` counts by adapter id, not by the name the folder was created under', async () => {
      // The ranking on the client sorts by this, so getting it wrong silently returns the old alphabetical
      // order. A source that has been renamed keeps its history under the old name in `lib_series.source`:
      // on the install this was written against, one adapter read as 13 under "Aqua Manga" and 176 under
      // "Aqua Manga (EN)" while being one source with 189 series.
      await q('DELETE FROM lib_series WHERE id = ANY($1)', [['sa_used_1', 'sa_used_2']]);
      for (const [id, folderName] of [['sa_used_1', 'Clean Source'], ['sa_used_2', 'A Former Name']] as const) {
        await q(
          `INSERT INTO lib_series (id, source, source_id, title, folder, books_count)
           VALUES ($1,$2,$3,$4,$5,1)`,
          [id, folderName, CLEAN, `Used ${id}`, `${folderName}/${id}`],
        );
      }
      try {
        const r = await app.inject({ method: 'GET', url: '/api/sources', headers: tok(ids.plain) });
        const row = r.json().content.find((s: any) => s.id === CLEAN);
        assert.equal(row.used, 2, `both series should count toward ${CLEAN}, got ${row.used}`);
        // A series filed by hand has no source_id and must not be a vote for anything.
        assert.equal(r.json().content.find((s: any) => s.id === SLOW).used, 0);
      } finally {
        await q('DELETE FROM lib_series WHERE id = ANY($1)', [['sa_used_1', 'sa_used_2']]).catch(() => {});
      }
    });

    // ------------------------------------------------------------------ canDownload
    await t.test('canDownload:false is refused on EVERY route here, not just add', async () => {
      for (const r of ROUTES) {
        const res = await app.inject({ ...r, headers: tok(ids.nodl) });
        assert.equal(res.statusCode, 403, `${r.method} ${r.url} answered ${res.statusCode} for a denied account`);
      }
    });

    await t.test('only the literal false denies', async () => {
      for (const [label, id, role] of [
        ['empty perms', ids.emptyperms, 'user'],
        ['canDownload:true', ids.yesdl, 'user'],
        ['an admin with canDownload:false', ids.adminnodl, 'admin'],
      ] as const) {
        const res = await app.inject({ method: 'GET', url: '/api/sources', headers: tok(id, role) });
        assert.equal(res.statusCode, 200, `${label} was refused`);
      }
    });

    await t.test('a user row that cannot be read is denied, not allowed through', async () => {
      // The old check was `if (me && ...)`, so a token for a deleted user fell through to allowed on the
      // one route in this file that writes to disk.
      const ghost = app.jwt.sign({ sub: '00000000-0000-0000-0000-000000000000', role: 'user' });
      const res = await app.inject({
        method: 'POST', url: '/api/sources/add', headers: { authorization: `Bearer ${ghost}` },
        payload: { source: CLEAN, sourceId: `${CLEAN}-1` },
      });
      assert.equal(res.statusCode, 403, 'a token for a nonexistent user was allowed to add');
    });

    // ------------------------------------------------------------------ speed
    await t.test('a hung source is cut off, and pays for it in health', async () => {
      await q('DELETE FROM source_health WHERE source_id = $1', [SLOW]);
      const started = Date.now();
      // Raced against a deadline rather than simply awaited. The fake adapter's promise never settles, so
      // with the timeout removed a plain `await` hangs the whole run forever instead of failing this case --
      // which is exactly what happened when this guard was validated by putting the bug back.
      const r = await Promise.race([
        app.inject({ method: 'GET', url: `/api/sources/latest?source=${SLOW}`, headers: tok(ids.plain) }),
        new Promise<null>((res) => setTimeout(() => res(null), 3000)),
      ]);
      const took = Date.now() - started;
      assert.ok(r, `a hung adapter held the request for over ${took}ms -- the timeout is not being applied`);
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json().content, []);

      // The write is fired without being awaited, so give it a moment before reading it back.
      const read = async () => {
        let h: any = null;
        for (let i = 0; i < 40 && !h; i++) {
          h = (await q(
            'SELECT status, consecutive, slow_streak, blocked_until FROM source_health WHERE source_id = $1',
            [SLOW],
          ))[0] ?? null;
          if (!h) await new Promise((r2) => setTimeout(r2, 50));
        }
        return h;
      };

      // It is recorded as SLOW, which is a different fact from failing, and this is the whole point.
      // Previously the timeout went through `classify` as `down` and earned an escalating five-to-thirty
      // minute cooldown -- during which the route short-circuits and never asks again, so the punishment
      // removed the only requests that could have shown the source working. A real install lost its
      // largest source that way: it answered correctly in ~11.5s against an 8s budget and vanished for a
      // day while every check reported it healthy.
      const first = await read();
      assert.ok(first, 'a timeout recorded nothing at all, so a hung source stays invisible to diagnosis');
      assert.equal(first.slow_streak, 1, 'our own impatience should be counted as such');
      assert.equal(first.consecutive, 0, 'and must never feed the failure backoff');
      assert.equal(first.status, 'ok', 'being slow is not being down');
      assert.equal(first.blocked_until, null, 'one slow answer must not cost a source its place');

      // ...but it must not keep being asked first forever. That was the real point of the old assertion
      // here, and it still holds -- just after a few chances rather than instantly, and via a short fixed
      // breather rather than a half-hour block.
      for (let i = 0; i < 3; i++) {
        await Promise.race([
          app.inject({ method: 'GET', url: `/api/sources/latest?source=${SLOW}&page=${i + 2}`, headers: tok(ids.plain) }),
          new Promise<null>((res) => setTimeout(() => res(null), 3000)),
        ]);
      }
      const after = await read();
      assert.ok(after.slow_streak >= 3, `expected repeated slowness to be counted, got ${after.slow_streak}`);
      assert.ok(after.blocked_until, 'a source that is always too slow should eventually get a breather');
      assert.equal(after.consecutive, 0, 'even then, it is still not a failure');
      const mins = (new Date(after.blocked_until).getTime() - Date.now()) / 60000;
      assert.ok(mins <= 6, `the breather must stay short and fixed, got ${mins} min`);
    });

    await t.test('an empty page does not clear a cooldown somebody else recorded', async () => {
      // reportOk resets consecutive and nulls blocked_until. Adapters that answer a failed Cloudflare
      // challenge with [] rather than a throw would otherwise let a visit to Discover clear a block the
      // downloader had recorded, on the strength of a response that says nothing at all.
      const { clearLatestCache } = await import('../src/routes/sources');
      clearLatestCache();
      await q(
        `INSERT INTO source_health (source_id, status, consecutive, blocked_until, updated_at)
         VALUES ($1,'blocked',3, now() + interval '30 minutes', now())
         ON CONFLICT (source_id) DO UPDATE SET status='blocked', consecutive=3,
           blocked_until = now() + interval '30 minutes', updated_at=now()`,
        [EMPTY],
      );
      const r = await app.inject({ method: 'GET', url: `/api/sources/latest?source=${EMPTY}`, headers: tok(ids.plain) });
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json().content, []);
      // reportOk is fired without being awaited, so reading health straight away races it and the row still
      // says "blocked" whether or not the guard is there. This assertion is about the ABSENCE of a write,
      // so there is nothing to poll for: give it time to land, then check it did not.
      await new Promise((res) => setTimeout(res, 750));
      const h = (await q<{ status: string; blocked_until: string | null }>(
        'SELECT status, blocked_until FROM source_health WHERE source_id = $1', [EMPTY]))[0];
      assert.equal(h.status, 'blocked', 'an empty page cleared the source status');
      assert.ok(h.blocked_until, 'an empty page cleared an active cooldown');
    });

    await t.test('a source serving a cooldown is not asked again', async () => {
      // Reporting health only changed the client's ordering, so a source that had already proved it cannot
      // answer still cost the full timeout on every visit. On the install this was written against, two of
      // them burned 8s each on every load of the page, forever.
      const { clearLatestCache } = await import('../src/routes/sources');
      clearLatestCache();
      calls[SLOW] = 0;
      await q(
        `INSERT INTO source_health (source_id, status, consecutive, blocked_until, updated_at)
         VALUES ($1,'down',2, now() + interval '30 minutes', now())
         ON CONFLICT (source_id) DO UPDATE SET status='down', consecutive=2,
           blocked_until = now() + interval '30 minutes', updated_at=now()`,
        [SLOW],
      );
      const started = Date.now();
      const r = await app.inject({ method: 'GET', url: `/api/sources/latest?source=${SLOW}`, headers: tok(ids.plain) });
      assert.equal(r.statusCode, 200);
      assert.equal(calls[SLOW], 0, 'a source in cooldown was asked anyway');
      assert.ok(Date.now() - started < 1000, 'the request waited on a source it should not have asked');
      await q('DELETE FROM source_health WHERE source_id = $1', [SLOW]);
    });

    await t.test('the cache answers the second call, and concurrent calls collapse into one', async () => {
      const { clearLatestCache } = await import('../src/routes/sources');
      clearLatestCache();
      calls[CLEAN] = 0;

      const url = `/api/sources/latest?source=${CLEAN}&page=1`;
      const first = await app.inject({ method: 'GET', url, headers: tok(ids.plain) });
      assert.equal(first.json().content.length, 2);
      assert.equal(calls[CLEAN], 1);

      await app.inject({ method: 'GET', url, headers: tok(ids.plain) });
      assert.equal(calls[CLEAN], 1, 'the second call re-scraped the source');

      // Six chips, several tabs and a refresh must not become six outbound scrapes of the same site.
      clearLatestCache();
      calls[CLEAN] = 0;
      await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: 'GET', url, headers: tok(ids.plain) })));
      assert.equal(calls[CLEAN], 1, `5 concurrent calls made ${calls[CLEAN]} scrapes`);

      // A different page is a different answer and must not be served from the same entry.
      await app.inject({ method: 'GET', url: `/api/sources/latest?source=${CLEAN}&page=2`, headers: tok(ids.plain) });
      assert.equal(calls[CLEAN], 2);
    });
    // ------------------------------------------------------- internal detail must not leave this route file
    //
    // `GET /api/sources/status` used to sit fifteen lines below a comment forbidding exactly what it did. The
    // public `/api/sources` deliberately publishes only a public sentence, "never `last_error`, which carries
    // internal hostnames and ports", because it is cached client-side under one key that does not vary by
    // account. The status route then answered any AUTHENTICATED caller with the whole row. This file's
    // preHandler is `authenticate`, not `requireAdmin`, so "any caller" meant every member of the household.
    await t.test('the raw health row is not reachable from a non-admin route', async () => {
      await q(
        `INSERT INTO source_health (source_id, status, last_error) VALUES ($1,'down',$2)
         ON CONFLICT (source_id) DO UPDATE SET status='down', last_error = EXCLUDED.last_error`,
        [CLEAN, 'connect ECONNREFUSED 172.19.0.4:8191 (flaresolverr)'],
      );

      const gone = await app.inject({ method: 'GET', url: '/api/sources/status', headers: tok(ids.plain) });
      assert.equal(gone.statusCode, 404, 'the duplicate route must stay deleted, not merely unused');

      // and the surviving public route must still refuse to name the internals
      const pub = await app.inject({ method: 'GET', url: '/api/sources', headers: tok(ids.plain) });
      assert.equal(pub.statusCode, 200);
      const body = pub.body;
      assert.ok(!body.includes('last_error'), 'the field name leaked');
      assert.ok(!body.includes('ECONNREFUSED'), 'the error text leaked');
      assert.ok(!body.includes('172.19.0.4'), 'an internal address leaked');
      assert.ok(!body.includes('8191'), 'an internal port leaked');
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
    await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[CLEAN, ADULT, SLOW, EMPTY]]).catch(() => {});
  }
});
