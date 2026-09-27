// What Library -> Downloads, the Library ring and the series band make of GET /api/sources/jobs
// (lib/serverDownloads.ts): the server's download activity, the five sections, the ring and the poll.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandFor, bandReload, beyondJobs, chapterSpan, downloadSections, groupRecent, jobsPollInterval, landedFor, navRing, originLabel,
  shouldReload, tileStatus, viewState, type ActivityEntry, type DownloadJob, type SourceJobs,
} from '../lib/serverDownloads';
import { downloadsLabel, type RunCard } from '../lib/jobs';
import type { ArchiveEntry } from '../lib/archive';

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

test('each chapter is listed once: a job card already shows its own', () => {
  const active = [e({ status: 'downloading', folder: 'Src/One' }), e({ status: 'queued', folder: 'Src/Two', seriesId: 's2' })];
  assert.deepEqual(beyondJobs(active, new Set(['Src/One'])).map((x) => x.folder), ['Src/Two']);
});

test("the ring speaks for the server's downloads too, after a person's own", () => {
  // Reintroduce by dropping `serverChapters`: a followed source's check downloads with no words on the ring.
  assert.equal(downloadsLabel(0, 0, [], 0, 3), 'Fetching 3 chapters', "a followed source's check downloads with no words on the ring");
  assert.equal(downloadsLabel(1, 5, [], 0, 3), 'Fetching 5 chapters', "a person's own job still names its own count");
  assert.equal(downloadsLabel(0, 0, [], 0, 1), 'Fetching 1 chapter', 'one chapter, not "1 chapters"');
  assert.equal(downloadsLabel(0, 0, [], 0, 0), null);
});

/* ================================================================ v0.49.0: Library -> Downloads */

const job = (o: Partial<DownloadJob>): DownloadJob => ({ folder: 'Src/One', title: 'One', total: 10, done: 4, status: 'downloading', startedAt: 100, ...o });
const run = (o: Partial<RunCard>): RunCard => ({ kind: 'sweep', startedAt: 0, status: 'running', done: 0, total: 0, fetched: 0, failed: 0, ...o });
const data = (o: { content?: DownloadJob[]; runs?: RunCard[]; active?: ActivityEntry[]; recent?: ActivityEntry[] }): SourceJobs =>
  ({ content: o.content ?? [], runs: o.runs ?? [], activity: { active: o.active ?? [], recent: o.recent ?? [] } });

test("Running: a person's job and its own chapters are ONE cover; the server's chapters are one cover per series", () => {
  // Reintroduce by building the activity tiles from `active` instead of `beyondJobs(...)`: "two covers for one
  // series" fails -- the add and the chapter it is fetching would be side by side.
  const d = data({
    content: [job({ seriesId: 's1' })],
    active: [
      e({ status: 'downloading', number: 5, folder: 'Src/One', seriesId: 's1', origin: 'add' }),
      e({ status: 'downloading', number: 180, folder: 'Src/Two', seriesId: 's2', title: 'Two', source: 'Asura' }),
      e({ status: 'queued', number: 181, folder: 'Src/Two', seriesId: 's2', title: 'Two', source: 'Asura' }),
    ],
  });
  const s = downloadSections(d, { admin: false });
  assert.deepEqual(s.running.map((t) => t.key), ['s1', 's2'], 'two covers for one series, or a series missing');
  assert.equal(s.running[0].job?.folder, 'Src/One');
  assert.equal(s.running[0].entries.length, 1, "the job's own chapter is not on its cover");
  assert.equal(s.running[0].progress, 0.4, "the job's ring does not fill with its done/total");
  assert.equal(s.running[1].progress, 'spin', "the server's chapters have no total to fill with, so they turn");
  assert.equal(tileStatus(s.running[1]), 'Ch. 180 · Asura');
  assert.deepEqual(s.queued, []);
});

test('Queued: a series whose chapters all wait their turn, and a job that never leaves Running between chapters', () => {
  // Reintroduce by sending a job whose chapter is queued to Queued: its cover hops sections on every poll.
  const d = data({
    content: [job({ seriesId: 's1' })],
    active: [
      e({ status: 'queued', folder: 'Src/One', seriesId: 's1', source: 'MangaDex' }),
      e({ status: 'queued', folder: 'Src/Three', seriesId: 's3', title: 'Three', source: 'Asura' }),
    ],
  });
  const s = downloadSections(d, { admin: false });
  assert.deepEqual(s.running.map((t) => t.key), ['s1'], 'a job waiting between chapters left Running');
  assert.equal(tileStatus(s.running[0]), 'Waiting for MangaDex');
  assert.deepEqual(s.queued.map((t) => t.key), ['s3']);
  assert.equal(tileStatus({ job: job({ cancelRequested: true }), entries: [] }), 'Stopping after this chapter…', 'a pending Cancel does not win the line');
});

test('THE SLOW ARCHIVE is never a download in progress: no Running cover, no ring, no fast poll', () => {
  // #117's chapters come one every quarter of an hour, for days. The owner: the ring animates only for normal
  // downloads, and the archive lives in Queued. Reintroduce by dropping `!isArchive(e)` from jobsPollInterval
  // ("polls every 2.5 s for the archive"), by counting archive chapters in navRing ("the ring turns for the
  // archive"), or by letting a downloading archive chapter into Running ("a Running cover for the archive").
  const archiving = e({ status: 'downloading', origin: 'archive', folder: 'Src/Old', seriesId: 's9', title: 'Old' });
  const d = data({ active: [archiving] });
  const s = downloadSections(d, { admin: false });
  assert.deepEqual(s.running, [], 'a Running cover for the archive');
  assert.deepEqual(s.queued.map((t) => [t.key, t.archive]), [['s9', true]], 'the archive is not in Queued, or not drawn as the archive');
  assert.equal(jobsPollInterval(d), 30_000, 'polls every 2.5 s for the archive');
  const ring = navRing(d);
  assert.equal(ring.count, 0, 'the archive counts on the ring');
  assert.equal(ring.slow, true, 'no calm slow mark while only the archive works');
  assert.equal(ring.show, true);
  assert.equal(ring.label, 'Archiving slowly');
  // Beside a normal download it is simply left out: the ring counts and fills for the normal one alone.
  const both = navRing(data({ content: [job({ seriesId: 's1' })], active: [archiving] }));
  assert.equal(both.slow, false, 'the ring turns for the archive');
  assert.equal(both.count, 1, 'the ring turns for the archive');
  assert.equal(both.progress, 0.4);
  // And a series the scheduled check is on while it is archived is not drawn still.
  const mixed = downloadSections(data({ active: [archiving, e({ status: 'downloading', folder: 'Src/Old', seriesId: 's9', title: 'Old', origin: 'sweep' })] }), { admin: false });
  assert.deepEqual(mixed.running.map((t) => [t.key, t.archive]), [['s9', false]]);
  assert.deepEqual(mixed.queued.map((t) => [t.key, t.archive]), [['s9', true]]);
  assert.equal(originLabel('archive'), 'Slow archive');
});

test('the poll: 2.5 s while chapters come in, 5 s while only a run goes, 30 s otherwise', () => {
  // Reintroduce by dropping the activity clause: the scheduled check's chapters come in at 30 s and the ring freezes.
  assert.equal(jobsPollInterval(data({ content: [job({})] })), 2500);
  assert.equal(jobsPollInterval(data({ active: [e({ status: 'queued', origin: 'check' })] })), 2500, 'the scheduled check\'s chapters come in at 30 s');
  assert.equal(jobsPollInterval(data({ runs: [run({})] })), 5000);
  assert.equal(jobsPollInterval(data({ runs: [run({ status: 'done' })], content: [job({ status: 'error' })] })), 30_000);
  assert.equal(jobsPollInterval(undefined), 30_000, 'nothing known yet is not a reason to hammer the server');
});

test('the ring counts SERIES, fills with the jobs, turns for the server alone, and stays away when nothing runs', () => {
  // Reintroduce by counting chapters (`chaptersLeft`) instead of Running covers: "the count reads 40".
  const three = data({
    content: [job({ folder: 'A', seriesId: 'a', total: 20, done: 5 }), job({ folder: 'B', seriesId: 'b', total: 15, done: 0 }), job({ folder: 'C', seriesId: 'c', total: 5, done: 5 })],
  });
  const r = navRing(three);
  assert.equal(r.count, 3, 'the count reads chapters, not series');
  assert.equal(r.progress, 10 / 40);
  assert.equal(r.label, 'Fetching 30 chapters');
  // The count is the covers in RUNNING: a series whose chapters all wait their turn is in Queued, not on it.
  // Reintroduce by counting the queued series too: 4.
  const waiting = navRing({ ...three, activity: { active: [e({ status: 'queued', origin: 'check', folder: 'Q', seriesId: 'q' })], recent: [] } });
  assert.equal(waiting.count, 3, 'a queued series counted on the ring');
  // Activity alone (the scheduled check's chapters, no job, no sized run): it turns.
  const server = navRing(data({ active: [e({ status: 'downloading', origin: 'check' })] }));
  assert.equal(server.progress, 'spin');
  assert.equal(server.show, true);
  // With no job, a run that has sized itself fills the ring.
  assert.equal(navRing(data({ runs: [run({ done: 3, total: 12 })] })).progress, 0.25);
  // Finished things only: nothing to draw.
  const idle = navRing(data({ content: [job({ status: 'done', finishedAt: 1 })], runs: [run({ status: 'done' })], recent: [e({})] }));
  assert.equal(idle.show, false, 'a finished-only answer raised the ring');
  assert.equal(idle.progress, 'idle');
  assert.equal(navRing(undefined).show, false);
});

test("the amber dot is a failed download, never the scheduled check's chapter failures, and a scoped repair never turns the ring", () => {
  // Reintroduce by lighting the dot for failed chapters in activity: a sweep that could not save one chapter
  // keeps the Library tab amber all day.
  const sweepFail = navRing(data({ recent: [e({ status: 'failed', origin: 'sweep' })] }));
  assert.equal(sweepFail.attention, false, 'the dot lit for a sweep chapter failure');
  assert.equal(sweepFail.show, false);
  const failed = navRing(data({ content: [job({ status: 'error', reason: 'refused' })] }));
  assert.equal(failed.attention, true, 'no dot for a failed download');
  assert.equal(failed.show, true, 'a failed download alone draws nothing');
  assert.equal(failed.progress, 'idle', 'a failure turns the ring');
  assert.equal(failed.label, '1 failed');
  // A Health key that only resets the solver starts a repair run that cannot download (`downloads: false`).
  // Reintroduce by ignoring the flag: the admin's ring turns for a solver reset.
  // The dot is for a failed DOWNLOAD card only. A run that ended in error is in Needs attention for its admin,
  // but not a reason to keep the Library tab amber. Reintroduce by counting runs in error: the dot lights.
  const runFailed = navRing(data({ runs: [run({ kind: 'repair', status: 'error', reason: 'disk' })] }));
  assert.equal(runFailed.attention, false, 'a run that ended in error lit the dot');
  const scoped = navRing(data({ runs: [run({ kind: 'repair', downloads: false })] }));
  assert.equal(scoped.show, false, 'the ring turns for a repair that cannot download');
  assert.equal(navRing(data({ runs: [run({ kind: 'repair' })] })).show, true, 'a repair that can download is not on the ring');
});

test('Needs attention: failed downloads with Try again by what they did not land, chapters that failed and did not land later', () => {
  // Reintroduce by keeping every failed chapter: chapter 8, which landed from another source, is offered again.
  const d = data({
    content: [
      job({ folder: 'F1', seriesId: 'f1', title: 'Failed one', status: 'error', reason: 'refused', left: [3, 2, 2], mine: true, finishedAt: 5 }),
      job({ folder: 'F2', title: 'First chapter never landed', status: 'error', finishedAt: 9 }),
    ],
    recent: [
      e({ number: 8, status: 'failed', seriesId: 's5', folder: 'S5', title: 'Five', finishedAt: 10 }),
      e({ number: 8, status: 'done', seriesId: 's5', folder: 'S5', title: 'Five', finishedAt: 11 }),
      e({ number: 9, status: 'failed', seriesId: 's5', folder: 'S5', title: 'Five', finishedAt: 12, reason: 'timeout' }),
      e({ number: 4, status: 'failed', seriesId: 'f1', folder: 'F1', title: 'Failed one', origin: 'add' }),
      e({ number: 30, status: 'failed', seriesId: 'arch', folder: 'Arch', title: 'Archived', origin: 'archive' }),
    ],
  });
  const s = downloadSections(d, { admin: false });
  assert.deepEqual(s.attention.map((a) => a.key), ['job:F2', 'job:F1', 'ch:s5'], 'the failed job\'s own chapters listed twice, or the archive\'s retries listed');
  const [noSeries, f1, ch] = s.attention;
  assert.ok(f1.kind === 'job' && noSeries.kind === 'job' && ch.kind === 'chapters');
  assert.deepEqual(f1.retry, [2, 3], 'Try again does not ask for what the job did not land');
  assert.equal(f1.dismiss, true);
  assert.deepEqual(noSeries.retry, [], 'Try again offered with no series to fetch into');
  assert.equal(noSeries.dismiss, false, "a member was offered Dismiss on someone else's card");
  const asAdmin = downloadSections(d, { admin: true }).attention.find((a) => a.key === 'job:F2');
  assert.ok(asAdmin?.kind === 'job' && asAdmin.dismiss, 'an admin was not offered Dismiss on every failed card');
  assert.deepEqual(ch.retry, [9], 'chapter 8 landed later and is offered again');
  // A series being fetched again right now is not "needs attention" while it is.
  const retrying = downloadSections({ ...d, activity: { active: [e({ status: 'downloading', seriesId: 's5', folder: 'S5' })], recent: d.activity!.recent } }, { admin: false });
  assert.ok(!retrying.attention.some((a) => a.key === 'ch:s5'), 'a series being fetched again is still listed as failed');
  // A run that ended in error is here, not in Server tasks.
  const runs = downloadSections(data({ runs: [run({ kind: 'repair', status: 'error', reason: 'disk' }), run({ status: 'done' })] }), { admin: true });
  assert.deepEqual(runs.attention.map((a) => a.key), ['run:repair']);
  assert.deepEqual(runs.tasks.map((r) => r.kind), ['sweep']);
});

test('Server tasks put the running run first; Came in today is what landed, the archive included; a Cancel is kept', () => {
  // A download that simply finished is not "stopped": listed there, with no reason set, it would read "Cancelled;
  // what landed is kept." Reintroduce by listing every finished card: 'Y' is there too.
  const s = downloadSections(data({
    content: [
      job({ folder: 'X', status: 'done', cancelled: true, reason: 'Cancelled after 3 of 10', finishedAt: 7 }),
      job({ folder: 'Y', status: 'done', total: 5, done: 5, finishedAt: 8 }),
    ],
    runs: [run({ kind: 'newest', status: 'done', startedAt: 50 }), run({ kind: 'repair', startedAt: 10 })],
    recent: [e({ number: 1, origin: 'archive', seriesId: 'a', folder: 'A', title: 'A', finishedAt: 30 }), e({ number: 2, status: 'failed', seriesId: 'b', folder: 'B' })],
  }), { admin: true });
  assert.deepEqual(s.tasks.map((r) => r.kind), ['repair', 'newest']);
  assert.deepEqual(s.cameIn.map((g) => g.key), ['a'], 'a series with only a failure came in');
  assert.deepEqual(s.cameIn[0].origins, ['archive']);
  assert.deepEqual(s.stopped.map((j) => j.folder), ['X'], 'a download that finished is listed as stopped');
});

test('the series band finds this series by id or folder, and watches its chapters land', () => {
  // Reintroduce by matching the folder only: a member, who is never sent the folder, gets no band.
  const d = data({
    content: [job({ folder: 'Src/One', seriesId: 's1' }), job({ folder: 'Src/Bad', seriesId: 's2', status: 'error' })],
    recent: [e({ seriesId: 's1', status: 'done' }), e({ seriesId: 's1', status: 'partial', number: 2 }), e({ seriesId: 's1', status: 'failed', number: 3 }), e({ seriesId: 's3', folder: 'Other' })],
  });
  const s = downloadSections(d, { admin: false });
  assert.equal(bandFor(s, 's1').tile?.job?.folder, 'Src/One', 'no band without the folder');
  assert.equal(bandFor(s, 's2').failed?.job.folder, 'Src/Bad');
  assert.equal(bandFor(s, 'zz').tile, undefined);
  assert.equal(bandFor(s, 'zz', 'Src/One').tile?.key, 's1', 'the folder no longer finds it for an admin');
  // Reintroduce by counting another series' chapters: every landing anywhere re-reads this page.
  assert.equal(landedFor(d, 's1'), 2, 'a failed chapter counted as landed, or another series counted');
  assert.equal(landedFor(d, 's3'), 1);
  // An add's first chapters land before the series has a row, so they carry no id -- only the folder, which an
  // admin's page knows. Reintroduce by matching the id alone: those landings never re-read the page.
  const early = data({ recent: [e({ seriesId: null, folder: 'Src/New', status: 'done' }), e({ seriesId: null, folder: 'Src/New', status: 'done', number: 2 })] });
  assert.equal(landedFor(early, 'sNew', 'Src/New'), 2, "an add's chapters, which have no series id yet, are not watched by folder");
  assert.equal(landedFor(early, 'sNew'), 0);
});

test('the band re-reads the chapter list when more of the series lands, never on the first answer', () => {
  // A cold load of a series page: the downloads poll answers after the page has read its chapters, with
  // today's landings already in that read. Reintroduce by starting from 0 (`useRef(landed)` on an empty cache):
  // "the first answer re-reads the page".
  assert.deepEqual(shouldReload(null, null), { reload: false, seen: null }, 'no answer yet is not a landing');
  assert.deepEqual(shouldReload(null, 3), { reload: false, seen: 3 }, 'the first answer re-reads the page');
  assert.deepEqual(shouldReload(3, 4), { reload: true, seen: 4 }, 'a chapter landed and the page was not re-read');
  assert.deepEqual(shouldReload(4, 4), { reload: false, seen: 4 }, 'the same answer again re-read the page');
  assert.deepEqual(shouldReload(4, 2), { reload: false, seen: 2 }, 'a day aging out re-read the page');
  assert.deepEqual(shouldReload(2, 3), { reload: true, seen: 3 });
  assert.deepEqual(shouldReload(2, null), { reload: false, seen: 2 }, 'a lost answer forgot what was seen');
});

test('what the band saw belongs to its series: moving to another series in the app is a first answer again', () => {
  // The band stays mounted from /series/?id=A to ?id=B (the page is not keyed by id). Reintroduce the bare count
  // (shouldReload(seen.n, landed) whatever the id): B's first answer, 2 against A's 0, re-reads B's chapters right
  // after B's page read them -- "a new series' first answer re-reads its page" fails.
  assert.deepEqual(bandReload({ id: 'A', n: 0 }, 'B', 2), { reload: false, seen: { id: 'B', n: 2 } }, "a new series' first answer re-reads its page");
  assert.deepEqual(bandReload({ id: 'A', n: 5 }, 'B', 1), { reload: false, seen: { id: 'B', n: 1 } });
  assert.deepEqual(bandReload({ id: 'B', n: 1 }, 'B', 2), { reload: true, seen: { id: 'B', n: 2 } }, 'a landing on the new series is missed');
  assert.deepEqual(bandReload({ id: 'A', n: 2 }, 'A', 3), { reload: true, seen: { id: 'A', n: 3 } }, 'a landing on the same series is missed');
  assert.deepEqual(bandReload(null, 'A', 3), { reload: false, seen: { id: 'A', n: 3 } }, 'the first answer on a cold load re-reads the page');
  assert.deepEqual(bandReload({ id: 'A', n: 3 }, 'B', null), { reload: false, seen: { id: 'B', n: null } }, "A's count is kept for B while there is no answer");
});

test('the view says when it could not read the downloads, instead of "nothing is being fetched"', () => {
  const none = downloadSections(undefined, { admin: false });
  assert.equal(viewState({ isLoading: true, isError: false }, none), 'loading');
  // Reintroduce by dropping the error branch: a 500 or a timeout reads as all quiet.
  assert.equal(viewState({ isLoading: false, isError: true }, none), 'error', 'a failed read says so');
  assert.equal(viewState({ data: data({}), isLoading: false, isError: false }, downloadSections(data({}), { admin: false })), 'empty');
  const d = data({ content: [job({})] });
  assert.equal(viewState({ data: d, isLoading: false, isError: true }, downloadSections(d, { admin: false })), 'list', 'an answer in hand was hidden by a refetch that failed');
});

/* ================================================================ v0.49.0: the slow archive's own rows (#117) */

const arch = (o: Partial<ArchiveEntry>): ArchiveEntry => ({
  seriesId: 'a1', title: 'Archived', state: 'queued', direction: 'up', done: 12, left: 88, failed: 0, bytes: 0, mine: true,
  queuedAt: '2026-09-27T08:00:00Z', startedAt: '2026-09-27T08:10:00Z', ...o,
});
const withArchive = (series: ArchiveEntry[], o: { active?: ActivityEntry[]; recent?: ActivityEntry[]; content?: DownloadJob[]; paused?: boolean } = {}): SourceJobs =>
  ({ ...data(o), archive: { paused: !!o.paused, perHour: 4, window: null, series } });

test("the archive's own row is ONE Queued cover: its chapter in flight joins it, and it never speeds the poll or turns the ring", () => {
  // Reintroduce by dropping the row check in downloadSections' activity loop: "two covers for one archived
  // series" fails -- one from the row, one from its chapter in flight.
  const flying = e({ status: 'downloading', origin: 'archive', folder: 'Src/Arch', seriesId: 'a1', title: 'Archived', number: 13 });
  const d = withArchive([arch({ current: { number: 13, startedAt: '2026-09-27T12:00:00Z' }, etaMs: 3 * 86_400_000 }), arch({ seriesId: 'a2', title: 'Other', state: 'paused' })], { active: [flying] });
  const s = downloadSections(d, { admin: false });
  assert.deepEqual(s.running, [], 'a Running cover for the archive');
  assert.deepEqual(s.queued.map((t) => [t.key, t.archive, !!t.item]), [['a1', true, true], ['a2', true, true]], 'two covers for one archived series');
  assert.deepEqual(s.queued[0].entries.map((x) => x.number), [13], "the chapter in flight is not on its row's cover");
  assert.equal(s.queued[0].folder, 'Src/Arch');
  assert.equal(s.queued[0].progress, 0.12);
  // Reintroduce by counting the archive's activity in jobsPollInterval: "polls every 2.5 s for the archive".
  assert.equal(jobsPollInterval(d), 30_000, 'polls every 2.5 s for the archive');
  const ring = navRing(d);
  assert.equal(ring.count, 0, 'the archive counts on the ring');
  assert.equal(ring.slow, true, 'no calm slow mark while only the archive works');
  // An archive with no chapter in flight is not "being fetched right now": a paused one does not hide the
  // series' failed chapters from Needs attention for as long as it stays paused.
  const failedToo = downloadSections(withArchive([arch({ seriesId: 'a2', state: 'paused' })],
    { recent: [e({ number: 3, status: 'failed', seriesId: 'a2', folder: 'Src/A2', title: 'Other', origin: 'sweep' })] }), { admin: false });
  assert.deepEqual(failedToo.attention.map((a) => a.key), ['ch:a2'], "a paused archive hides the series' failed chapters");
});

test('a paused archive puts no mark on the ring; one taking chapters puts the still one, and never a count', () => {
  // Reintroduce by dropping `live` from navRing's slow rule: "a paused archive puts a mark on the ring".
  assert.equal(navRing(withArchive([arch({ state: 'paused' })])).show, false, 'a paused archive puts a mark on the ring');
  assert.equal(navRing(withArchive([arch({})], { paused: true })).show, false, 'an archive paused for everyone puts a mark on the ring');
  const quiet = navRing(withArchive([arch({})]));
  assert.deepEqual([quiet.show, quiet.slow, quiet.count, quiet.progress, quiet.label], [true, true, 0, 'spin', 'Archiving slowly']);
  // Beside a person's download the ring is theirs alone.
  const both = navRing(withArchive([arch({})], { content: [job({ seriesId: 's1' })] }));
  assert.deepEqual([both.slow, both.count, both.progress], [false, 1, 0.4]);
  // A flagged archive is Needs attention's, not a reason for the mark.
  assert.equal(navRing(withArchive([arch({ attention: { why: 'disk', since: '' } })])).show, false);
});

test('Needs attention and Came in today for the archive: flagged rows, the day\'s chapters summed up, a finished archive said once', () => {
  const d = withArchive([
    arch({ seriesId: 'b', title: 'Refused', attention: { why: 'backoff', since: '2026-09-27T09:00:00Z' } }),
    arch({ seriesId: 'g', title: 'Gaps', state: 'done', left: null, note: { capped: 1, held: 0, blocked: 0 }, attention: { why: 'finished_with_gaps', since: '2026-09-27T09:00:00Z' } }),
    arch({ seriesId: 'd', title: 'Done', state: 'done', left: null, done: 40, finishedAt: '2026-09-27T11:00:00Z' }),
    arch({ seriesId: 'x', title: 'Done here', state: 'done', left: null, done: 3, finishedAt: '2026-09-27T11:30:00Z' }),
  ], {
    recent: [
      e({ number: 1, origin: 'archive', seriesId: 'x', folder: 'X', title: 'Done here', finishedAt: Date.parse('2026-09-27T11:00:00Z') }),
      e({ number: 2, origin: 'archive', seriesId: 'x', folder: 'X', title: 'Done here', finishedAt: Date.parse('2026-09-27T11:10:00Z') }),
      e({ number: 9, origin: 'sweep', seriesId: 'x', folder: 'X', title: 'Done here', finishedAt: Date.parse('2026-09-27T11:20:00Z') }),
    ],
  });
  const s = downloadSections(d, { admin: false });
  assert.deepEqual(s.attention.map((a) => a.key), ['archive:b', 'archive:g'], 'a flagged archive is not under Needs attention');
  assert.deepEqual(s.queued, [], 'a flagged archive is also a Queued cover');
  // One tile per series: the archive's chapters and a finished archive said on it, never a second tile.
  assert.deepEqual(s.cameIn.map((g) => g.key), ['x', 'd'], 'a finished archive is a second tile for its series');
  const [x, done] = s.cameIn;
  assert.deepEqual(x.archived, [1, 2], "the archive's chapters are not told apart from the sweep's");
  assert.deepEqual(x.numbers.sort((a, b) => a - b), [1, 2, 9]);
  assert.equal(x.archiveFinished?.seriesId, 'x', 'a finished archive is a second tile for its series');
  assert.equal(done.archiveFinished?.entry.done, 40);
  assert.deepEqual(done.numbers, []);
});

test('the series band finds its archive whether it is queued or flagged, and a series with none has none', () => {
  const d = withArchive([arch({ seriesId: 'q' }), arch({ seriesId: 'f', attention: { why: 'source_missing', since: '' } })]);
  const s = downloadSections(d, { admin: false });
  assert.equal(bandFor(s, 'q').archive?.section, 'queued');
  assert.equal(bandFor(s, 'q').tile?.item?.seriesId, 'q');
  assert.equal(bandFor(s, 'f').archive?.section, 'attention', 'a flagged archive is not on its series page');
  assert.equal(bandFor(s, 'zz').archive, undefined);
});
