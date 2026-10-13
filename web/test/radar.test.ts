// The release radar in words (v0.61.0, lib/radar.ts): where a series stands against its estimate, the line the series
// page and the reader's end card say, the note a Releasing soon card says, and the end card's label.
//
// Pure: the clock is a parameter. CI runs in UTC, but the two midnight cases below are built in LOCAL time, so the file
// also passes on a machine set to another time zone (it failed on a Europe/Berlin host: 23:30Z is 01:30 there).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approxDay, byExpected, dayText, radarNote, radarParts, radarState, radarText } from '../lib/radar';
import { endLabel, endLine } from '../components/ReaderEndRadar';
import { setActiveDict } from '../lib/i18n';
import { setActiveLocale } from '../lib/format';
import type { SeriesRadar } from '../lib/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Monday 12 October 2026, noon UTC. */
const NOW = Date.parse('2026-10-12T12:00:00Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
/** A weekly radar whose next chapter is `next` days away. */
const radar = (next: number | null, over: Partial<SeriesRadar> = {}): SeriesRadar => ({
  nextAt: next == null ? null : at(next), dueUntil: next == null ? null : at(next + 3.5), quietAfter: at((next ?? 0) + 14),
  lastAt: at((next ?? 0) - 7), every: 7, kind: 'weekly', steady: false, ended: false, basis: 'source', ...over,
});

test('where a series stands: expected, due, late, quiet, ended, none', () => {
  // Reintroduce by reading "late" from nextAt alone (no dueUntil): a chapter an hour past its estimate reads late.
  assert.equal(radarState(radar(4), NOW), 'expected');
  assert.equal(radarState(radar(-0.04), NOW), 'due', 'an hour past the estimate is "any day"');
  assert.equal(radarState(radar(-5), NOW), 'late');
  assert.equal(radarState(radar(-20), NOW), 'quiet', 'past quietAfter it is no longer late');
  assert.equal(radarState(radar(4, { ended: true }), NOW), 'ended');
  assert.equal(radarState(radar(null), NOW), 'none', 'no estimate (hiatus, uneven, too few)');
  assert.equal(radarState(null, NOW), 'none');
  assert.equal(radarState(undefined, NOW), 'none', 'a server older than v0.61.0');
});

test('the days: today, tomorrow, a weekday within the week, a date beyond it', () => {
  setActiveLocale('en');
  assert.equal(dayText(NOW + 2 * HOUR, NOW), 'today');
  assert.equal(dayText(NOW + DAY, NOW), 'tomorrow');
  assert.equal(dayText(NOW + 4 * DAY, NOW), 'Friday');
  assert.equal(dayText(NOW + 4 * DAY, NOW, 'short'), 'Fri');
  assert.equal(dayText(NOW + 12 * DAY, NOW), 'Oct 24');
  // Local days, not 24-hour spans: 23:30 is still today, and half past midnight is tomorrow.
  assert.equal(dayText(new Date(2026, 9, 12, 23, 30).getTime(), NOW), 'today');
  assert.equal(dayText(new Date(2026, 9, 13, 0, 30).getTime(), NOW), 'tomorrow');
});

test('the line: next chapter, its weekday or its rhythm; due any day; running late', () => {
  setActiveLocale('en');
  // Reintroduce by saying a date ("Next chapter Friday"): the "~" is gone -- the owner's rule is that an estimate always
  // says it is one.
  assert.equal(radarText(radar(4, { steady: true }), { now: NOW }), 'Next chapter ~Friday · usually Fridays');
  assert.equal(radarText(radar(4), { now: NOW }), 'Next chapter ~Friday · ships weekly', 'no weekday of its own: its rhythm');
  assert.equal(radarText(radar(1, { kind: 'daily', every: 1 }), { now: NOW }), 'Next chapter ~tomorrow · ships daily');
  assert.equal(radarText(radar(-1), { now: NOW }), 'Next chapter due any day');
  assert.match(radarText(radar(-5), { now: NOW }), /^Running late · last release /);
  assert.deepEqual(radarParts(radar(-5, { lastAt: null }), { now: NOW }), ['Running late']);
  // Nothing for a quiet, ended, undated or unmonitored series.
  for (const r of [radar(-20), radar(4, { ended: true }), radar(null), null]) assert.equal(radarText(r, { now: NOW }), '');
  assert.equal(radarText(radar(4), { now: NOW, autoUpdate: false }), '', 'nothing fetches it, so nothing is coming');
  // "usually" is the estimate's own weekday in the reader's zone (the server moved the estimate onto it).
  assert.equal(radarParts(radar(5, { steady: true }), { now: NOW })[1], 'usually Saturdays');
});

test('in Japanese the estimate is the day with 頃 after it', () => {
  // '~{day}' is a key of its own because not every language puts the mark before the day. Reintroduce a hard-coded
  // `~${day}`: this reads "次の話は~金曜日".
  setActiveLocale('ja');
  setActiveDict({ '~{day}': '{day}頃', 'Next chapter {when}': '次の話は{when}', 'usually Fridays': 'たいてい金曜日', 'ships weekly': '毎週更新' });
  try {
    assert.equal(approxDay(NOW + 4 * DAY, NOW), '金曜日頃');
    assert.equal(radarText(radar(4, { steady: true }), { now: NOW }), '次の話は金曜日頃 · たいてい金曜日');
    assert.equal(radarText(radar(1), { now: NOW }), '次の話は明日頃 · 毎週更新');
  } finally {
    setActiveDict({});
    setActiveLocale('en');
  }
});

test('a Releasing soon card says ~Fri, Due or Running late, and nothing without an estimate', () => {
  setActiveLocale('en');
  assert.equal(radarNote(radar(4), { now: NOW }), '~Fri');
  assert.equal(radarNote(radar(0.1), { now: NOW }), '~today');
  assert.equal(radarNote(radar(-1), { now: NOW }), 'Due');
  assert.equal(radarNote(radar(-5), { now: NOW }), 'Running late');
  assert.equal(radarNote(radar(-20), { now: NOW }), null);
  assert.equal(radarNote(radar(null), { now: NOW }), null);
  assert.equal(radarNote(radar(4), { now: NOW, autoUpdate: false }), null);
});

test('Expected this week keeps the soonest first, and a series without an estimate last', () => {
  const s = (id: string, next: number | null) => ({ id, yomi: { radar: next == null ? null : radar(next) } });
  assert.deepEqual([s('c', 3), s('none', null), s('a', -2), s('b', 1)].sort(byExpected).map((x) => x.id), ['a', 'b', 'c', 'none']);
});

test('the end card: caught up while more is on the way, finished otherwise', () => {
  // Reintroduce "You finished" for every series: a reader who caught up with a weekly series is told it is over.
  const series = (r: SeriesRadar | null, missing: number | null = 0) => ({ yomi: { favorite: false, rating: null, radar: r }, source: missing == null ? null : { missing, chapters: 10, checkedAt: at(-1) } });
  assert.equal(endLabel(series(radar(4))), 'You’re all caught up');
  assert.equal(endLabel(series(radar(-20))), 'You’re all caught up', 'a quiet series is not finished either');
  assert.equal(endLabel(series(radar(4, { ended: true }))), 'You finished');
  assert.equal(endLabel(series(null)), 'You finished', 'nothing dates it: as before');
  assert.equal(endLabel(undefined), 'You finished', 'while the series loads');
  assert.equal(endLabel(series(radar(4), 3)), 'You finished', '"caught up" over 3 chapters not here yet');
  assert.equal(endLabel(series(radar(4), null)), 'You’re all caught up', 'a series with no source summary');
  // The line: what the sources list that is not here yet first, else the radar.
  assert.equal(endLine(series(radar(4), 3)), '3 not here yet');
  assert.equal(endLine(series(radar(4), 1)), '1 not here yet');
  // endLine reads the clock itself: a radar four days from the real now.
  const soon: SeriesRadar = { ...radar(4, { steady: true }), nextAt: new Date(Date.now() + 4 * DAY).toISOString(),
    dueUntil: new Date(Date.now() + 7 * DAY).toISOString(), quietAfter: new Date(Date.now() + 14 * DAY).toISOString() };
  assert.match(endLine(series(soon)), /^Next chapter ~\w+ · usually \w+$/);
  assert.equal(endLine(series(null, null)), '');
});

test('the new code draws no capsule, no physical side and no motion', () => {
  // The owner's rules for every new surface (RTL by logical properties, no pills, no new motion): the files this release
  // added for the radar. noPills.test.ts and lenisScrollers.test.ts hold them too.
  const ROOT = join(__dirname, '..');
  for (const f of ['lib/radar.ts', 'components/ReaderEndRadar.tsx']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\b(?:ml|mr|pl|pr|left|right)-[\w[]/, `${f}: a physical side`);
    assert.doesNotMatch(src, /rounded-full|framer-motion|<motion\.|animate-|transition/, `${f}: a capsule or motion`);
  }
});
