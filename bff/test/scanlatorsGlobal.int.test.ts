// The library-wide group list the Settings page's picker reads: GET /api/admin/scanlators.
//
// Two things to pin. The merge has to use the server's own idea of group equality (lib/releases.ts
// normGroup), so that "Asura Scans" on a file and "asura-scans" in a listing are one chip rather than two
// -- a picker that offered both would let a person block one spelling and keep receiving the other. And
// the answer is memoised, because the page refetches it on every focus and forty sources' worth of
// listings is not a query to run on each.
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

const S = 's_sg_series', FOLDER = 'T!sg/Groups';
const USER = 'sg-admin';
let q: any, app: any, tok: string;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  await migrate();

  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!sg','Groups Test',$2,2)`, [S, FOLDER]);
  for (const n of [1, 2]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, scanlator)
             VALUES ($1,$2,'T!sg',$3,$4,$5,'/library','Asura Scans')`, [`b_sg_${n}`, S, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  // The listing spells the same group the way a scraped site does, and adds a joint group.
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, groups, status)
           VALUES ($1, 3, 'sg-src', '{"sourceId":"c/3","number":3}'::jsonb, $2::text[], 'available')`, [S, ['asura-scans', 'Flame']]);

  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [USER]))[0].id;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  tok = `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}`;
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {}); // the listing cascades
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
});

const get = () => app.inject({ method: 'GET', url: '/api/admin/scanlators', headers: { authorization: tok } });

test('groups are merged by the server\'s own equality, disk and listing counted apart', { skip }, async () => {
  // Reintroduce by keying the merge on the raw name instead of normGroup(name): "Asura Scans" and
  // "asura-scans" come back as two entries, and the first assertion finds `listed` 0 on the disk one.
  const res = await get();
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();
  const asura = j.content.filter((g: any) => /asura/i.test(g.name));
  assert.equal(asura.length, 1, `one entry for both spellings, got ${JSON.stringify(asura)}`);
  assert.deepEqual(asura[0], { name: 'Asura Scans', onDisk: 2, listed: 1, series: 1 }, 'the disk\'s spelling wins; two files, one listed number, one series');
  const flame = j.content.find((g: any) => g.name === 'Flame');
  assert.deepEqual(flame, { name: 'Flame', onDisk: 0, listed: 1, series: 1 });
  const i = (name: string) => j.content.findIndex((g: any) => g.name === name);
  assert.ok(i('Asura Scans') < i('Flame'), 'busiest first');
});

test('the answer is memoised for half a minute', { skip }, async () => {
  // Reintroduce by dropping the `knownGroups` early return in the route: the new group shows up at once.
  await get();
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, scanlator)
           VALUES ('b_sg_memo', $1, 'T!sg', $2, 9, 'Chapter 9', '/library', 'Memo Group')`, [S, `${FOLDER}/Chapter 9.cbz`]);
  const j = (await get()).json();
  assert.ok(!j.content.some((g: any) => g.name === 'Memo Group'), 'a group that appeared seconds ago is not in the memoised answer yet');
});
