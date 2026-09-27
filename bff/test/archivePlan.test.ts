// The slow archive's decisions that need no database (#117, lib/archivePlan.ts), and the ghost reason it gives
// the series page (lib/seriesListing.ts whyOf). What the scheduler does with them against a real Postgres --
// which chapter it starts, what it waits for, what survives a restart -- is archive.int.test.ts.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

import {
  directionFor, boundaryFor, globalWait, sourceWait, attentionOf, shownDone, rowsFor, STALLED_MS, DONE_SHOWN_MS,
  type SourceState,
} from '../src/lib/archivePlan';
import { inWindow } from '../src/lib/archivePace';

// seriesListing imports the database module, which refuses to load without DATABASE_URL: imported after it.
let whyOf: typeof import('../src/lib/seriesListing')['whyOf'];
let CAP: number;
before(async () => {
  ({ whyOf } = await import('../src/lib/seriesListing'));
  ({ CHAPTER_RETRY_CAP: CAP } = await import('../src/lib/updater'));
});

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

test('which way a series fills: up from nothing, down from a held top, up from a held start', () => {
  assert.equal(directionFor({ heldMin: null, listedMin: 1 }), 'up', "'Nothing yet': read from chapter one");
  assert.equal(directionFor({ heldMin: null, listedMin: null }), 'up', 'no listing yet: decided at the first pick, up until then');
  // The design's contradiction, settled: a Latest-2-of-200 add is floored at its lowest held number, so nothing
  // is held BELOW its boundary -- the literal rule said up; the reason (no interior hole) says down.
  // Reintroduce by answering 'up' whenever nothing is held below the boundary: this reads up.
  assert.equal(directionFor({ heldMin: 199, listedMin: 1 }), 'down', 'Latest-N grows down from its own edge');
  assert.equal(directionFor({ heldMin: 1, listedMin: 1 }), 'up', 'the start is held: carry on in reading order');
  assert.equal(directionFor({ heldMin: 3, listedMin: 1 }), 'down', 'a block that starts above the lowest listed number is grown from its edge');
});

test('the boundary: the floor when there is one, else a hair above the newest listed number', () => {
  assert.equal(boundaryFor({ floor: 6, listedMax: 10 }), 6);
  assert.equal(boundaryFor({ floor: null, listedMax: 10 }), 10.001);
  assert.equal(boundaryFor({ floor: null, listedMax: null }), null, 'no listing: placed at the first pick');
  const b = boundaryFor({ floor: null, listedMax: 10 })!;
  assert.ok(10 < b && b < 10.5, 'every listed number is below it, the next release (10.5, 11) is not');
});

const gw = (over: Partial<Parameters<typeof globalWait>[0]> = {}) => globalWait({
  stopping: false, paused: false, windowFrom: null, windowTo: null, hour: 12, now: NOW, inWindow,
  updating: false, repairing: false, checking: false, freeBytes: 100 * 2 ** 30, minFreeGb: 20, ...over,
});

test('the server-wide gates, each on its own, and none when all are clear', () => {
  assert.equal(gw(), null);
  assert.equal(gw({ stopping: true })?.why, 'stopping');
  assert.equal(gw({ paused: true })?.why, 'paused');
  assert.equal(gw({ windowFrom: 22, windowTo: 6 })?.why, 'window', 'noon is outside 22:00-06:00');
  assert.equal(gw({ windowFrom: 22, windowTo: 6, hour: 23 }), null, 'and 23:00 is inside it');
  assert.equal(gw({ updating: true })?.why, 'sweep');
  assert.equal(gw({ repairing: true })?.why, 'repair');
  // Reintroduce by dropping `checking` from globalWait: this reads null, and the archive meets the daily source
  // check on the very site it is pacing.
  assert.equal(gw({ checking: true })?.why, 'check');
  assert.equal(gw({ freeBytes: 5 * 2 ** 30 })?.why, 'disk', '5 GiB free under a 20 GiB floor');
  assert.equal(gw({ freeBytes: null }), null, 'a disk it cannot measure does not stop it (fail open, as the downloader)');
  assert.equal(gw({ freeBytes: 0, minFreeGb: 0 }), null, 'a floor of 0 is no floor');
  // The admin's pause outranks everything but a shutdown: it is the one a person set.
  assert.equal(gw({ paused: true, updating: true, freeBytes: 0 })?.why, 'paused');
  const w = gw({ windowFrom: 22, windowTo: 6, opensAt: () => NOW + 10 * 3600_000 });
  assert.equal(w?.until, NOW + 10 * 3600_000, 'a closed window says when it opens');
});

const idle: SourceState = {
  loaded: true, disabled: false, blockedUntil: null, gate: { active: 0, queued: 0 }, paceLevel: 0,
  nextAt: null, backoffUntil: null, inFlight: false,
};

test('the per-source gates: each on its own, and the more telling reason first', () => {
  assert.equal(sourceWait(idle, NOW), null);
  assert.equal(sourceWait({ ...idle, inFlight: true }, NOW)?.why, 'turn');
  assert.deepEqual(sourceWait({ ...idle, nextAt: NOW + 60_000 }, NOW), { why: 'break', until: NOW + 60_000 });
  assert.equal(sourceWait({ ...idle, nextAt: NOW - 1 }, NOW), null, 'a break that has run out is no reason');
  assert.deepEqual(sourceWait({ ...idle, backoffUntil: NOW + 3600_000 }, NOW), { why: 'backoff', until: NOW + 3600_000 });
  assert.equal(sourceWait({ ...idle, loaded: false }, NOW)?.why, 'source_missing');
  assert.equal(sourceWait({ ...idle, disabled: true }, NOW)?.why, 'disabled');
  assert.deepEqual(sourceWait({ ...idle, blockedUntil: NOW + 900_000 }, NOW), { why: 'cooldown', until: NOW + 900_000 });
  assert.equal(sourceWait({ ...idle, gate: { active: 1, queued: 0 } }, NOW)?.why, 'source_busy', "a person's Fetch on the site");
  assert.equal(sourceWait({ ...idle, gate: { active: 0, queued: 2 } }, NOW)?.why, 'source_busy', 'queued counts too');
  assert.equal(sourceWait({ ...idle, paceLevel: 1 }, NOW)?.why, 'pace');
  // A backoff and a break together: the backoff is the longer and says more.
  assert.equal(sourceWait({ ...idle, nextAt: NOW + 60_000, backoffUntil: NOW + 3600_000 }, NOW)?.why, 'backoff');
});

const att = (over: Partial<Parameters<typeof attentionOf>[0]> = {}) => attentionOf({
  state: 'queued', now: NOW, failed: 0, note: null, finishedAt: null, pausedAt: null, backoffLevel: 0,
  backoffSince: null, wait: null, waitSince: null, global: null, ...over,
});

test('what needs a person: a finish with gaps, a source that keeps refusing or has gone, a forgotten pause, the disk', () => {
  assert.equal(att(), null);
  assert.equal(att({ state: 'done', finishedAt: NOW }), null, 'a clean finish is not a problem');
  assert.deepEqual(att({ state: 'done', finishedAt: NOW, note: { capped: 1, held: 0, blocked: 0 } }), { why: 'finished_with_gaps', since: NOW });
  assert.equal(att({ state: 'done', finishedAt: NOW, failed: 2 })?.why, 'finished_with_gaps');
  assert.equal(att({ backoffLevel: 1 }), null, 'one refusal is one bad hour');
  assert.equal(att({ backoffLevel: 2, backoffSince: NOW - 1000 })?.why, 'backoff');
  assert.equal(att({ wait: { why: 'source_missing' }, waitSince: NOW - 5 })?.why, 'source_missing');
  assert.equal(att({ wait: { why: 'disabled' } })?.why, 'disabled');
  assert.equal(att({ wait: { why: 'break' } }), null, 'a break is the archive working');
  assert.equal(att({ global: { why: 'disk' } })?.why, 'disk');
  assert.equal(att({ state: 'paused', pausedAt: NOW - 3600_000 }), null);
  assert.equal(att({ state: 'paused', pausedAt: NOW - STALLED_MS })?.why, 'stalled', 'paused and forgotten hides the back catalogue');
});

test('a finished archive is shown for a day, or until dismissed when something was left behind', () => {
  assert.equal(shownDone({ state: 'queued', finishedAt: null, attention: null, now: NOW }), true);
  assert.equal(shownDone({ state: 'done', finishedAt: NOW - 1000, attention: null, now: NOW }), true);
  assert.equal(shownDone({ state: 'done', finishedAt: NOW - DONE_SHOWN_MS, attention: null, now: NOW }), false);
  assert.equal(shownDone({ state: 'done', finishedAt: NOW - 30 * DONE_SHOWN_MS, attention: { why: 'finished_with_gaps', since: 0 }, now: NOW }), true);
});

test("one viewer's rows out of everyone's: filtered per call, the enqueuer kept on the server", () => {
  const rows = [
    { seriesId: 'a', addedBy: 'me', title: 'A' },
    { seriesId: 'b', addedBy: 'other', title: 'B' },
    { seriesId: 'c', addedBy: null, title: 'C' },
  ];
  // Reintroduce by returning every row: the member reads B.
  const mine = rowsFor(rows, (id) => id !== 'b', 'me');
  assert.deepEqual(mine.map((r) => r.seriesId), ['a', 'c']);
  assert.deepEqual(mine.map((r) => r.mine), [true, false]);
  assert.ok(mine.every((r) => !('addedBy' in r)), 'who queued it never leaves the server');
  assert.deepEqual(rowsFor(rows, () => true, null).map((r) => r.mine), [false, false, false], 'nobody signed in owns nothing');
  // The shared rows are not touched: the next viewer gets the whole list to filter again.
  assert.equal(rows.length, 3);
  assert.equal(rows[0].addedBy, 'me');
});

test("the series page's reason for a number an active archive will fetch", () => {
  // Available, uncapped, below the boundary: on its way.
  assert.equal(whyOf('available', 3, null, 0, 10.001), 'archive');
  assert.equal(whyOf('available', 3, null, CAP - 1, 10.001), 'archive', 'failed once or twice is still the archive\'s to retry');
  // Reintroduce by testing the boundary after the cap (or dropping the cap from it): these read archive.
  assert.equal(whyOf('available', 3, null, CAP, 10.001), 'failed', 'a capped number keeps its own reason: the archive will not fetch it');
  assert.equal(whyOf('held', 3, null, 0, 10.001), 'held');
  assert.equal(whyOf('blocked', 3, null, 0, 10.001), 'blocked');
  // Below a Latest-N floor AND an archive: the archive's, not "older than where it was added".
  assert.equal(whyOf('available', 3, 6, 0, 6), 'archive');
  assert.equal(whyOf('available', 3, 6, 0, null), 'floor', 'no archive: the floor as before');
  assert.equal(whyOf('available', 11, null, 0, 10.001), 'missing', 'above the boundary is the sweep\'s');
  assert.equal(whyOf('available', 3, null, 0), 'missing', 'the four-argument call is unchanged');
});
