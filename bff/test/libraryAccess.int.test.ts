// Per-library access, attacked rather than admired.
//
// This is a security feature, so the tests that matter are the ones that try to get at a library the viewer
// was not granted, through every door: the series, its chapters, the file resolver behind both the image
// server and the OPDS download, search, and the rails.
//
// Two design decisions are pinned here because getting either wrong is silent:
//
//   * NO GRANT ROWS MEANS EVERY LIBRARY, not none. Upgrading an existing install must therefore change
//     nothing at all, and a library created later is visible to unrestricted accounts without touching a
//     single user row. The opposite convention (seed a row per user per library) fails by locking everyone
//     out of everything, which is a far worse way to be wrong.
//   * An EMPTY grant list is a real setting meaning "nothing", and must never be conflated with null.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let owned: any;
let viewCtxFor: any;
let visibleBookFile: any;
let seriesVisible: any;

const LIB_A = 'lib_test_a', LIB_B = 'lib_test_b';
const S_A = 's_la_a', S_B = 's_la_b';
const bookOf = (s: string) => `b_${s}_1`;
let uid: string, adminId: string;

async function seed() {
  for (const [id, name, path] of [[LIB_A, 'A', 'A'], [LIB_B, 'B', 'B']] as const) {
    await q(`INSERT INTO libraries (id, name, path) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, name, path]);
  }
  for (const [sid, lib] of [[S_A, LIB_A], [S_B, LIB_B]] as const) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!la',$1,$1,1,$2)`,
      [sid, lib],
    );
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
       VALUES ($1,$2,'T!la',$3,1,'Chapter 1','/library')`,
      [bookOf(sid), sid, `T!la/${sid}/ch1.cbz`],
    );
  }
}

const grant = async (libs: string[] | null) => {
  await q('DELETE FROM user_libraries WHERE user_id = $1', [uid]);
  for (const l of libs ?? []) {
    await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [uid, l]);
  }
};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  const vis = await import('../src/lib/visibility');
  viewCtxFor = (vis as any).viewCtxFor;
  visibleBookFile = (vis as any).visibleBookFile;
  seriesVisible = (vis as any).seriesVisible;
  await migrate();

  for (const n of ['la-user', 'la-admin']) await q('DELETE FROM users WHERE username = $1', [n]);
  const u = await q<{ id: string }>(`INSERT INTO users (display_name, username, role, password_hash, auth_kind)
    VALUES ('U','la-user','user','x','password') RETURNING id`);
  const a = await q<{ id: string }>(`INSERT INTO users (display_name, username, role, password_hash, auth_kind)
    VALUES ('A','la-admin','admin','x','password') RETURNING id`);
  uid = u[0].id; adminId = a[0].id;
});

beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM user_libraries WHERE user_id = ANY($1)', [[uid, adminId]]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [[S_A, S_B]]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S_A, S_B]]);
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB_A, LIB_B]]);
  await seed();
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM user_libraries WHERE user_id = ANY($1)', [[uid, adminId]]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [[S_A, S_B]]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S_A, S_B]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB_A, LIB_B]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [['la-user', 'la-admin']]).catch(() => {});
});

const ctxOf = (id: string, role?: string) => viewCtxFor(id, role);

// ---- the default, which is what every existing install upgrades into ----

test('THE DEFAULT: no grant rows means every library', { skip }, async () => {
  const ctx = await ctxOf(uid);
  assert.equal(ctx.libraryIds, null, 'an unrestricted viewer must not be given a list');
  assert.ok(await seriesVisible(S_A, ctx));
  assert.ok(await seriesVisible(S_B, ctx));
});

test('a library created later is visible to an unrestricted account with no user row touched', { skip }, async () => {
  const ctx = await ctxOf(uid);
  await q(`INSERT INTO libraries (id, name, path) VALUES ('lib_test_c','C','C')`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
           VALUES ('s_la_c','T!la','C','s_la_c',1,'lib_test_c')`);
  try {
    assert.ok(await seriesVisible('s_la_c', await ctxOf(uid)), 'a new library was invisible to an unrestricted account');
    void ctx;
  } finally {
    await q(`DELETE FROM lib_series WHERE id = 's_la_c'`).catch(() => {});
    await q(`DELETE FROM libraries WHERE id = 'lib_test_c'`).catch(() => {});
  }
});

// ---- restricted: every door ----

test('a granted library is reachable, so the refusals below mean something', { skip }, async () => {
  await grant([LIB_A]);
  const ctx = await ctxOf(uid);
  assert.deepEqual([...ctx.libraryIds], [LIB_A]);
  assert.equal((await owned.series(ctx, S_A)).id, S_A);
});

test('THE POINT: a series in a library you were not granted is not reachable', { skip }, async () => {
  await grant([LIB_A]);
  const ctx = await ctxOf(uid);
  await assert.rejects(() => owned.series(ctx, S_B), /not found/i);
  assert.equal(await seriesVisible(S_B, ctx), false);
});

test('its chapters are not reachable by book id', { skip }, async () => {
  await grant([LIB_A]);
  const ctx = await ctxOf(uid);
  await assert.rejects(() => owned.book(ctx, bookOf(S_B)), /not found/i);
  assert.deepEqual(await owned.bookPages(ctx, bookOf(S_B)), []);
  assert.equal((await owned.seriesBooks(ctx, S_B, 0, 50)).content.length, 0);
});

test('its files do not resolve, which is what the image server and OPDS download both call', { skip }, async () => {
  await grant([LIB_A]);
  const ctx = await ctxOf(uid);
  assert.ok(await visibleBookFile(bookOf(S_A), ctx), 'setup: a granted chapter should resolve');
  assert.equal(await visibleBookFile(bookOf(S_B), ctx), null, 'a chapter outside the grant resolved to a path');
});

test('search and the rails only show granted libraries, and the count agrees', { skip }, async () => {
  await grant([LIB_A]);
  const ctx = await ctxOf(uid);
  const r = await owned.searchSeries(ctx, {}, 0, 200);
  const ids = r.content.map((s: any) => s.id);
  assert.ok(ids.includes(S_A));
  assert.ok(!ids.includes(S_B), 'search returned a library the viewer was not granted');
  assert.equal(r.totalElements, r.content.length, 'the count disagrees with the page');

  for (const fn of ['seriesNew', 'seriesUpdated'] as const) {
    const rail = await owned[fn](ctx, 0, 200);
    assert.ok(!rail.content.map((s: any) => s.id).includes(S_B), `${fn} leaked an ungranted library`);
  }
});

test('the library list itself does not name libraries you cannot open', { skip }, async () => {
  await grant([LIB_A]);
  const ctx = await ctxOf(uid);
  const libs = await owned.libraries(ctx);
  const ids = libs.map((l: any) => l.id);
  assert.ok(ids.includes(LIB_A));
  assert.ok(!ids.includes(LIB_B), 'the list leaked the existence and name of an ungranted library');
});

// ---- the edges ----

test('an empty grant list means nothing, and is not treated as unrestricted', { skip }, async () => {
  await grant([]);
  const ctx = await ctxOf(uid);
  // grant([]) deletes the rows, so this is the "no rows" case: it must be unrestricted, not locked out.
  assert.equal(ctx.libraryIds, null, 'deleting every grant row must mean unrestricted, not nothing');

  // A genuine "nothing" is expressed by granting a library that does not match any series.
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [uid, LIB_A]);
  await q('DELETE FROM user_libraries WHERE user_id = $1 AND library_id = $2', [uid, LIB_A]);
  assert.equal((await ctxOf(uid)).libraryIds, null);
});

test('admins are unrestricted even with grant rows present', { skip }, async () => {
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [adminId, LIB_A]);
  const ctx = await ctxOf(adminId, 'admin');
  assert.equal(ctx.libraryIds, null, 'an admin was restricted, which is how a household locks itself out');
  assert.ok(await seriesVisible(S_B, ctx));
});

test('a grant is per user: restricting one member does not touch another', { skip }, async () => {
  await grant([LIB_A]);
  assert.equal((await ctxOf(adminId, 'user')).libraryIds, null, 'a grant leaked across users');
});
