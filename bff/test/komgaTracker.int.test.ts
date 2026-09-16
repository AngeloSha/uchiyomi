// The Mihon built-in Komga tracker, end to end, against real database rows.
//
// The tracker has no login of its own: it sends only a User-Agent, derives the URL from the manga, and
// cannot be pointed at a token. KOMGA_TRACKER_USER whitelists one account so those credential-less requests
// act as that user. The risk this file exists to pin is attribution: sync traffic must land on the
// whitelisted account and on nothing else, and an explicit token must still win over the anonymous fallback.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = process.env.LIBRARY_BACKEND || 'owned';
  // Set before ANY src import: env.ts validates the environment once, at module load.
  process.env.KOMGA_TRACKER_USER = 'tk-owner';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const SKIP = { skip };

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let app: any;
let ownerId: string;
let otherId: string;
let otherToken: string;

const S = 's_tk_series';
const BOOKS: Array<[string, number]> = [['b_tk_1', 1], ['b_tk_2', 2], ['b_tk_3', 3]];
const readTestProgress = (userId: string) =>
  q<{ book_id: string; completed: boolean }>(
    `SELECT book_id, completed FROM read_progress WHERE user_id = $1 AND series_id = $2 ORDER BY book_id`,
    [userId, S],
  );

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { issueApiToken } = await import('../src/lib/auth');
  const komgaCompatRoutes = (await import('../src/routes/komgaCompat')).default;
  await migrate();

  await q(`DELETE FROM users WHERE username = ANY($1)`, [['tk-owner', 'tk-other']]);
  const own = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ('Owner', 'tk-owner', 'admin', 'x', 'password') RETURNING id`,
  );
  ownerId = own[0].id;
  const oth = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ('Other', 'tk-other', 'user', 'x', 'password') RETURNING id`,
  );
  otherId = oth[0].id;
  otherToken = (await issueApiToken(otherId, 'tracker-int', ['read', 'write'], null)).token;

  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register(komgaCompatRoutes);
  await app.ready();
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = ANY($1)`, [[ownerId, otherId]]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!tk','TK Test',$1,3)`, [S]);
  for (const [id, num] of BOOKS) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
       VALUES ($1,$2,'T!tk',$3,$4,$4,'/library')`,
      [id, S, `${id}.cbz`, num],
    );
  }
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = ANY($1)`, [[ownerId, otherId]]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['tk-owner', 'tk-other']]).catch(() => {});
});

test('anonymous series detail is served as the whitelisted account, with its read counts', SKIP, async () => {
  // The tracker's match()/refresh() GET the series detail with no credentials and need the read counts
  // they use to set READ/READING/COMPLETED. Prove the counts are the OWNER's, not an aggregate: seed a
  // completed chapter for the OTHER account only and expect the owner's counts to stay untouched.
  await q(`INSERT INTO read_progress (book_id, series_id, user_id, page, completed, updated_at)
           VALUES ('b_tk_1',$1,$2,8,true,now())`, [S, otherId]);
  const r = await app.inject({ method: 'GET', url: `/api/v1/series/${S}` });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.id, S);
  assert.equal(body.booksCount, 3);
  assert.equal(body.booksReadCount, 0, 'someone else reading must not move the tracker account');
  assert.equal(body.booksUnreadCount, 3);
  assert.equal(body.metadata.title, 'TK Test');
  assert.equal(body.metadata.status, 'UNKNOWN');
});

test('anonymous PUT marks chapters read for the whitelisted account only', SKIP, async () => {
  const r = await app.inject({
    method: 'PUT',
    url: `/api/v2/series/${S}/read-progress/tachiyomi`,
    payload: JSON.stringify({ lastBookNumberSortRead: 2 }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(r.statusCode, 204);

  const owner = await readTestProgress(ownerId);
  assert.deepEqual(owner.map((x) => x.book_id), ['b_tk_1', 'b_tk_2']);
  assert.ok(owner.every((x) => x.completed), 'both chapters written by the tracker must be completed');
  assert.deepEqual(await readTestProgress(otherId), [], 'no row may land on any other account');
});

test('anonymous GET progress reports what the tracker just wrote', SKIP, async () => {
  await app.inject({
    method: 'PUT',
    url: `/api/v2/series/${S}/read-progress/tachiyomi`,
    payload: JSON.stringify({ lastBookNumberSortRead: 2 }),
    headers: { 'content-type': 'application/json' },
  });
  const r = await app.inject({ method: 'GET', url: `/api/v2/series/${S}/read-progress/tachiyomi` });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.booksCount, 3);
  assert.equal(body.booksReadCount, 2);
  assert.equal(body.booksUnreadCount, 1);
  assert.equal(body.booksInProgressCount, 0);
  assert.equal(body.lastReadContinuousNumberSort, 2);
  assert.equal(body.maxNumberSort, 3);
});

test('an explicit token wins over the anonymous fallback', SKIP, async () => {
  const r = await app.inject({
    method: 'PUT',
    url: `/api/v2/series/${S}/read-progress/tachiyomi`,
    payload: JSON.stringify({ lastBookNumberSortRead: 1 }),
    headers: { 'content-type': 'application/json', 'x-api-key': otherToken },
  });
  assert.equal(r.statusCode, 204);
  assert.deepEqual(await readTestProgress(otherId).then((rows) => rows.map((x) => x.book_id)), ['b_tk_1']);
  assert.deepEqual(await readTestProgress(ownerId), [], 'whitelisted account must not see token writes');
});

test('the browsing API stays locked to real credentials', SKIP, async () => {
  // The anonymous fallback must not open the rest of the Komga surface.
  for (const url of ['/api/v1/series', '/api/v1/libraries', `/api/v1/series/${S}/books`]) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 401, `${url} must still require credentials`);
  }
});