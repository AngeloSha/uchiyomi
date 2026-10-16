// Health's By series view against a real Postgres (lib/health.ts groupBySeries, GET /api/admin/health?view=series,
// v0.72.0, @Squeaks72's idea in #254): every series with a finding, grouped on the server from each card's whole list.
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

/** More series with a gap than the gaps card sends rows (MAX_ITEMS, 50). */
const GAPPY = 60;
const gappy = Array.from({ length: GAPPY }, (_, i) => `hbs_gap_${String(i).padStart(2, '0')}`);
let q: any, app: any, token = '';

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  const book = (sid: string, n: number, pages = 20) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages) VALUES ($1, $2, 'test', $3, $4, $5, $6)`,
      [`b_${sid}_${n}`, sid, `/test/${sid}/${n}.cbz`, `Chapter ${n}`, n, pages]);
  for (const id of gappy) {
    await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1, 'test', $2, $1)`, [id, `BS ${id}`]);
    for (const n of [1, 2, 4]) await book(id, n);
  }
  // One of them also has a whole chapter of a single page: a second card, and that card's verdict is a problem.
  await book(gappy[GAPPY - 1], 5, 1);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                          VALUES ('hbs-admin', 'hbs-admin', 'x', 'admin', 'password') RETURNING id`))[0].id;
  token = app.jwt.sign({ sub: admin, role: 'admin' });
});

after(async () => {
  if (!DSN) return;
  await app?.close();
});

test('By series has every series, past the fifty a card shows', { skip }, async () => {
  // #254 grouped the rows each card sends. Reintroduce by grouping `c.items` (or dropping a check's withAll): ten of
  // these series are missing.
  const r = await get('/api/admin/health?view=series');
  assert.equal(r.statusCode, 200, r.body);
  const report = r.json();
  const gaps = report.checks.find((c: any) => c.id === 'chapter-gaps');
  assert.equal(gaps.items.filter((i: any) => gappy.includes(i.seriesId)).length, 50, 'the premise: the card sends fifty');
  const ids = report.bySeries.map((s: any) => s.seriesId);
  for (const id of gappy) assert.ok(ids.includes(id), `${id} is missing`);
  // None of them has a source, so each is also a series that can no longer update -- a card that shows twenty.
  const frozen = report.checks.find((c: any) => c.id === 'frozen-series');
  assert.ok(frozen.items.length <= 20, 'the premise: the frozen card shows twenty');
  for (const s of report.bySeries.filter((x: any) => gappy.includes(x.seriesId))) {
    assert.ok(s.findings.some((f: any) => f.check === 'frozen-series'), `${s.seriesId} lost its frozen finding past the card's twenty`);
  }
  // The one with a finding more, on a card whose verdict is a problem, comes first.
  const first = report.bySeries[0];
  assert.equal(first.seriesId, gappy[GAPPY - 1]);
  assert.equal(first.status, 'problem');
  assert.deepEqual(first.findings.map((f: any) => f.check).sort(), ['chapter-gaps', 'frozen-series', 'short-chapters']);
  assert.equal(first.title, `BS ${gappy[GAPPY - 1]}`);
  // Each finding is its card's row, with its keys.
  const gap = first.findings.find((f: any) => f.check === 'chapter-gaps').item;
  assert.ok(gap.actions.includes('fill') && gap.key === `series:${gappy[GAPPY - 1]}`);
});

test('By check, and the header\'s refresh, never carry the grouping', { skip }, async () => {
  const plain = (await get('/api/admin/health')).json();
  assert.equal(plain.bySeries, undefined);
  assert.equal((await get('/api/admin/health?view=checks')).json().bySeries, undefined);
  assert.equal((await get('/api/admin/health?view=everything')).statusCode, 400);
  const { runHealthChecks } = await import('../src/lib/health');
  assert.equal((await runHealthChecks()).bySeries, undefined, 'the six-hourly refresh builds none');
  // The full lists never go on the wire: the card's payload stays the page it was. Reintroduce a string key for them
  // (lib/healthKit.ts ALL_ROWS): the gaps card carries all sixty.
  const gaps = plain.checks.find((c: any) => c.id === 'chapter-gaps');
  for (const [k, v] of Object.entries(gaps)) if (Array.isArray(v)) assert.ok(v.length <= 50, `${k} carries ${v.length}`);
});

test('what is not about one series, a greyed row and a duplicate pair stay By check', { skip }, async () => {
  const { groupBySeries } = await import('../src/lib/health');
  const { withAll } = await import('../src/lib/healthKit');
  const check = (id: string, status: 'warn' | 'problem', items: any[]) =>
    withAll({ id, title: id, status, summary: '', items: items.slice(0, 1) }, items);
  const rows = await groupBySeries([
    check('sources', 'warn', [{ title: 'A source', detail: '', sourceId: 'x' }]),
    check('duplicates', 'warn', [{ title: 'Pair', detail: '', seriesId: gappy[0], seriesIds: [gappy[0], gappy[1]] }]),
    check('chapter-gaps', 'warn', [{ title: 'greyed', detail: '', seriesId: gappy[2], info: true }, { title: 'x', detail: '', seriesId: gappy[3] }]),
    // Downloads missing titles its rows by folder: the group takes the series' own title.
    check('downloads-missing', 'problem', [{ title: 'Downloads / Somewhere', detail: '', seriesId: gappy[3] }]),
    check('outliers', 'ok', [{ title: 'never', detail: '', seriesId: gappy[4] }]),
  ]);
  assert.deepEqual(rows.map((r) => [r.seriesId, r.status, r.title, r.findings.map((f) => f.check)]),
    [[gappy[3], 'problem', `BS ${gappy[3]}`, ['chapter-gaps', 'downloads-missing']]]);
});

test('a series removed from the library leaves the view', { skip }, async () => {
  const r = await app.inject({ method: 'POST', url: '/api/admin/series/bulk/hide', headers: { authorization: `Bearer ${token}` },
    payload: { ids: [gappy[0], gappy[1]] } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().hidden, 2);
  const ids = (await get('/api/admin/health?view=series')).json().bySeries.map((s: any) => s.seriesId);
  assert.ok(!ids.includes(gappy[0]) && !ids.includes(gappy[1]));
  assert.equal(ids.filter((id: string) => gappy.includes(id)).length, GAPPY - 2);
});
