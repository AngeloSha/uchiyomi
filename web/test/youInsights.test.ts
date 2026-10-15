// The You page's insight sections (lib/insights.ts and components/you/): the figures, and that the cards are wired up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  weeklyCounts, paceVsAverage, projections, streakStats, mixRows, backlogRows, neglectedRows, funnel, yearReview, peakIndex, hasInsights,
  type InsightSeries, type InsightsPayload,
} from '../lib/insights';

const NOW = Date.parse('2026-10-14T12:00:00Z'); // a Wednesday
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW - d * DAY).toISOString().slice(0, 10);
const S = (o: Partial<InsightSeries>): InsightSeries => ({ id: 'a', title: 'A', source: 'Src', genres: [], total: 10, read: 5, lastReadAt: new Date(NOW - 3 * DAY).toISOString(), recent: 0, thisMonth: 0, prevMonth: 0, ...o });

test('weekly buckets end today, oldest first', () => {
  const w = weeklyCounts([[ago(0), 2], [ago(6), 1], [ago(7), 4], [ago(60), 9]], NOW, 4);
  assert.deepEqual(w, [0, 0, 4, 3]);
});

test('pace: this week against the average of earlier weeks, not counting weeks before the first read', () => {
  const daily: [string, number][] = [[ago(0), 6], [ago(8), 2], [ago(15), 4]];
  const p = paceVsAverage(daily, NOW, 8);
  assert.equal(p.thisWeek, 6);
  assert.equal(p.weeks, 2, 'only the two weeks since the first read');
  assert.equal(p.average, 3);
  assert.equal(p.deltaPct, 100);
  const fresh = paceVsAverage([[ago(1), 3]], NOW, 8);
  assert.equal(fresh.weeks, 0);
  assert.equal(fresh.deltaPct, null);
  assert.equal(paceVsAverage([], NOW).thisWeek, 0);
});

test('projection: unread over the last 28 days\' pace; needs a pace and chapters left; far-off ones are left out', () => {
  const p = projections([
    S({ id: 'soon', title: 'Soon', total: 20, read: 10, recent: 28 }),   // 1/day -> 10 days
    S({ id: 'idle', title: 'Idle', recent: 0 }),
    S({ id: 'done', title: 'Done', total: 5, read: 5, recent: 5 }),
    S({ id: 'far', title: 'Far', total: 5000, read: 1, recent: 1 }),
    S({ id: 'later', title: 'Later', total: 30, read: 10, recent: 14 }), // 20 / 0.5 = 40 days
  ], NOW);
  assert.deepEqual(p.map((x) => x.id), ['soon', 'later']);
  assert.equal(p[0].days, 10);
  assert.equal(p[0].date, '2026-10-24');
});

test('streaks: current anchored on today or yesterday, longest, best day and best week', () => {
  const s = streakStats([[ago(1), 1], [ago(2), 5], [ago(3), 1], [ago(10), 1], [ago(11), 1]], NOW);
  assert.equal(s.current, 3);
  assert.equal(s.longest, 3);
  assert.deepEqual(s.bestDay, { day: ago(2), n: 5 });
  assert.ok(s.bestWeek && s.bestWeek.n >= 5);
  assert.equal(new Date(`${s.bestWeek!.start}T00:00:00Z`).getUTCDay(), 1, 'weeks start on Monday');
  const gap = streakStats([[ago(2), 1]], NOW);
  assert.equal(gap.current, 0);
  assert.deepEqual(streakStats([], NOW), { current: 0, longest: 0, bestDay: null, bestWeek: null });
});

test('hour / weekday peak', () => {
  assert.equal(peakIndex([0, 0, 0]), -1);
  assert.equal(peakIndex([1, 4, 2]), 1);
});

test('mix: share of this month by genre (a chapter counts toward each genre) and by source, with the change since last month', () => {
  const series = [
    S({ id: '1', source: 'X', genres: ['Action', 'Drama'], thisMonth: 6, prevMonth: 2 }),
    S({ id: '2', source: 'Y', genres: ['Action'], thisMonth: 4, prevMonth: 8 }),
    S({ id: '3', source: 'Y', genres: ['Comedy'], thisMonth: 0, prevMonth: 2 }),
  ];
  const g = mixRows(series, 'genre');
  assert.equal(g.total, 10);
  assert.deepEqual(g.rows.map((r) => [r.label, r.share, r.prevShare, r.deltaPts]), [['Action', 100, 83, 17], ['Drama', 60, 17, 43]]);
  const src = mixRows(series, 'source');
  assert.deepEqual(src.rows.map((r) => [r.label, r.share, r.deltaPts]), [['X', 60, 43], ['Y', 40, -43]]);
  assert.equal(mixRows([S({ genres: ['Z'], thisMonth: 3, prevMonth: 0 })], 'genre').rows[0].deltaPts, null, 'a new genre is new, not a rise from zero');
  assert.deepEqual(mixRows([], 'genre'), { rows: [], total: 0 });
});

test('backlog: unread per started series, and the longest neglected', () => {
  const series = [
    S({ id: 'big', title: 'Big', total: 100, read: 10, lastReadAt: new Date(NOW - 5 * DAY).toISOString() }),
    S({ id: 'old', title: 'Old', total: 12, read: 2, lastReadAt: new Date(NOW - 200 * DAY).toISOString() }),
    S({ id: 'done', title: 'Done', total: 3, read: 3 }),
    S({ id: 'unstarted', title: 'U', total: 9, read: 0 }),
  ];
  const b = backlogRows(series, NOW);
  assert.deepEqual(b.rows.map((r) => r.id), ['big', 'old']);
  assert.equal(b.totalUnread, 100);
  assert.equal(b.seriesCount, 2);
  const n = neglectedRows(series, NOW);
  assert.equal(n[0].id, 'old');
  assert.equal(n[0].idleDays, 200);
  assert.deepEqual(backlogRows([], NOW), { rows: [], totalUnread: 0, seriesCount: 0 });
});

test('funnel: started, finished, dropped (idle with chapters left), still reading, and the typical drop-off', () => {
  const idle = (d: number) => new Date(NOW - d * DAY).toISOString();
  const f = funnel([
    S({ id: '1', total: 10, read: 10 }),
    S({ id: '2', total: 20, read: 4, lastReadAt: idle(90) }),
    S({ id: '3', total: 20, read: 8, lastReadAt: idle(100) }),
    S({ id: '4', total: 20, read: 6, lastReadAt: idle(100) }),
    S({ id: '5', total: 20, read: 2, lastReadAt: idle(2) }),
    S({ id: '6', total: 20, read: 0 }),
  ], NOW);
  assert.deepEqual({ s: f.started, f: f.finished, d: f.dropped, a: f.active, m: f.dropMedian }, { s: 5, f: 1, d: 3, a: 1, m: 6 });
  assert.equal(f.dropPct, 30);
  const none = funnel([], NOW);
  assert.deepEqual([none.started, none.dropMedian, none.dropPct], [0, null, null]);
});

test('year review: months, same-period comparison, and an empty year', () => {
  const y = yearReview([['2026-01-05', 3], ['2026-10-01', 2], ['2025-01-05', 4], ['2025-10-20', 9], ['2025-10-01', 1], ['2024-05-01', 50]], NOW);
  assert.equal(y.year, 2026);
  assert.equal(y.thisTotal, 5);
  assert.equal(y.thisYear[0], 3);
  assert.equal(y.lastTotal, 14);
  assert.equal(y.lastSamePeriod, 5, 'last year up to 14 October');
  assert.equal(y.deltaPct, 0);
  const e = yearReview([], NOW);
  assert.deepEqual([e.thisTotal, e.lastTotal, e.deltaPct], [0, 0, null]);
});

test('a new account has nothing to show', () => {
  const p: InsightsPayload = { tz: 'UTC', now: new Date(NOW).toISOString(), daily: [], byHour: Array(24).fill(0), byWeekday: Array(7).fill(0), series: [] };
  assert.equal(hasInsights(p), false);
  assert.equal(hasInsights(undefined), false);
  assert.equal(hasInsights({ ...p, daily: [['2026-10-01', 1]] }), true);
});

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('the You tab renders the seven cards from one request, keyed on the 18+ switch', () => {
  const page = read('app/profile/page.tsx');
  assert.match(page, /<YouInsights \/>/);
  assert.match(page, /import \{ YouInsights \} from '@\/components\/you\/YouInsights'/);
  const y = read('components/you/YouInsights.tsx');
  assert.match(y, /\/api\/stats\/insights/);
  assert.match(y, /adultShown\(\)/);
  for (const c of ['ReadingPace', 'Streaks', 'WhenYouRead', 'CompletionFunnel', 'MixShare', 'BacklogHealth', 'YearInReview']) {
    assert.ok(readdirSync(join(__dirname, '../components/you')).includes(`${c}.tsx`), c);
    assert.match(y, new RegExp(`<${c} data=`));
  }
  assert.match(read('components/you/YearInReview.tsx'), /href="\/wrapped\/"/);
});

test('the insight cards leave the heatmap alone', () => {
  for (const f of readdirSync(join(__dirname, '../components/you'))) assert.doesNotMatch(read(`components/you/${f}`), /Heatmap/);
});
