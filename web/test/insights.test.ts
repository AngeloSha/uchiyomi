// Profile → Insights (lib/insights.ts, components/ProfileInsights.tsx; from @Squeaks72's #249, reduced): the figures, the
// cards drawn from one answer, and what #249 had that stays out because the Reading studio and Wrapped already show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  backlogRows, funnel, hasInsights, mixRows, projections, unreadOf, waitingRows, DROP_AFTER_DAYS,
  type InsightSeries, type InsightsPayload,
} from '../lib/insights';
import { InsightCards } from '../components/ProfileInsights';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as any).React = React;

const NOW = Date.parse('2026-10-14T12:00:00Z'); // a Wednesday
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();
const S = (o: Partial<InsightSeries>): InsightSeries => ({
  id: 'a', title: 'A', source: 'Src', genres: [], total: 10, read: 5, lastReadAt: ago(3), recent: 0, thisMonth: 0, prevMonth: 0, ...o,
});
const payload = (o: Partial<InsightsPayload> = {}): InsightsPayload => ({ now: new Date(NOW).toISOString(), bestDay: null, bestWeek: null, series: [], ...o });

test('at this pace: unread over the last four weeks\' pace; needs a pace and chapters left; far-off ones are left out', () => {
  const p = projections([
    S({ id: 'soon', title: 'Soon', total: 20, read: 10, recent: 28 }), // a chapter a day: 10 days
    S({ id: 'idle', title: 'Idle', recent: 0 }),
    S({ id: 'done', title: 'Done', total: 5, read: 5, recent: 5 }),
    S({ id: 'unstarted', title: 'Unstarted', read: 0, recent: 2 }),
    S({ id: 'far', title: 'Far', total: 5000, read: 1, recent: 1 }),
    S({ id: 'later', title: 'Later', total: 30, read: 10, recent: 14 }), // 20 / 0.5 = 40 days
  ], NOW);
  assert.deepEqual(p.map((x) => x.id), ['soon', 'later']);
  assert.deepEqual([p[0].days, p[0].date, p[0].unread], [10, '2026-10-24', 10]);
  assert.equal(p[1].days, 40);
});

test('mix: this month\'s share by genre (a chapter counts toward each genre) and by source, with the change since last month', () => {
  const series = [
    S({ id: '1', source: 'X', genres: ['Action', 'Drama'], thisMonth: 6, prevMonth: 2 }),
    S({ id: '2', source: 'Y', genres: ['Action', ' Action '], thisMonth: 4, prevMonth: 8 }),
    S({ id: '3', source: 'Y', genres: ['Comedy'], thisMonth: 0, prevMonth: 2 }),
  ];
  const g = mixRows(series, 'genre');
  assert.equal(g.total, 10);
  assert.deepEqual(g.rows.map((r) => [r.label, r.share, r.prevShare, r.deltaPts]), [['Action', 100, 83, 17], ['Drama', 60, 17, 43]],
    'a genre written twice on one series counts once');
  const src = mixRows(series, 'source');
  assert.deepEqual(src.rows.map((r) => [r.label, r.share, r.deltaPts]), [['X', 60, 43], ['Y', 40, -43]]);
  assert.equal(mixRows([S({ genres: ['Z'], thisMonth: 3, prevMonth: 0 })], 'genre').rows[0].deltaPts, null, 'a new genre is new, not a rise from zero');
  assert.deepEqual(mixRows([], 'genre'), { rows: [], total: 0 });
});

test('backlog: the unread chapters of the series begun, most unread first, and the ones waiting longest', () => {
  const series = [
    S({ id: 'big', title: 'Big', total: 100, read: 10, lastReadAt: ago(5) }),
    S({ id: 'old', title: 'Old', total: 12, read: 2, lastReadAt: ago(200) }),
    S({ id: 'done', title: 'Done', total: 3, read: 3 }),
    S({ id: 'unstarted', title: 'U', total: 9, read: 0 }),
    S({ id: 'over', title: 'Over', total: 3, read: 4 }), // read marks on chapters since removed: nothing unread, never negative
  ];
  assert.equal(unreadOf(series[4]), 0);
  const b = backlogRows(series);
  assert.deepEqual(b.rows.map((r) => r.id), ['big', 'old']);
  assert.deepEqual([b.totalUnread, b.seriesCount], [100, 2]);
  assert.deepEqual(waitingRows(series).map((r) => r.id), ['old', 'big']);
  assert.deepEqual(backlogRows([]), { rows: [], totalUnread: 0, seriesCount: 0 });
});

test('the series begun: finished, dropped (chapters left, nothing read in two months), still reading, and where they stop', () => {
  assert.equal(DROP_AFTER_DAYS, 60, 'the card says "two months": change both or neither');
  const f = funnel([
    S({ id: '1', total: 10, read: 10 }),
    S({ id: '2', total: 20, read: 4, lastReadAt: ago(90) }),
    S({ id: '3', total: 20, read: 8, lastReadAt: ago(100) }),
    S({ id: '4', total: 20, read: 6, lastReadAt: ago(60) }),
    S({ id: '5', total: 20, read: 2, lastReadAt: ago(59) }),
    S({ id: '6', total: 20, read: 0 }),
  ], NOW);
  assert.deepEqual({ s: f.started, f: f.finished, d: f.dropped, a: f.active, m: f.dropMedian, p: f.dropPct }, { s: 5, f: 1, d: 3, a: 1, m: 6, p: 30 });
  const none = funnel([], NOW);
  assert.deepEqual([none.started, none.dropMedian, none.dropPct], [0, null, null]);
});

test('a reader with nothing finished has no insight yet', () => {
  assert.equal(hasInsights(undefined), false);
  assert.equal(hasInsights(payload()), false);
  assert.equal(hasInsights(payload({ series: [S({ read: 0 })] })), false, 'a series opened and never finished');
  assert.equal(hasInsights(payload({ bestDay: { day: '2026-10-01', chapters: 1 } })), true);
});

test('the cards, drawn from one answer: finish dates, bests, the mix, the series begun, the backlog', () => {
  const html = renderToStaticMarkup(createElement(InsightCards, {
    data: payload({
      bestDay: { day: '2026-09-01', chapters: 119 },
      bestWeek: { start: '2026-08-03', chapters: 246 },
      series: [
        S({ id: 'p1', title: 'Pace One', total: 20, read: 10, recent: 28, genres: ['Action'], thisMonth: 4, prevMonth: 2 }),
        S({ id: 'b1', title: 'Backlog One', total: 90, read: 5, lastReadAt: ago(120), genres: ['Drama'], prevMonth: 2 }),
      ],
    }),
  }));
  for (const id of ['pace', 'bests', 'mix', 'funnel', 'backlog']) assert.match(html, new RegExp(`data-insight="${id}"`), id);
  assert.match(html, /Pace One<\/span><span[^>]*>Oct 24 · 10 chapters left</, 'the finish date and the chapters left');
  assert.match(html, /119 chapters/);
  assert.match(html, /246 chapters/);
  assert.match(html, /week of Aug 3, 2026/);
  // (next/link drops the trailing slash outside the app; the app's own config keeps it.)
  assert.match(html, /href="\/series\/?\?id=b1"/, 'a backlog row opens its series');
  assert.match(html, /85 unread/);
  // The series begun, counted once above the bars of what became of them (no bar for "started": it is always all of them).
  assert.match(html, /data-insight="funnel"[\s\S]*?>2 series<\/p>/);
  assert.doesNotMatch(html, /Started reading/);
  assert.match(html, /Last read Jun 16, 2026/, 'waiting the longest says when it was last read');
  // #249's cards that the Studio and Wrapped already have stay out: the hours, the weekdays, the year in review, Wrapped's link.
  assert.doesNotMatch(html, /When you read|Year in review|By hour|Open your Wrapped|wrapped/);
  // The share and its change: a signed number kept in order in Arabic by an isolate.
  assert.match(html, /100% · ⁦\+50⁩/);
});

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('Insights is its own page, from one request keyed on Show 18+, and the Studio\'s heatmap writes no numbers', () => {
  const page = read('app/profile/page.tsx');
  assert.match(page, /summary: tr\('What your reading adds up to'\), tile: <ActivityBars days=\{stats\?\.byDay \?\? \[\]\} \/>, pane: <ProfileInsights \/> \}/, 'the Insights page does not draw the insights');
  const board = page.slice(page.indexOf('function YouBoard('), page.indexOf('function FootRows('));
  assert.ok(board.length > 100, 'YouBoard is not where this test looks');
  assert.doesNotMatch(board, /Insight/, 'the insights are on the You page, which they made twice as long');
  const src = read('components/ProfileInsights.tsx');
  assert.match(src, /queryKey: \['stats-insights', shown\]/, 'the answer is not keyed on Show 18+, whose series it names');
  assert.match(src, /api<InsightsPayload>\('\/api\/stats\/insights'\)/);
  // #249 wrote each day's count on the heatmap: 3-7 px glyphs on a phone. Reintroduce a <text> per cell: this fails.
  assert.doesNotMatch(read('components/charts/Heatmap.tsx'), /data-day-count|numbers\??:/);
});
