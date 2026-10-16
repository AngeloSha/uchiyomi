// The chapters a series is missing, as the reader is told of them (#236): GET /api/series/:id/gaps, the Health card's own
// rule (lib/seriesGaps.ts) -- a range file's numbers, a chapter deleted on purpose and a post its source deleted are held,
// an impossible number is left out, and a run an admin ignored on Health is not news -- behind the series' own gate.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
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

const LIB = 'lib_sg', LIB_HIDDEN = 'lib_sg_hidden';
const S = 's_sg_a', S_POST = 's_sg_post', S_HIDDEN = 's_sg_hidden';
let q: any, app: any;
let reader = '';
const H: Record<string, string> = {};

/** A chapter row: `end` for a range file, `pruned` for a tombstone and why. */
async function book(series: string, n: number, o: { end?: number; pruned?: string } = {}) {
  await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, number_end, pages, pruned_at, pruned_reason)
           VALUES ($1, $2, 'T!sg', $3, $4, $5, $6, 20, $7, $8)`,
    [`b_${series}_${n}`, series, `/sg/${series}/${n}.cbz`, `Chapter ${n}`, n, o.end ?? null,
      o.pruned ? new Date() : null, o.pruned ?? null]);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q(`DELETE FROM users WHERE username = 'sg_reader'`);
  reader = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                     VALUES ('sg_reader', 'R', 'x', 'user', 'password') RETURNING id`))[0].id;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'SG', '/sg'), ($2, 'SG hidden', '/sg-hidden') ON CONFLICT (id) DO NOTHING`, [LIB, LIB_HIDDEN]);
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)`, [reader, LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, S_POST, S_HIDDEN]]);
  for (const [id, lib] of [[S, LIB], [S_POST, LIB], [S_HIDDEN, LIB_HIDDEN]]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1, 'T!sg', $1, $1, 10, $2)`, [id, lib]);
  }
  // 1, 2; a file holding 3 to 7; 8 deleted on purpose; 9 found missing by Verify files; 10; 15; 20; and a 9001 that is
  // the sidebar-widget bug's signature, not 8,980 chapters to come.
  for (const n of [1, 2, 10, 15, 20, 9001]) await book(S, n);
  await book(S, 3, { end: 7 });
  await book(S, 8, { pruned: 'deleted' });
  await book(S, 9, { pruned: 'missing' });
  // Numbered by posting order: post 3 was deleted at its source, so its number is a hole nothing can fill.
  await q(`UPDATE lib_series SET source_id = 'sg-src', numbering = 'posting_order', numbering_by = 'auto', numbering_source = 'sg-src'
            WHERE id = $1`, [S_POST]);
  for (const n of [1, 2, 4]) await book(S_POST, n);
  await q(`INSERT INTO series_post_numbers (series_id, source_id, post_id, number, seen_at, gone_at)
           VALUES ($1, 'sg-src', 'p3', 3, now(), now())`, [S_POST]);
  for (const n of [1, 5]) await book(S_HIDDEN, n);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: reader, role: 'user' })}`;
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM health_ignored WHERE check_id = 'chapter-gaps' AND item_key = ANY($1)`, [[`series:${S}`]]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, S_POST, S_HIDDEN]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, LIB_HIDDEN]]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'sg_reader'`).catch(() => {});
  await app?.close();
});

const gaps = async (id: string) => {
  const r = await app.inject({ method: 'GET', url: `/api/series/${id}/gaps`, headers: H });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().gaps;
};

test('the runs a series is missing, by the Health card\'s rule', { skip }, async () => {
  // 3-7 is one file's, 8 went on purpose: held, never "missing here". 9 went without anyone deciding so: missing. 9001 is
  // impossible, so 21-9000 is no gap. Reintroduce plain numbers over the live rows (the PR's chapterRefs): 3-9 reads missing.
  assert.deepEqual(await gaps(S), [{ lo: 9, hi: 9 }, { lo: 11, hi: 14 }, { lo: 16, hi: 19 }]);
});

test('a run an admin ignored on Health is not news to a reader; one missing since is', { skip }, async () => {
  await q(`INSERT INTO health_ignored (check_id, item_key, members, title, at, seen_at)
           VALUES ('chapter-gaps', $1, $2, 'sg', now(), now())`, [`series:${S}`, ['11-14', '16-19']]);
  try {
    // Reintroduce seriesGaps without notIgnored: 11-14 and 16-19 come back.
    assert.deepEqual(await gaps(S), [{ lo: 9, hi: 9 }]);
    // Ignored back when the run was 16-17: two chapters have gone missing since, so 16-19 is news again; and 11-14 is no
    // longer ignored at all.
    await q(`UPDATE health_ignored SET members = $2 WHERE check_id = 'chapter-gaps' AND item_key = $1`, [`series:${S}`, ['16-17']]);
    assert.deepEqual(await gaps(S), [{ lo: 9, hi: 9 }, { lo: 11, hi: 14 }, { lo: 16, hi: 19 }], 'only a run inside an ignored one is quiet');
  } finally {
    await q(`DELETE FROM health_ignored WHERE check_id = 'chapter-gaps' AND item_key = $1`, [`series:${S}`]);
  }
});

test('a post its source deleted is a hole, not a missing chapter', { skip }, async () => {
  assert.deepEqual(await gaps(S_POST), []);
  await q(`UPDATE series_post_numbers SET gone_at = NULL WHERE series_id = $1`, [S_POST]);
  try {
    assert.deepEqual(await gaps(S_POST), [{ lo: 3, hi: 3 }], 'the same number, not deleted at the source, is missing');
  } finally {
    await q(`UPDATE series_post_numbers SET gone_at = now() WHERE series_id = $1`, [S_POST]);
  }
});

test('404 for a series this account may not open, as for the series itself', { skip }, async () => {
  for (const id of [S_HIDDEN, 's_sg_nope']) {
    const r = await app.inject({ method: 'GET', url: `/api/series/${id}/gaps`, headers: H });
    assert.equal(r.statusCode, 404, `${id}: ${r.body}`);
  }
});
