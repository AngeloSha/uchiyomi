// Whose account of "where you are" wins, when two devices and a replayed queue disagree.
//
// Two faults met here, and both cost the reader their place:
//
//  1. `page = EXCLUDED.page` applied every write unconditionally. The offline outbox replays events minutes
//     or days after they happened, so a queued page 12 landing after the reader had gone on to page 60 on
//     another device rewound the bookmark, and the reader resumed 48 pages back. `completed` was already
//     careful here; `page` was not.
//
//     The rule is "the newest event wins", NOT "the furthest page wins". Turning back a page is a real thing
//     readers do and must still persist, which is why this is not simply GREATEST(page).
//
//  2. The route took the series from the REQUEST BODY whenever the body carried both a seriesId and
//     completed:true -- the completion ping, and every replay the outbox sends. A phone that was offline
//     while an admin merged duplicates then filed finished chapters under the merged-away id, where
//     `seriesCompleted` (which groups by series_id) never counted them and Continue Reading excluded them via
//     `merged_into IS NULL`. The series vanished from the rail and read as permanently unread, and nothing
//     repaired it afterwards because the merge's fix-up had already run.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_po', REAL = 's_po_real', OTHER = 's_po_other', BOOK = 'b_po_1';
const USER = 'po-reader';
let q: any, writeProgress: any, uid: string;

const stored = async () =>
  (await q('SELECT page, completed, series_id FROM read_progress WHERE user_id = $1 AND book_id = $2', [uid, BOOK]))[0];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ writeProgress } = (await import('../src/lib/progress')) as any);
  await migrate();

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'PO',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  for (const sid of [REAL, OTHER]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
             VALUES ($1,'T!po',$1,$1,1,$2) ON CONFLICT (id) DO NOTHING`, [sid, LIB]);
  }
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, pages)
           VALUES ($1,$2,'T!po',$3,1,'Chapter 1','/library',80) ON CONFLICT (id) DO NOTHING`,
    [BOOK, REAL, `T!po/${REAL}/ch1.cbz`]);
  await q('DELETE FROM users WHERE username = $1', [USER]);
  uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                  VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]))[0].id;
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM lib_books WHERE id = $1', [BOOK]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[REAL, OTHER]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('the newest event decides the page', { skip }, async (t) => {
  await t.test('a live write lands', async () => {
    await q('DELETE FROM read_progress WHERE user_id = $1', [uid]);
    await writeProgress({ userId: uid, bookId: BOOK, seriesId: REAL, page: 70, completed: false, silent: true });
    assert.equal((await stored()).page, 70);
  });

  await t.test('a replayed OLD event must not rewind the bookmark', async () => {
    await writeProgress({
      userId: uid, bookId: BOOK, seriesId: REAL, page: 12, completed: false, silent: true,
      at: Date.now() - 6 * 60 * 60 * 1000, // queued on the plane, six hours ago
    });
    assert.equal((await stored()).page, 70, 'a six-hour-old queued page must not move a newer bookmark');
  });

  await t.test('but turning BACK a page live still persists — this is not GREATEST', async () => {
    await writeProgress({ userId: uid, bookId: BOOK, seriesId: REAL, page: 68, completed: false, silent: true });
    assert.equal((await stored()).page, 68, 'a reader who turns back a page must stay turned back');
  });

  await t.test('and completion is still monotonic, whatever the ordering', async () => {
    await writeProgress({ userId: uid, bookId: BOOK, seriesId: REAL, page: 80, completed: true, silent: false });
    await writeProgress({
      userId: uid, bookId: BOOK, seriesId: REAL, page: 3, completed: false, silent: false,
      at: Date.now() - 60 * 60 * 1000,
    });
    assert.equal((await stored()).completed, true, 'a stale event must not un-finish a finished chapter');
  });
});

test('the series a chapter belongs to comes from the server', { skip }, async (t) => {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` };

  try {
    await t.test('a completion ping naming the wrong series is filed under the right one', async () => {
      await q('DELETE FROM read_progress WHERE user_id = $1', [uid]);
      const res = await app.inject({
        method: 'PUT', url: `/api/books/${BOOK}/progress`, headers: auth,
        // exactly the shape the reader and the outbox send on completion: seriesId present, completed true.
        payload: { page: 80, completed: true, seriesId: OTHER },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((await stored()).series_id, REAL, 'the body does not get to choose the series');
    });

    await t.test('a chapter that is genuinely gone answers 404, so the outbox drops it', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/api/books/b_po_nonexistent/progress', headers: auth,
        payload: { page: 1, completed: true, seriesId: REAL },
      });
      assert.equal(res.statusCode, 404);
    });
  } finally {
    await app.close();
  }
});
