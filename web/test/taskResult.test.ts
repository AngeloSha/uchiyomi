// What a background task's last run says in Admin.
//
// This moved out of app/admin/page.tsx to be testable at all: it is the only part of that 2000-line file
// with real branching, and every branch exists because of a run that reported nothing useful.
//
// The rule the extension branch inherits: a check that could not read the repositories is NOT a quiet check.
// Rendering "0 updated" for it repeats, one layer up, exactly the bug the extension monitor was built to
// fix -- a stale or unreadable catalogue looking identical to an up-to-date one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskResult } from '../lib/tasks';

test('no result at all renders nothing, rather than a stray separator', () => {
  assert.equal(taskResult(null), '');
  assert.equal(taskResult(undefined), '');
  assert.equal(taskResult({}), '');
});

test('a chapter sweep distinguishes a quiet week from a broken one', () => {
  // Reintroduce by dropping the healthy === false branch: both lines below become "+0 chapters".
  assert.equal(taskResult({ added: 12, healthy: true }), ' · +12 chapters');
  const broken = taskResult({ added: 0, healthy: false, failed: 9, chapterFailures: 3 });
  assert.match(broken, /9 series did not answer/);
  assert.match(broken, /3 chapters could not be saved/);
  assert.notEqual(broken, ' · +0 chapters');
});

test('the read-chapter cleanup is not mistaken for a backup', () => {
  // ⚠️ Both results carry `bytes`. The cleanup branch has to come first, or "12 chapters deleted, 4 MB
  // freed" renders as an archive size and the only number that matters -- how many files were destroyed --
  // disappears from the panel entirely.
  const r = taskResult({ deleted: 12, bytes: 4194304, remaining: 0, failed: 0, ms: 40 });
  assert.match(r, /12 chapters deleted/);
  assert.match(r, /4(\.0)? ?MB freed/i);
});

test('a cleanup run that could not look says why, instead of reporting nothing deleted', () => {
  // A read-only download volume is a permissions problem on somebody's NAS. Rendering it as "0 chapters
  // deleted" is how it goes unnoticed for a month.
  assert.match(taskResult({ deleted: 0, bytes: 0, skipped: 'read_only' }), /not writable/);
  assert.match(taskResult({ deleted: 0, bytes: 0, skipped: 'shutdown' }), /restart/);
  assert.match(taskResult({ deleted: 3, bytes: 9, failed: 2 }), /2 could not be deleted/);
});

test('a cleanup that stopped at a missing folder says the volume is missing, not that deletes failed', () => {
  // Reintroduce by dropping the `stopped === 'unmounted'` line: the line below reads only "3 could not be
  // deleted", which sends the admin to chmod a folder that is not there.
  const r = taskResult({ deleted: 2, bytes: 9, failed: 3, stopped: 'unmounted' });
  assert.match(r, /2 chapters deleted/);
  assert.match(r, /3 could not be deleted/);
  assert.match(r, /volume mounted/, 'the unmounted stop is named');
  assert.doesNotMatch(taskResult({ deleted: 2, bytes: 9, failed: 0 }), /mounted/, 'a run that did not stop says nothing about volumes');
});

test('a verify run that skipped an unmounted folder says so, first, instead of reading as none missing', () => {
  // Every chapter under a skipped root is still claiming bytes, and "0 missing" is exactly what the admin
  // would conclude the task had found. Reintroduce by dropping the `unmounted` line: the first result below
  // reads "4,000 checked, none missing" with /library-dl never mentioned.
  const r = taskResult({ checked: 4000, missing: 0, unmounted: ['/library-dl'] });
  assert.match(r, /4000 checked/);
  assert.match(r, /unmounted/, 'the skipped root is named as unmounted');
  assert.match(r, /\/library-dl/);
  // ⚠️ And it comes FIRST. The task is detached, so this line is where its result lives, and on a phone a
  // 900 px line shows its first clause and nothing after: with the warning last, a run that skipped the
  // whole download root read "4000 checked, 312 missing, marked…" -- a clean run. Reintroduce by pushing
  // the unmounted clause after the counts: the index below is greater.
  const both = taskResult({ checked: 4000, missing: 312, unmounted: ['/library-dl'] });
  assert.ok(both.indexOf('unmounted') < both.indexOf('4000 checked'), `the unmounted warning must lead the line: ${both}`);
  assert.equal(both, ' · one folder looked unmounted and was left alone: /library-dl, 4000 checked, 312 missing, marked for the next sweep');
  assert.match(taskResult({ checked: 12, missing: 3, unmounted: [] }), /3 missing, marked for the next sweep/);
  assert.doesNotMatch(taskResult({ checked: 12, missing: 0, unmounted: [] }), /unmounted/, 'a run that skipped nothing says nothing about volumes');
});

test('a verify run that found read-library files gone says so, without claiming to have marked them', () => {
  // The read library is not Uchiyomi's to re-fetch (a re-fetch lands under the download folder, on a new
  // row), so the task counts those and leaves them alone -- and must say so, or "12 checked, none missing"
  // over a read library with three files gone reads as "the read library is fine". Reintroduce by dropping
  // the `readLibraryMissing` line.
  const r = taskResult({ checked: 12, missing: 0, readLibraryMissing: 3, unmounted: [] });
  assert.match(r, /none missing/);
  assert.match(r, /3 missing in the read library, not marked/);
  assert.doesNotMatch(taskResult({ checked: 12, missing: 0, readLibraryMissing: 0, unmounted: [] }), /read library/, 'nothing missing there says nothing about it');
});

test('a backup that measured nothing says so instead of showing a contented size', () => {
  assert.match(taskResult({ bytes: 1048576 }), /1(\.0)? ?MB/i);
  assert.match(taskResult({ bytes: 0, sizeUnknown: true }), /size unknown/);
  assert.match(taskResult({ bytes: 5, configEmpty: true }), /config not captured/);
});

test('an extension check that could not read the repositories says that, not "0 updated"', () => {
  // Reintroduce by removing the !r.refreshed branch: an unreachable extension server reports a clean run.
  const r = taskResult({ refreshed: false, refreshError: 'suwayomi 502' });
  assert.match(r, /could not read the repositories/);
  assert.match(r, /502/);
  assert.ok(!/updated/.test(r), 'a failed refresh must not claim an update count');
});

test('an extension check reports what it did, including what it deliberately did not do', () => {
  assert.equal(taskResult({ refreshed: true, autoUpdate: true, updated: [{ name: 'A' }, { name: 'B' }], failed: [] }),
    ' · 2 updated');

  const off = taskResult({ refreshed: true, autoUpdate: false, updated: [], failed: [], updatesAvailable: ['A', 'B'] });
  assert.match(off, /2 waiting \(auto-update off\)/, 'the kill switch has to be visible, or it looks broken');

  const messy = taskResult({
    refreshed: true, autoUpdate: true, updated: [{ name: 'A' }],
    failed: [{ name: 'B', reason: '404' }], obsolete: ['C'], reinstalled: ['D'], deferred: true,
  });
  assert.match(messy, /1 updated/);
  assert.match(messy, /1 failed/);
  assert.match(messy, /1 obsolete/);
  assert.match(messy, /1 reinstalled/);
  assert.match(messy, /waiting for the library sweep/);
});

test('a quiet extension check does not claim things are waiting when auto-update is on', () => {
  const r = taskResult({ refreshed: true, autoUpdate: true, updated: [], failed: [], updatesAvailable: [], obsolete: [] });
  assert.equal(r, ' · 0 updated');
});

// ---- the nightly repair (v0.41.0) ----

test('a repair reports all five sections, with the backlog it has not reached yet', () => {
  // `uncounted` is the point of the count step: 30,625 chapter files on the owner's server have never
  // been opened, so the first weeks of nightly runs are a drain and "2000 stamped" alone reads as a job
  // that has finished. Reintroduce by dropping the `r.uncounted` clause: the line below claims the count
  // is done on the night it stamped its first 2000 of 30,625.
  const r = taskResult({
    counted: 2000, uncounted: 28625,
    short: { looked: 20, replaced: 3, confirmed: 5, left: 12 },
    gaps: { series: 5, followed: 2, fetched: 9, unfillable: 1, sweep: 0 },
    failures: { reset: 41 },
    solver: { reset: true, unblocked: 4, expired: 0 },
  });
  assert.equal(r, ' · 2000 page counts stamped, 28625 still to count · short: 3 replaced, 5 confirmed, 12 left'
    + ' · gaps: 5 series, 2 followed, 9 chapters fetched · 41 failures reset · solver reset, 4 unblocked');
});

test('a repair counts in singulars when the count is one', () => {
  // "1 page counts stamped · 1 chapters fetched · 1 failures reset" is the line this prevents.
  const r = taskResult({
    counted: 1, uncounted: 0,
    short: { looked: 1, replaced: 0, confirmed: 0, left: 0 },
    gaps: { series: 1, followed: 0, fetched: 1, unfillable: 0, sweep: 0 },
    failures: { reset: 1 },
    solver: { reset: false, unblocked: 0, expired: 1 },
  });
  assert.equal(r, ' · 1 page count stamped · short: 0 replaced, 0 confirmed · gaps: 1 series, 0 followed, 1 chapter fetched'
    + ' · 1 failure reset · solver: nothing to reset, 1 old block cleared');
});

test('a repair started from a Health chip reports only the step it was asked for', () => {
  // ⚠️ A chip sends `only: ['short']` (or one of the other four). Rendering the whole line for it would
  // say "0 page counts stamped · gaps: 0 series" about work that was never asked for -- which reads as a
  // repair that found nothing to do, the exact failure every branch in this file exists to prevent.
  // Reintroduce by dropping the `ran()` gate: both lines below grow three sections of zeroes.
  const solver = taskResult({
    counted: 0, uncounted: 0, only: ['solver'],
    short: { looked: 0, replaced: 0, confirmed: 0, left: 0 },
    gaps: { series: 0, followed: 0, fetched: 0, unfillable: 0, sweep: 0 },
    failures: { reset: 0 }, solver: { reset: false, unblocked: 0, expired: 0 },
  });
  assert.equal(solver, ' · solver: nothing to reset', `a solver-only run said: ${solver}`);
  const short = taskResult({
    counted: 0, uncounted: 0, only: ['short'],
    short: { looked: 1, replaced: 1, confirmed: 0, left: 0 },
    gaps: { series: 0, followed: 0, fetched: 0, unfillable: 0, sweep: 0 },
    failures: { reset: 0 }, solver: { reset: false, unblocked: 0, expired: 0 },
  });
  assert.equal(short, ' · short: 1 replaced, 0 confirmed');
});

test('a Retry now says what the re-check did, not just what it reset', () => {
  // `failures.retried` is written only by a run against ONE source -- the "Retry now" chip on a failing
  // source in Health -- and it is the half the admin pressed the chip for. With only the reset count, a
  // run that re-checked three series and landed two chapters read "4 failures reset": the same line as a
  // nightly that reset four rows and did nothing else, which is the failure every branch in this file
  // exists to prevent. Reintroduce by dropping the `retried` block from lib/tasks.ts.
  const r = taskResult({
    counted: 0, uncounted: 0, only: ['failures'],
    failures: { reset: 4, retried: { series: 3, added: 2, failed: 0 } },
  });
  assert.equal(r, ' · 4 failures reset · 3 series re-checked, 2 chapters added');
  // ⚠️ And a re-check in which every chapter failed again is not a quiet success. Reintroduce by pushing
  // the bare sentence unconditionally: the line below stops at "0 chapters added".
  const still = taskResult({
    counted: 0, uncounted: 0, only: ['failures'],
    failures: { reset: 1, retried: { series: 1, added: 0, failed: 5 } },
  });
  assert.equal(still, ' · 1 failure reset · 1 series re-checked, 0 chapters added, 5 still could not be saved');
  // One chapter is "chapter", and a nightly (no `retried`) says nothing about a re-check it never ran.
  assert.match(taskResult({ counted: 0, only: ['failures'], failures: { reset: 2, retried: { series: 1, added: 1, failed: 0 } } }), /1 chapter added/);
  assert.equal(taskResult({ counted: 0, only: ['failures'], failures: { reset: 7 } }), ' · 7 failures reset');
});

test('a repair that stopped early says so before its counts', () => {
  // The numbers after a stop are partial, and on a phone a clause at the end of a long line is the clause
  // that is off the edge -- the same lesson the verify branch above carries. Reintroduce by pushing the
  // stop clause after the sections: the index assertion below fails.
  const r = taskResult({
    counted: 120, uncounted: 4, stopped: 'shutdown',
    short: { looked: 0, replaced: 0, confirmed: 0, left: 0 },
    gaps: { series: 0, followed: 0, fetched: 0, unfillable: 0, sweep: 0 },
    failures: { reset: 0 }, solver: { reset: false, unblocked: 0, expired: 0 },
  });
  assert.ok(r.indexOf('stopped for a restart') < r.indexOf('120 page counts'), `the stop must lead the line: ${r}`);
  const disk = taskResult({
    counted: 0, uncounted: 900, stopped: 'disk', only: ['count'],
  });
  assert.equal(disk, ' · stopped: the download disk is at its floor · 0 page counts stamped, 900 still to count');
});

test('a repair that is switched off says so, instead of five empty sections', () => {
  // The nightly tick honours the Settings switch and returns without doing anything. Rendering its result
  // as "0 page counts stamped · short: 0 replaced…" would read as a repair that ran and found nothing.
  // Reintroduce by dropping the `skipped === 'disabled'` line.
  assert.equal(taskResult({ counted: 0, skipped: 'disabled' }), ' · switched off');
});

test('the repair branch is read before the verify branch', () => {
  // ⚠️ Both results are counts of files. `counted` is the repair and `checked` is Verify chapter files,
  // and a repair result that also carried a `checked` key would render as a verify run with none of its
  // own numbers. Reintroduce by moving the repair branch below the verify one: this reads "99 checked".
  const r = taskResult({ counted: 5, uncounted: 0, checked: 99, missing: 0, unmounted: [] });
  assert.match(r, /5 page counts stamped/);
  assert.doesNotMatch(r, /checked/, 'a repair result was rendered as a verify run');
});

test('group upgrades say what they did when switched on, and nothing when off (#81)', () => {
  const base = {
    counted: 0, uncounted: 0,
    short: { looked: 0, replaced: 0, confirmed: 0, left: 0 },
    gaps: { series: 0, followed: 0, fetched: 0, unfillable: 0, sweep: 0 },
    failures: { reset: 0 }, solver: { reset: false, unblocked: 0, expired: 0 },
  };
  // Off is the default, and "groups: off" on every night's line would be noise about a feature nobody chose.
  assert.doesNotMatch(taskResult({ ...base, groups: { off: true, looked: 0, replaced: 0, left: 0 } }), /groups/);
  // A result from before v0.47.0 has no `groups` at all.
  assert.doesNotMatch(taskResult(base), /groups/);
  assert.match(taskResult({ ...base, groups: { looked: 3, replaced: 2, left: 1 } }), / · groups: 2 replaced, 1 left/);
  assert.equal(taskResult({ counted: 0, uncounted: 0, only: ['groups'], groups: { looked: 1, replaced: 1, left: 0 } }), ' · groups: 1 replaced');
  // A cancelled run (the download pill, #82) leads with it, like the other stops.
  assert.match(taskResult({ ...base, stopped: 'cancelled' }), /^ · cancelled · /);
});

test('the repair says when it learned reading directions, and a directions-only run always answers', () => {
  // #102. Quiet most nights once a library has been through it, so the nightly line only grows a clause when
  // something was learned -- but a run that asked for nothing else must not render an empty line.
  const base = { counted: 0, uncounted: 0, short: {}, gaps: {}, failures: { reset: 0 }, solver: {} };
  assert.match(taskResult({ ...base, directions: { asked: 40, learned: 3 } }), /3 reading directions learned/);
  assert.doesNotMatch(taskResult({ ...base, directions: { asked: 40, learned: 0 } }), /reading direction/);
  assert.equal(taskResult({ ...base, only: ['directions'], directions: { asked: 2, learned: 0 } }), ' · 0 reading directions learned');
  assert.equal(taskResult({ ...base, only: ['directions'], directions: { asked: 1, learned: 1 } }), ' · 1 reading direction learned');
});
