// GET /api/stats/insights against a real database: one row per series the caller has a RECORDED read in, counts from
// reading_events only (an incognito read writes none), and a series the caller may not browse is absent.
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

test('stats insights', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const personal = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  const SERIES = ['s_yi_read', 's_yi_unread', 's_yi_other'];
  await q('DELETE FROM reading_events WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'yi-%'`).catch(() => {});
  for (const id of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, genres) VALUES ($1,'T!yi',$1,$1,3,ARRAY['Drama'])`, [id]);
    for (const n of [1, 2, 3]) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title) VALUES ($1,$2,'T!yi',$3,$4,'Chapter')`,
        [`b_${id}_${n}`, id, `T!yi/${id}/${n}.cbz`, n]);
    }
  }
  const mk = async (name: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;
  const me = await mk('yi-me');
  const other = await mk('yi-other');
  // Two finishes in s_yi_read (today and ten days ago), one by someone else in another series.
  for (const [u, s, n, ago] of [[me, 's_yi_read', 1, 0], [me, 's_yi_read', 2, 10], [other, 's_yi_other', 1, 0]] as const) {
    await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at)
             VALUES ($1,$2,$3,3,true, now() - ($4 || ' days')::interval)`, [u, s, `b_${s}_${n}`, ago]);
    await q(`INSERT INTO read_progress (user_id, series_id, book_id, page, completed) VALUES ($1,$2,$3,3,true)
             ON CONFLICT DO NOTHING`, [u, s, `b_${s}_${n}`]);
  }

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personal);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: me, role: 'user' })}` };

  const r = await app.inject({ method: 'GET', url: '/api/stats/insights?tz=Asia/Kolkata', headers: auth });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.tz, 'Asia/Kolkata');
  assert.equal(b.daily.reduce((a: number, d: [string, number]) => a + d[1], 0), 2, 'only my own finishes are counted');
  assert.equal(b.byHour.length, 24);
  assert.equal(b.byWeekday.length, 7);
  assert.equal(b.byHour.reduce((a: number, n: number) => a + n, 0), 2);
  assert.deepEqual(b.series.map((s: any) => s.id), ['s_yi_read'], 'a series with no recorded read, and another reader\'s, are not listed');
  const s = b.series[0];
  assert.equal(s.total, 3);
  assert.equal(s.read, 2);
  assert.equal(s.recent, 2, 'both finishes are inside the last 28 days');

  assert.equal((await app.inject({ method: 'GET', url: '/api/stats/insights' })).statusCode, 401);
  await app.close();
});
