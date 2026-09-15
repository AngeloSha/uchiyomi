// Who scanlates a series: the pure aggregator behind the series page's panel, the admin's preference
// editor and the add dialog.
//
// No database: groupStats and cadenceOf are functions over their arguments, and the clock is a parameter,
// so every rhythm and every "quiet" verdict here is pinned against fixed dates rather than against the day
// the suite runs. The routes that feed it are groupsAndVersions.int.test.ts.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

// Imported after the environment is set: a static import is hoisted above these assignments, and the
// releases module this one imports sits beside lib/env, which refuses to load without DATABASE_URL.
let groupStats: typeof import('../src/lib/groupStats')['groupStats'];
let cadenceOf: typeof import('../src/lib/groupStats')['cadenceOf'];
let emptyGroupStat: typeof import('../src/lib/groupStats')['emptyGroupStat'];
before(async () => {
  ({ groupStats, cadenceOf, emptyGroupStat } = await import('../src/lib/groupStats'));
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-14T12:00:00Z');
/** `n` dates ending `lastAgoDays` ago, `everyDays` apart, newest last. */
const every = (everyDays: number, n: number, lastAgoDays = 0): number[] =>
  Array.from({ length: n }, (_, i) => NOW - lastAgoDays * DAY - (n - 1 - i) * everyDays * DAY);
const iso = (t: number) => new Date(t).toISOString();

test('cadence: one date per kind', async (t) => {
  await t.test('a chapter every day ships daily', () => {
    const c = cadenceOf(every(1, 6), NOW);
    assert.equal(c.kind, 'daily');
    assert.equal(c.intervalDays, 1);
    assert.equal(c.daysSince, 0);
  });
  await t.test('a chapter every seven days ships weekly', () => {
    const c = cadenceOf(every(7, 6), NOW);
    assert.equal(c.kind, 'weekly');
    assert.equal(c.intervalDays, 7);
  });
  await t.test('a chapter every thirty days ships monthly', () => {
    assert.equal(cadenceOf(every(30, 4), NOW).kind, 'monthly');
  });
  await t.test('a chapter every ninety days is irregular', () => {
    assert.equal(cadenceOf(every(90, 4), NOW).kind, 'irregular');
  });
  await t.test('one date is unknown, with no interval but with the days since', () => {
    const c = cadenceOf([NOW - 3 * DAY], NOW);
    assert.deepEqual(c, { kind: 'unknown', intervalDays: null, daysSince: 3, quiet: false });
  });
  await t.test('no date at all is unknown, and never quiet', () => {
    assert.deepEqual(cadenceOf([], NOW), { kind: 'unknown', intervalDays: null, daysSince: null, quiet: false });
  });
});

test('cadence: the median gap, not the mean, so one hiatus does not rewrite a weekly rhythm', () => {
  // Nine weekly releases and one ninety-day gap in the middle: the mean gap is over two weeks, the median
  // is still seven days.
  const dates = [...every(7, 5, 90 + 28), ...every(7, 5)];
  const c = cadenceOf(dates, NOW);
  assert.equal(c.kind, 'weekly', `interval ${c.intervalDays}`);
  assert.equal(c.intervalDays, 7);
});

test('cadence: only the last ten releases are judged', () => {
  // A group that shipped daily for a year and then one chapter a month for ten months ships monthly now.
  const old = every(1, 50, 400);
  const recent = every(30, 10);
  assert.equal(cadenceOf([...old, ...recent], NOW).kind, 'monthly');
});

/**
 * The rhythm is judged over RELEASES -- clusters of uploads less than half a day apart -- because groups
 * ship in batches. Reintroduce by windowing the raw timestamps (`valid.slice(0, CADENCE_WINDOW)`, gaps
 * divided by DAY_MS) in cadenceOf: the batch reads `daily` with an interval of 0 and, twenty days after
 * the drop, `quiet`; the pairs read `daily` because five of nine gaps are zero.
 */
test('ten chapters dropped in one hour a month apart ship monthly', () => {
  // Three monthly drops, each ten chapters six minutes apart; the last one twenty days ago.
  const drop = (agoDays: number) => Array.from({ length: 10 }, (_, i) => NOW - agoDays * DAY - i * 6 * 60_000);
  const c = cadenceOf([...drop(80), ...drop(50), ...drop(20)], NOW);
  assert.equal(c.kind, 'monthly', JSON.stringify(c));
  assert.equal(c.intervalDays, 30);
  assert.equal(c.daysSince, 20);
  assert.equal(c.quiet, false, 'twenty days is inside a monthly rhythm');
});

test('two chapters a week at a time still ships weekly', () => {
  const weekly = every(7, 5);
  const pairs = weekly.flatMap((t) => [t, t - 60_000]);
  const c = cadenceOf(pairs, NOW);
  assert.equal(c.kind, 'weekly', JSON.stringify(c));
  assert.equal(c.intervalDays, 7);
});

test('a batch that crosses midnight is one release', () => {
  // A US-evening upload: two chapters at 23:50 and 00:10 UTC, every week for five weeks. Bucketing by
  // calendar day counted two release days a week and read "daily". Reintroduce by replacing the cluster
  // walk in cadenceOf with `new Set(valid.map((t) => Math.floor(t / DAY_MS)))`: kind reads daily.
  const midnight = Math.floor(NOW / DAY) * DAY;   // a UTC midnight in the recent past
  const dates: number[] = [];
  for (let w = 1; w <= 5; w++) dates.push(midnight - w * 7 * DAY - 10 * 60_000, midnight - w * 7 * DAY + 10 * 60_000);
  const c = cadenceOf(dates, NOW);
  assert.equal(c.kind, 'weekly', JSON.stringify(c));
  assert.equal(c.intervalDays, 7);
});

test('a weekly group silent for six weeks is quiet', () => {
  // Reintroduce by replacing the quiet rule in cadenceOf with the 45-day fallback alone
  // (`daysSince > 45`): forty-two days of silence on a weekly group then reads not quiet. Dropping only
  // the `3 * intervalDays` (leaving the 14-day floor) is caught by "a monthly group silent for forty
  // days is not quiet" below, not by this one -- forty-two is over the floor either way.
  const c = cadenceOf(every(7, 6, 42), NOW);
  assert.equal(c.kind, 'weekly');
  assert.equal(c.daysSince, 42);
  assert.equal(c.quiet, true, 'six weeks is three times its own interval and then some');
});

test('a weekly group ten days silent is not quiet', () => {
  // Ten days is over one interval but inside the two-week floor: a late week is not a hiatus.
  const c = cadenceOf(every(7, 6, 10), NOW);
  assert.equal(c.daysSince, 10);
  assert.equal(c.quiet, false);
});

test('a monthly group silent for forty days is not quiet', () => {
  // Three of its own intervals is ninety days; forty is one late chapter. Reintroduce by dropping the
  // `3 * intervalDays` from the quiet rule in cadenceOf (leaving the 14-day floor): forty days is over
  // the floor, so this reads quiet.
  const c = cadenceOf(every(30, 4, 40), NOW);
  assert.equal(c.kind, 'monthly');
  assert.equal(c.quiet, false);
});

test('a daily group silent for two weeks is not quiet, but one silent for fifteen days is', () => {
  // Three days would be three intervals; the fortnight floor keeps a long weekend from reading as a hiatus.
  assert.equal(cadenceOf(every(1, 6, 14), NOW).quiet, false);
  assert.equal(cadenceOf(every(1, 6, 15), NOW).quiet, true);
});

test('a group with no rhythm is quiet after forty-five days', () => {
  assert.equal(cadenceOf([NOW - 45 * DAY], NOW).quiet, false);
  assert.equal(cadenceOf([NOW - 46 * DAY], NOW).quiet, true);
});

test('per group: releases, chapters, range, last release and languages', () => {
  const copies = [
    { number: 1, scanlator: 'Group A', publishedAt: iso(NOW - 21 * DAY), lang: 'en', source: 'pri' },
    { number: 2, scanlator: 'Group A', publishedAt: iso(NOW - 14 * DAY), lang: 'en', source: 'pri' },
    { number: 3, scanlator: 'Group A', publishedAt: iso(NOW - 7 * DAY), lang: 'en', source: 'pri' },
    { number: 3, scanlator: 'Group A', publishedAt: iso(NOW - 6 * DAY), lang: 'pt-br', source: 'fol' }, // the same number again, from a follower
    { number: 3, groups: ['Group B'], publishedAt: iso(NOW - 5 * DAY), lang: 'en', source: 'pri' },
    { number: 4, scanlator: 'Group B', publishedAt: null, lang: 'en', source: 'pri' },
    { number: 5, scanlator: '', source: 'pri' }, // names nobody: counted for nobody
  ];
  const stats = groupStats(copies, [], NOW);
  assert.deepEqual(stats.map((g) => g.name), ['Group A', 'Group B'], 'sorted by releases descending');
  const a = stats[0];
  assert.deepEqual(a.chapters, [1, 2, 3], 'chapter 3 is one chapter however many copies of it are listed');
  assert.deepEqual([a.first, a.last], [1, 3]);
  assert.equal(a.lastReleaseAt, iso(NOW - 7 * DAY), 'the earliest date for a number is its release; a re-upload is not a new one');
  assert.equal(a.cadence.kind, 'weekly');
  assert.deepEqual(a.langs, ['en', 'pt-br'], 'distinct, sorted');
  assert.equal(a.onDisk, 0);
  const b = stats[1];
  assert.equal(b.releases, 2);
  assert.deepEqual(b.chapters, [3, 4]);
  assert.equal(b.cadence.kind, 'unknown', 'one dated release of two');
  assert.equal(b.lastReleaseAt, iso(NOW - 5 * DAY));
});

test('the follower\'s duplicate is not a release', () => {
  // Four copies carry Group A -- two of them chapter 3, from the primary and a follower -- and the group
  // released three chapters. A series followed on two sources that both list a group's whole run would
  // otherwise report twice the chapters it has. Reintroduce by counting one per copy in groupStats: 4.
  const stats = groupStats([
    { number: 1, scanlator: 'Group A', source: 'pri' },
    { number: 2, scanlator: 'Group A', source: 'pri' },
    { number: 3, scanlator: 'Group A', source: 'pri' },
    { number: 3, scanlator: 'Group A', source: 'fol' },
  ], [], NOW);
  assert.equal(stats[0].releases, 3, 'three chapters, not four copies');
  assert.deepEqual(stats[0].chapters, [1, 2, 3]);
});

test('a joint release counts for each of its groups', () => {
  // As the release rules read a block: B's work as much as A's. One copy from a scraped site ("A & B") and
  // one from a structured source (groups array) both split.
  const stats = groupStats([
    { number: 1, scanlator: 'Group A & Group B', source: 'pri' },
    { number: 2, groups: ['Group A', 'Group B'], source: 'pri' },
    { number: 3, scanlator: 'Group A', source: 'pri' },
  ], [], NOW);
  const byName = Object.fromEntries(stats.map((g) => [g.name, g]));
  assert.equal(byName['Group A'].releases, 3);
  assert.equal(byName['Group B'].releases, 2);
  assert.deepEqual(byName['Group B'].chapters, [1, 2]);
});

test('the display name is the spelling on disk, else the first listed, and identity ignores case and punctuation', () => {
  const stats = groupStats([
    { number: 1, scanlator: 'asura-scans', source: 'pri' },
    { number: 2, scanlator: 'ASURA SCANS', source: 'pri' },
    { number: 3, scanlator: 'wish it', source: 'pri' },
    { number: 4, scanlator: 'WishIt', source: 'pri' },
  ], [{ number: 1, scanlator: 'Asura Scans' }], NOW);
  assert.deepEqual(stats.map((g) => g.name), ['Asura Scans', 'wish it']);
  assert.equal(stats[0].releases, 2, 'one group however it is spelt');
  assert.equal(stats[0].onDisk, 1);
});

test('onDisk is counted through the same joint-release split as the listing', () => {
  // A file stamped "Group A & Group B" is one chapter on disk for each of them; a file with no stamp is
  // nobody's; a group that is only on disk still gets a row.
  const stats = groupStats(
    [{ number: 1, scanlator: 'Group A', source: 'pri' }],
    [
      { number: 1, scanlator: 'Group A & Group B' },
      { number: 2, scanlator: 'Group A' },
      { number: 3, scanlator: null },
      { number: 4, scanlator: 'Old Group' },
    ],
    NOW,
  );
  const byName = Object.fromEntries(stats.map((g) => [g.name, g]));
  assert.equal(byName['Group A'].onDisk, 2);
  assert.equal(byName['Group B'].onDisk, 1);
  assert.equal(byName['Group B'].releases, 0);
  assert.deepEqual([byName['Old Group'].onDisk, byName['Old Group'].releases, byName['Old Group'].chapters], [1, 0, []]);
  assert.deepEqual(byName['Old Group'].cadence, { kind: 'unknown', intervalDays: null, daysSince: null, quiet: false });
});

test('a group nothing lists or holds is a row of zeros', () => {
  assert.deepEqual(emptyGroupStat('Vanished Group'), {
    name: 'Vanished Group', releases: 0, first: null, last: null, lastReleaseAt: null,
    cadence: { kind: 'unknown', intervalDays: null, daysSince: null, quiet: false },
    onDisk: 0, chapters: [], langs: [], weeks: Array(12).fill(false),
  });
});

/**
 * The activity strip: one flag per week for the last twelve, OLDEST FIRST, so the rightmost dot is this
 * week. Reintroduce by indexing from the oldest end in weeksOf (`weeks[w] = true` instead of
 * `weeks[WEEKS - 1 - w]`): "one and three weeks ago light indexes 10 and 8" reads indexes 1 and 3 set
 * instead. Reintroduce the fold by dropping the `Math.max(0, …)`: the future-dated release computes a
 * negative week, lands nowhere, and "a date just ahead of the clock counts as this week" reads false.
 */
test('weeks: twelve flags, newest last', async (t) => {
  await t.test('one and three weeks ago light indexes 10 and 8, twenty weeks ago is off the strip', () => {
    const stats = groupStats([
      { number: 1, scanlator: 'Group A', publishedAt: iso(NOW - 20 * 7 * DAY), source: 'pri' },
      { number: 2, scanlator: 'Group A', publishedAt: iso(NOW - 3 * 7 * DAY), source: 'pri' },
      { number: 3, scanlator: 'Group A', publishedAt: iso(NOW - 7 * DAY), source: 'pri' },
    ], [], NOW);
    const weeks = stats[0].weeks;
    assert.equal(weeks.length, 12, 'twelve weeks, always');
    const lit = weeks.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(lit, [8, 10], 'index 11 is this week, 10 is last week, 8 is three weeks ago; twenty weeks ago is past the strip');
  });
  await t.test('a date just ahead of the clock counts as this week', () => {
    const stats = groupStats([
      { number: 1, scanlator: 'Group A', publishedAt: iso(NOW + 2 * DAY), source: 'pri' },
    ], [], NOW);
    assert.equal(stats[0].weeks[11], true, 'folded into this week, not dropped');
    assert.equal(stats[0].weeks.filter(Boolean).length, 1);
  });
  await t.test('a group with no dated release has an empty strip', () => {
    const stats = groupStats([{ number: 1, scanlator: 'Group A', source: 'pri' }], [], NOW);
    assert.deepEqual(stats[0].weeks, Array(12).fill(false));
  });
});
