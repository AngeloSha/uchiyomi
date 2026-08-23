// Page bookmarks.
//
// Kavita has them and this did not. The interesting part is not storing a page number, it is that a bookmark
// is a THIRD THING that names a book id, alongside reading progress and notes -- and every one of those has
// to be behind the same visibility rule, or listing them becomes a way to learn that a series you cannot see
// exists and what you once read of it.
//
// That is not hypothetical here: the routes that leaked in v0.8.0 leaked precisely because they resolved a
// book id without joining lib_series. This file exists so the newest thing to name a book id does not repeat
// it, and so does the write path -- creating a bookmark against a hidden series would be a write that
// confirms the id is real.
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

const OPEN = 's_bm_open';
const HIDDEN = 's_bm_hidden';
const ALL = [OPEN, HIDDEN];

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const { viewCtxFor } = await import('../src/lib/visibility');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;

  await migrate();
  await q('DELETE FROM bookmarks WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'bm-user'`).catch(() => {});

  for (const id of ALL) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!bm',$1,$2,1)`,
      [id, `T!bm/${id}`]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title)
             VALUES ($1,$2,'T!bm',$3,1,'Chapter 1')`, [`b_${id}`, id, `T!bm/${id}/ch1.cbz`]);
  }
  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('bm-user','bm-user','x','user','password') RETURNING id`);

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  return { app, q, viewCtxFor, token: app.jwt.sign({ sub: u[0].id, role: 'user' }) };
}

test('page bookmarks', { skip }, async (t) => {
  const { app, q, token } = await setup();
  const auth = { authorization: `Bearer ${token}` };
  const put = (book: string, page: number, note?: string) =>
    app.inject({ method: 'PUT', url: `/api/bookmarks/${book}/${page}`, headers: auth, payload: note ? { note } : {} });
  const list = (seriesId?: string) =>
    app.inject({ method: 'GET', headers: auth, url: `/api/bookmarks${seriesId ? `?seriesId=${seriesId}` : ''}` });

  try {
    await t.test('a bookmark round-trips', async () => {
      assert.equal((await put(`b_${OPEN}`, 7, 'the good bit')).statusCode, 200);
      const r = await list();
      const rows = r.json().content;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].page, 7);
      assert.equal(rows[0].note, 'the good bit');
      assert.equal(rows[0].series_id, OPEN);
      assert.ok(rows[0].series_title, 'the list has to name the series, or it is unreadable');
    });

    await t.test('setting the same page again edits rather than duplicates', async () => {
      await put(`b_${OPEN}`, 7, 'changed my mind');
      const rows = (await list()).json().content;
      assert.equal(rows.length, 1, 'the primary key is (user, book, page), so this must be one row');
      assert.equal(rows[0].note, 'changed my mind');
    });

    await t.test('filtering by series works, and removing works', async () => {
      await put(`b_${OPEN}`, 12);
      assert.equal((await list(OPEN)).json().content.length, 2);
      assert.equal((await list(HIDDEN)).json().content.length, 0);

      const del = await app.inject({ method: 'DELETE', url: `/api/bookmarks/b_${OPEN}/12`, headers: auth });
      assert.equal(del.statusCode, 200);
      assert.equal((await list(OPEN)).json().content.length, 1);
    });

    await t.test('THE RULE: a hidden series cannot be bookmarked', async () => {
      await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [HIDDEN]);
      try {
        const r = await put(`b_${HIDDEN}`, 3);
        assert.equal(r.statusCode, 404,
          'creating a bookmark against a series the viewer cannot see is a write that confirms the id exists');
        assert.equal(
          (await q('SELECT 1 FROM bookmarks WHERE book_id = $1', [`b_${HIDDEN}`])).length, 0,
          'and it must not have been written',
        );
      } finally {
        await q('UPDATE lib_series SET deleted_at = NULL WHERE id = $1', [HIDDEN]);
      }
    });

    await t.test('THE RULE: bookmarks for a series that becomes hidden stop being listed', async () => {
      // The row stays -- like reading progress, a bookmark outlives the file and the visibility of the
      // series -- but it must not appear for someone who can no longer see the series.
      await put(`b_${HIDDEN}`, 4);
      assert.equal((await list()).json().content.length, 2, 'both visible to start with');

      await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [HIDDEN]);
      try {
        const rows = (await list()).json().content;
        assert.equal(rows.length, 1, 'a bookmark on a hidden series was still listed');
        assert.equal(rows[0].series_id, OPEN);
        assert.equal((await q('SELECT 1 FROM bookmarks WHERE book_id = $1', [`b_${HIDDEN}`])).length, 1,
          'the row itself is kept: hiding a series must not destroy what someone recorded about it');
      } finally {
        await q('UPDATE lib_series SET deleted_at = NULL WHERE id = $1', [HIDDEN]);
      }
    });

    await t.test('a nonsense page is refused', async () => {
      assert.equal((await put(`b_${OPEN}`, 0)).statusCode, 400);
      assert.equal((await put(`b_${OPEN}`, -1)).statusCode, 400);
    });

    await t.test('a book that does not exist is a 404, not a crash', async () => {
      assert.equal((await put('b_nope', 1)).statusCode, 404);
    });
  } finally {
    await app.close();
    await q('DELETE FROM bookmarks WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
    await q(`DELETE FROM users WHERE username = 'bm-user'`).catch(() => {});
  }
});
