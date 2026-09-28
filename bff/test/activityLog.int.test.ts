// What the server finished downloading survives a restart (lib/activityLog.ts, v0.49.0).
//
// The activity feed lives in memory, and every release restarts the server, so "Came in today" and the failed
// chapters under Needs attention were empty the morning after an update. Now:
//
//   - each finished chapter is written to download_log after the fact (a file already on disk writes nothing);
//   - at boot the last day is read back into the feed, with the feed's own caps, per class: the slow archive
//     (#117) keeps its own, so its trickle never pushes out the adds, Fetches and the scheduled check;
//   - rows older than a week are pruned, at boot and at most once an hour after that.
//
// The first test needs no database; the rest are skipped unless TEST_DATABASE_URL is set.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

let q: any;
before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
});

/** One finished download, the way downloadChapter records it. */
async function finish(origin: string, n: number, outcome: { status: 'done' | 'failed'; pages?: number; reason?: string } | 'skipped', by: string | null = 'u-log') {
  const act = await import('../src/lib/downloadActivity');
  const id = act.withOrigin(origin as any, by, () => act.beginDownload({ folder: `log/${origin}`, title: `Log ${origin}`, number: n, source: 'log-src' }));
  act.startedDownload(id);
  act.endDownload(id, outcome);
}
/** The feed without its in-memory ids, which a restart hands out afresh. */
async function recent() {
  const act = await import('../src/lib/downloadActivity');
  return act.listActivity().recent.map(({ id: _id, ...e }) => e);
}

test("the slow archive has a cap of its own: its chapters never push out anyone else's", async () => {
  const act = await import('../src/lib/downloadActivity');
  act.clearActivity();
  for (let n = 1; n <= 3; n++) await finish('add', n, { status: 'done', pages: 10 });
  // More archive chapters than the whole shared cap used to hold.
  for (let n = 1; n <= act.FINISHED_CAP.main + 20; n++) await finish('archive', n, { status: 'done', pages: 10 });
  const r = act.listActivity().recent;
  // Reintroduce by counting every origin against one cap (`capClass` answering 'main' for 'archive'): the adds
  // are pushed out by the archive's trickle.
  assert.deepEqual(r.filter((e) => e.origin === 'add').map((e) => e.number).sort(), [1, 2, 3], "the day's adds are still listed");
  assert.equal(r.filter((e) => e.origin === 'archive').length, act.FINISHED_CAP.archive, 'the archive keeps its own latest, no more');
  assert.equal(r[0].origin, 'archive', 'newest first, across the classes');
  assert.equal(r[0].number, act.FINISHED_CAP.main + 20);
  act.clearActivity();
});

test('what finished is written down, and a restart reads it back into the feed', { skip }, async () => {
  const act = await import('../src/lib/downloadActivity');
  const log = await import('../src/lib/activityLog');
  await q('DELETE FROM download_log');
  act.clearActivity();
  assert.equal(await log.startActivityLog(), 0, 'an empty log restores nothing');

  await finish('fetch', 3, { status: 'done', pages: 20 });
  await finish('sweep', 4.5, { status: 'failed', reason: 'no images downloaded (blocked?)' }, null);
  await finish('archive', 7, { status: 'done', pages: 12 });
  // A file already on disk: nothing came in, so nothing is written either.
  await finish('sweep', 9, 'skipped', null);
  // Kept incomplete: `partial` once its caller writes it.
  const id = act.withOrigin('fill', 'u-log', () => act.beginDownload({ folder: 'log/fill', title: 'Log fill', number: 11, source: 'log-src' }));
  const hold = { missing: [2], write: async () => ({ pages: 15, missing: [2] }) };
  act.holdPartial(id, hold);
  await hold.write();
  await log.flushActivityLog();

  // Reintroduce by not registering the listener in startActivityLog: the table is empty.
  const rows = await q('SELECT origin, number, status, by_user, pages, reason FROM download_log ORDER BY id');
  assert.deepEqual(rows.map((r: any) => `${r.origin}:${r.number}:${r.status}`), ['fetch:3:done', 'sweep:4.5:failed', 'archive:7:done', 'fill:11:partial'],
    'every finished chapter is written, and a skip is not');
  assert.equal(rows[1].by_user, null, "the server's own run has no account");
  assert.match(rows[3].reason, /1 page missing/);

  const before = await recent();
  // The restart: memory is gone, the log is not.
  act.clearActivity();
  assert.deepEqual(await recent(), []);
  // Reintroduce by dropping the restoreFinished call in startActivityLog: the feed stays empty.
  assert.equal(await log.startActivityLog(), 4);
  assert.deepEqual(await recent(), before, 'the feed after a restart is the feed before it');
  // Read back once, never listened to twice: one more chapter is one more row.
  await finish('fetch', 5, { status: 'done', pages: 8 });
  await log.flushActivityLog();
  assert.equal((await q('SELECT count(*)::int AS n FROM download_log'))[0].n, 5, 'a second start registered a second writer');
  act.clearActivity();
});

test('a chapter made whole later is landed in the log too, so a restart does not bring the holes back', { skip }, async () => {
  // v0.49.1: the feed heals a chapter the completion pass (or a later download) made whole; its row in download_log
  // must follow, or the next restart reads "saved with pages missing" back into Came in today. Reintroduce by not
  // registering onHealed in startActivityLog: the row still reads partial.
  const act = await import('../src/lib/downloadActivity');
  const log = await import('../src/lib/activityLog');
  await q('DELETE FROM download_log');
  act.clearActivity();
  await log.startActivityLog();
  const id = act.withOrigin('sweep', null, () => act.beginDownload({ folder: 'log/heal', title: 'Log heal', number: 4.5, source: 'log-src' }));
  const hold = { missing: [1, 2], write: async () => ({ pages: 12, missing: [1, 2] }) };
  act.holdPartial(id, hold);
  await hold.write();
  // Healed straight away: the rewrite queues behind the row's own insert.
  assert.equal(act.healFinished('log/heal', 4.5), 1, 'PREMISE: the feed healed it');
  await log.flushActivityLog();
  const rows = await q(`SELECT number, status, reason FROM download_log WHERE folder = 'log/heal'`);
  assert.deepEqual(rows.map((r: any) => [Number(r.number), r.status, r.reason]), [[4.5, 'done', null]], 'the log still says partial');
  act.clearActivity();
  await log.startActivityLog();
  assert.deepEqual((await recent()).filter((e) => e.folder === 'log/heal').map((e) => [e.status, e.reason]), [['done', undefined]],
    'a restart brought "saved with pages missing" back');
  act.clearActivity();
  await q('DELETE FROM download_log');
});

test('rows older than a week are pruned, and only the last day comes back', { skip }, async () => {
  const act = await import('../src/lib/downloadActivity');
  const log = await import('../src/lib/activityLog');
  await q('DELETE FROM download_log');
  const row = (title: string, agoMs: number) => q(
    `INSERT INTO download_log (folder, title, number, source, origin, by_user, status, started_at, finished_at)
     VALUES ('log/age', $1, 1, 'log-src', 'sweep', NULL, 'done', $2, $2)`, [title, new Date(Date.now() - agoMs)]);
  await row('eight days', 8 * DAY);
  await row('two days', 2 * DAY);
  await row('an hour', HOUR);
  act.clearActivity();
  assert.equal(await log.startActivityLog(), 1);
  // Reintroduce by dropping the prune in startActivityLog: the eight-day row is still there.
  assert.deepEqual((await q('SELECT title FROM download_log ORDER BY finished_at')).map((r: any) => r.title), ['two days', 'an hour'],
    'a row older than a week is pruned at boot, and a younger one kept');
  assert.deepEqual((await recent()).map((e) => e.title), ['an hour'], 'the feed reads only the last day');

  // A server that runs for weeks prunes as it writes, at most once an hour. The last prune an hour and more ago:
  await log.startActivityLog(Date.now() - 2 * HOUR);
  await row('eight days again', 8 * DAY);
  await finish('fetch', 1, { status: 'done', pages: 3 });
  await log.flushActivityLog();
  // Reintroduce by dropping the prune from write(): the old row outlives the write.
  assert.deepEqual(await q(`SELECT 1 FROM download_log WHERE title = 'eight days again'`), [], 'a write an hour after the last prune prunes');
  act.clearActivity();
});

test("a restart keeps each class's cap: a busy archive does not push the day's adds out of what is read back", { skip }, async () => {
  const act = await import('../src/lib/downloadActivity');
  const log = await import('../src/lib/activityLog');
  await q('DELETE FROM download_log');
  // Three adds two hours ago, then more archive chapters than the whole main cap, all newer.
  await q(`INSERT INTO download_log (folder, title, number, source, origin, by_user, status, started_at, finished_at)
           SELECT 'log/add', 'An add', n, 'log-src', 'add', 'u-log', 'done', now() - interval '2 hours', now() - interval '2 hours' + n * interval '1 second'
             FROM generate_series(1, 3) AS n`);
  await q(`INSERT INTO download_log (folder, title, number, source, origin, by_user, status, started_at, finished_at)
           SELECT 'log/archive', 'Archived', n, 'log-src', 'archive', 'u-log', 'done', now() - interval '1 hour', now() - interval '1 hour' + n * interval '1 second'
             FROM generate_series(1, $1::int) AS n`, [act.FINISHED_CAP.main + 100]);
  act.clearActivity();
  const n = await log.startActivityLog();
  const r = act.listActivity().recent;
  // Reintroduce by reading one `ORDER BY finished_at DESC LIMIT` over both classes: all of it is archive, and
  // the adds are gone.
  assert.deepEqual(r.filter((e) => e.origin === 'add').map((e) => e.number), [3, 2, 1], "the day's adds survive the restart, newest first");
  assert.equal(n, 3 + act.FINISHED_CAP.archive, 'no more is read than each class keeps');
  const archived = r.filter((e) => e.origin === 'archive').map((e) => e.number);
  assert.equal(archived.length, act.FINISHED_CAP.archive);
  assert.equal(archived[0], act.FINISHED_CAP.main + 100, "and the archive's newest are the ones kept");
  act.clearActivity();
  await q('DELETE FROM download_log');
});
