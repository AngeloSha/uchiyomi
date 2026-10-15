// Reading time from page turns (v0.61.0, lib/readingTime.ts): what counts, what is a break, what a sitting adds, and
// that two devices or a replayed turn never count twice.
//
// No database: readingTimeline and summarize are functions over the events, allowances and hours they are handed.
// The routes are readingTime.int.test.ts.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

let T: typeof import('../src/lib/readingTime');
before(async () => { T = await import('../src/lib/readingTime'); });

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-12T10:00:00Z');
let id = 0;
/** A turn `s` seconds after T0 on `book`, by `device`. */
const turn = (s: number, book = 'b1', o: { device?: string | null; series?: string; completed?: boolean } = {}) =>
  ({ id: ++id, at: T0 + s * SEC, bookId: book, seriesId: o.series ?? `s_${book}`, deviceId: o.device === undefined ? 'phone' : o.device, completed: !!o.completed });
const flat = () => T.allowanceFor(null);
const utc = (t: number) => new Date(t).getUTCHours();
const all = (tl: import('../src/lib/readingTime').Timeline) => T.summarize(tl, T0 - HOUR, T0 + 24 * HOUR, utc);

test('a page is read within five minutes; a strip may take longer, up to thirty', () => {
  assert.equal(T.allowanceFor(null), 5 * MIN, 'unknown: a page');
  assert.equal(T.allowanceFor(1.45), 5 * MIN, 'a manga page');
  assert.equal(T.allowanceFor(12), 15 * MIN, 'a strip three times taller than the tallest page');
  assert.equal(T.allowanceFor(80), 30 * MIN, 'never more than thirty');
  assert.equal(T.allowanceFor(Number.NaN), 5 * MIN);
});

test('gaps within the allowance count in full, and a sitting adds one typical page for the page it opened on', () => {
  // Turns at 0, 30 and 60 s: two counted gaps of 30 s, and the opening page priced as the window's median gap (30 s).
  // Reintroduce without the opening page: 60 s.
  const r = all(T.readingTimeline([turn(0), turn(30), turn(60)], flat));
  assert.equal(r.ms, 90 * SEC);
});

test('a long gap is a break, and counts nothing', () => {
  // A phone put down on a page for an hour is not an hour of reading, nor five minutes of it. Two sittings: each opens
  // with a typical page (the median counted gap, 40 s). Reintroduce clipping (count the allowance): 1 h reads 5 min.
  const r = all(T.readingTimeline([turn(0), turn(40), turn(40 + 3600), turn(40 + 3640)], flat));
  assert.equal(r.ms, 40 * SEC + 40 * SEC + 2 * 40 * SEC);
});

test('a tall strip read for twelve minutes counts twelve; a page left for twelve minutes counts nothing', () => {
  // Reintroduce one allowance for every chapter: the strip's twelve minutes read as a break.
  const ratio: Record<string, number> = { strip: 12, page: 1.4 };
  const allowance = (book: string) => T.allowanceFor(ratio[book]);
  const strip = T.readingTimeline([turn(0, 'strip'), turn(12 * 60, 'strip')], allowance);
  const page = T.readingTimeline([turn(0, 'page'), turn(12 * 60, 'page')], allowance);
  assert.deepEqual(strip.pieces.filter((p) => !p.opening).map((p) => p.ms), [12 * MIN]);
  assert.deepEqual(page.pieces.filter((p) => !p.opening).map((p) => p.ms), [], 'twelve minutes on a page is a break');
  assert.equal(page.pieces.filter((p) => p.opening).length, 2, 'and the next turn opens a sitting');
});

test('two devices at once count once', () => {
  // The phone and the PC both turning pages over the same minute: one timeline, so one minute. Reintroduce a timeline
  // per device: about two minutes.
  const events = [turn(0, 'b1', { device: 'phone' }), turn(10, 'b2', { device: 'pc' }), turn(20, 'b1', { device: 'phone' }),
    turn(30, 'b2', { device: 'pc' }), turn(40, 'b1', { device: 'phone' }), turn(50, 'b2', { device: 'pc' }), turn(60, 'b1', { device: 'phone' })];
  const r = all(T.readingTimeline(events, flat));
  assert.equal(r.ms, 60 * SEC + 10 * SEC, 'the minute, and one opening page of ten seconds');
  assert.deepEqual([...r.byDevice].sort(), [['pc', 30 * SEC], ['phone', 40 * SEC]], 'each gap is the earlier turn\'s device');
});

test('a turn replayed at the same instant adds nothing', () => {
  // The offline outbox sends a turn again when its first answer was lost: same `at`, a second row.
  const once = all(T.readingTimeline([turn(0), turn(30), turn(60)], flat));
  const a = turn(30);
  const twice = all(T.readingTimeline([turn(0), a, { ...a, id: ++id }, turn(60)], flat));
  assert.equal(twice.ms, once.ms);
});

test('time is the earlier turn\'s: its chapter, its series, its hour', () => {
  // The gap from 10:59:30 on chapter A to 11:00:10 on chapter B was spent on A, in the 10 o'clock hour.
  const events = [
    { id: ++id, at: Date.parse('2026-10-12T10:59:00Z'), bookId: 'A', seriesId: 'sA', deviceId: 'phone', completed: false },
    { id: ++id, at: Date.parse('2026-10-12T10:59:30Z'), bookId: 'A', seriesId: 'sA', deviceId: 'phone', completed: true },
    { id: ++id, at: Date.parse('2026-10-12T11:00:10Z'), bookId: 'B', seriesId: 'sB', deviceId: 'phone', completed: false },
  ];
  const r = all(T.readingTimeline(events, flat));
  assert.equal(r.bySeries.get('sA'), 30 * SEC + 40 * SEC + 35 * SEC, 'both gaps and the opening page');
  assert.equal(r.bySeries.get('sB') ?? 0, 0);
  assert.equal(r.byHour[10], r.ms);
  assert.equal(r.chapters, 1);
});

test('per chapter: the median of the chapters finished with time, and nothing under three', () => {
  const chapter = (book: string, start: number, pages: number, every: number) =>
    Array.from({ length: pages }, (_, i) => turn(start + i * every, book, { completed: i === pages - 1 }));
  const two = T.readingTimeline([...chapter('c1', 0, 5, 20), ...chapter('c2', 1000, 5, 30)], flat);
  assert.equal(all(two).perChapterMs, null, 'two chapters say nothing of a pace');
  const three = T.readingTimeline([...chapter('c1', 0, 5, 20), ...chapter('c2', 1000, 5, 30), ...chapter('c3', 2000, 5, 40)], flat);
  // c1: 4 x 20 s plus its opening page (the window's median gap, 30 s); c2: 4 x 30 + 30; c3: 4 x 40 + 30.
  assert.equal(all(three).perChapterMs, 4 * 30 * SEC + 30 * SEC);
  // A chapter opened and finished with no time between (marked read from the list) is not a pace of 0.
  const marked = T.readingTimeline([...chapter('c1', 0, 5, 20), ...chapter('c2', 1000, 5, 30), turn(5000, 'c9', { completed: true })], flat);
  assert.equal(all(marked).perBook.size, 3, 'its opening page is still time');
  // One series' own pace leaves the others out.
  assert.equal(T.summarize(three, T0 - HOUR, T0 + 24 * HOUR, utc, 's_c1').perChapterMs, null);
});

test('a read-through counts once (#264)', () => {
  // One read-through writes two completed events: the page before the last already counts as the end
  // (progressRules.ts reachedEnd) and the last page sends its own, seconds later. A re-read the same week is the same
  // chapter again. Reintroduce `chapters: finished.length`: this reads three.
  const read = [turn(0, 'c1'), turn(20, 'c1', { completed: true }), turn(40, 'c1', { completed: true })];
  const again = turn(3 * 3600, 'c1', { completed: true });
  const other = turn(3 * 3600 + 20, 'c2', { completed: true });
  const tl = T.readingTimeline([...read, again, other], flat);
  assert.equal(tl.finished.length, 4, 'the premise: four completed events');
  assert.equal(all(tl).chapters, 2, 'two chapters, each once');
});

test('a window counts what began inside it', () => {
  // A gap that starts before the window is the earlier turn's, outside it.
  const tl = T.readingTimeline([turn(0), turn(60), turn(120)], flat);
  const late = T.summarize(tl, T0 + 30 * SEC, T0 + HOUR, utc);
  assert.equal(late.ms, 60 * SEC, 'only the gap from 60 s; the sitting opened before the window');
});

test('the typical page stays between five and ninety seconds, twenty when there is nothing to judge by', () => {
  const lone = all(T.readingTimeline([turn(0)], flat));
  assert.equal(lone.ms, 20 * SEC);
  const quick = all(T.readingTimeline([turn(0), turn(1), turn(2)], flat));
  assert.equal(quick.ms, 2 * SEC + 5 * SEC);
  const slow = all(T.readingTimeline([turn(0), turn(240)], flat));
  assert.equal(slow.ms, 240 * SEC + 90 * SEC);
});

test('hours in the reader\'s own timezone, half-hour and quarter-hour zones included', () => {
  // 00:45 UTC is 06:15 in Kolkata (+5:30); 00:10 UTC is 05:55 in Kathmandu (+5:45), and 00:20 is 06:05.
  // Reintroduce UTC hours: 0 every time.
  assert.equal(T.hourIn('Asia/Kolkata')(Date.parse('2026-10-12T00:45:00Z')), 6);
  const ktm = T.hourIn('Asia/Kathmandu');
  assert.equal(ktm(Date.parse('2026-10-12T00:10:00Z')), 5);
  assert.equal(ktm(Date.parse('2026-10-12T00:20:00Z')), 6);
  // A daylight-saving change: 06:30 UTC is 02:30 in New York in summer and 01:30 in winter.
  const ny = T.hourIn('America/New_York');
  assert.equal(ny(Date.parse('2026-07-01T06:30:00Z')), 2);
  assert.equal(ny(Date.parse('2026-12-01T06:30:00Z')), 1);
});

test('a timezone that is not one is UTC', () => {
  assert.equal(T.validTz('Asia/Kolkata'), 'Asia/Kolkata');
  for (const bad of ['Not/AZone', '../../etc/passwd', '', 'x'.repeat(80), 42, null, undefined, 'UTC; DROP TABLE']) {
    assert.equal(T.validTz(bad), 'UTC', String(bad));
  }
  assert.equal(T.hourIn('Not/AZone')(Date.parse('2026-10-12T05:30:00Z')), 5);
});
