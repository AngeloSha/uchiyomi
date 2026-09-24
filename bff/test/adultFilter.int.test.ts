// What the 18+ switch hides besides 18+ libraries: admin-named genres and sources.
//
// adultLibrary.int.test.ts is the sweep that proves the switch reaches every listing; this file proves the
// two lists behind Admin → Settings → 18+ filter feed that same switch, and nothing more:
//   - a genre on `server_settings.adult_genres` takes a series off a listing while the switch is off, the
//     same request with `?adult=1` brings it back, and an admin genre override wins over what the scan
//     read -- the same precedence the age rating has;
//   - `series_overrides.adult_exempt` lets one series through, and the meta route does not clear it when a
//     client (the edit modal of an older build, a script) leaves the field out;
//   - a source on `adult_sources` leaves the source list and the cross-source fan-out exactly as a
//     self-declared NSFW source does, and is not asked at all;
//   - the genre list reaches SQL by interpolation (browsable() cannot bind), so a hostile value stored
//     straight into the column, past the PATCH route, must neither break a listing nor change its answer,
//     and a legitimate name with an apostrophe must still match.
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

const LIB = 'lib_af_clean';
const TAGGED = 's_af_tagged';
const EXEMPT = 's_af_exempt';
const RETAGGED = 's_af_retagged';
const QUOTED = 's_af_quoted';
const PLAIN = 's_af_plain';
const SERIES = [TAGGED, EXEMPT, RETAGGED, QUOTED, PLAIN];
const TITLE = (id: string) => `Zzz AF ${id}`;
const ADMIN = 'af-admin';
const NAMED_SRC = 'af-src-named';
const CLEAN_SRC = 'af-src-clean';

const asked: Record<string, number> = { [NAMED_SRC]: 0, [CLEAN_SRC]: 0 };
function fakeSource(id: string, name: string) {
  return {
    id, name,
    async search(term: string) { asked[id]++; return [{ sourceId: `${id}-1`, source: id, title: `${term} ${id}` }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: name }; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
    async latest() { return []; },
    async popular() { return []; },
  };
}

test('the 18+ filter hides named genres and sources, and nothing else', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { invalidateAdultFilter } = await import('../src/lib/visibility');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(fakeSource(NAMED_SRC, 'Zzz Named Source') as any);
  registerAdapter(fakeSource(CLEAN_SRC, 'Zzz Clean Source') as any);

  const cleanup = async () => {
    await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
    await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
    // Shared database: leaving a list behind would quietly change what every later suite's listings return.
    await q(`UPDATE server_settings SET adult_genres = '[]'::jsonb, adult_sources = '[]'::jsonb WHERE id = 1`).catch(() => {});
    invalidateAdultFilter();
  };
  await cleanup();

  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'AF Clean Shelf','/af-clean',NULL)`, [LIB]);
  // Every series sits on an UNRATED library, so nothing here can be hidden by the library rule; the only
  // thing that can take one off a listing is the genre list under test. Mixed case and a stray space on
  // purpose: the filter stores lowercase keys and must still match what the scanner wrote.
  const genresOf: Record<string, string[]> = {
    [TAGGED]: ['Action', 'ZzzAF Ecchi '],
    [EXEMPT]: ['ZzzAF Ecchi'],
    [RETAGGED]: ['ZzzAF Ecchi'],
    [QUOTED]: ["ZzzAF Boys' Love"],
    [PLAIN]: ['Action'],
  };
  for (const sid of SERIES) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, latest_mtime, created_at)
       VALUES ($1,'T!af',$2,$3,1,$4,$5, 1, now())`,
      [sid, TITLE(sid), `T!af/${sid}`, LIB, genresOf[sid]],
    );
  }
  // The admin re-tagged this one without the adult genre; the override is what counts.
  await q(`INSERT INTO series_overrides (series_id, genres) VALUES ($1, ARRAY['Action'])`, [RETAGGED]);

  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`,
    [ADMIN],
  ))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };

  /** Which of this file's series the library grid lists. */
  const listed = async (adult = false): Promise<string[]> => {
    const r = await app.inject({ method: 'POST', url: `/api/series/search${adult ? '?adult=1' : ''}`, headers,
      payload: { query: 'Zzz AF', size: 100 } });
    assert.equal(r.statusCode, 200, `the listing failed: ${r.body}`);
    return SERIES.filter((sid) => r.body.includes(sid)).sort();
  };
  const patch = async (body: Record<string, unknown>) => {
    const r = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers, payload: body });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };

  try {
    await t.test('PREMISE: with empty lists nothing of ours is hidden', async () => {
      assert.deepEqual(await listed(), [...SERIES].sort());
    });

    await t.test('a named genre leaves the listing, and ?adult=1 brings it back', async () => {
      const row = await patch({ adultGenres: ['  ZZZAF Ecchi', "zzzaf boys' love"] });
      assert.deepEqual(row.adult_genres, ['zzzaf ecchi', "zzzaf boys' love"], 'stored in the folded form it is matched in');
      // RETAGGED stays: its override says Action only. The apostrophe genre is hidden, so quoting kept it
      // a match rather than a syntax error or a silent miss.
      assert.deepEqual(await listed(), [PLAIN, RETAGGED].sort(),
        'the named genres did not hide exactly the series carrying them');
      assert.deepEqual(await listed(true), [...SERIES].sort(), 'the reveal did not bring them back');
    });

    await t.test('adult_exempt lets one series through, and a save that omits it keeps it', async () => {
      const put = (payload: Record<string, unknown>) =>
        app.inject({ method: 'PUT', url: `/api/admin/series/${EXEMPT}/meta`, headers, payload });
      assert.equal((await put({ title: TITLE(EXEMPT), adultExempt: true })).statusCode, 200);
      assert.ok((await listed()).includes(EXEMPT), 'the exemption did not let the series through');
      // Reintroduce by writing `adult_exempt = $8` without the COALESCE: an ordinary retitle clears it.
      assert.equal((await put({ title: TITLE(EXEMPT) })).statusCode, 200);
      assert.ok((await listed()).includes(EXEMPT), 'a metadata save without adultExempt cleared the exemption');
      const s = await app.inject({ method: 'GET', url: `/api/series/${EXEMPT}`, headers });
      assert.equal(s.json().overrides?.adultExempt, true, 'the edit modal cannot seed its checkbox');
      assert.equal((await put({ title: TITLE(EXEMPT), adultExempt: false })).statusCode, 200);
      assert.ok(!(await listed()).includes(EXEMPT), 'the exemption could not be turned off');
    });

    await t.test('the PATCH route drops a name outside the allowed shape instead of storing it', async () => {
      // Every rejected value here carries a character outside the shape (`=`, `;`, backslash, `$`, `"`).
      const row = await patch({ adultGenres: ["x' OR 'a'='a", 'a;b', 'ok genre', 'back\\slash', '$1', 'a"b'] });
      assert.deepEqual(row.adult_genres, ['ok genre']);
    });

    await t.test('a hostile value stored past the route neither breaks a listing nor widens it', async () => {
      // Straight into the column, as a restored backup or a hand edit would put it. browsable() cannot
      // bind, so this is the value that would reach SQL if the sanitiser were skipped anywhere.
      const hostile = [
        "zzzaf ecchi') OR true OR lower('x", "')) OR 1=1 --", "zzzaf ecchi'; DROP TABLE lib_series; --",
        '$1', 'e\\\' OR true --', 'zzzaf ecchi',
      ];
      await q('UPDATE server_settings SET adult_genres = $1::jsonb WHERE id = 1', [JSON.stringify(hostile)]);
      invalidateAdultFilter();
      // The `;`, `=`, `$` and backslash values are dropped. The first one is made only of allowed
      // characters and survives -- as one inert, quoted literal that matches no genre. So exactly the
      // plain 'zzzaf ecchi' series are hidden (EXEMPT's exemption was switched off above): no error (the
      // listing answers 200 inside `listed`), nothing hidden that should not be, nothing shown that should not.
      assert.deepEqual(await listed(), [PLAIN, QUOTED, RETAGGED].sort());
      const n = await q<{ n: string }>('SELECT count(*)::text AS n FROM lib_series WHERE id = ANY($1)', [SERIES]);
      assert.equal(Number(n[0].n), SERIES.length);
    });

    await t.test('a named source leaves Discover like a self-declared adult one, and is not asked', async () => {
      await patch({ adultGenres: [], adultSources: [NAMED_SRC.toUpperCase()] });
      const ids = async (url: string) =>
        ((await app.inject({ method: 'GET', url, headers })).json().content as Array<{ id: string }>).map((s) => s.id);
      assert.ok(!(await ids('/api/sources')).includes(NAMED_SRC), 'the named source is still listed');
      assert.ok((await ids('/api/sources')).includes(CLEAN_SRC), 'the filter took the clean source too');
      assert.ok((await ids('/api/sources?adult=1')).includes(NAMED_SRC), 'the reveal did not bring it back');

      const before = { ...asked };
      const r = await app.inject({ method: 'GET', url: '/api/sources/search-all?q=Zzzafhidden', headers });
      assert.equal(r.statusCode, 200);
      assert.equal(asked[NAMED_SRC] - before[NAMED_SRC], 0, 'the fan-out still asked the named source');
      assert.equal(asked[CLEAN_SRC] - before[CLEAN_SRC], 1, 'PREMISE: the fan-out asked nobody');
    });
  } finally {
    await app.close();
    await cleanup();
  }
});
