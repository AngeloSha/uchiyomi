// page-level download progress (lib/serverDownloads.ts inFlight, tileFraction, pageLine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chaptersAfter, inFlight, pageLine, tileFraction, type ActivityEntry } from '../lib/serverDownloads';

const e = (p: Partial<ActivityEntry>): ActivityEntry => ({
  id: 1, seriesId: 's', folder: 'f', title: 'T', number: 132, source: 'Example Source', origin: 'fetch', status: 'downloading', startedAt: 0, ...p,
});

test('a one-chapter fetch moves with its pages instead of sitting at 0 until it lands', () => {
  const job = { done: 0, total: 1 };
  assert.equal(tileFraction(job, [e({ pagesDone: 0, pagesTotal: 78 })]), 0);
  assert.equal(tileFraction(job, [e({ pagesDone: 39, pagesTotal: 78 })]), 0.5);
  assert.equal(tileFraction({ done: 2, total: 4 }, [e({ pagesDone: 39, pagesTotal: 78 })]), 2.5 / 4);
  // never past the job, whatever the entries say
  assert.equal(tileFraction({ done: 4, total: 4 }, [e({ pagesDone: 78, pagesTotal: 78 })]), 1);
});

test('a queued chapter, or one not sized yet, adds nothing; the server\'s own chapters use pages alone', () => {
  assert.equal(inFlight([e({ status: 'queued', pagesDone: 5, pagesTotal: 10 }), e({})]), 0);
  assert.equal(tileFraction(undefined, [e({})]), 'spin');
  assert.equal(tileFraction(undefined, [e({ pagesDone: 10, pagesTotal: 40 }), e({ pagesDone: 10, pagesTotal: 10 })]), 20 / 50);
});

test('the page line: the oldest chapter in flight, a time left only once the rate means something', () => {
  const now = 100_000;
  assert.equal(pageLine([e({ status: 'queued' })], now), null);
  const early = pageLine([e({ pagesDone: 2, pagesTotal: 78, pagesSince: now - 1000 })], now)!;
  assert.deepEqual([early.done, early.total, early.secondsLeft], [2, 78, null]);
  const mid = pageLine([e({ pagesDone: 20, pagesTotal: 78, pagesSince: now - 10_000 })], now)!;
  assert.equal(mid.secondsLeft, 29); // 58 pages at 2 a second
  const two = pageLine([e({ id: 2, number: 133, startedAt: 5, pagesDone: 1, pagesTotal: 9 }), e({ startedAt: 1, pagesDone: 70, pagesTotal: 78 })], now)!;
  assert.equal(two.number, 132);
  assert.equal(pageLine([e({ pagesDone: 78, pagesTotal: 78, pagesSince: now - 39_000 })], now)!.secondsLeft, null);
});

test('the time left is the whole download: the chapters not yet started, at this page rate', () => {
  const now = 100_000;
  const flying = [e({ pagesDone: 20, pagesTotal: 78, pagesSince: now - 10_000 })];
  assert.equal(chaptersAfter({ done: 1, total: 12 }, flying), 10);
  assert.equal(chaptersAfter(undefined, flying), 0);
  assert.equal(chaptersAfter({ done: 12, total: 12 }, flying), 0);
  // 58 pages of this chapter and 10 more of 78, at 2 pages a second
  assert.equal(pageLine(flying, now, { chaptersAfter: 10 })!.secondsLeft, Math.ceil((58 + 780) / 2));
});

test('the time left is the server\'s elapsed time, whatever the browser\'s clock says', () => {
  // `pagesSince` is the server's clock; a phone a minute behind read every rate a minute long. The server sends how long
  // the pages have taken (`pagesFor`), and that is what counts. Reintroduce by reckoning from `pagesSince` alone: the
  // skewed entry reads about four minutes left instead of about thirty seconds.
  const now = 100_000;
  const right = pageLine([e({ pagesDone: 20, pagesTotal: 78, pagesSince: now - 10_000, pagesFor: 10_000 })], now)!;
  const skewed = pageLine([e({ pagesDone: 20, pagesTotal: 78, pagesSince: now - 70_000, pagesFor: 10_000 })], now)!;
  assert.equal(skewed.secondsLeft, right.secondsLeft);
  assert.equal(right.secondsLeft, Math.ceil(58 / 2));
});
