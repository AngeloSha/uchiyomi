// The release radar against the database and the real routes (v0.61.0, lib/releaseRadar.ts).
//
// Where the radar is written (every listing refresh, a sweep and a Check now that land chapters), what it reads (the
// chosen copies the release rules let through, never a blocked number or a hidden notice), and who sees what: every
// series' yomi.radar, the Library's Releasing soon, and Updates' Expected this week -- this reader's favourites and
// reading only, in the libraries this account may see. The rules themselves are pinned in releaseRadar.test.ts.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-radar-'));
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0'; // the disk floor belongs to diskGuard.test.ts
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_rr', LIB_HIDDEN = 'lib_rr_hidden', LIB_ADULT = 'lib_rr_adult';
const SRC = 'rr-src', SRC_LAND = 'rr-land';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;

let q: any, app: any, R: typeof import('../src/lib/releaseRadar');
let replaceListing: typeof import('../src/lib/seriesListing')['replaceListing'];
let listingRows: typeof import('../src/lib/seriesListing')['listingRows'];
let runUpdateAll: typeof import('../src/lib/updater')['runUpdateAll'];
let refreshNoticesActive: typeof import('../src/lib/noticeSettings')['refreshNoticesActive'];
let reader = '', other = '', admin = '';
const H: Record<string, string> = {};
const A: Record<string, string> = {};
const created: string[] = [];

/** A series in `lib`, routed through `source` (null: none), its title its id. */
async function mk(id: string, o: { lib?: string; source?: string | null; auto?: boolean; status?: string | null } = {}) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, status)
           VALUES ($1, 'T!rr', $1, $1, 0, $2, $3, $4, $5, $6)`,
    [id, o.lib ?? LIB, o.source === undefined ? SRC : o.source, o.source === null ? null : `${id}-src`, o.auto ?? true, o.status ?? 'Ongoing']);
  created.push(id);
}
/** The chapters a source would list: `n` numbers, one a week, the newest `lastAgo` ms ago, by `group`. */
const weekly = (n: number, lastAgo: number, group = 'Good Group') => {
  const last = Date.now() - lastAgo;
  return Array.from({ length: n }, (_, i) => ({
    number: i + 1, title: `Chapter ${i + 1}`, sourceId: `c${i + 1}`, source: SRC, scanlator: group,
    publishedAt: new Date(last - (n - 1 - i) * 7 * DAY).toISOString(), pages: 20,
  }));
};
const write = (id: string, chapters: any[]) => replaceListing(id, listingRows(chapters, chapters, new Set(), SRC));
const row = async (id: string) => (await q(`SELECT * FROM series_radar WHERE series_id = $1`, [id]))[0] ?? null;
const t = (v: unknown) => (v ? new Date(v as string).getTime() : null);
/** A radar row written by hand, its times in days from now. */
async function radar(id: string, d: { next: number | null; due?: number; quiet?: number; last?: number; ended?: boolean }) {
  const at = (x: number | null | undefined) => (x == null ? null : new Date(Date.now() + x * DAY).toISOString());
  await q(`INSERT INTO series_radar (series_id, basis, kind, interval_days, last_at, next_at, due_until, quiet_after, steady, ended)
           VALUES ($1, 'source', 'weekly', 7, $2, $3, $4, $5, false, $6)
           ON CONFLICT (series_id) DO UPDATE SET last_at = EXCLUDED.last_at, next_at = EXCLUDED.next_at, due_until = EXCLUDED.due_until,
             quiet_after = EXCLUDED.quiet_after, ended = EXCLUDED.ended`,
    [id, at(d.last ?? -7), at(d.next), at(d.due ?? (d.next == null ? null : d.next + 3)), at(d.quiet ?? 14), d.ended ?? false]);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  R = await import('../src/lib/releaseRadar');
  ({ replaceListing, listingRows } = await import('../src/lib/seriesListing'));
  ({ runUpdateAll } = await import('../src/lib/updater'));
  ({ refreshNoticesActive } = await import('../src/lib/noticeSettings'));
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();

  // Chapters 1-6, undated, each one PNG page: what the sweep and Check now land in the last two tests.
  registerAdapter({
    id: SRC_LAND, name: SRC_LAND,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_LAND, title: sid }; },
    async listChapters() { return Array.from({ length: 6 }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, sourceId: `l${i + 1}` })); },
    async getPageUrls() { return ['https://example.invalid/page.png']; },
    async latest() { return []; },
  } as any);

  await q(`DELETE FROM users WHERE username IN ('rr_reader', 'rr_other', 'rr_admin')`);
  const users = await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                         VALUES ('rr_reader', 'R', 'x', 'user', 'password'), ('rr_other', 'O', 'x', 'user', 'password'),
                                ('rr_admin', 'A', 'x', 'admin', 'password') RETURNING id, username`);
  reader = users.find((u: any) => u.username === 'rr_reader').id;
  other = users.find((u: any) => u.username === 'rr_other').id;
  admin = users.find((u: any) => u.username === 'rr_admin').id;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'Radar', '/rr'), ($2, 'Radar hidden', '/rr-hidden')
           ON CONFLICT (id) DO NOTHING`, [LIB, LIB_HIDDEN]);
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1, 'Radar 18+', '/rr-adult', 18) ON CONFLICT (id) DO NOTHING`, [LIB_ADULT]);
  // The reader may see LIB and the 18+ LIB_ADULT (which their 18+ switch tidies away from listings), and not LIB_HIDDEN.
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2), ($1, $3)`, [reader, LIB, LIB_ADULT]);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: reader, role: 'user' })}`;
  A.authorization = `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM favorites WHERE series_id = ANY($1)', [created]).catch(() => {});
  await q('DELETE FROM reading_events WHERE series_id = ANY($1)', [created]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [created]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [created]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_LAND]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, LIB_HIDDEN, LIB_ADULT]]).catch(() => {});
  await q(`DELETE FROM users WHERE username IN ('rr_reader', 'rr_other', 'rr_admin')`).catch(() => {});
  await app?.close();
});

test('a listing refresh writes the series\' radar', { skip }, async () => {
  // Eight Fridays-or-whatever-today-is, a week apart, the last three days ago. Reintroduce by dropping the refresh at
  // the end of replaceListing: no row.
  await mk('s_rr_weekly');
  const chapters = weekly(8, 3 * DAY);
  await write('s_rr_weekly', chapters);
  const r = await row('s_rr_weekly');
  assert.ok(r, 'no radar was written');
  const last = Date.parse(chapters[7].publishedAt);
  assert.deepEqual([r.basis, r.kind, Number(r.interval_days), r.steady, r.ended], ['source', 'weekly', 7, true, false]);
  assert.equal(t(r.last_at), last);
  assert.equal(t(r.next_at), last + 7 * DAY, 'a week after the last release, on its weekday');
  assert.equal(t(r.quiet_after), last + 21 * DAY);
});

test('blocked numbers and hidden notices do not move it', { skip }, async () => {
  // Chapter 9 is released only by a blocked group, and 8.5 is a two-page notice the series hides; both are dated
  // yesterday. Neither is a release this reader will get, so the radar's last release stays three days ago.
  // Reintroduce by reading every listing row (drop the status and notice tests in refreshRadar): last_at reads yesterday.
  await q(`UPDATE lib_series SET scanlator_prefs = '{"priority": [], "blocked": ["Bad Group"], "patienceDays": null}'::jsonb,
                                 hide_notices = true WHERE id = 's_rr_weekly'`);
  await refreshNoticesActive();
  const yesterday = new Date(Date.now() - DAY).toISOString();
  const chapters = [
    ...weekly(8, 3 * DAY),
    { number: 9, title: 'Chapter 9', sourceId: 'c9', source: SRC, scanlator: 'Bad Group', publishedAt: yesterday, pages: 20 },
    { number: 8.5, title: 'Notice', sourceId: 'c85', source: SRC, scanlator: 'Good Group', publishedAt: yesterday, pages: 2 },
  ];
  try {
    await write('s_rr_weekly', chapters);
    const statuses = Object.fromEntries((await q(`SELECT number, status FROM series_listing WHERE series_id = 's_rr_weekly' AND number IN (8.5, 9)`))
      .map((x: any) => [x.number, x.status]));
    assert.deepEqual(statuses, { 8.5: 'available', 9: 'blocked' }, 'the fixture is not what the test thinks');
    const r = await row('s_rr_weekly');
    assert.equal(t(r.last_at), Date.parse(chapters[7].publishedAt), 'a blocked number or a hidden notice dated the last release');
  } finally {
    await q(`UPDATE lib_series SET scanlator_prefs = NULL, hide_notices = NULL WHERE id = 's_rr_weekly'`);
    await refreshNoticesActive();
  }
  // The same listing with neither rule in force does move it: the fixture is not vacuous.
  await write('s_rr_weekly', chapters);
  assert.equal(t((await row('s_rr_weekly')).last_at), Date.parse(yesterday));
  await write('s_rr_weekly', weekly(8, 3 * DAY)); // back as the tests below expect it
});

test('a series with no source has no radar', { skip }, async () => {
  await mk('s_rr_nosrc', { source: null });
  await write('s_rr_nosrc', weekly(8, 3 * DAY));
  assert.equal(await row('s_rr_nosrc'), null, 'nothing will ever be released through it here');
  // And one that loses its source loses its radar at the next refresh.
  await q(`INSERT INTO series_radar (series_id, kind) VALUES ('s_rr_nosrc', 'weekly')`);
  assert.equal(await R.refreshRadar('s_rr_nosrc'), null);
  assert.equal(await row('s_rr_nosrc'), null);
});

test('the radar goes with its series', { skip }, async () => {
  await mk('s_rr_gone');
  await write('s_rr_gone', weekly(5, DAY));
  assert.ok(await row('s_rr_gone'));
  await q(`DELETE FROM lib_series WHERE id = 's_rr_gone'`);
  assert.equal(await row('s_rr_gone'), null, 'the radar outlived its series');
});

test('the series page carries its radar', { skip }, async () => {
  // Reintroduce by leaving yomi.radar out of enrichSeries: undefined.
  const r = await row('s_rr_weekly');
  const res = await app.inject({ method: 'GET', url: '/api/series/s_rr_weekly', headers: H });
  assert.equal(res.statusCode, 200, res.body);
  const iso = (v: unknown) => new Date(v as string).toISOString();
  assert.deepEqual(res.json().yomi.radar, {
    nextAt: iso(r.next_at), dueUntil: iso(r.due_until), quietAfter: iso(r.quiet_after), lastAt: iso(r.last_at),
    every: 7, kind: 'weekly', steady: true, ended: false, basis: 'source',
  });
  await mk('s_rr_undated');
  const none = await app.inject({ method: 'GET', url: '/api/series/s_rr_undated', headers: H });
  assert.equal(none.json().yomi.radar, null, 'a series nothing dates says so');
});

test('Releasing soon orders the Library by the radar', { skip }, async () => {
  // B is expected in two days, A in four; C has no radar, D is not monitored, E has gone quiet, F has ended. The four
  // without an estimate in force come after the dated ones in either direction, by title. Reintroduce by dropping the
  // branch in sortSql: A-Z.
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) await mk(`s_rr_sort_${k}`, { auto: k !== 'D' });
  await radar('s_rr_sort_A', { next: 4 });
  await radar('s_rr_sort_B', { next: 2 });
  await radar('s_rr_sort_D', { next: 1 });
  await radar('s_rr_sort_E', { next: -10, last: -40, quiet: -1 });
  await radar('s_rr_sort_F', { next: null, ended: true });
  const order = async (sort: string, collapseEditions = false) => {
    const res = await app.inject({ method: 'POST', url: '/api/series/search', headers: H, payload: { sort, size: 100, collapseEditions } });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().content as any[]).map((s) => s.id).filter((id: string) => id.startsWith('s_rr_sort_')).map((id: string) => id.slice(-1));
  };
  for (const collapse of [false, true]) {
    assert.deepEqual(await order('releasing,asc', collapse), ['B', 'A', 'C', 'D', 'E', 'F'], `soonest first (collapse ${collapse})`);
    assert.deepEqual(await order('releasing,desc', collapse), ['A', 'B', 'C', 'D', 'E', 'F'], `latest first (collapse ${collapse})`);
  }
  // The Library's own choice is saved with the account like every other order.
  const put = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { librarySort: 'soon' } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().librarySort, 'soon');
});

test('Expected this week: this reader\'s series due within seven days, in the libraries they may see', { skip }, async () => {
  // read: read ten days ago, expected tomorrow. fav: a favourite, in three days. late: a favourite two days past its
  // estimate and not yet quiet. Left out: one read only 100 days ago, one only ANOTHER member reads, a favourite in a
  // library this account may not see, one ten days out, a quiet one, one nobody updates.
  // adult: a favourite in an 18+ library the account may open, which a listing leaves out while the 18+ switch is off.
  const keys = ['read', 'fav', 'late', 'oldread', 'other', 'hidden', 'far', 'quiet', 'manual', 'adult'];
  for (const k of keys) await mk(`s_rr_x_${k}`, { lib: k === 'hidden' ? LIB_HIDDEN : k === 'adult' ? LIB_ADULT : LIB, auto: k !== 'manual' });
  await radar('s_rr_x_read', { next: 1 });
  await radar('s_rr_x_fav', { next: 3 });
  await radar('s_rr_x_late', { next: -2, due: -1, quiet: 10 });
  await radar('s_rr_x_oldread', { next: 2 });
  await radar('s_rr_x_other', { next: 2 });
  await radar('s_rr_x_hidden', { next: 2 });
  await radar('s_rr_x_far', { next: 10 });
  await radar('s_rr_x_quiet', { next: -2, quiet: -1 });
  await radar('s_rr_x_manual', { next: 2 });
  await radar('s_rr_x_adult', { next: 2 });
  for (const k of ['fav', 'late', 'hidden', 'far', 'quiet', 'manual', 'adult']) {
    await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1, $2)`, [reader, `s_rr_x_${k}`]);
  }
  const event = (user: string, k: string, daysAgo: number) => q(
    `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at) VALUES ($1, $2, $3, 3, false, now() - make_interval(days => $4))`,
    [user, `s_rr_x_${k}`, `b_rr_${k}`, daysAgo]);
  await event(reader, 'read', 10);
  await event(reader, 'oldread', 100);
  await event(other, 'other', 1);
  const res = await app.inject({ method: 'GET', url: '/api/updates/expected', headers: H });
  assert.equal(res.statusCode, 200, res.body);
  const ids = (res.json().content as any[]).map((s) => s.id).filter((id: string) => id.startsWith('s_rr_x_')).map((id: string) => id.slice(7));
  // Reintroduce another member's reading (drop the user from the events test): "other" is listed; drop browsable():
  // "adult" is (the series is still resolved through visible(), which keeps "hidden" out but knows no 18+ switch).
  assert.deepEqual(ids, ['late', 'read', 'fav'], 'soonest first, and only what this reader follows and may see');
  // With the 18+ switch on, the 18+ favourite is listed too, in its place.
  const revealed = await app.inject({ method: 'GET', url: '/api/updates/expected?adult=1', headers: H });
  assert.deepEqual((revealed.json().content as any[]).map((s) => s.id).filter((id: string) => id.startsWith('s_rr_x_')).map((id: string) => id.slice(7)),
    ['late', 'read', 'adult', 'fav']);
  assert.ok((res.json().content as any[]).every((s) => s.yomi?.radar?.nextAt), 'each carries the radar it is listed by');
  // The other member sees only what they read.
  const theirs = await app.inject({ method: 'GET', url: '/api/updates/expected', headers: { authorization: `Bearer ${app.jwt.sign({ sub: other, role: 'user' })}` } });
  assert.deepEqual((theirs.json().content as any[]).map((s) => s.id).filter((id: string) => id.startsWith('s_rr_x_')), ['s_rr_x_other']);
});

/** Chapters 1-5 of `id` on another root, one a week, the newest a day ago -- as rows only, never scanned. */
async function arrived(id: string) {
  for (let n = 1; n <= 5; n++) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, mtime, created_at)
             VALUES ($1, $2, 'T!rr', $3, $4, $5, '/rr-elsewhere', 0, now() - make_interval(days => $6))`,
      [`b_${id}_${n}`, id, `${id}/old ${n}.cbz`, n, `Chapter ${n}`, 1 + (5 - n) * 7]);
  }
}

test('a sweep that lands a chapter dates the radar from it', { skip }, async () => {
  // The sweep refreshes the listing -- and with it the radar -- before it downloads; the chapter it then lands is the
  // newest arrival. Reintroduce by dropping the refresh after the sweep's scan (lib/updater.ts): last_at stays a day ago.
  await mk('s_rr_land1', { source: SRC_LAND });
  await arrived('s_rr_land1');
  await q(`UPDATE lib_series SET auto_update = (id = 's_rr_land1')`);
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const before = Date.now();
  const r = await runUpdateAll({ maxNew: 5 });
  assert.equal(r.added, 1, `the sweep landed nothing: ${JSON.stringify(r.outcomes)}`);
  const radarRow = await row('s_rr_land1');
  assert.equal(radarRow.basis, 'arrival');
  assert.ok(t(radarRow.last_at)! >= before - 5 * 60_000, `last_at ${radarRow.last_at} is not the chapter that just came`);
});

test('Check now dates the radar from the chapter it landed', { skip }, async () => {
  // Reintroduce by dropping the refresh after Check now's scan (routes/admin.ts): last_at stays a day ago.
  await mk('s_rr_land2', { source: SRC_LAND });
  await arrived('s_rr_land2');
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const before = Date.now();
  const start = await app.inject({ method: 'POST', url: '/api/admin/series/s_rr_land2/check', headers: A, payload: {} });
  assert.equal(start.statusCode, 200, start.body);
  let state: any = { running: true };
  for (let i = 0; i < 400 && state.running; i++) {
    await new Promise((res) => setTimeout(res, 50));
    state = (await app.inject({ method: 'GET', url: '/api/admin/series/s_rr_land2/check', headers: A })).json();
  }
  assert.equal(state.added, 1, JSON.stringify(state));
  assert.ok(t((await row('s_rr_land2')).last_at)! >= before - 5 * 60_000, 'the radar does not know the chapter Check now landed');
});
