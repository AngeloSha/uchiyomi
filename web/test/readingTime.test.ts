// Reading time in words and where it shows (v0.61.0): the amounts, the pace, the catch-up estimate, the Reading
// Studio's tiles, hours and devices, the series page's line and Wrapped's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catchUpText, hoursText, perChapterText } from '../lib/readingTime';
import { deviceRows } from '../components/ProfileYou';
import { setActiveDict } from '../lib/i18n';
import { setActiveLocale } from '../lib/format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('an amount of reading: minutes to five under an hour, one decimal under ten hours, whole hours above, never days', () => {
  // Reintroduce durationText ("1 day 3 hr"): 27 hours reads as a day. Reintroduce exact minutes: "23 min".
  setActiveLocale('en');
  assert.equal(hoursText(0), '0 min');
  assert.equal(hoursText(40_000), '5 min', 'anything read is at least five minutes');
  assert.equal(hoursText(23 * MIN), '25 min');
  assert.equal(hoursText(58 * MIN), '1 hr', 'fifty-eight minutes rounds to the hour, not to "60 min"');
  assert.equal(hoursText(4.46 * HOUR), '4.5 hr');
  assert.equal(hoursText(2 * HOUR), '2 hr');
  assert.equal(hoursText(27 * HOUR), '27 hr', 'never a day');
  assert.equal(hoursText(312.4 * HOUR), '312 hr');
});

test('in another language through Intl\'s own units', () => {
  setActiveLocale('de');
  try {
    assert.equal(hoursText(4.46 * HOUR), '4,5 Std.');
    assert.equal(hoursText(25 * MIN), '25 Min.');
  } finally { setActiveLocale('en'); }
});

test('a pace per chapter, and nothing without one', () => {
  setActiveLocale('en');
  assert.equal(perChapterText(6.2 * MIN), '~6 min per chapter');
  assert.equal(perChapterText(44_000), '~45 sec per chapter');
  assert.equal(perChapterText(null), '');
  assert.equal(perChapterText(0), '');
  setActiveDict({ '~{time} per chapter': '1 話あたり約 {time}' });
  setActiveLocale('ja');
  try { assert.equal(perChapterText(6 * MIN), '1 話あたり約 6 分'); } finally { setActiveDict({}); setActiveLocale('en'); }
});

test('catch up: only with something read, something left and a pace', () => {
  // Reintroduce without the read test: a series never opened says "Catch up in ~3 hr" from someone else's pace.
  setActiveLocale('en');
  assert.equal(catchUpText({ read: 3, unread: 20, perChapterMs: 6 * MIN }), 'Catch up in ~2 hr');
  assert.equal(catchUpText({ read: 0, unread: 20, perChapterMs: 6 * MIN }), '', 'never opened');
  assert.equal(catchUpText({ read: 3, unread: 0, perChapterMs: 6 * MIN }), '', 'caught up');
  assert.equal(catchUpText({ read: 3, unread: 20, perChapterMs: null }), '', 'no pace yet');
});

test('the devices: one row per name as the sessions say it, unnamed ones as "Device", most time first', () => {
  // Bars keys its rows by label: two "Device" rows would collide, and say nothing anyway.
  setActiveLocale('en');
  assert.deepEqual(deviceRows([{ name: 'iPhone', ms: 2 * HOUR }, { name: null, ms: 10 * MIN }, { name: 'SSO', ms: 5 * MIN }, { name: 'This PC', ms: 3 * HOUR }]),
    [{ label: 'This PC', value: 3 * HOUR, hint: '3 hr' }, { label: 'iPhone', value: 2 * HOUR, hint: '2 hr' }, { label: 'Device', value: 15 * MIN, hint: '15 min' }]);
});

test('the Reading Studio: three squared tiles, the pace and its note, then By hour and Devices after By weekday', () => {
  const src = code(read('components/ProfileYou.tsx'));
  // Its own key and endpoint, the window's and the reader's timezone in it (queryKeys.test.ts holds keys to endpoints).
  assert.match(src, /queryKey: \['stats-time', days, tz\],\s*queryFn: \(\) => api<ReadingTime>\(`\/api\/stats\/time\?days=\$\{days\}&tz=\$\{encodeURIComponent\(tz\)\}`\)/);
  // The count line after the tiles: All time's view (#265) says the same count before them, on its own.
  const start = src.indexOf('<div data-studio-time>');
  const block = src.slice(start, src.indexOf("{bookCountText(data?.windowChapters ?? total)}", start));
  assert.match(block, /\{ label: tr\('Last 7 days'\), \.\.\.time\.week \},\s*\{ label: tr\('Last 30 days'\), \.\.\.time\.month \},\s*\{ label: String\(time\.year\.year\), \.\.\.time\.year \},/);
  assert.match(block, /className="grid grid-cols-3 gap-2"/);
  assert.match(block, /rounded-xl border/, 'the tiles are squared');
  assert.match(block, /\{hoursText\(tile\.ms\)\}[\s\S]*\{bookCountText\(tile\.chapters\)\}/);
  assert.match(block, /perChapterText\(time\.window\.perChapterMs\)/);
  assert.match(block, /tr\('Counted from page turns; long pauses are left out\.'\)/, 'the note that these are estimates is gone');
  const weekday = src.indexOf("tr('By weekday')");
  assert.ok(weekday > 0 && src.indexOf("tr('By hour')") > weekday && src.indexOf("tr('Devices')") > src.indexOf("tr('By hour')"), 'By hour and Devices follow By weekday');
  assert.match(src, /<Columns values=\{time\.window\.byHour\} \/>/);
  assert.match(src, /<Bars items=\{devices\} wideHint \/>/);
});

test('the Reading Studio counts each finished chapter once over its heatmap, as the server counts it (#264)', () => {
  // The heatmap's days add a chapter read again on another day twice; the count above it is the server's own, once.
  // Reintroduce by printing the sum: this finds `bookCountText(total)` again.
  const src = code(read('components/ProfileYou.tsx'));
  assert.match(src, /\{bookCountText\(data\?\.windowChapters \?\? total\)\}/);
  assert.doesNotMatch(src, /\{bookCountText\(total\)\}/);
});

test('the series page puts "Catch up in" first on its outlook line, asking for a pace only when it can say one', () => {
  const page = code(read('app/series/page.tsx'));
  assert.match(page, /queryKey: \['reading-pace', id\],\s*queryFn: \(\) => api<[^>]*>\(`\/api\/series\/\$\{id\}\/reading-pace`\),\s*enabled: !!id && readCount\.read > 0 && unreadCount > 0,/);
  assert.match(page, /const outlook = \[\s*catchUpText\(\{ read: readCount\.read, unread: unreadCount, perChapterMs: pace\?\.perChapterMs \}\),\s*radarText\(series\?\.yomi\?\.radar, \{ autoUpdate: series\?\.autoUpdate !== false \}\),\s*\]\.filter\(Boolean\)\.join\(' · '\);/);
});

test('Wrapped says the year\'s time once, still, and its hours', () => {
  const page = code(read('app/wrapped/page.tsx'));
  // Reintroduce a CountUp around it: the owner asked for nothing new to animate.
  assert.match(page, /\{timeLine && <p data-wrapped-time className="[^"]*">\{timeLine\}<\/p>\}/);
  assert.match(page, /tr\('\{time\} of reading', \{ time: hoursText\(data\.ms\) \}\), perChapterText\(data\.perChapterMs\)/);
  assert.doesNotMatch(page, /<CountUp to=\{data\??\.ms/);
  assert.match(page, /tz=\$\{encodeURIComponent\(tz\)\}/, 'the hours are not the reader\'s');
  assert.match(page, /<Columns values=\{data!\.byHour!\} \/>/);
});

test('the hours chart: twenty-four columns in a flex row that mirrors by itself, nothing animated', () => {
  const src = read('components/charts/Columns.tsx');
  assert.match(src, /className="flex h-16 items-end gap-0\.5"/);
  assert.doesNotMatch(src, /\b(?:ml|mr|pl|pr|left|right)-[\w[]|rounded-full|transition|animate-|framer-motion|reverse\(/);
  for (const f of ['lib/readingTime.ts']) assert.doesNotMatch(read(f), /\b(?:ml|mr|pl|pr|left|right)-[\w[]|rounded-full/);
});
