// The release radar's rules (v0.61.0, lib/releaseRadar.ts): which evidence dates a series, when an estimate is made at
// all, where it lands, and how often the smart update checks ask a series.
//
// No database: radarOf, releaseArrivals, checkEvery and isDue are functions over their arguments with the clock as a
// parameter, so every verdict here is pinned against fixed dates rather than the day the suite runs. The database
// wrapper and the routes are releaseRadar.int.test.ts and smartSweep.int.test.ts.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

// Imported after the environment is set: the module's database wrapper sits beside lib/env, which refuses to load
// without DATABASE_URL (nothing here connects).
let R: typeof import('../src/lib/releaseRadar');
let releaseStarts: typeof import('../src/lib/groupStats')['releaseStarts'];
before(async () => {
  R = await import('../src/lib/releaseRadar');
  ({ releaseStarts } = await import('../src/lib/groupStats'));
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A Monday, noon UTC. */
const NOW = Date.parse('2026-10-12T12:00:00Z');
const FRI = Date.parse('2026-10-09T15:00:00Z');   // the Friday before NOW, 15:00 UTC
const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
/** `n` dates `every` days apart, the newest `lastAgo` ms before NOW (or at `last`), oldest first. */
const run = (n: number, everyDays: number, last: number): number[] =>
  Array.from({ length: n }, (_, i) => last - (n - 1 - i) * everyDays * DAY);
const radar = (over: Partial<import('../src/lib/releaseRadar').RadarInput>) =>
  R.radarOf({ status: 'Ongoing', sourceDates: [], arrivals: [], ...over }, NOW);

test('the radar clusters releases exactly as the cadence does', () => {
  // The function cadenceOf walks, exported unchanged (groupStats.test.ts's batch tests are its guard).
  const drop = (t: number) => Array.from({ length: 10 }, (_, i) => t - i * 6 * 60_000);
  assert.deepEqual(releaseStarts([...drop(FRI), ...drop(FRI - 30 * DAY)]), [FRI - 54 * 60_000, FRI - 30 * DAY - 54 * 60_000]);
});

test('a series that ships every Friday is expected next Friday, and keeps its weekday', () => {
  // Eight Fridays at 15:00 UTC, the last three days before NOW. Reintroduce the weekday snap away (`nextAt = base`):
  // still Friday here; give the rhythm an interval that is not seven days -- the next test -- and it is not.
  const r = radar({ sourceDates: run(8, 7, FRI) })!;
  assert.equal(r.basis, 'source');
  assert.equal(r.kind, 'weekly');
  assert.equal(r.intervalDays, 7);
  assert.equal(r.steady, true, 'eight Fridays out of eight');
  assert.equal(iso(r.nextAt), '2026-10-16T15:00:00.000Z');
  assert.equal(new Date(r.nextAt!).getUTCDay(), 5);
  assert.equal(iso(r.dueUntil), '2026-10-20T03:00:00.000Z', 'half an interval of "any day" after the estimate');
  assert.equal(iso(r.quietAfter), '2026-10-30T15:00:00.000Z', 'three intervals after the last release');
  assert.equal(r.ended, false);
});

test('a steady weekday pulls a stretched interval back onto it', () => {
  // Fridays, with three weeks skipped among them: the median gap is longer than seven days (the skipped weeks), and the
  // estimate is the nearest Friday to "last release plus the interval" rather than the Monday that sum lands on.
  // Reintroduce by dropping ontoWeekday: nextAt reads a Monday.
  const dates = [FRI - 63 * DAY, FRI - 49 * DAY, FRI - 42 * DAY, FRI - 28 * DAY, FRI - 21 * DAY, FRI - 14 * DAY, FRI];
  const r = radar({ sourceDates: dates })!;
  assert.equal(r.steady, true);
  assert.equal(r.intervalDays, 10.5, 'the median of three one-week and three two-week gaps');
  assert.equal(new Date(r.nextAt!).getUTCDay(), 5, `next ${iso(r.nextAt)}`);
});

test('a weekly series that has no weekday of its own is still weekly, and not steady', () => {
  // Every seven days but at a different UTC weekday each time is impossible; every eight days walks the weekdays.
  const r = radar({ sourceDates: run(8, 8, FRI) })!;
  assert.equal(r.kind, 'weekly');
  assert.equal(r.steady, false);
  assert.equal(iso(r.nextAt), iso(FRI + 8 * DAY), 'the last release plus the interval, untouched');
});

test('ten chapters dropped in an hour, a month apart, ship monthly -- not daily', () => {
  // The arrival evidence of a group that dumps a month's work at once. Reintroduce raw timestamps for the rhythm
  // (no clustering): "daily", and an estimate of tomorrow.
  const drop = (t: number) => Array.from({ length: 10 }, (_, i) => t + i * 5 * 60_000);
  const arrivals = [...drop(FRI - 90 * DAY), ...drop(FRI - 60 * DAY), ...drop(FRI - 30 * DAY), ...drop(FRI)];
  const r = radar({ arrivals })!;
  assert.equal(r.basis, 'arrival');
  assert.equal(r.kind, 'monthly');
  assert.equal(r.intervalDays, 30);
  assert.equal(iso(r.nextAt), iso(FRI + 30 * DAY), 'a month after the last drop began');
  assert.equal(r.steady, false, 'thirty days walks the weekdays');
});

test('a re-downloaded old chapter is not a release', () => {
  // Chapters 1-5 arrived a week apart; chapter 3 was fetched again yesterday (a re-download, a fill, the slow archive),
  // and a range file 6-7 arrived last. Reintroduce by counting every row: yesterday reads as a release.
  const week = (n: number) => FRI - (5 - n) * 7 * DAY;
  const rows = [
    { at: week(1), top: 1 }, { at: week(2), top: 2 }, { at: week(3), top: 3 }, { at: week(4), top: 4 }, { at: week(5), top: 5 },
    { at: NOW - DAY, top: 3 },
    { at: NOW - 2 * HOUR, top: 7 },
  ];
  assert.deepEqual(R.releaseArrivals(rows), [week(1), week(2), week(3), week(4), week(5), NOW - 2 * HOUR]);
  // The order rows are handed in does not matter; a row with no time or number is not evidence.
  assert.deepEqual(R.releaseArrivals([...rows].reverse().concat([{ at: NaN, top: 9 }, { at: NOW, top: NaN }])),
    [week(1), week(2), week(3), week(4), week(5), NOW - 2 * HOUR]);
});

test('uneven gaps give no estimate', () => {
  // Gaps of 1, 1, 7, 15 and 20 days: the median says weekly, and only one gap in five is anywhere near it.
  // Reintroduce by estimating from any rhythm: a date is made up.
  let t = FRI;
  const dates = [t];
  for (const g of [1, 1, 7, 15, 20]) { t -= g * DAY; dates.push(t); }
  const r = radar({ sourceDates: dates })!;
  assert.equal(r.kind, 'weekly');
  assert.equal(r.nextAt, null);
  assert.equal(r.dueUntil, null);
  assert.equal(r.steady, false);
});

test('three releases give no estimate, but say when the last one was', () => {
  const r = radar({ sourceDates: run(3, 7, FRI) })!;
  assert.equal(r.kind, 'weekly');
  assert.equal(r.nextAt, null);
  assert.equal(iso(r.lastAt), iso(FRI));
  assert.equal(iso(r.quietAfter), iso(FRI + 21 * DAY));
});

test('an ended or paused series has no estimate', () => {
  // Reintroduce by dropping the status test: both read next Friday.
  for (const status of ['Completed', 'COMPLETED', 'Cancelled', 'Ended']) {
    const r = radar({ status, sourceDates: run(8, 7, FRI) })!;
    assert.equal(r.nextAt, null, status);
    assert.equal(r.ended, true, status);
  }
  const paused = radar({ status: 'On hiatus', sourceDates: run(8, 7, FRI) })!;
  assert.equal(paused.nextAt, null);
  assert.equal(paused.ended, false, 'a hiatus is not the end');
  assert.equal(radar({ status: null, sourceDates: run(8, 7, FRI) })!.nextAt !== null, true, 'a series that says nothing is running');
});

test('stale source dates: the arrivals win', () => {
  // The source dated a year of Fridays and then stopped dating; the chapters kept arriving every Tuesday. Reintroduce
  // by taking the source whenever it shows two releases: basis 'source', and a next chapter dated a year ago.
  const oldFri = FRI - 365 * DAY;
  const tue = Date.parse('2026-10-06T09:00:00Z');
  const r = radar({ sourceDates: run(8, 7, oldFri), arrivals: run(6, 7, tue) })!;
  assert.equal(r.basis, 'arrival');
  assert.equal(iso(r.lastAt), iso(tue));
  assert.equal(new Date(r.nextAt!).getUTCDay(), 2, 'a Tuesday');
  // Within two days the source still wins: it dates releases, the arrivals only when the sweep fetched them.
  const fresh = radar({ sourceDates: run(8, 7, FRI), arrivals: [FRI + 40 * HOUR] })!;
  assert.equal(fresh.basis, 'source');
  // No source date at all, or only one release of them: the arrivals.
  assert.equal(radar({ sourceDates: [FRI], arrivals: run(5, 7, FRI) })!.basis, 'arrival');
});

test('a date far ahead of the clock is dropped, one just ahead is taken as now', () => {
  // A site's scheduled post three days out is not a release; one stamped ten hours ahead (its timezone) is today's.
  // Reintroduce by taking every date: lastAt reads three days from now.
  const r = radar({ sourceDates: [...run(6, 7, FRI), NOW + 3 * DAY, NOW + 10 * HOUR] })!;
  assert.equal(iso(r.lastAt), iso(NOW), 'the near one, capped at now');
  const only = radar({ sourceDates: [NOW + 3 * DAY] });
  assert.equal(only, null, 'nothing but a far-future date dates nothing');
});

test('quiet after three intervals, a fortnight at least, or 45 days with no rhythm', () => {
  assert.equal(iso(radar({ sourceDates: run(8, 7, FRI) })!.quietAfter), iso(FRI + 21 * DAY));
  assert.equal(iso(radar({ sourceDates: run(8, 1, FRI) })!.quietAfter), iso(FRI + 14 * DAY), 'a daily series: the fortnight floor');
  const one = radar({ arrivals: [FRI] })!;
  assert.equal(one.basis, null);
  assert.equal(one.kind, 'unknown');
  assert.equal(one.nextAt, null);
  assert.equal(iso(one.quietAfter), iso(FRI + 45 * DAY));
  assert.equal(radar({}), null, 'no date at all is no radar');
});

/* ------------------------------------------------------------------------------------------- the smart checks */

const H = 6 * HOUR;
const base = { checkedAt: null, sourceMissing: 0, nextAt: null, dueUntil: null, lastAt: null, latestMtime: null, createdAt: null };
const quietYears = { ...base, lastAt: NOW - 3650 * DAY, latestMtime: NOW - 3650 * DAY, createdAt: NOW - 3650 * DAY };

test('a series quiet for ten years is still asked within three days', () => {
  // Reintroduce by dropping the cap: checkEvery reads 521 days and the series is never asked again in practice.
  assert.equal(R.checkEvery(quietYears, NOW, H), 72 * HOUR);
  assert.equal(R.isDue({ ...quietYears, checkedAt: NOW - 70 * HOUR }, NOW, H), true, 'asked at the sweep before the three days are up');
  assert.equal(R.isDue({ ...quietYears, checkedAt: NOW - 60 * HOUR }, NOW, H), false, 'and rested before');
});

test('an update interval past three days is the cap', () => {
  const week = 168 * HOUR;
  assert.equal(R.checkEvery(quietYears, NOW, week), week, 'never asked less often than the interval itself');
  assert.equal(R.isDue({ ...quietYears, checkedAt: NOW - week }, NOW, week), true, 'so every weekly sweep asks it');
  // And a seventh of the silence is the rule in between: three weeks quiet, asked every three days; one week, daily.
  assert.equal(R.checkEvery({ ...base, lastAt: NOW - 21 * DAY }, NOW, H), 72 * HOUR);
  assert.equal(R.checkEvery({ ...base, lastAt: NOW - 7 * DAY }, NOW, H), DAY);
  assert.equal(R.checkEvery({ ...base, lastAt: NOW - DAY, latestMtime: NOW - 30 * DAY }, NOW, H), H, 'a day quiet: every sweep');
});

test('while its next chapter is due a series is asked every sweep', () => {
  // From a day before the estimate until its "any day" runs out. Reintroduce by dropping the window: a series whose
  // weekly chapter is due today, quiet a week, is asked once a day instead.
  const due = { ...base, lastAt: NOW - 7 * DAY, nextAt: NOW + 12 * HOUR, dueUntil: NOW + 4 * DAY };
  assert.equal(R.checkEvery(due, NOW, H), H);
  assert.equal(R.checkEvery({ ...due, nextAt: NOW - 2 * DAY, dueUntil: NOW + HOUR }, NOW, H), H, 'any day');
  assert.equal(R.checkEvery({ ...due, nextAt: NOW + 2 * DAY, dueUntil: NOW + 5 * DAY }, NOW, H), DAY, 'not yet: a seventh of its silence');
  assert.equal(R.checkEvery({ ...due, nextAt: NOW - 5 * DAY, dueUntil: NOW - HOUR }, NOW, H), DAY, 'late: its silence again');
});

test('a series with chapters still to fetch is asked every sweep', () => {
  assert.equal(R.checkEvery({ ...quietYears, sourceMissing: 3 }, NOW, H), H);
});

test('a series never asked is due', () => {
  assert.equal(R.isDue(quietYears, NOW, H), true);
});

test('half an interval of slack', () => {
  // A six-hourly sweep that reached a series late in its run asked it five and a half hours before the next sweep.
  // Reintroduce without the slack: rested, and asked twelve hours apart instead of six.
  assert.equal(R.isDue({ ...base, lastAt: NOW - DAY, checkedAt: NOW - 5.5 * HOUR }, NOW, H), true);
  assert.equal(R.isDue({ ...base, lastAt: NOW - DAY, checkedAt: NOW - 2.5 * HOUR }, NOW, H), false, 'but not twice in one sweep');
});
