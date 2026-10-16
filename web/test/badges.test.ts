// The profile's badges say what they take (#267 parts 1 and 2, CheetahDoesStuff): lib/badges.ts and BadgesCard. Each badge
// is a goal on one measure, its key says the goal and where the reader stands, the next one always says so, and the rest
// wait behind Show locked, nearest first. Part 3 (avatar rewards) is not built.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BADGES, badgeCaption, badgeEarned, badgeGoalText, lockedBadges } from '../lib/badges';
import { BadgesCard, type Stats } from '../components/ProfileYou';

(globalThis as any).React = React;

const stats = (chapters: number, best: number): Stats => ({
  chapters_completed: chapters, longestStreak: best, series_touched: 1, last_read_at: null, byDay: [], currentStreak: 0, weekChapters: 0, weeklyGoal: 0,
});
const byLabel = (l: string) => BADGES.find((b) => b.label === l)!;

test('every badge is a goal on one measure, and its words say the goal', () => {
  // The thresholds the badges always had (they were bare test() functions until #267).
  assert.deepEqual(BADGES.map((b) => [b.label, b.kind, b.goal]), [
    ['Reader', 'chapters', 10], ['Bookworm', 'chapters', 50], ['On a roll', 'streak', 7],
    ['Centurion', 'chapters', 100], ['Devoted', 'streak', 30], ['Legend', 'chapters', 500],
  ]);
  assert.equal(badgeGoalText(byLabel('Bookworm')), 'Read 50 chapters');
  assert.equal(badgeGoalText(byLabel('On a roll')), '7 day streak', 'a streak in the words the hero says one in');
  assert.equal(badgeGoalText({ emoji: '1', label: 'Reader', kind: 'chapters', goal: 1 }), 'Read 1 chapter');
  const s = stats(40, 3);
  assert.equal(badgeCaption(byLabel('Bookworm'), s), 'Read 50 chapters · you have 40');
  assert.equal(badgeCaption(byLabel('On a roll'), s), '7 day streak · your best is 3');
  assert.equal(badgeCaption(byLabel('Reader'), s), 'Read 10 chapters · Earned');
  // Earned at exactly the goal, not one past it.
  assert.equal(badgeEarned(byLabel('Reader'), stats(10, 0)), true);
  assert.equal(badgeEarned(byLabel('Reader'), stats(9, 0)), false);
});

test('the badges still to earn come nearest first, a chapter goal and a streak goal compared by the share done', () => {
  // 18 of 50 chapters (36%) against 3 of 7 days (43%): the streak is nearer. Reintroduce the ladder's order: Bookworm first.
  assert.deepEqual(lockedBadges(stats(18, 3)).map((b) => b.label), ['On a roll', 'Bookworm', 'Centurion', 'Devoted', 'Legend']);
  assert.deepEqual(lockedBadges(stats(40, 3)).map((b) => b.label), ['Bookworm', 'On a roll', 'Centurion', 'Devoted', 'Legend']);
  // A tie keeps the ladder's order: nothing read yet is 0% of everything.
  assert.deepEqual(lockedBadges(stats(0, 0)).map((b) => b.label), BADGES.map((b) => b.label));
  assert.deepEqual(lockedBadges(stats(600, 40)), []);
});

test('the card: the earned badges and the next as squared keys, the next one\'s goal said, the rest behind Show locked', () => {
  const html = renderToStaticMarkup(createElement(BadgesCard, { stats: stats(40, 3) }));
  // Earned: Reader. Next: Bookworm, with where the reader stands. The other four are not drawn until asked for.
  const drawn = [...html.matchAll(/data-badge="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(drawn, ['Reader', 'Bookworm'], 'more than the earned badges and the next are drawn by default');
  assert.match(html, /data-badge-caption[^>]*>Next: Bookworm · Read 50 chapters · you have 40</);
  assert.match(html, /40\/50/, 'the next badge carries its progress');
  assert.match(html, /<button[^>]*aria-pressed="false"[^>]*data-badges-locked/, 'Show locked is not a key, off by default');
  // Every badge is a key (a tap shows its caption on a phone, where nothing hovers), squared: statuses, not filters.
  for (const m of html.matchAll(/<(\w+)[^>]*data-badge="[^"]+"[^>]*>/g)) {
    assert.equal(m[1], 'button', 'a badge is not a key');
    assert.match(m[0], /rounded-lg/);
    assert.doesNotMatch(m[0], /rounded-full/, 'a badge is a capsule again');
  }
  // Everything earned: no next, no Show locked, and the line says so.
  const all = renderToStaticMarkup(createElement(BadgesCard, { stats: stats(600, 40) }));
  assert.match(all, /data-badge-caption[^>]*>Every badge earned</);
  assert.doesNotMatch(all, /data-badges-locked/);
  // One badge left: Show locked would show nothing new.
  assert.doesNotMatch(renderToStaticMarkup(createElement(BadgesCard, { stats: stats(600, 7) })), /data-badges-locked/);
});
