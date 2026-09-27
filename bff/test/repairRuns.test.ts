// The repair history's pure rules (lib/repairRuns.ts): which runs own the Tasks line, what kind a run is (its
// "usually" is the median of that kind), and which runs may turn the Library ring.
//
// The database half -- a scoped run landing in repair_runs and leaving server_settings.repair_last_* alone --
// is in repair.int.test.ts and repairRoutes.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';

// The module imports the database pool, which reads its DSN on load; nothing here queries it.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

test('only a run with no `only` is a full run: every Health press is scoped', async () => {
  // Reintroduce by answering true for any run (the pre-v0.49.0 behaviour, where every run wrote the Tasks
  // line): the scoped cases below fail.
  const { isFullRun } = await import('../src/lib/repairRuns');
  assert.equal(isFullRun({}), true, 'the nightly');
  assert.equal(isFullRun({ only: [] }), true, 'an empty list is no list, as the route and the job read it');
  assert.equal(isFullRun({ only: ['short'], bookId: 'b' }), false, 'Fix on one chapter');
  assert.equal(isFullRun({ only: ['solver'] }), false, 'Reset the solver');
  assert.equal(isFullRun({ only: ['solver', 'count', 'failures', 'short', 'gaps'], now: true }), false,
    'Fix all issues names its steps, so it is scoped however many it names');
});

test('a run is its chip, or its steps sorted, so one plan pressed twice is one kind', async () => {
  const { kindOf } = await import('../src/lib/repairRuns');
  assert.equal(kindOf({}), 'full');
  assert.equal(kindOf({ only: ['short'], bookId: 'b' }), 'fix_short');
  assert.equal(kindOf({ only: ['gaps'], seriesId: 's' }), 'fill');
  assert.equal(kindOf({ only: ['failures'], sourceId: 'x' }), 'retry');
  assert.equal(kindOf({ only: ['short'] }), 'steps:short', 'the card-level Fix all is not the one-row Fix');
  assert.equal(kindOf({ only: ['gaps', 'failures', 'solver'], now: true }), 'steps:failures+gaps+solver:now');
  assert.equal(kindOf({ only: ['solver', 'gaps', 'failures'], now: true }), kindOf({ only: ['failures', 'solver', 'gaps'], now: true }),
    'the order a client listed the steps in is not a different kind');
  assert.equal(kindOf({ only: ['failures'] }), 'steps:failures');
  assert.notEqual(kindOf({ only: ['failures'], now: true }), kindOf({ only: ['failures'] }),
    'everything-now and the nightly reset are different amounts of work');
});

test('a run that cannot download a chapter does not turn the Library ring', async () => {
  // Reintroduce by answering true for every run: the solver reset lights the ring again.
  const { canDownload } = await import('../src/lib/repairRuns');
  assert.equal(canDownload({}), true, 'the nightly downloads');
  for (const only of [['short'], ['gaps'], ['groups'], ['solver', 'gaps']]) assert.equal(canDownload({ only }), true, only.join('+'));
  for (const only of [['solver'], ['count'], ['names'], ['directions'], ['solver', 'count']]) {
    assert.equal(canDownload({ only }), false, `${only.join('+')} only resets, counts or reads`);
  }
  assert.equal(canDownload({ only: ['failures'] }), false, 'the nightly failures step only resets ledger rows');
  assert.equal(canDownload({ only: ['failures'], sourceId: 'x' }), true, 'Retry now re-checks, and downloads');
  assert.equal(canDownload({ only: ['failures'], now: true }), true, 'so does everything-now');
});

test('the typical time is the median, and an even count averages the middle two', async () => {
  const { median } = await import('../src/lib/repairRuns');
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5, 'sorted first');
  assert.equal(median([1, 2, 3, 10]), 3, 'one slow run does not drag "usually" with it');
});
