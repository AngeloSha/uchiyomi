// Editing a series, over HTTP, which is how anyone actually edits a series.
//
// This file exists because `PUT /api/admin/series/:id/meta` shipped a release in which EVERY save failed.
// The statement wrote seven placeholders and bound six values, so Postgres refused it, the handler had no
// try/catch, and the client got a bare 500 whose body carried no `message` -- so the UI could only say
// "Could not save". Retitling, the summary, the author, the genres and the age rating were all broken
// identically, and nothing anywhere reported which.
//
// It survived a 432-test suite because of exactly one property: no test drove this route. Postgres fails
// loudly on a bind mismatch, so every other query in the codebase is proven correct simply by being
// executed once. A route no test executes is the only place this class of bug can live, and a grep for
// `/meta` across bff/test returned nothing at all -- neither this route nor the books one.
//
// So the assertions here are deliberately mundane. The point is not that they are clever; the point is that
// they run.
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

const S = 's_sm_a';
const B = 'b_sm_a';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q('DELETE FROM series_overrides WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM book_overrides WHERE book_id = $1', [B]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'sm-%'`).catch(() => {});

  await q(
    `INSERT INTO lib_series (id, source, title, summary, author, status, genres, folder, books_count)
     VALUES ($1,'T!sm','Scanned Title','Scanned summary','Scanned Author','ongoing',$2,$1,1)`,
    [S, ['Action']],
  );
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title)
           VALUES ($1,$2,'T!sm',$3,1,'Chapter 1')`, [B, S, 'T!sm/a/ch1.cbz']);

  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('sm-admin','sm-admin','x','admin','password') RETURNING id`))[0].id;

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  return { q, app, auth: { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` } };
}

const meta = (over: Record<string, unknown> = {}) => ({
  title: 'Scanned Title', summary: 'Scanned summary', author: 'Scanned Author',
  status: 'ongoing', genres: ['Action'], ageRating: null, ...over,
});

test('editing a series over HTTP', { skip }, async (t) => {
  const { q, app, auth } = await setup();
  const put = (payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/admin/series/${S}/meta`, headers: auth, payload });
  const row = async () =>
    (await q<{ title: string; author: string; genres: string[]; age_rating: number | null }>(
      'SELECT title, author, genres, age_rating FROM series_overrides WHERE series_id = $1', [S]))[0];

  try {
    await t.test('THE REGRESSION: an ordinary edit saves', async () => {
      // The shape the modal sends when someone only changed the title. This 500'd for a whole release.
      const r = await put(meta({ title: 'A Better Title' }));
      assert.equal(r.statusCode, 200, `saving a title answered ${r.statusCode}: ${r.body.slice(0, 200)}`);
      assert.equal((await row()).title, 'A Better Title');
    });

    await t.test('an age rating round-trips, and reaches the read path', async () => {
      assert.equal((await put(meta({ title: 'A Better Title', ageRating: 18 }))).statusCode, 200);
      assert.equal((await row()).age_rating, 18);

      // Not just stored: the override has to beat what the scan read, everywhere the app reads a series.
      const { content } = await import('../src/lib/backend');
      const { SYSTEM_CTX } = await import('../src/lib/visibility');
      assert.equal((await content.series(SYSTEM_CTX, S) as any).metadata.ageRating, 18,
        'the series page seeds its rating control from this');
    });

    await t.test('null clears it rather than leaving the old rating behind', async () => {
      assert.equal((await put(meta({ title: 'A Better Title', ageRating: null }))).statusCode, 200);
      assert.equal((await row()).age_rating, null,
        'clearing a rating must actually clear it, or a mis-set 18+ can never be undone');
    });

    await t.test('every other field on the modal saves too', async () => {
      // All six are written on every call, so a regression in any one of them is a silent data loss.
      const r = await put(meta({
        title: 'Retitled', summary: 'Rewritten summary', author: 'Someone Else',
        status: 'completed', genres: ['Drama', 'Romance'], ageRating: 13,
      }));
      assert.equal(r.statusCode, 200);
      const o = await row();
      assert.equal(o.title, 'Retitled');
      assert.equal(o.author, 'Someone Else');
      assert.deepEqual(o.genres, ['Drama', 'Romance']);
      assert.equal(o.age_rating, 13);
    });

    await t.test('a rating outside the scale is refused, not crashed on', async () => {
      // 400 and 500 look the same to a user and completely different to whoever has to fix it.
      for (const bad of [19, -1, 3.5]) {
        const r = await put(meta({ ageRating: bad }));
        assert.equal(r.statusCode, 400, `ageRating ${bad} answered ${r.statusCode}, expected 400`);
      }
      assert.equal((await put(meta({ ageRating: 18 }))).statusCode, 200, 'and 18 is still inside the scale');
    });

    await t.test('the chapter route saves too, since it was equally untested', async () => {
      const r = await app.inject({
        method: 'PUT', url: `/api/admin/books/${B}/meta`, headers: auth,
        payload: { number: 1.5, title: 'Chapter 1.5' },
      });
      assert.equal(r.statusCode, 200, `saving a chapter answered ${r.statusCode}: ${r.body.slice(0, 200)}`);
      const o = (await q<{ number: string; title: string }>(
        'SELECT number, title FROM book_overrides WHERE book_id = $1', [B]))[0];
      assert.equal(Number(o.number), 1.5);
      assert.equal(o.title, 'Chapter 1.5');
    });
  } finally {
    await app.close();
    await q('DELETE FROM series_overrides WHERE series_id = $1', [S]).catch(() => {});
    await q('DELETE FROM book_overrides WHERE book_id = $1', [B]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
    await q(`DELETE FROM users WHERE username LIKE 'sm-%'`).catch(() => {});
  }
});
