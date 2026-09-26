// What the pill and the Offline tab make of the server's download activity (lib/serverDownloads.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { beyondJobs, chapterSpan, groupRecent, type ActivityEntry } from '../lib/serverDownloads';
import { pillLabel } from '../lib/jobs';

let n = 0;
const e = (o: Partial<ActivityEntry>): ActivityEntry => ({
  id: ++n, seriesId: 's1', folder: 'Src/One', title: 'One', number: 1, source: 'MangaDex', origin: 'sweep',
  status: 'done', startedAt: 1000, finishedAt: 2000, ...o,
});

test('chapter numbers read as a short span', () => {
  assert.equal(chapterSpan([14, 12, 13, 16]), 'Ch. 12–14, 16');
  assert.equal(chapterSpan([3, 4]), 'Ch. 3, 4', 'two in a row are two numbers, not a range');
  assert.equal(chapterSpan([12, 12.5, 13]), 'Ch. 12, 12.5, 13', 'a half chapter is not folded into a range');
  assert.equal(chapterSpan([]), '');
});

test('what came in is one line per series, newest first, and a chapter that failed then landed is not a failure', () => {
  const g = groupRecent([
    e({ number: 7, finishedAt: 5000 }),
    e({ number: 8, status: 'failed', source: 'A', finishedAt: 5100, origin: 'check' }),
    e({ number: 8, status: 'done', source: 'B', finishedAt: 5200, origin: 'check' }),
    e({ number: 9, status: 'failed', finishedAt: 5300, reason: 'timeout' }),
    e({ seriesId: 's2', folder: 'Src/Two', title: 'Two', number: 1, finishedAt: 9000, origin: 'add' }),
  ]);
  assert.deepEqual(g.map((x) => x.title), ['Two', 'One']);
  const one = g[1];
  assert.deepEqual(one.numbers.sort((a, b) => a - b), [7, 8]);
  // Reintroduce by keeping every failure: chapter 8 shows red although it is on the server.
  assert.deepEqual(one.failed.map((f) => f.number), [9]);
  assert.deepEqual(one.origins, ['sweep', 'check']);
});

test('the pill lists each chapter once: a job card already shows its own', () => {
  const active = [e({ status: 'downloading', folder: 'Src/One' }), e({ status: 'queued', folder: 'Src/Two', seriesId: 's2' })];
  assert.deepEqual(beyondJobs(active, new Set(['Src/One'])).map((x) => x.folder), ['Src/Two']);
});

test("the pill comes up for the server's downloads too, after a person's own", () => {
  // Reintroduce by dropping `serverChapters`: a followed source's check downloads with no pill at all.
  assert.equal(pillLabel(0, 0, [], 0, 3), 'Fetching 3 chapters');
  assert.equal(pillLabel(1, 5, [], 0, 3), 'Fetching 5 chapters', "a person's own job still names its own count");
  assert.equal(pillLabel(0, 0, [], 0, 1), 'Fetching 1 chapter', 'one chapter, not "1 chapters"');
  assert.equal(pillLabel(0, 0, [], 0, 0), null);
});
