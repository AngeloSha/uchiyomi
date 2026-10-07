// A list's sorts (v0.55.7, #164): what GET /api/collections/:id carries for them.
//
// The web sorts a list itself -- a list is one request and never paged -- by its title, the unread badge's number, when
// this reader last read in each series and when each one's newest chapter arrived. The last two are on no series
// payload, so the route adds them to the list's items: `lastReadAt`, the reader's OWN latest progress (another member's
// reading must not move a series up someone else's list), and `latestChapterAt`, the newest chapter file's time. The
// items themselves stay in the list's own order, which is the default sort, and a series added to a list goes to its
// end, as a bulk add already did.
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

const A = 's_ls_alpha';   // 5 chapters, newest file 3 days old; the reader read in it 2 days ago
const B = 's_ls_bravo';   // 3 chapters, newest file 1 day old; the reader read in it 5 hours ago
const C = 's_ls_charlie'; // 1 chapter; only ANOTHER member read in it
const D = 's_ls_delta';   // 2 chapters; added last, through the single add
const E = 's_ls_echo';    // no chapter at all yet
const ALL = [A, B, C, D, E];
const USER = 'ls-user';
const OTHER = 'ls-other';
const HOUR = 3_600_000;
const NOW = Date.now();

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;

  await migrate();
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[USER, OTHER]]).catch(() => {});

  const chapters: Record<string, number> = { [A]: 5, [B]: 3, [C]: 1, [D]: 2, [E]: 0 };
  const newest: Record<string, number> = { [A]: NOW - 72 * HOUR, [B]: NOW - 24 * HOUR, [C]: NOW - 400 * HOUR, [D]: NOW - 200 * HOUR, [E]: 0 };
  for (const id of ALL) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, latest_mtime) VALUES ($1,'T!ls',$1,$2,$3,$4)`,
      [id, `T!ls/${id}`, chapters[id], newest[id]]);
    for (let n = 1; n <= chapters[id]; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, mtime) VALUES ($1,$2,'T!ls',$3,$4,$5,$6)`,
        [`b_${id}_${n}`, id, `T!ls/${id}/ch${n}.cbz`, n, `Chapter ${n}`, newest[id] - (chapters[id] - n) * HOUR]);
    }
  }
  const user = async (name: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;
  const uid = await user(USER);
  const other = await user(OTHER);
  const read = (who: string, book: string, series: string, at: number, completed = true) =>
    q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES ($1,$2,$3,20,$4,$5)`,
      [who, book, series, completed, new Date(at)]);
  await read(uid, `b_${A}_1`, A, NOW - 60 * HOUR);
  await read(uid, `b_${A}_2`, A, NOW - 48 * HOUR); // A's latest: 2 days ago
  await read(uid, `b_${B}_1`, B, NOW - 5 * HOUR, false); // part-way still counts as reading
  await read(other, `b_${C}_1`, C, NOW - HOUR); // someone else, an hour ago
  await read(other, `b_${A}_3`, A, NOW - 2 * HOUR); // ...and in A, later than the reader

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  return { app, q, auth: { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` } };
}

test("a list's items carry what its sorts need, in the list's own order", { skip }, async (t) => {
  const { app, q, auth } = await setup();
  try {
    const col = (await app.inject({ method: 'POST', url: '/api/collections', headers: auth, payload: { name: 'ls-list' } })).json();
    const add = (seriesId: string) => app.inject({ method: 'POST', url: `/api/collections/${col.id}/items`, headers: auth, payload: { seriesId } });
    for (const id of [C, A, B, E]) await add(id);
    // The list's own order, set by hand: C, A, B, E. Then D, through the single add, goes to its end.
    const put = await app.inject({ method: 'PUT', url: `/api/collections/${col.id}/items`, headers: auth, payload: { seriesIds: [C, A, B, E] } });
    assert.equal(put.statusCode, 200, put.payload);
    await add(D);
    const get = async () => {
      const r = await app.inject({ method: 'GET', url: `/api/collections/${col.id}`, headers: auth });
      assert.equal(r.statusCode, 200, r.payload);
      return r.json().items as any[];
    };
    const items = await get();
    const by = (id: string) => items.find((s) => s.id === id);

    await t.test("the items come in the list's own order, and an added series goes to its end", () => {
      // Reintroduce the single add's old position (the column default, 0): D ties with C at the top of a list someone
      // ordered by hand, and "the list's own order" fails.
      assert.deepEqual(items.map((s) => s.id), [C, A, B, E, D], "the list's own order");
    });

    await t.test("lastReadAt is when THIS reader last read in the series, and nobody else's reading", () => {
      // Reintroduce by dropping `user_id = $1` from listDates: C reads as read an hour ago, from the other member's
      // progress, and A as two hours ago -- a series moves up a list because someone else opened it.
      assert.equal(by(A).lastReadAt, new Date(NOW - 48 * HOUR).toISOString(), "the reader's latest read in A");
      assert.equal(by(B).lastReadAt, new Date(NOW - 5 * HOUR).toISOString(), 'a chapter read part-way is reading too');
      assert.equal(by(C).lastReadAt, null, "another reader's reading is not this reader's last read");
      assert.equal(by(D).lastReadAt, null, 'a series never opened has no last read');
    });

    await t.test('latestChapterAt is when the newest chapter arrived', () => {
      assert.equal(by(A).latestChapterAt, new Date(NOW - 72 * HOUR).toISOString());
      assert.equal(by(B).latestChapterAt, new Date(NOW - 24 * HOUR).toISOString());
      assert.equal(by(C).latestChapterAt, new Date(NOW - 400 * HOUR).toISOString());
      assert.equal(by(E).latestChapterAt, null, 'a series with no chapter has no latest chapter');
    });

    await t.test('the unread badge is still the reader\'s own count beside them', () => {
      // The badge on a list item is the Library's: enrich's count against this reader's progress (unreadCounts.int).
      assert.equal(by(A).booksUnreadCount, 3, 'two of five read');
      assert.equal(by(A).yomi.unread, 3);
      assert.equal(by(B).yomi.unread, 3, 'part-way is not read');
      assert.equal(by(C).yomi.unread, 1, "another member's reading is not this reader's either");
      assert.equal(by(E).yomi.unread, 0);
    });

    await t.test('the dates follow the reading', async () => {
      // Reading moves a series up "Last read" at once: the list is fetched again, not cached on the server.
      await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
               SELECT id, $1, $2, 3, false, $3 FROM users WHERE username = $4`, [`b_${D}_1`, D, new Date(NOW - 10 * 60_000), USER]);
      const again = await get();
      assert.equal(again.find((s) => s.id === D).lastReadAt, new Date(NOW - 10 * 60_000).toISOString());
    });
  } finally {
    await app.close();
    await q('DELETE FROM collections WHERE name = $1', ['ls-list']).catch(() => {});
    await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [[USER, OTHER]]).catch(() => {});
  }
});
