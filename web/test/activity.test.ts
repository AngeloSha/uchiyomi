// When a group's activity is a picture and when it is a sentence, and what colour its dot is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityStatus, seriesFinished, weeksOf } from '../lib/activity';
import type { Cadence } from '../lib/types';

const c = (over: Partial<Cadence> = {}): Cadence => ({ kind: 'weekly', intervalDays: 7, daysSince: 3, quiet: false, ...over });
const iso = new Date().toISOString();

test('a group with a recent release is active; the same group gone quiet is quiet', () => {
  assert.equal(activityStatus({ cadence: c(), lastReleaseAt: iso }, 'Ongoing'), 'active');
  assert.equal(activityStatus({ cadence: c({ quiet: true, daysSince: 60 }), lastReleaseAt: iso }, 'Ongoing'), 'quiet');
});

test('quiet on a finished series is done, not a warning', () => {
  // Reintroduce by dropping the seriesFinished branch in activityStatus: every group of every completed
  // title in the library gets an amber dot, which is most of a library.
  assert.equal(activityStatus({ cadence: c({ quiet: true }), lastReleaseAt: iso }, 'Completed'), 'done');
  assert.equal(activityStatus({ cadence: c({ quiet: true }), lastReleaseAt: iso }, 'ended'), 'done');
  assert.ok(seriesFinished('Cancelled'));
  assert.ok(!seriesFinished('Ongoing'));
  assert.ok(!seriesFinished(null));
});

test('no dated release at all is unknown', () => {
  assert.equal(activityStatus({ cadence: c({ kind: 'unknown', intervalDays: null, daysSince: null }), lastReleaseAt: null }), 'unknown');
});

test('the strip is drawn only when the server sent twelve weeks with something in them', () => {
  // Reintroduce by returning `w` whenever it is an array: a group silent for twelve weeks draws twelve empty
  // squares instead of "last release {ago}".
  assert.equal(weeksOf({}), null);
  assert.equal(weeksOf({ weeks: [true, false] }), null);
  assert.equal(weeksOf({ weeks: Array(12).fill(false) }), null);
  const w = Array(12).fill(false); w[11] = true; w[4] = true;
  assert.deepEqual(weeksOf({ weeks: w }), w);
});
