// Ignoring a Health finding (v0.48.3, lib/healthIgnore.ts, POST /api/admin/health/ignore).
//
// The owner: "there is no button to ignore this warning so it never repeats again". An ignored finding stays
// on its card, greyed, and out of the check's verdict; it stays quiet while everything it is about was already
// part of what was ignored (a gap that shrinks), comes back when something new is part of it (another missing
// chapter), and its ignore is forgotten once the finding has been gone for a day.
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

const S = 's_hign_gap';
const KEY = `series:${S}`;
let q: any, runHealthChecks: any, app: any, token = '';

const book = (n: number) =>
  q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages) VALUES ($1,$2,'test',$3,$4,$5,20)
     ON CONFLICT (id) DO NOTHING`, [`b_hign_${n}`, S, `/test/${S}/${n}.cbz`, `Chapter ${n}`, n]);
const gapItem = async () => {
  const r = await runHealthChecks();
  const c = r.checks.find((x: any) => x.id === 'chapter-gaps');
  return { c, item: c.items.find((i: any) => i.key === KEY) };
};
const post = (body: unknown) => app.inject({ method: 'POST', url: '/api/admin/health/ignore', headers: { authorization: `Bearer ${token}` }, payload: body });

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  ({ runHealthChecks } = (await import('../src/lib/health')) as any);
  await q(`DELETE FROM health_ignored WHERE item_key = $1`, [KEY]);
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Ignore Gap Fixture',$1)`, [S]);
  // 1-3, then 7-8: a gap of 4-6.
  for (const n of [1, 2, 3, 7, 8]) await book(n);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = 'hign-admin'`);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                          VALUES ('hign-admin','hign-admin','x','admin','password') RETURNING id`))[0].id;
  token = app.jwt.sign({ sub: admin, role: 'admin' });
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM health_ignored WHERE item_key = $1`, [KEY]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'hign-admin'`).catch(() => {});
});

test('a gap can be ignored, and then it is greyed, out of the verdict, and says so', { skip }, async () => {
  const before = await gapItem();
  assert.ok(before.item, 'the fixture gap is not reported');
  assert.ok(before.item.actions.includes('ignore'), 'a gap offers no Ignore');
  const r = await post({ check: 'chapter-gaps', key: KEY, ignored: true });
  assert.equal(r.statusCode, 200, r.body);
  // Reintroduce by not marking ignored items: the gap is still a finding and still offers Ignore.
  const { c, item } = await gapItem();
  assert.equal(item.info, true, 'an ignored gap is still a finding');
  assert.deepEqual(item.actions, ['unignore'], 'an ignored gap does not offer Stop ignoring (or still offers Fill)');
  assert.ok(item.ignored?.at, 'the item does not say when it was ignored');
  assert.match(item.detail, / · ignored \d{4}-\d{2}-\d{2} by hign-admin$/);
  assert.match(c.summary, /\d+ ignored$/);
  const audit = await q(`SELECT detail FROM audit_log WHERE event = 'health.ignore' ORDER BY at DESC LIMIT 1`);
  assert.equal(audit[0]?.detail?.key, KEY);
});

test('a gap that shrinks stays ignored; a newly missing chapter makes it a finding again', { skip }, async () => {
  await book(5); // the gap is now 4 and 6: both were part of the ignore
  assert.equal((await gapItem()).item.info, true, 'a gap that got smaller came back');
  // Reintroduce by comparing the member sets for equality: the shrunk gap above is shown again.
  await q(`DELETE FROM lib_books WHERE id = 'b_hign_8'`); // nothing changes: 8 was the last, not a hole
  await book(10); // 9 is now missing: it was not part of what was ignored
  const { item } = await gapItem();
  assert.notEqual(item.info, true, 'a new missing chapter stayed ignored');
  assert.ok(item.actions.includes('ignore'), 'the returning finding does not offer Ignore again');
});

test('Stop ignoring puts it back; a finding that is gone is answered 404; short chapters use It\'s fine', { skip }, async () => {
  await post({ check: 'chapter-gaps', key: KEY, ignored: true });
  assert.equal((await gapItem()).item.info, true);
  const off = await post({ check: 'chapter-gaps', key: KEY, ignored: false });
  assert.equal(off.statusCode, 200);
  assert.notEqual((await gapItem()).item.info, true, 'Stop ignoring did not put the finding back');
  const gone = await post({ check: 'chapter-gaps', key: 'series:s_hign_nope', ignored: true });
  assert.equal(gone.statusCode, 404, 'a finding that is not there was recorded');
  const short = await post({ check: 'short-chapters', key: KEY, ignored: true });
  assert.equal(short.statusCode, 400, 'short chapters take a generic ignore beside their own "It\'s fine"');
});

test('an ignore whose finding has been gone for a day is forgotten, and one still there is kept alive', { skip }, async () => {
  await post({ check: 'chapter-gaps', key: KEY, ignored: true });
  // Still there: its seen_at is refreshed however old it was.
  await q(`UPDATE health_ignored SET seen_at = now() - interval '3 days' WHERE item_key = $1`, [KEY]);
  await runHealthChecks();
  const kept = await q(`SELECT seen_at FROM health_ignored WHERE item_key = $1`, [KEY]);
  assert.equal(kept.length, 1, 'an ignore of a finding that is still there was dropped');
  assert.ok(Date.now() - new Date(kept[0].seen_at).getTime() < 60_000, 'seen_at was not refreshed');
  // Gone: fill the gap, and let a day pass since it was last seen.
  for (const n of [4, 6, 8, 9]) await book(n);
  await q(`UPDATE health_ignored SET seen_at = now() - interval '2 days' WHERE item_key = $1`, [KEY]);
  await runHealthChecks();
  // Reintroduce by never pruning: a gap that comes back months later is hidden by today's ignore.
  assert.equal((await q(`SELECT 1 FROM health_ignored WHERE item_key = $1`, [KEY])).length, 0, 'the ignore outlived its finding');
});
