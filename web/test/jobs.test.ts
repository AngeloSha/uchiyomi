// The download pill's rules (lib/jobs.ts, #82): what the strip shows now the server keeps a finished job for a
// day, who is offered a Cancel, and how the server's own runs are worded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finished, forStrip, mayCancel, pillLabel, runProgress, runTitle, STRIP_DONE_MS, type JobCard, type RunCard } from '../lib/jobs';

const job = (over: Partial<JobCard>): JobCard => ({ folder: 'f', title: 'T', total: 3, done: 3, status: 'done', ...over });
const run = (over: Partial<RunCard>): RunCard =>
  ({ kind: 'sweep', startedAt: 0, status: 'running', done: 0, total: 0, fetched: 0, failed: 0, ...over });

test("Discover's strip keeps a finished job for five minutes, as it always did, and a failed one until dismissed", () => {
  const now = 10 * 3600_000;
  const jobs = [
    job({ folder: 'fresh', finishedAt: now - 60_000 }),
    job({ folder: 'old', finishedAt: now - STRIP_DONE_MS - 1 }),
    job({ folder: 'failed', status: 'error', finishedAt: now - 5 * 3600_000 }),
    job({ folder: 'running', status: 'downloading', done: 1 }),
  ];
  // Reintroduce by showing every card the server returns: "old" -- hours of green cards -- is back on Discover.
  assert.deepEqual(forStrip(jobs, now).map((j) => j.folder), ['fresh', 'failed', 'running']);
});

test('the Finished list is finished downloads, newest first, and never a carrier card with nothing on it', () => {
  const list = finished([
    job({ folder: 'a', finishedAt: 1 }),
    job({ folder: 'b', finishedAt: 3, cancelled: true, done: 1 }),
    job({ folder: 'carrier', total: 0, done: 0, finishedAt: 5 }),
    job({ folder: 'failed', status: 'error', finishedAt: 4 }),
    job({ folder: 'running', status: 'downloading' }),
  ]);
  assert.deepEqual(list.map((j) => j.folder), ['b', 'a']);
});

test('Cancel is offered for your own running download, or anyone\'s to an admin, and only once', () => {
  const mine = job({ status: 'downloading', mine: true });
  const theirs = job({ status: 'downloading', mine: false });
  assert.equal(mayCancel(mine, false), true);
  assert.equal(mayCancel(theirs, false), false, "a member was offered someone else's Cancel");
  assert.equal(mayCancel(theirs, true), true);
  assert.equal(mayCancel({ ...mine, cancelRequested: true }, false), false, 'Cancel was offered twice');
  assert.equal(mayCancel(job({ mine: true }), true), false, 'a finished job was offered a Cancel');
});

test("the pill says the person's own downloads first, then the server's run, then failures", () => {
  assert.equal(pillLabel(1, 7, [run({})], 2), 'Fetching 7 chapters');
  assert.equal(pillLabel(0, 0, [run({ status: 'done' }), run({ kind: 'repair' })], 2), runTitle('repair'));
  assert.equal(pillLabel(0, 0, [run({ status: 'done' })], 2), '2 failed');
  assert.equal(pillLabel(0, 0, [run({ status: 'cancelled' })], 0), null, 'a finished run raised the pill by itself');
});

test('a run says how far it has got in its own unit, and nothing before it has sized itself', () => {
  assert.equal(runProgress(run({})), '', 'an unsized run said "0 of 0"');
  assert.equal(runProgress(run({ done: 34, total: 224, fetched: 7 })), '34 of 224 series · 7 chapters saved');
  assert.equal(runProgress(run({ kind: 'newest', done: 2, total: 10, failed: 1 })), '2 of 10 series · 1 could not be saved');
  // The repair counts steps, and names the one it is on rather than the ones it has finished.
  assert.equal(runProgress(run({ kind: 'repair', done: 2, total: 5 })), 'step 3 of 5');
  assert.equal(runProgress(run({ kind: 'repair', done: 5, total: 5, status: 'done', fetched: 4 })), 'step 5 of 5 · 4 chapters saved');
});
