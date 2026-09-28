// The slow archive (#117) as the web app shows it (lib/archive.ts): where each archive goes in Library ->
// Downloads and who may touch it, the estimate made before the server has timed anything, a sentence for every
// reason it can be waiting, and the words for turning it on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  archiveAddLine, archiveBulkNotice, archiveItems, archiveOutcomeNotice, archivePaceHelp, archiveProgressText, archiveStateText,
  archiveSwitchHelp, attentionText, expectedCycleMs, globalWaitOf, leftBehindLines, listingArchiveLine, waitingText, TYPICAL_CHAPTER_MS,
  type ArchiveEntry, type ArchiveView, type EnqueueOutcome, type GlobalWaitWhy, type SeriesWaitWhy, type ArchiveAttentionWhy,
} from '../lib/archive';

const entry = (o: Partial<ArchiveEntry>): ArchiveEntry => ({
  seriesId: 's1', title: 'One', state: 'queued', direction: 'up', done: 30, left: 70, failed: 0, bytes: 0, mine: false,
  queuedAt: '2026-09-27T10:00:00Z', startedAt: null, ...o,
});
const view = (series: ArchiveEntry[], o: Partial<ArchiveView> = {}): ArchiveView => ({ paused: false, perHour: 4, window: null, series, ...o });

test('each archive goes where it belongs, and only its owner or an admin may touch it', () => {
  // Reintroduce by dropping the attention branch from archiveItems: "a source that keeps refusing is under
  // Needs attention" fails -- it sits in Queued with a still ring, as if all were well.
  const v = view([
    entry({ seriesId: 'q' }),
    entry({ seriesId: 'p', state: 'paused', mine: true }),
    entry({ seriesId: 'b', attention: { why: 'backoff', since: '2026-09-27T10:00:00Z' } }),
    entry({ seriesId: 'g', state: 'done', left: null, mine: true, note: { capped: 2, held: 0, blocked: 1 }, attention: { why: 'finished_with_gaps', since: '2026-09-27T10:00:00Z' } }),
    entry({ seriesId: 'd', state: 'done', left: null, finishedAt: '2026-09-27T12:00:00Z' }),
  ]);
  const member = archiveItems(v, { admin: false });
  assert.deepEqual(member.map((i) => [i.seriesId, i.section]), [['q', 'queued'], ['p', 'queued'], ['b', 'attention'], ['g', 'attention'], ['d', 'today']],
    'a source that keeps refusing is under Needs attention');
  const [q, p, b, g, d] = member;
  assert.deepEqual(q.may, { pause: false, resume: false, stop: false, dismiss: false }, "a member may touch someone else's archive");
  assert.deepEqual(p.may, { pause: false, resume: true, stop: true, dismiss: false }, 'its owner may not resume or stop their paused archive');
  assert.deepEqual(g.may, { pause: false, resume: false, stop: false, dismiss: true }, 'its owner may not dismiss their finished archive');
  assert.deepEqual(archiveItems(v, { admin: true })[0].may, { pause: true, resume: false, stop: true, dismiss: false }, 'an admin may not pause any archive');
  // The ring: done / (done + left), full once finished, and the still dashed circle before the listing is read.
  assert.equal(q.progress, 0.3);
  assert.equal(d.progress, 1);
  assert.equal(archiveItems(view([entry({ left: null })]), { admin: false })[0].progress, 'spin');
  // Taking chapters: queued and not paused, by itself or by the admin for everyone.
  assert.equal(q.live, true);
  assert.equal(p.live, false, 'a paused archive counts as working');
  assert.equal(b.live, true);
  assert.equal(archiveItems(view([entry({})], { paused: true }), { admin: false })[0].live, false, 'an archive paused for everyone counts as working');
  assert.deepEqual(archiveItems(undefined, { admin: true }), []);
});

test('the estimate is the server\'s arithmetic, not an hour divided by the setting', () => {
  // Every chapter is followed by at least 45 s of break, so past about 18 an hour the setting names a rate the
  // archive cannot reach. Reintroduce `HOUR / perHour` in expectedCycleMs: "promises 720 a day at 30 an hour".
  assert.equal(Math.round(expectedCycleMs(4)), 900_000, 'the default does not come out at its own rate');
  assert.equal(Math.round(expectedCycleMs(30)), 148_125, 'promises 720 a day at 30 an hour');
  assert.equal(Math.round(expectedCycleMs(1, 30 * 60_000)), 3_600_000, 'a slow setting with long chapters is not its own rate');
  assert.equal(archivePaceHelp(4), 'About 96 a day per source; 1,000 chapters take about 10 days.');
  assert.equal(archivePaceHelp(30), 'About 583 a day per source; 1,000 chapters take about 2 days.', 'promises 720 a day at 30 an hour');
  assert.equal(archivePaceHelp(1), 'About 24 a day per source; 1,000 chapters take about 42 days.');
  assert.equal(TYPICAL_CHAPTER_MS, 60_000);
});

test('the web\'s estimate matches bff/src/lib/archivePace.ts wherever the server has one', async (t) => {
  // lib/archive.ts mirrors the server's expectedCycleMs because the web cannot import server code at run time.
  // This reads the server's own module and compares, so the mirror cannot drift from the scheduler.
  const path = join(__dirname, '..', '..', 'bff', 'src', 'lib', 'archivePace.ts');
  if (!existsSync(path)) { t.skip('no bff/ beside web/ in this checkout'); return; }
  const server = (await import(path)) as { expectedCycleMs?: (o: { perHour: number; chapterMs: number }) => number };
  if (typeof server.expectedCycleMs !== 'function') { t.skip('this bff has no expectedCycleMs yet (it comes with the lane 2 pacing fixes)'); return; }
  for (let perHour = 1; perHour <= 30; perHour++) {
    for (const chapterMs of [0, 30_000, TYPICAL_CHAPTER_MS, 5 * 60_000, 40 * 60_000]) {
      assert.equal(Math.round(expectedCycleMs(perHour, chapterMs)), Math.round(server.expectedCycleMs({ perHour, chapterMs })), `${perHour} an hour, ${chapterMs} ms chapters`);
    }
  }
});

test('every reason the server can send has a sentence of its own', () => {
  // Reintroduce by dropping any case from waitingText or attentionText: its reason reads as nothing at all.
  const now = Date.parse('2026-09-27T12:00:00Z');
  const globals: GlobalWaitWhy[] = ['stopping', 'paused', 'window', 'sweep', 'repair', 'check', 'disk'];
  const series: SeriesWaitWhy[] = ['turn', 'break', 'backoff', 'source_busy', 'pace', 'cooldown', 'disabled', 'source_missing', 'series_busy', 'listing', 'renumbering'];
  const seen = new Set<string>();
  for (const why of [...globals, ...series]) {
    const s = waitingText({ why }, view([]), now);
    assert.ok(s && !s.includes('_') && s !== why, `no sentence for "${why}"`);
    seen.add(s);
  }
  // Two reasons may share words only where they mean the same thing to the reader.
  assert.ok(seen.size >= globals.length + series.length - 1, 'reasons share a sentence');
  // A window's hours are the server's local time: the wait says when it opens, the same in every timezone, and names
  // the hours only when the server sent no time, as server time. Reintroduce the bare hours: the first line fails.
  assert.equal(waitingText({ why: 'window', until: '2026-09-27T15:00:00Z' }, view([], { window: { from: 1, to: 7 } }), now),
    'Outside the hours it may run; it starts again in 3 hours', 'the window says hours a viewer elsewhere reads as theirs');
  assert.equal(waitingText({ why: 'window' }, view([], { window: { from: 1, to: 7 } }), now), 'Only runs between 01:00 and 07:00, server time');
  // `listing` is a read that gave nothing, retried on a ladder (1 h, 3 h, 12 h, a day). Reintroduce "Reading its
  // chapter list again": a series waiting a day for its next read says it is reading now.
  assert.equal(waitingText({ why: 'listing', until: '2026-09-27T15:00:00Z' }, null, now), 'Its chapter list could not be read; trying again in 3 hours',
    'a failed listing reads as a read in progress');
  assert.equal(waitingText({ why: 'listing' }, null, now), 'Its chapter list could not be read; trying again soon');
  assert.equal(waitingText({ why: 'break', until: '2026-09-27T12:20:00Z' }, null, now), 'Next chapter in 20 minutes');
  assert.equal(waitingText({ why: 'backoff', until: '2026-09-27T15:00:00Z' }, null, now), 'The site asked us to slow down; trying again in 3 hours');
  assert.equal(waitingText({ why: 'backoff', until: '2026-09-27T11:00:00Z' }, null, now), 'The site asked us to slow down', 'a time already past is promised');
  assert.equal(waitingText(undefined, null, now), '');
  const whys: ArchiveAttentionWhy[] = ['backoff', 'source_missing', 'disabled', 'stalled', 'disk', 'finished_with_gaps'];
  for (const why of whys) assert.ok(attentionText(entry({ attention: { why, since: '' } }), now), `no sentence for attention "${why}"`);
  const gaps = entry({ state: 'done', note: { capped: 2, held: 0, blocked: 1 }, attention: { why: 'finished_with_gaps', since: '' } });
  assert.equal(attentionText(gaps, now), 'Finished · 3 chapters could not be fetched');
  assert.equal(attentionText({ ...gaps, note: { capped: 1, held: 0, blocked: 0 } }, now), 'Finished · 1 chapter could not be fetched', '"1 chapters"');
  assert.deepEqual(leftBehindLines({ capped: 2, held: 1, blocked: 0 }), ['2 failed too many times', '1 is waiting for a preferred group']);
  // `stalled` is two things (bff lib/archivePlan.ts attentionOf): paused for a week, or queued with its turns had and
  // nothing brought in for three days. Reintroduce the one sentence for both: a queued series reads as paused.
  assert.equal(attentionText(entry({ state: 'paused', attention: { why: 'stalled', since: '2026-09-19T12:00:00Z' } }), now), 'Paused for over a week');
  assert.equal(attentionText(entry({ attention: { why: 'stalled', since: '2026-09-24T08:00:00Z' } }), now), 'Nothing has come in for 3 days 4 hr',
    'a queued series that stalled reads as paused');
  assert.equal(attentionText(entry({ attention: { why: 'stalled', since: '' } }), now), 'Nothing has come in for days');
});

test('an archive under Needs attention still says the chapter it is taking', () => {
  // The retry after a backoff: the row said only "The site keeps refusing", and the chapter coming in was nowhere but
  // the sheet. Reintroduce `if (item.section === 'attention') return attentionText(e, now);`: this fails.
  const now = Date.parse('2026-09-27T12:00:00Z');
  const vv = view([entry({ current: { number: 4, startedAt: '' }, attention: { why: 'backoff', since: '' } })]);
  const [item] = archiveItems(vv, { admin: true });
  assert.equal(item.section, 'attention');
  assert.equal(archiveStateText(item, vv, now), 'Fetching Ch. 4 · The site keeps refusing', 'the chapter in flight is shown nowhere');
  const idle = view([entry({ attention: { why: 'backoff', since: '' } })]);
  assert.equal(archiveStateText(archiveItems(idle, { admin: true })[0], idle, now), 'The site keeps refusing');
});

test('the line under a cover: how far, then paused, the chapter coming in, the whole archive\'s wait, else how long', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const one = (o: Partial<ArchiveEntry>, v: Partial<ArchiveView> = {}) => {
    const vv = view([entry(o)], v);
    return archiveStateText(archiveItems(vv, { admin: false })[0], vv, now);
  };
  assert.equal(archiveProgressText(entry({})), '30 of 100');
  assert.equal(archiveProgressText(entry({ left: null, done: 1 })), '1 chapter so far', '"1 chapters so far"');
  assert.equal(archiveProgressText(entry({ state: 'done', done: 900, left: null })), 'Archive finished · 900 chapters');
  assert.equal(one({ state: 'paused', etaMs: 5 * 86_400_000 }), 'Paused');
  assert.equal(one({ etaMs: 5 * 86_400_000 }, { paused: true }), 'Paused for everyone');
  assert.equal(one({ current: { number: 12, startedAt: '' }, etaMs: 5 * 86_400_000 }), 'Fetching Ch. 12');
  assert.equal(one({ etaMs: 5 * 86_400_000 }, { waiting: { why: 'sweep' } }), 'Waiting for the scheduled check to finish');
  assert.equal(one({ etaMs: 5 * 86_400_000 }), 'About 5 days', 'the ETA is not the line');
  assert.equal(one({ waiting: { why: 'turn' } }), 'Waiting its turn on its source');
  // Just after Resume all, the scheduler's last reason is still "paused"; the flag already says otherwise.
  assert.equal(one({ etaMs: 5 * 86_400_000 }, { paused: false, waiting: { why: 'paused' } }), 'About 5 days', 'a stale pause');
  assert.deepEqual(globalWaitOf({ paused: false, waiting: { why: 'paused' } }), undefined, 'a stale pause');
  assert.deepEqual(globalWaitOf({ paused: true, waiting: { why: 'sweep' } }), { why: 'paused' });
  assert.deepEqual(globalWaitOf({ paused: false, waiting: { why: 'disk' } }), { why: 'disk' });
  assert.equal(listingArchiveLine({ state: 'queued', done: 120, left: 780, failed: 0, mine: true }), '120 of 900');
  assert.equal(listingArchiveLine(null), '');
});

test('the add dialog says how many come in, which way, and about how long', () => {
  // The server fills a "Nothing yet" or First-N add upward and a Latest-N add downward from its held block
  // (bff lib/archivePlan.ts directionFor): the line says the same order.
  assert.equal(archiveSwitchHelp('none', 200, 4), '200 chapters come in slowly in the background. Oldest first. About 2 days at the current pace.');
  assert.equal(archiveSwitchHelp('first', 150, 4), '150 more chapters come in slowly in the background. Oldest first. About 38 hours at the current pace.');
  assert.equal(archiveSwitchHelp('latest', 175, 4), '175 older chapters come in slowly in the background. Newest first. About 44 hours at the current pace.');
  // One chapter has no order and no plural.
  assert.equal(archiveSwitchHelp('latest', 1, 4), '1 older chapter comes in slowly in the background. Under an hour at the current pace.');
  // A faster setting is a shorter estimate, by the server's arithmetic.
  assert.equal(archiveSwitchHelp('none', 200, 30), '200 chapters come in slowly in the background. Oldest first. About 8 hours at the current pace.');
});

test('what became of queueing: the add dialog, one series, a Library selection', () => {
  assert.match(archiveAddLine('later'), /^The rest comes in slowly/, "a download's rest, queued once its own chapters are in, reads as not queued");
  assert.match(archiveAddLine('queued'), /^The rest comes in slowly/);
  assert.match(archiveAddLine('queued', true), /^Its chapters come in slowly/, 'a Nothing yet add calls every chapter "the rest"');
  assert.equal(archiveAddLine('nothing'), 'Nothing older was left to archive.');
  assert.equal(archiveAddLine('denied'), 'The rest could not be queued for the slow archive.');
  assert.equal(archiveAddLine(undefined), '');
  const outcomes: EnqueueOutcome[] = ['queued', 'already', 'nothing', 'unrouted', 'denied', 'not_found'];
  const msgs = new Set(outcomes.map((o) => archiveOutcomeNotice(o, 'One').msg));
  assert.equal(msgs.size, outcomes.length, 'two outcomes read the same');
  assert.deepEqual(archiveOutcomeNotice('queued', 'One'), { msg: 'Archiving One slowly', tone: 'success' });
  assert.equal(archiveOutcomeNotice('unrouted', 'One').tone, 'error');
  // Reintroduce by counting every outcome as queued: "3 series queued" for a selection where one was.
  const r = (outcome: EnqueueOutcome, id: string = outcome) => ({ id, outcome });
  assert.deepEqual(archiveBulkNotice([r('queued'), r('nothing', 'n1'), r('nothing', 'n2'), r('already')]),
    { msg: '1 series queued for the slow archive · 1 already being archived · 2 had nothing older to fetch', tone: 'success' });
  assert.deepEqual(archiveBulkNotice([r('nothing')]), { msg: '1 had nothing older to fetch', tone: 'info' });
  assert.deepEqual(archiveBulkNotice([r('denied'), r('not_found')]), { msg: '2 could not be queued', tone: 'error' });
});
