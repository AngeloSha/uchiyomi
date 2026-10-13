// #201: what a push tells a tracker about the series' list status.
//
// CheetahDoesStuff read every chapter they had of a series still coming out, and AniList moved it to Completed: a
// push said COMPLETED whenever every chapter on THIS server was read, which says nothing about whether the series
// has ended. Since v0.61.2 a push first reads what the service holds (the adapters' seriesState) and pushStatus
// decides from that: Completed only when the service says the series has ended and gives a chapter count the push
// reaches -- Mihon's rule. The adapters' reads and writes are trackerProviders.int.test.ts; the push end to end,
// through a stub service, is trackers.int.test.ts.
//
// No database: pushStatus is a pure function. (The module still opens a pool on import, so the URL is set.)
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const load = async () => (await import('../src/lib/trackers')).pushStatus;
type Entry = { status: 'reading' | 'plan_to_read' | 'completed' | 'on_hold' | 'dropped' | 'rereading'; progress: number };
const running = (entry: Entry | null = null) => ({ ended: false, total: null, entry });
const ended = (total: number | null, entry: Entry | null = null) => ({ ended: true, total, entry });

test('a series still coming out, read to its newest chapter, stays reading', async () => {
  const pushStatus = await load();
  // The report: chapters 1-50 here, all read, the series still releasing. Reintroduce the old rule (completed at the
  // end of the local chapters): this reads 'completed'.
  assert.equal(pushStatus(50, running()), 'reading', 'not on the list yet');
  assert.equal(pushStatus(50, running({ status: 'reading', progress: 49 })), 'reading');
  // Running with a count somebody filled in early is still running: the count alone never completes it.
  assert.equal(pushStatus(50, { ended: false, total: 50, entry: null }), 'reading');
});

test('completed only when the service says it has ended and the push reaches its count', async () => {
  const pushStatus = await load();
  assert.equal(pushStatus(100, ended(100)), 'completed', 'finished at 100, read to 100');
  assert.equal(pushStatus(101, ended(100)), 'completed', 'a numbering past the service\'s count is still the end');
  assert.equal(pushStatus(80, ended(100)), 'reading', 'finished, but this server stops at 80: not read to the end');
  // An ended series whose count the service does not know cannot be shown to be read to the end.
  assert.equal(pushStatus(100, ended(null)), 'reading');
});

test('the service already at or past this chapter is told nothing, unless a resync asks to go down', async () => {
  const pushStatus = await load();
  assert.equal(pushStatus(40, running({ status: 'reading', progress: 40 })), null, 'level: nothing new');
  assert.equal(pushStatus(40, running({ status: 'reading', progress: 120 })), null, 'ahead: never rewound');
  assert.equal(pushStatus(40, ended(100, { status: 'completed', progress: 100 })), null,
    'a re-read here of a series completed there leaves the entry alone');
  // Reintroduce by ignoring `lower`: a resync could no longer correct a number that was too high.
  assert.equal(pushStatus(40, running({ status: 'reading', progress: 120 }), { lower: true }), 'reading');
  // And the resync is the at-once repair for an entry the bug completed: same chapter, back to reading.
  assert.equal(pushStatus(50, running({ status: 'completed', progress: 50 }), { lower: true }), 'reading');
});

test('a re-read stays a re-read, and a completed entry on a series that has ended stays completed', async () => {
  const pushStatus = await load();
  assert.equal(pushStatus(12, running({ status: 'rereading', progress: 11 })), 'rereading');
  assert.equal(pushStatus(12, ended(100, { status: 'rereading', progress: 11 })), 'rereading');
  assert.equal(pushStatus(100, ended(100, { status: 'rereading', progress: 99 })), 'completed', 'a re-read finished is completed');
  // Marked completed by the person below the count (they finished it elsewhere): theirs to keep.
  assert.equal(pushStatus(60, ended(100, { status: 'completed', progress: 50 })), 'completed');
});

test('a series the bug completed, still coming out, goes back to reading on the next new chapter', async () => {
  const pushStatus = await load();
  // Completed at 50 by the old rule; chapter 51 lands and is read. Reintroduce by keeping every completed entry
  // completed: this reads 'completed' and the series never leaves the Completed list.
  assert.equal(pushStatus(51, running({ status: 'completed', progress: 50 })), 'reading');
});

test('planned, paused and dropped entries picked up again are reading', async () => {
  const pushStatus = await load();
  for (const status of ['plan_to_read', 'on_hold', 'dropped'] as const) {
    assert.equal(pushStatus(5, running({ status, progress: 0 })), 'reading', status);
    assert.equal(pushStatus(5, ended(100, { status, progress: 4 })), 'reading', `${status} on an ended series`);
  }
});
