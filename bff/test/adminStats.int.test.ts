// What the admin overview is allowed to say about the people using the server.
//
// The member-activity cards now show what each member last read, so the card can be washed in that series'
// cover instead of being another flat rectangle. That is a disclosure, and where it lives matters:
//
//   * /api/admin/stats is behind requireAdmin. An admin already administers these accounts.
//   * /api/leaderboard is readable by EVERY member and deliberately does NOT carry it. "Renata read 57
//     chapters" and "Renata is reading <title>" are different facts, and only the first one was ever
//     opted into. Adding the second to the leaderboard would be a silent change to what a household
//     shares, made for a layout.
//
// The other thing worth pinning: a soft-deleted series must not come back through this door. Hiding a
// series is how you make it stop appearing, and an admin dashboard captioning someone's card with the
// title they thought they had removed is the one way that promise visibly breaks.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
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

const SERIES = ['s_as_old', 's_as_new'] as const;

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'as-%'`).catch(() => {});
  for (const [id, title] of [['s_as_old', 'An Older Read'], ['s_as_new', 'The Latest Thing']] as const) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!as',$2,$1,1)`, [id, title]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title)
             VALUES ($1,$2,'T!as',$3,1,'Chapter 1')`, [`b_${id}`, id, `T!as/${id}/ch1.cbz`]);
  }
  const mk = async (name: string, role = 'user') => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  const reader = await mk('as-reader');
  const admin = await mk('as-admin', 'admin');

  // Two reads, so "last" has to mean something rather than "whichever row came back first".
  for (const [id, ago] of [['s_as_old', 5], ['s_as_new', 1]] as const) {
    await q(
      `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at)
       VALUES ($1,$2,$3,3,true, now() - ($4 || ' days')::interval)`,
      [reader, id, `b_${id}`, ago],
    );
  }

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  return { q, app, reader, auth: { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` } };
}

test('admin member activity', { skip }, async (t) => {
  const { q, app, reader, auth } = await setup();
  const row = async () => (await app.inject({ method: 'GET', url: '/api/admin/stats', headers: auth }))
    .json().activity.find((a: any) => a.id === reader);

  try {
    await t.test('it reports the series each member read most recently', async () => {
      const r = await row();
      assert.equal(r.last_series_id, 's_as_new', 'the MOST RECENT read, not any read');
      assert.equal(r.last_series_title, 'The Latest Thing');
      assert.equal(r.total, 2, 'and the counts it already had are unchanged');
      assert.equal(r.week, 2);
    });

    await t.test('an admin override renames it here too', async () => {
      // The overview would otherwise caption a card with a title the admin renamed away from, which is the
      // same class of bug as browse and search disagreeing about a genre.
      await q(`INSERT INTO series_overrides (series_id, title) VALUES ('s_as_new','Renamed By Hand')
               ON CONFLICT (series_id) DO UPDATE SET title = EXCLUDED.title`);
      assert.equal((await row()).last_series_title, 'Renamed By Hand');
      await q(`DELETE FROM series_overrides WHERE series_id = 's_as_new'`);
    });

    await t.test('a hidden series does not resurface on the dashboard', async () => {
      await q(`UPDATE lib_series SET deleted_at = now() WHERE id = 's_as_new'`);
      const r = await row();
      assert.equal(r.last_series_id, 's_as_old',
        'a soft-deleted series was still being named; hiding it is supposed to make it stop appearing');
      await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = 's_as_new'`);
    });

    await t.test('a member who has read nothing gets nulls, not a crash or a stray title', async () => {
      const quiet = (await q<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
         VALUES ('as-quiet','as-quiet','x','user','password') RETURNING id`))[0].id;
      const r = (await app.inject({ method: 'GET', url: '/api/admin/stats', headers: auth }))
        .json().activity.find((a: any) => a.id === quiet);
      assert.ok(r, 'a member with no history must still be listed');
      assert.equal(r.last_series_id, null);
      assert.equal(r.last_series_title, null);
      assert.equal(r.total, 0);
    });

    await t.test('THE LINE: the household leaderboard still says nothing about what anyone is reading', async () => {
      // Every member can read this one. It carries how much, on purpose, and must not start carrying what.
      const catalogRoutes = (await import('../src/routes/catalog')).default;
      const Fastify = (await import('fastify')).default;
      const jwt = (await import('@fastify/jwt')).default;
      const pub = Fastify();
      await pub.register(jwt, { secret: process.env.JWT_SECRET! });
      await pub.register(catalogRoutes);
      await pub.ready();
      try {
        const r = await pub.inject({
          method: 'GET', url: '/api/leaderboard',
          headers: { authorization: `Bearer ${pub.jwt.sign({ sub: reader, role: 'user' })}` },
        });
        assert.equal(r.statusCode, 200);
        for (const m of r.json().content) {
          for (const k of Object.keys(m)) {
            assert.ok(!/series|title|reading|last_read/i.test(k),
              `/api/leaderboard grew a "${k}" field; every member can read this, and what someone is reading is not what they opted into sharing`);
          }
        }
      } finally { await pub.close(); }
    });
  } finally {
    await app.close();
    await q(`DELETE FROM users WHERE username LIKE 'as-%'`).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  }
});
