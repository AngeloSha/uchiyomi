// Admin → Tasks → Rescan everything (v0.55.4, discussion #150): what the panel says about a preview, a run and an
// Apply (lib/rescan.ts), the Tasks line's result (lib/tasks.ts), and the panel's wiring into the Tasks list.
//
// The preview is the only thing between an admin and a library-wide change, so each sentence that could read as
// "nothing to worry about" while something was left alone is held here: a folder that looked unmounted leads its
// line, the download folder's files are said to be Verify's, and a refused Apply names the job it would run beside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appliedLine, applyRefusalText, exampleLine, numbersLine, planHeadline, progressLine, rescanView, uncheckedLine, unmountedLine,
  type RescanStatus,
} from '../lib/rescan';
import { taskResult } from '../lib/tasks';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
/** The source with its comments blanked, so a rule quoted in a comment is not read as code. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the headline says the four counts, each with its singular, and the first one always', () => {
  // Reintroduce by dropping the download-folder clause: the second line below loses "left to Verify chapter files",
  // and an admin reads a preview with gone downloads as one without.
  assert.equal(planHeadline({ gone: 0, moved: 0, downloads: 0, emptied: 0 }), 'No chapter file is gone from your folders');
  assert.equal(planHeadline({ gone: 12, moved: 3, downloads: 4, emptied: 2 }),
    '12 chapter files are gone from your folders · 3 were probably moved or renamed (kept) · 4 in the download folder, left to Verify chapter files · 2 series with nothing left');
  assert.equal(planHeadline({ gone: 1, moved: 1, downloads: 1, emptied: 1 }),
    '1 chapter file is gone from your folders · 1 was probably moved or renamed (kept) · 1 in the download folder, left to Verify chapter files · 1 series with nothing left');
  assert.equal(planHeadline({ gone: 5, moved: 0, downloads: 0, emptied: 0 }), '5 chapter files are gone from your folders', 'a zero count is not said');
});

test('a folder left alone says why, with the share of it when that was the reason', () => {
  assert.equal(unmountedLine({ root: '/library' }), '\u2068/library\u2069 looks unmounted. Nothing under it is touched.');
  assert.equal(unmountedLine({ root: '/library', missing: 19, of: 20 }),
    '\u2068/library\u2069: 95 % of 20 chapter files are gone, which looks like a folder that is not mounted. Nothing under it is touched.');
  assert.equal(uncheckedLine(1), '1 file could not be checked and was left alone');
  assert.equal(uncheckedLine(3), '3 files could not be checked and were left alone');
});

test('a running rescan says its phase, and how far when there is a count', () => {
  const s = (phase: any, done = 0, of: number | null = null, running: any = 'preview') => progressLine({ running, phase, done, of });
  assert.equal(s('scan'), 'Scanning the library…');
  assert.equal(s('look', 1200, 4000), 'Looking for every chapter file: 1200 of 4000');
  assert.equal(s('look', 0, 0), 'Looking for every chapter file…', 'no "0 of 0"');
  assert.equal(s('pair', 3, 7), 'Checking for moved or renamed files: 3 of 7');
  assert.equal(s('numbers'), 'Reading file names by the new rules…');
  assert.equal(s('mark', 9, 4, 'apply'), 'Applying: 4 of 4', 'done never runs past the total');
  assert.equal(s(null, 0, null, 'apply'), 'Applying…');
});

test('a series of the opt-in says what renumbering it costs, and the tracker moves only when it is linked', () => {
  // Reintroduce by saying the tracker clauses without `tracked`: the second line below grows two clauses about a
  // tracker the series is not linked to.
  assert.equal(numbersLine({ chapters: 3, readers: 1, overrides: 1, tracked: true, up: 2, down: 1 }),
    '3 chapters are renumbered · 1 reader finished one of them · 1 with a number set by hand keeps it · 2 finished chapters get a higher number on a tracker · 1 finished chapter gets a lower number; the tracker keeps the higher one');
  assert.equal(numbersLine({ chapters: 1, readers: 0, overrides: 0, tracked: false, up: 1, down: 1 }), '1 chapter is renumbered');
  assert.equal(numbersLine({ chapters: 4, readers: 2, overrides: 3, tracked: true, up: 0, down: 0 }),
    '4 chapters are renumbered · 2 readers finished one of them · 3 with a number set by hand keep it');
  // Each part isolated: in an Arabic sentence a bare "1–7" displays as "7–1". Reintroduce by passing `to` bare.
  assert.equal(exampleLine({ file: 'T/Batman/Batman 01-07 (1987).cbz', from: '1', to: '1–7' }),
    '\u2068Batman 01-07 (1987).cbz\u2069: \u20681\u2069 → \u20681–7\u2069');
});

test('what an Apply did leads with a folder it left alone, and is the Tasks line', () => {
  // Reintroduce by pushing the unmounted clause last in appliedLine: the index check below fails.
  const r = { ok: true as const, plan: 'p', marked: 12, back: 1, changed: 2, moved: 3, downloads: 4, emptied: 1, unmounted: [], ms: 40, renumbered: { series: 2, chapters: 9 } };
  // Joined by " · ": two clauses carry a comma of their own, and commas between them read as one long clause.
  assert.equal(appliedLine(r),
    '12 chapters marked as no longer on disk · 1 back on disk before Apply, left alone · 2 changed since the preview, left alone · 3 were probably moved or renamed (kept) · 2 series renumbered by the new rules');
  const left = appliedLine({ ...r, marked: 0, back: 0, changed: 0, moved: 0, renumbered: { series: 0, chapters: 0 }, unmounted: [{ root: '/library' }] });
  assert.equal(left, '\u2068/library\u2069 no longer held the files the preview saw: nothing under it was marked · 0 chapters marked as no longer on disk');
  assert.ok(left.indexOf('no longer held') < left.indexOf('0 chapters marked'), 'the folder left alone must lead the line');
  assert.equal(appliedLine({ ...r, marked: 1, back: 0, changed: 0, moved: 0, renumbered: undefined }), '1 chapter marked as no longer on disk');
  // v0.55.4 integration (lanes J × K): a series a download was running in is left alone, and said. Reintroduce by
  // dropping the clause: a series Apply never touched reads as one with nothing gone.
  assert.equal(appliedLine({ ...r, busy: 2 }),
    '12 chapters marked as no longer on disk · 1 back on disk before Apply, left alone · 2 changed since the preview, left alone · 3 were probably moved or renamed (kept) · 2 series had a download or a check running and were left alone · 2 series renumbered by the new rules');
  assert.equal(appliedLine({ ...r, marked: 0, back: 0, changed: 0, moved: 0, renumbered: undefined, busy: 1 }),
    '0 chapters marked as no longer on disk · 1 series had a download or a check running and was left alone');
  assert.match(appliedLine({ ...r, stopped: 'shutdown' }), /^stopped for a restart · 12 chapters/);
  // The Tasks line: the rescan's result is told apart by `marked`, and never read as the verify's or the cleanup's.
  // Reintroduce by dropping the `marked` branch in taskResult: the line is empty.
  assert.equal(taskResult(r), ` · ${appliedLine(r)}`);
});

test('a refused Apply names the job it would run beside, and a stale preview asks to run it again', () => {
  // Reintroduce by answering every refusal "Already running": a sweep's clash reads as the rescan being stuck.
  assert.equal(applyRefusalText('sweep_running'), 'A chapter sweep is running — try again in a few minutes');
  assert.equal(applyRefusalText('repair_running'), 'The library repair is running — try again in a few minutes');
  assert.match(applyRefusalText('autofix_running'), /^Fix everything is running/);
  assert.match(applyRefusalText('verify_running'), /^Verify chapter files is running/);
  assert.match(applyRefusalText('cleanup_running'), /^Delete read chapters is running/);
  assert.match(applyRefusalText('scan_running'), /^A library scan is running/);
  assert.match(applyRefusalText('stale'), /Run it again/);
  assert.equal(applyRefusalText('no_plan'), applyRefusalText('stale'), 'a preview a restart forgot is a stale one');
  assert.match(applyRefusalText('applied'), /already applied/);
  assert.match(applyRefusalText('not_in_plan'), /not in this preview/);
  assert.equal(applyRefusalText('busy'), 'Already running');
  assert.equal(applyRefusalText('something new'), 'Failed');
});

test('the panel shows a run, then the preview, then the series its Apply left empty, until it is closed', () => {
  // Reintroduce by showing a result whatever plan it was for (drop `s.last?.plan === p.id`): a new preview applied by
  // nobody shows the previous Apply's series as its own. The result itself is the Tasks line's, so an Apply that left
  // no series empty leaves no panel.
  const plan = (over: object = {}) => ({ id: 'p2', applied: false, emptied: 1, ...over }) as any;
  const s = (over: Partial<RescanStatus>): RescanStatus => ({
    running: null, phase: null, done: 0, of: null, startedAt: null, error: null, plan: null, last: null, lastRun: null, ...over,
  });
  assert.equal(rescanView(null, null), 'none');
  assert.equal(rescanView(s({}), null), 'none', 'never run: nothing under the row');
  assert.equal(rescanView(s({ running: 'preview', phase: 'look' }), null), 'running');
  assert.equal(rescanView(s({ plan: plan() }), null), 'preview');
  assert.equal(rescanView(s({ plan: plan() }), 'p2'), 'none', 'a preview the admin closed');
  assert.equal(rescanView(s({ plan: plan({ applied: true }), last: { plan: 'p2' } as any }), null), 'result');
  assert.equal(rescanView(s({ plan: plan({ applied: true }), last: { plan: 'p1' } as any }), null), 'none', 'an older Apply\'s result shown as this one\'s');
  assert.equal(rescanView(s({ plan: plan({ applied: true }), last: { plan: 'p2' } as any }), 'p2'), 'none');
  assert.equal(rescanView(s({ plan: plan({ applied: true, emptied: 0 }), last: { plan: 'p2' } as any }), null), 'none', 'nothing left to link to');
  assert.equal(rescanView(s({ error: 'failed' }), null), 'failed');
  assert.equal(rescanView(s({ error: 'failed' }), 'failed'), 'none');
});

test('the Tasks row starts the preview, and the panel under it carries the plan, the ticks and Apply', () => {
  // Reintroduce by rendering the generic "Run now" for the rescan row, or by toasting "Started" for it: the
  // assertions below name which.
  const page = code(read('app/admin/page.tsx'));
  const tasks = page.slice(page.indexOf('function Tasks()'), page.indexOf('function DesktopBackups()'));
  assert.match(tasks, /\{t\.id === 'rescan' && \(\s*<div className="col-span-full row-start-3 min-w-0 lg:row-start-2">\s*<RescanPanel running=\{!!t\.running\} \/>/,
    'the rescan row has no panel under it');
  assert.match(tasks, /t\.id === 'rescan' \? tr\('Start'\) : tr\('Run now'\)/, 'the rescan row does not say Start');
  assert.match(tasks, /else if \(id === 'rescan' && r\?\.started\) qc\.invalidateQueries\(\{ queryKey: RESCAN_KEY \}\);/,
    'a started preview does not wake the panel');
  const panel = code(read('components/RescanTask.tsx'));
  // The plan the admin saw, by id, and the series ticked in its opt-in: nothing else decides what Apply does.
  assert.match(panel, /api<[^>]+>\('\/api\/admin\/tasks\/rescan\/apply', \{\s*method: 'POST', json: \{ plan: plan\.id, renumber: \[\.\.\.ticked\] \},/,
    'Apply does not send the plan id and the ticked series');
  assert.match(panel, /disabled=\{busy \|\| nothing \|\| plan\.stale\}/, 'Apply can be pressed on a stale preview, or with nothing to do');
  // Every series with nothing left is a link to its page: the rescan never hides one, so the admin decides there.
  assert.match(panel, /<Link href=\{`\/series\/\?id=\$\{encodeURIComponent\(e\.seriesId\)\}`\} dir="auto"/, 'a series with nothing left is not a link');
  // The opt-in's list scrolls in place, so it opts out of the smooth scroll like every inner scroller.
  assert.match(panel, /overflow-y-auto overscroll-contain pe-1" data-lenis-prevent/, 'the opt-in list scrolls without data-lenis-prevent');
});
