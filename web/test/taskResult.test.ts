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
