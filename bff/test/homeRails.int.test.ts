// Home's two v0.61.0 rails: Pick back up (lib/onDeck.ts, the stale window) and Hidden gems (ownedCatalog seriesGems).
//
// Pick back up is Keep reading's pick over series put down 90 days to two years ago, in which you finished at least one
// chapter; the two rails must never share a series, so the boundary is tried from both sides. Hidden gems are the
// well-rated series NOBODY on the server has opened, in any language edition: one member's reading of the English
// edition takes the Spanish one off everyone's rail.
//
// The viewer is granted this file's two libraries only, so another file's leftovers cannot reach either rail.
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

const LIB = 'lib_hr', LIB18 = 'lib_hr_18';
const W_ES = '0d6c5a1e-4b0f-4c2a-9a51-7d0b5e1f6a01', W_TWO = '0d6c5a1e-4b0f-4c2a-9a51-7d0b5e1f6a02';
/** id, library, chapters, AniList score (null: no link), popularity, work, lang. */
const SERIES: Array<[string, string, number, number | null, number | null, string | null, string | null]> = [
  // reading history, for the two windows
  ['s_hr_recent', LIB, 3, null, null, null, null],
  ['s_hr_89', LIB, 3, null, null, null, null],
  ['s_hr_91', LIB, 3, null, null, null, null],
  ['s_hr_mixed', LIB, 3, null, null, null, null],
  ['s_hr_done', LIB, 2, null, null, null, null],
  ['s_hr_old', LIB, 3, null, null, null, null],
  ['s_hr_peeked', LIB, 3, null, null, null, null],
  // gems
  ['s_hr_g80', LIB, 1, 80, 1000, null, null],
  ['s_hr_g90', LIB, 1, 90, 500, null, null],
  ['s_hr_gread', LIB, 1, 85, 900, null, null],
  ['s_hr_gen', LIB, 1, 88, 700, W_ES, 'en'],
  ['s_hr_ges', LIB, 1, 88, 700, W_ES, 'es'],
  ['s_hr_gnone', LIB, 1, null, null, null, null],
  ['s_hr_g70', LIB, 1, 70, 5000, null, null],
  ['s_hr_g18', LIB18, 1, 95, 9000, null, null],
  ['s_hr_ga', LIB, 1, 82, 300, W_TWO, 'en'],
  ['s_hr_gb', LIB, 1, 79, 300, W_TWO, 'fr'],
];
const IDS = SERIES.map((s) => s[0]);
const book = (s: string, n: number) => `b_${s}_${n}`;

let q: any, app: any, onDeckPicks: any, viewCtxFor: any, viewer = '', other = '';
const H = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: viewer, role: 'user' })}` });

async function cleanup() {
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM series_trackers WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q(`DELETE FROM anilist_scores WHERE anilist_id LIKE 'hr-%'`).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, LIB18]]).catch(() => {});
  await q(`DELETE FROM users WHERE username IN ('hr-viewer','hr-other')`).catch(() => {});
}

/** `who` read chapter `n` of `s` `days` ago; `done` whether to the end. */
const read = (who: string, s: string, n: number, days: number, done = true) =>
  q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES ($1,$2,$3,5,$4, now() - make_interval(days => $5))`,
    [who, book(s, n), s, done, days]);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ onDeckPicks } = (await import('../src/lib/onDeck')) as any);
  ({ viewCtxFor } = (await import('../src/lib/visibility')) as any);
  await migrate();
  await cleanup();
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'Hr','/hr',NULL), ($2,'Hr 18','/hr18',18)`, [LIB, LIB18]);
  for (const [id, lib, chapters, score, pop, work, lang] of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, work_id, lang) VALUES ($1,'T!hr',$1,$1,$2,$3,$4,$5)`,
      [id, chapters, lib, work, lang]);
    for (let n = 1; n <= chapters; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!hr',$3,$4,$5,'/library')`,
        [book(id, n), id, `T!hr/${id}/ch${n}.cbz`, n, `Chapter ${n}`]);
    }
    if (score != null) {
      await q(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES ($1,'anilist',$2, now())`, [id, `hr-${id}`]);
      await q(`INSERT INTO anilist_scores (anilist_id, score, popularity) VALUES ($1,$2,$3)`, [`hr-${id}`, score, pop]);
    }
  }
  const user = async (name: string) => (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
    VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id as string;
  viewer = await user('hr-viewer');
  other = await user('hr-other');
  for (const l of [LIB, LIB18]) await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [viewer, l]);

  await read(viewer, 's_hr_recent', 1, 10);
  await read(viewer, 's_hr_89', 1, 89);
  await read(viewer, 's_hr_91', 1, 91);
  await read(viewer, 's_hr_mixed', 1, 300);
  await read(viewer, 's_hr_mixed', 2, 5, false); // opened again this week: Keep reading's, not Pick back up's
  await read(viewer, 's_hr_done', 1, 200);
  await read(viewer, 's_hr_done', 2, 200); // finished: nothing to offer
  await read(viewer, 's_hr_old', 1, 800); // put down more than two years ago
  await read(viewer, 's_hr_peeked', 1, 200, false); // opened and left, never finished a chapter
  // Gems: another member read one series, and one edition of a two-edition work.
  await read(other, 's_hr_gread', 1, 30, false);
  await read(other, 's_hr_gen', 1, 30);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.ready();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await cleanup();
});

const seriesOf = (picks: Array<{ seriesId: string }>) => picks.map((p) => p.seriesId).sort();

test('Pick back up and Keep reading split at 90 days and never share a series', { skip }, async () => {
  const ctx = await viewCtxFor(viewer, 'user', { hideAdult: true });
  const recent = await onDeckPicks(viewer, ctx, { window: 'recent', limit: 60 });
  const stale = await onDeckPicks(viewer, ctx, { window: 'stale', limit: 20 });
  assert.deepEqual(seriesOf(recent), ['s_hr_89', 's_hr_mixed', 's_hr_recent'], 'Keep reading: read in the last 90 days');
  // Reintroduce by grouping the stale window without `max(updated_at) <= 90 days`: s_hr_mixed, read this week, is here too.
  // Without `> 730 days`: s_hr_old is. Without the completed-chapter count: s_hr_peeked is.
  assert.deepEqual(seriesOf(stale), ['s_hr_91'], 'Pick back up: put down 90 days to two years ago, something finished');
  const both = seriesOf(recent).filter((s) => seriesOf(stale).includes(s));
  assert.deepEqual(both, [], 'no series is on both rails');
  assert.equal(stale[0].bookId, book('s_hr_91', 2), 'the next chapter after the one finished');
});

test('/api/home carries pickUp, with when the reading stopped', { skip }, async () => {
  const home = (await app.inject({ method: 'GET', url: '/api/home', headers: H() })).json();
  assert.deepEqual(home.pickUp.map((b: any) => b.id), [book('s_hr_91', 2)]);
  const stopped = Date.parse(home.pickUp[0].stoppedAt);
  assert.ok(Math.abs(stopped - (Date.now() - 91 * 86_400_000)) < 120_000, `stoppedAt ${home.pickUp[0].stoppedAt}`);
  assert.ok(!home.onDeck.some((b: any) => b.seriesId === 's_hr_91'), 'and Keep reading does not offer it');
  assert.ok(home.onDeck.some((b: any) => b.seriesId === 's_hr_89'), 'the boundary from the other side');
});

test("Hidden gems: well rated, read by nobody in any edition, one card per work, as the viewer may browse", { skip }, async () => {
  const gems = async (adult: boolean) => (await app.inject({ method: 'GET', url: `/api/home${adult ? '?adult=1' : ''}`, headers: H() }))
    .json().gems.map((s: any) => s.id);
  // Not s_hr_gread (another member opened it), not s_hr_ges (its English edition was read), not s_hr_gnone (no score),
  // not s_hr_g70 (below the line), and s_hr_gb only through its work's better-scored edition, s_hr_ga.
  // Reintroduce by checking the series alone for reading: s_hr_ges appears. Reintroduce one card per edition: s_hr_gb.
  assert.deepEqual(await gems(false), ['s_hr_g90', 's_hr_ga', 's_hr_g80'], 'best score first');
  assert.deepEqual(await gems(true), ['s_hr_g18', 's_hr_g90', 's_hr_ga', 's_hr_g80'], 'the 18+ library only when revealed');
});

test('a gem stops being one the moment anyone opens it', { skip }, async () => {
  await read(other, 's_hr_g90', 1, 0, false);
  try {
    const ids = (await app.inject({ method: 'GET', url: '/api/home', headers: H() })).json().gems.map((s: any) => s.id);
    assert.deepEqual(ids, ['s_hr_ga', 's_hr_g80']);
  } finally {
    await q('DELETE FROM read_progress WHERE series_id = $1', ['s_hr_g90']);
  }
});
