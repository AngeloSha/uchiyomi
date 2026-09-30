// Find other sources, the other names, and "the site says it is offline": the web half.
//
// The server runs ONE calm search at a time for other sources (POST /api/admin/sources/find) and PROPOSES: nothing is
// followed until an admin confirms it on the search's review (app/admin/find/page.tsx). These hold what the page makes
// of it -- the words, the one-search-at-a-time gate, where each key posts and that it opens the review, that an amber
// match is never followed in bulk, and the wording of the offline diagnosis. The pure rules are lib/findSources.ts;
// the wiring is read from source, as healthActions.test.ts does. The idea, the review and the other-names list are
// @TIGamingTV's (PR #119).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setActiveDict } from '../lib/i18n';
import {
  altKey, altOriginLabel, altRefusal, coverageLine, findEta, findGate, findRefusalLine, findRunState, findSummary, itemLine,
  mayFollow, pickedFor, preselect, progressLine, ranges, reviewHref, startRefusal, FIND_SERIES_MAX_MS,
  type FindCandidate, type FindItem, type FindRun, type FindStatus,
} from '../lib/findSources';
import { ACTION_COPY } from '../lib/healthCopy';
import { answerView, evidenceView, healthRowEvidence, type StageLine } from '../lib/sourceEvidence';
import { diagnosisFix, diagnosisReason } from '../lib/said';
import { runProgress, runTitle, type RunCard } from '../lib/jobs';
import { navRing, runName, runWaitLine, type SourceJobs } from '../lib/serverDownloads';
import { FindRunRow } from '../components/FindSources';

(globalThis as any).React = React;
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed: several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
/** The source from `from` to `to`, failing by name when a marker moved rather than reading nothing. */
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

const run = (o: Partial<FindRun> = {}): FindRun => ({
  id: 'r1', status: 'running', total: 189, done: 12, found: 3, open: 4, followed: 0, failed: 0,
  startedBy: 'u1', startedAt: '2026-09-28T10:00:00Z', finishedAt: null, ...o,
});
const status = (o: Partial<FindStatus> = {}): FindStatus => ({ running: false, run: null, recent: [], ...o });
const cand = (o: Partial<FindCandidate> = {}): FindCandidate => ({
  id: 'c', itemId: 'i', source: 's', name: 'S', sourceSeriesId: 'x', theirTitle: 'T', cover: null, ourName: null, theirName: null,
  coverageFwd: 1, coverageBack: 1, verdict: 'ok', manual: false, status: null, ...o,
});
const item = (o: Partial<FindItem> = {}): FindItem => ({
  id: 'i', seriesId: 's1', title: 'Solo Leveling', names: ['Solo Leveling'], state: 'done', asked: 3, unreachable: 0,
  primary: null, following: [], freeSlots: 2, candidates: [], ...o,
});

/* ================================================================ what a search found */

test('a search says how far it got and what it found -- never that it followed something it only found', () => {
  // The owner's #132 report: a run that followed silently, or found nothing, read the same. A search now proposes.
  // Reintroduce `followedText(run.found)`: "a search says it followed what it only found" fails.
  assert.equal(progressLine(run()), '12 of 189 series · Sources found for 3 series');
  assert.equal(progressLine(run({ total: 1, done: 0, found: 0 })), '', 'a search of one series counts itself');
  assert.equal(findSummary(run({ status: 'review', done: 189 })), 'Sources found for 3 series · 4 matches to review');
  assert.equal(findSummary(run({ status: 'review', done: 189, found: 1, open: 1 })), 'Sources found for 1 series · 1 match to review', 'one is counted as many');
  assert.doesNotMatch(findSummary(run({ status: 'review', done: 189 })), /followed/, 'a search says it followed what it only found');
  assert.equal(findSummary(run({ status: 'done', done: 189, found: 0, open: 0 })), 'Nothing found');
  assert.equal(findSummary(run({ status: 'done', done: 189, open: 0, followed: 2 })), 'Sources found for 3 series · 2 sources followed');
  // Cut short: what it did stands, and how far it got is said.
  assert.equal(findSummary(run({ status: 'stopped', done: 50 })), 'Stopped before it finished · 50 of 189 series · Sources found for 3 series · 4 matches to review');
  assert.equal(findSummary(run({ status: 'interrupted', done: 50, open: 0 }), { status: false }), '50 of 189 series · Sources found for 3 series');
});

test('a search as a status line: working with its Stop, then what it found -- amber while matches wait', () => {
  const stop = () => {};
  const on = findRunState(run({ current: { seriesId: 's9', title: 'Solo Leveling' } }), { onStop: stop });
  assert.ok(on.kind === 'working');
  assert.equal(on.step, '12 of 189 series · Sources found for 3 series');
  assert.equal(on.detail, 'Solo Leveling');
  assert.equal(on.onStop, stop);
  const waiting = findRunState(run({ waiting: 'check' }));
  assert.ok(waiting.kind === 'working' && waiting.detail === 'Waiting for the source check to finish', 'a waiting search does not say why');
  const review = findRunState(run({ status: 'review', done: 189, finishedAt: '2026-09-28T11:00:00Z' }));
  assert.ok(review.kind === 'done' && review.partial === true, 'matches waiting read as all done');
  const done = findRunState(run({ status: 'done', done: 189, open: 0, finishedAt: '2026-09-28T11:00:00Z' }));
  assert.ok(done.kind === 'done' && !done.partial && done.tookMs === 3_600_000);
  assert.equal(findRunState(run({ status: 'failed' })).kind, 'failed');
  // The row renders its Stop while it searches, and no key once it is over.
  const live = renderToStaticMarkup(createElement(FindRunRow, { run: run(), onStop: stop }));
  assert.match(live, /data-find-stop/);
  const over = renderToStaticMarkup(createElement(FindRunRow, { run: run({ status: 'review', done: 189 }), onStop: stop }));
  assert.doesNotMatch(over, /data-find-stop/, 'a finished search offers Stop');
});

test('one search at a time: a key waits, saying why, while another goes', () => {
  const busy = 'Another search for other sources is running; this can start when it ends';
  assert.deepEqual(findGate(status({ running: true, run: run() })), { disabled: true, disabledWhy: busy });
  assert.deepEqual(findGate(status()), {});
  assert.deepEqual(findGate(undefined), {});
});

test('a refused start or follow is read by its code -- never a generic failure', () => {
  assert.equal(startRefusal(409, 'busy'), 'Another search for other sources is running; this can start when it ends');
  assert.equal(startRefusal(400, 'empty_scope'), 'No series to search for');
  assert.equal(startRefusal(400, 'too_many'), 'Too many series for one search: 500 at most');
  // Reintroduce the owner's `bad_request` = "500 at most": a malformed body read as too many series.
  assert.equal(startRefusal(400, 'bad_request'), null, 'a malformed body reads as too many series');
  assert.equal(startRefusal(400, null), null);
  // Every code the find routes refuse with has its words.
  for (const c of ['gone', 'posting_order', 'full', 'cap', 'too_few', 'already_followed', 'primary', 'unknown_source', 'unavailable',
    'unreachable', 'title_differs', 'not_this_series', 'changed', 'closed', 'busy', 'still_searching', 'not_followable',
    'nothing_to_follow', 'not_resumable', 'not_found']) {
    assert.ok(findRefusalLine(c), `${c} has no words`);
  }
  assert.equal(findRefusalLine('title_differs', 'Alpha Tale'), 'None of its names is one of this series’ names: it is called “Alpha Tale”.');
  assert.equal(findRefusalLine('something_new'), null);
  const hook = code(read('lib/useFindRun.tsx'));
  assert.match(hook, /startRefusal\(e instanceof ApiError \? e\.status : null, codeOf\(e\)\) \?\? msgOf\(e, tr\('Could not start the search'\)\)/);
  assert.match(hook, /findRefusalLine\(codeOf\(e\), fieldOf\(e, 'theirTitle'\)\) \?\? msgOf\(e, fallback\)/);
});

test("the estimate is the search's own wall per series (120 s) plus the 1.5 s pace", () => {
  assert.equal(FIND_SERIES_MAX_MS, 121_500);
  assert.equal(findEta(1), 'Up to 3 minutes');
  assert.equal(findEta(null), 'Up to about two minutes per series');
});

/* ================================================================ the review */

test('missing chapters read as runs, decimals alone, long lists cut', () => {
  assert.equal(ranges([1, 2, 3, 5, 7, 8]), '1–3, 5, 7–8');
  assert.equal(ranges([3, 1, 2, 2]), '1–3', 'unsorted and duplicated input');
  assert.equal(ranges([12, 12.5, 13]), '12, 12.5, 13', 'a decimal never joins a run');
  assert.match(ranges(Array.from({ length: 20 }, (_, i) => i * 3), 5), /^0, 3, 6, 9, 12 \+ 15 more$/);
  assert.equal(ranges([]), '');
});

test('"Select exact matches" ticks only green matches, best first, up to the free places', () => {
  // Reintroduce by ticking amber ones too: a source whose chapters do not line up is followed on a default nobody chose.
  const it = item({
    freeSlots: 1,
    candidates: [
      cand({ id: 'a', coverageFwd: 0.92, coverageBack: 0.95 }),
      cand({ id: 'b', coverageFwd: 1, coverageBack: 1 }),
      cand({ id: 'w', verdict: 'numbering_differs' }),
      cand({ id: 'done', status: 'linked' }),
    ],
  });
  assert.deepEqual([...preselect([it])], ['b']);
  assert.deepEqual([...preselect([{ ...it, freeSlots: 0 }])], [], 'a full series gets nothing');
  assert.equal(pickedFor(it, new Set(['a', 'x'])), 1);
  assert.equal(mayFollow({ verdict: 'ok' }), true);
  assert.equal(mayFollow({ verdict: 'numbering_differs' }), false);
  assert.equal(coverageLine(cand({ coverageFwd: 0.98, coverageBack: 0.95 })), 'Has 98% of this series’ chapters · this series has 95% of its');
  assert.equal(coverageLine(cand({ coverageFwd: null })), null);
});

test('each series says why it was not searched, or what its search found when it found nothing', () => {
  assert.equal(itemLine(item({ state: 'skipped', note: 'posting_order' })), 'Numbered by posting order: no other source’s numbers line up with it');
  assert.equal(itemLine(item({ state: 'skipped', note: 'full' })), 'Already follows as many other sources as a series may');
  assert.equal(itemLine(item({ state: 'skipped', note: 'too_few' })), 'Too few chapters to compare (fewer than 3)');
  assert.equal(itemLine(item({ state: 'skipped', note: 'no_source' })), 'No other source could be asked');
  assert.equal(itemLine(item({ state: 'pending' })), 'Not searched yet', 'a series never reached reads as searched');
  assert.equal(itemLine(item()), 'No other source lists it under its title or other names');
  assert.equal(itemLine(item({ asked: 3, unreachable: 3 })), 'No other source answered', 'nothing answered reads as nothing found');
  assert.equal(itemLine(item({ candidates: [cand()] })), null);
});

test('an amber match is never ticked for a bulk follow: it is followed on its own, confirmed, from its chapters', () => {
  // Review of #119: one confirmation used to cover every selected warning across every series -- the wrong-book case
  // in bulk. Reintroduce by sending `override`, or by giving an amber row a checkbox: this fails.
  const page = code(read('app/admin/find/page.tsx'));
  assert.doesNotMatch(page, /override/, 'the bulk override is back');
  assert.match(page, /const tickable = reviewing && open && mayFollow\(c\);/);
  assert.match(page, /const chosen = all\.filter\(\(c\) => selected\.has\(c\.id\) && isOpen\(c\) && mayFollow\(c\)\);/);
  assert.match(page, /`\/api\/admin\/sources\/find\/candidates\/\$\{id\}\/follow`, \{ json: \{ confirm: true \} \}/);
  assert.match(page, /onClick=\{\(\) => setConfirmSingle\(viewed\.id\)\}/, 'following one on its own is not behind a confirmation');
  assert.match(page, /`\/api\/admin\/sources\/find\/\$\{runId\}\/follow`, \{ json: \{ candidateIds: chosen\.map\(\(c\) => c\.id\) \} \}/);
});

test('the review shows a match\'s chapters before it is ticked, and the search by hand can too', () => {
  const page = code(read('app/admin/find/page.tsx'));
  assert.match(page, /onClick=\{\(\) => onChapters\(c\)\}[^>]*>\{tr\('Chapters'\)\}/, 'the match has no Chapters key');
  assert.match(page, /<FindChapterList itemId=\{viewedItem\.id\} source=\{viewed\.source\} sourceSeriesId=\{viewed\.sourceSeriesId\} \/>/);
  const pick = code(read('components/FindPickSheet.tsx'));
  assert.match(pick, /preview && pending \? \(\s*<FindChapterList itemId=\{item\.id\} source=\{pending\.source\} sourceSeriesId=\{pending\.sourceId\} \/>/, 'a pick cannot be previewed');
  assert.match(pick, /`\/api\/admin\/sources\/find\/items\/\$\{encodeURIComponent\(item\.id\)\}\/candidates`/);
  assert.match(code(read('components/FindChapterList.tsx')), /\/api\/admin\/sources\/find\/items\/\$\{encodeURIComponent\(itemId\)\}\/chapters\?source=/);
});

test('the search by hand runs on Search, never per keystroke, and keeps asking while sources are pending', () => {
  // Reported on the fork: typing a title returned nothing -- a debounce fanned every partial term out to every source.
  const src = code(read('components/FindPickSheet.tsx'));
  assert.doesNotMatch(src, /setTimeout\(/, 'the search is debounced per keystroke again');
  assert.match(src, /<form role="search" onSubmit=\{\(e\) => \{ e\.preventDefault\(\); search\(term\); \}\}/);
  assert.match(src, /onClick=\{\(\) => search\(n\)\}/, 'a name does not search');
  assert.match(src, /refetchInterval: \(qy\) => \(qy\.state\.data\?\.pending \? POLL_MS : false\)/);
  assert.match(src, /&wait=\$\{first \? FIRST_WAIT_MS : POLL_WAIT_MS\}/);
  // Its own sources are not offered.
  assert.match(src, /const groups = \(data\?\.content \?\? \[\]\)\.filter\(\(g\) => !taken\.has\(g\.source\)\);/);
});

test('a stopped or interrupted search offers to search on; its footer follows only what is ticked', () => {
  const page = code(read('app/admin/find/page.tsx'));
  assert.match(page, /\{cutShort\(run\.status\) && pending > 0 && \(/);
  assert.match(page, /api\(`\/api\/admin\/sources\/find\/\$\{runId\}\/resume`, \{ method: 'POST' \}\)/);
  assert.match(page, /chosen\.length === 1 \? tr\('Follow 1 selected source'\) : tr\('Follow \{n\} selected sources', \{ n: chosen\.length \}\)/);
  assert.match(page, /disabled=\{busy === 'follow' \|\| !chosen\.length\}/);
  assert.equal(reviewHref('abc'), '/admin/find/?run=abc');
});

/* ================================================================ where a search starts */

test('every key that starts a search opens its review, and waits while another search goes', () => {
  const hook = code(read('lib/useFindRun.tsx'));
  const start = slice(hook, 'export function useStartFind()', '');
  assert.match(start, /api<\{ runId: string; total: number \}>\('\/api\/admin\/sources\/find', \{ method: 'POST', json: scope \}\)/);
  assert.match(start, /router\.push\(reviewHref\(r\.runId\)\);/, 'a start does not open its review');
  assert.match(start, /catch \(e\) \{\s*toast\(findRefusal\(e\), 'error'\);/, 'a refused start is not said');
  // Library: a row of More for admins, the selection posted.
  const lib = code(read('app/library/page.tsx'));
  const fn = slice(lib, 'const findSelected = async () => {', 'const sentinel = useRef');
  assert.match(fn, /await startFind\(\{ seriesIds: \[\.\.\.picked\] \}\)/);
  const more = slice(lib, "<Sheet title={tr('{n} selected'", '</Sheet>');
  assert.match(more, /\{isAdmin && \([\s\S]*?setMore\(false\); void findSelected\(\);[\s\S]*?\{tr\('Find other sources'\)\}/, 'More has no Find other sources for admins');
  // Health: the row's source, the key waiting while another search goes.
  const row = slice(code(read('components/HealthActions.tsx')), 'export function HealthRow', 'const SCAN_CHECKS');
  const arm = slice(row, "case 'find_sources':", "case 'renumber':");
  assert.match(arm, /\.\.\.findGate\(findStatus\),/, 'the key starts while another search goes');
  assert.match(arm, /onRun: \(\) => \{ if \(item\.sourceId\) void startFind\(\{ sourceId: item\.sourceId \}\); \}/);
  assert.match(arm, /label: copy\.label\(\{ \.\.\.ctx, n: item\.findSeries \}\)/, "the row's key does not say how many series");
  assert.match(row, /const specs = all\.filter\(\(s\) => s\.id !== 'find_sources'\);\s*const finds = all\.filter\(\(s\) => s\.id === 'find_sources'\);/,
    "the find key shares the row's group");
  // Health's card, under the checks, with the way to the review.
  const health = slice(code(read('app/admin/page.tsx')), 'function Health()', 'function DesktopUpdateNote(');
  assert.match(health, /<FindRunCard \/>\s*<RepairHistory \/>/);
  assert.match(code(read('components/FindSources.tsx')), /<Link href=\{reviewHref\(run\.id\)\} className="btn-key" data-find-review>/);
});

test('the Sources sheet: Find more sources for this one series, below the other names, not for posting order or a full series', () => {
  const sheet = code(read('components/SourcesSheet.tsx'));
  const find = slice(sheet, 'function FindMore(', 'function OtherNames(');
  assert.match(find, /onRun: \(\) => \{ void start\(\{ seriesIds: \[id\] \}\); \}/, 'Find more sources does not start a search for this series');
  assert.match(find, /\.\.\.\(why \? \{ disabled: true, disabledWhy: why \} : findGate\(status\)\),/, 'Find more sources starts while another search goes');
  assert.match(find, /const why = postingOrder \? tr\('Numbered by posting order: no other source’s numbers line up with it'\)\s*: followers >= MAX_FOLLOWERS/);
  assert.match(find, /what: tr\('Searches the other sources under this title and its other names, and shows what it finds: you choose what to follow\.'\),/);
  const body = slice(sheet, 'export function SourcesSheet(', '');
  const translated = body.indexOf("<Eyebrow>{tr('Translated by')}</Eyebrow>");
  const names = body.indexOf('<OtherNames id={id} />');
  const more = body.indexOf('<FindMore id={id}');
  assert.ok(translated > 0 && names > translated, 'the other names push Prefer and Block down');
  assert.ok(more > names, 'Find more sources pushes Prefer and Block down');
  assert.match(body, /\{adminAccount && <OtherNames id=\{id\} \/>\}/, "a member sees the admin's other names");
  assert.match(body, /postingOrder=\{qc\.getQueryData<Listing>\(\['series-listing', id\]\)\?\.numbering\?\.mode === 'posting_order'\}/);
});

test("Health's key: what it does for how many series, how, and how long before the press", () => {
  const c = ACTION_COPY.find_sources;
  assert.equal(c.label({}), 'Find other sources');
  assert.equal(c.label({ n: 189 }), 'Find other sources (189 series)');
  assert.equal(c.label({ n: 1 }), 'Find other sources (1 series)');
  assert.match(c.what({ n: 189 }), /^Searches the other sources for the 189 series that come from this source, and shows what it finds/);
  assert.match(c.what({ n: 1 }), /for the 1 series that comes from this source/, 'one series');
  assert.match(c.what({}), /for every series that comes from this source/);
  const how = c.how!({});
  for (const fact of [/1\.5 seconds apart/, /chapter sweep, a repair or the daily check/, /up to 3 other names/, /never asks this source/, /posting order is skipped/, /only on its own/]) {
    assert.match(how, fact);
  }
  assert.equal(c.eta({}), 'Up to about two minutes per series');
  const de = JSON.parse(read('public/locales/de.json'));
  setActiveDict(de);
  try {
    assert.equal(c.label({ n: 189 }), de['Find other sources ({n} series)'].replace('{n}', '189'));
  } finally { setActiveDict({}); }
});

/* ================================================================ Server tasks */

test("Server tasks: the search's card is named as a noun, counts what it found, stops through its own route, and opens its review", () => {
  assert.equal(runTitle('find_sources'), 'Other-source search');
  const card: RunCard = { kind: 'find_sources', startedAt: 0, status: 'running', done: 12, total: 189, fetched: 0, failed: 0, found: 3, runId: 'r1', current: { id: 's9', title: 'Solo Leveling' } };
  assert.equal(runName(card), 'Other-source search');
  assert.equal(runProgress(card), '12 of 189 series · Sources found for 3 series');
  assert.equal(runProgress({ ...card, found: 1 }), '12 of 189 series · Sources found for 1 series');
  const view = code(read('components/ServerDownloadsView.tsx'));
  assert.match(view, /const cancelRun = \(kind: string\) => call\(kind === 'find_sources' \? '\/api\/admin\/sources\/find\/stop' : `\/api\/sources\/runs\/\$\{kind\}\/cancel`, 'POST'\);/);
  const task = slice(view, 'function TaskRow(', 'function CameInTile(');
  assert.match(task, /\{find && admin && r\.runId && \(\s*<Link href=\{reviewHref\(r\.runId\)\} data-find-review/, 'the card has no way to its review');
});

test('Server tasks: a find run waiting for a sweep, a repair or the daily check says so on its card', () => {
  // The jobs route's card carries `waiting` (lane F's review fix), and the card went on saying "Now: <the series it did
  // last>" for as long as the sweep took. Reintroduce the series line alone in TaskRow: "the card names a series while
  // the run waits" fails; answer '' in runWaitLine: "the waiting card does not say why".
  const card: RunCard = { kind: 'find_sources', startedAt: 0, status: 'running', done: 12, total: 189, fetched: 0, failed: 0, followed: 3, current: { id: 's9', title: 'Solo Leveling' } };
  assert.equal(runWaitLine({ ...card, waiting: 'check' }), 'Waiting for the source check to finish', 'the waiting card does not say why');
  assert.equal(runWaitLine({ ...card, waiting: 'sweep' }), 'Waiting for the scheduled check to finish');
  assert.equal(runWaitLine({ ...card, waiting: 'repair' }), 'Waiting for the library repair to finish');
  assert.equal(runWaitLine(card), '', 'a run that is not waiting says it waits');
  assert.equal(runWaitLine({ ...card, status: 'done', waiting: 'check' }), '', 'a run that ended still waits');
  const task = slice(code(read('components/ServerDownloadsView.tsx')), 'function TaskRow(', 'function CameInTile(');
  assert.match(task, /const wait = runWaitLine\(r\);/);
  assert.match(task, /\{wait\s*\?\s*<p [^>]*data-task-waiting>\{wait\}<\/p>\s*:\s*running && r\.current\?\.title && \(?\s*<p /,
    'the card names a series while the run waits');
});

test("Server tasks: a series title is cut at its own end, whatever the page's direction", () => {
  // Arabic walk: "الآن: …e until the line runs out of screen". The title sat in a <bdi> inside a truncating line,
  // which takes the page's direction, so the line's ellipsis took the English title's START. The title now truncates
  // in its own box, with its own direction, beside the words of the line; a series title alone in a truncating line
  // has its own direction. Reintroduce the old line: "the title is cut by the line"; drop a dir="auto": its line is named.
  const view = code(read('components/ServerDownloadsView.tsx'));
  const task = slice(view, 'function TaskRow(', 'function CameInTile(');
  assert.match(task, /<p className="mt-0\.5 flex min-w-0 text-\[11px\] text-fog-400" data-task-now>\s*<span className="shrink-0 whitespace-pre">\{nowBefore\}<\/span>\s*<bdi dir="auto" className="block min-w-0 truncate">\{r\.current\.title\}<\/bdi>/,
    'the title is cut by the line');
  assert.doesNotMatch(task, /truncate[^"]*">\{nowBefore\}/, 'the title is cut by the line');
  for (const [file, src] of [['ServerDownloadsView.tsx', view], ['ArchiveQueue.tsx', code(read('components/ArchiveQueue.tsx'))]] as const) {
    const lines = src.split('\n').filter((l) => /<p [^>]*\btruncate\b[^>]*>\{\w+\.title\}<\/p>/.test(l));
    assert.ok(lines.length > 0, `${file}: no series title in a truncating line -- this scan is broken`);
    for (const l of lines) assert.match(l, /<p dir="auto" /, `${file}: a series title takes the page's direction: ${l.trim()}`);
  }
});

test('a find run never turns the Library ring: it follows sources, it fetches nothing', () => {
  // Reintroduce by dropping `r.kind !== 'find_sources'` from navRing: the admin's ring turns for the hours aqua's 189
  // series take, and "the ring turns for a find run" fails.
  const d: Partial<SourceJobs> = { content: [], runs: [{ kind: 'find_sources', startedAt: 0, status: 'running', done: 3, total: 189, fetched: 0, failed: 0 }], activity: { active: [], recent: [] } };
  const ring = navRing(d);
  assert.equal(ring.show, false, 'the ring turns for a find run');
  assert.equal(ring.progress, 'idle');
});

/* ================================================================ the other names */

test('a name is removed by its key: the server\'s own, else the title keyed as the server keys it', () => {
  // DELETE /api/admin/series/:id/alt-titles/:norm takes the key, and GET's titles need not carry it. Reintroduce the
  // raw title in the path (`encodeURIComponent(a.title)`): "Na Honjaman Level Up" deletes nothing, and the source check
  // below fails too.
  assert.equal(altKey({ title: 'Na Honjaman Level Up!' }), 'nahonjamanlevelup');
  assert.equal(altKey({ title: 'Solo Leveling', norm: 'sololeveling' }), 'sololeveling');
  assert.equal(altKey({ title: 'Ore dake Level Up na Ken', norm: 'server-own' }), 'server-own', "the server's own key is ignored");
  const sheet = code(read('components/SourcesSheet.tsx'));
  const names = slice(sheet, 'function OtherNames(', 'const emptyStat');
  assert.match(names, /api<\{ titles: AltTitle\[\] \}>\(`\/api\/admin\/series\/\$\{encodeURIComponent\(id\)\}\/alt-titles`\)/, 'the names are not read from their route');
  assert.match(names, /`\/api\/admin\/series\/\$\{encodeURIComponent\(id\)\}\/alt-titles`, \{ json: \{ title \} \}/, 'a name is not added through its route');
  assert.match(names, /`\/api\/admin\/series\/\$\{encodeURIComponent\(id\)\}\/alt-titles\/\$\{encodeURIComponent\(altKey\(a\)\)\}`, \{ method: 'DELETE' \}/,
    'a name is not removed by its key');
  // Every answer is the whole list, and replaces the one shown.
  assert.equal((names.match(/qc\.setQueryData\(key, await api/g) ?? []).length, 2, 'an add or a remove does not show the list it answered');
});

test('a refused name says why under the field; anything else is a notice', () => {
  // Reintroduce a generic "Could not add that name" for a 400/409: the admin is not told the name is too short, not in
  // Latin letters, or already there.
  assert.match(altRefusal('too_short') ?? '', /at least 5 letters or digits/, 'a short name is not told why');
  assert.match(altRefusal('non_latin')!, /Latin letters/);
  assert.match(altRefusal('exists')!, /already has that name/);
  assert.equal(altRefusal('bad_request'), null);
  assert.equal(altRefusal(null), null);
  assert.equal(altOriginLabel('description'), 'from a source’s description');
  assert.equal(altOriginLabel('admin'), 'added by an admin');
  assert.equal(altOriginLabel('import'), 'from an import');
  assert.equal(altOriginLabel('merged'), '', "a newer server's origin reads as its code");
  const names = slice(code(read('components/SourcesSheet.tsx')), 'function OtherNames(', 'const emptyStat');
  assert.match(names, /const why = altRefusal\(codeOf\(e\)\);\s*if \(why\) setRefusal\(why\);\s*else toast\(msgOf\(e, tr\('Could not add that name'\)\), 'error'\);/,
    'a refusal is not said under the field');
  assert.match(names, /\{refusal && <p id=\{`alt-refusal-\$\{id\}`\} role="alert"/, 'the refusal is not announced where the field is');
  assert.match(names, /aria-describedby=\{refusal \? `alt-refusal-\$\{id\}` : undefined\}/, 'the field does not point at its refusal');
});


test('Other names: the refusal under the field goes once the name it answered is removed, or another is added', () => {
  // The walk refused a name the series already had, removed that name, and read "No other names yet." above "This
  // series already has that name.". Reintroduce by dropping setRefusal(null) from remove: "a removed name leaves the
  // refusal it answered" fails.
  const names = slice(code(read('components/SourcesSheet.tsx')), 'function OtherNames(', 'const emptyStat');
  const remove = slice(names, 'const remove = async', 'return (');
  assert.match(remove, /qc\.setQueryData\(key, await api<[^\n]+\{ method: 'DELETE' \}\)\);\s*setRefusal\(null\);\s*\} catch/, 'a removed name leaves the refusal it answered');
  const add = slice(names, 'const add = async', 'const remove = async');
  assert.match(add, /setBusy\(true\);\s*setRefusal\(null\);/, 'a name added keeps the refusal of the one before it');
  assert.equal((add.match(/setRefusal\(why\)/g) ?? []).length, 1, 'an add sets a refusal other than its own');
});

/* ================================================================ the site says it is offline */

test('the site says it is offline: worded by its code where every diagnosis is, and its stage lines say so', () => {
  // aqua's own "temporarily offline" page, which Health read as "markup may not match this engine". Its reason and fix
  // are worded by code in lib/said.ts, as every diagnosis is (REASON_WORDS.site_offline and 'fix.siteOffline': the
  // integration folded this lane's own wording into them). Reintroduce `d?.reason` in answerView: in German the
  // verdict is the server's English, and "the offline verdict is not in the reader's language" fails.
  const d = {
    code: 'site_offline', reason: 'The site says it is offline (its own page)',
    fix: 'Wait for the site to come back, or find other sources for its series.', fixSaid: { code: 'fix.siteOffline' },
  };
  assert.equal(diagnosisReason(d), d.reason, "the offline verdict is not the server's sentence");
  assert.equal(diagnosisFix(d), d.fix, "the offline fix is not the server's sentence");
  assert.equal(diagnosisReason({ code: 'from_a_newer_server', reason: 'Blocked.' }), 'Blocked.', 'a code this build does not know loses the server\'s words');
  const de = JSON.parse(read('public/locales/de.json'));
  setActiveDict(de);
  try {
    const offline: StageLine = { stage: 'search', state: 'fail', at: null, by: 'sweep', kind: 'site_offline', error: 'Aqua Manga is temporarily offline' };
    const v = answerView({ ok: false, state: 'fail', stage: 'search', diagnosis: d,
      checks: [{ name: 'Search', ok: false, detail: 'offline page', stage: 'search', kind: 'site_offline', error: 'Aqua Manga is temporarily offline' }] });
    assert.equal(v.head?.text, de['The site says it is offline (its own page)'], 'the offline verdict is not in the reader\'s language');
    assert.equal(v.fix, de['Wait for the site to come back, or find other sources for its series.']);
    assert.equal(v.rows[0].detail, de['the site says it is offline'], 'the Test\'s search line does not say the site is offline');
    assert.equal(evidenceView([offline]).rows[0].detail, de['the site says it is offline'], 'the stage line does not say the site is offline');
    // Health: the fix only where the row's own detail does not already end with it, both in the reader's language
    // (the rows as the server sends them, lib/health.ts sourceTrouble: the English with its codes).
    const row = {
      evidence: [offline], diagnosis: d,
      detail: 'Search failing since 2026-09-23 14:20 — The site says it is offline (its own page). 195 series use it',
      detailSaid: [
        { code: 'sources.failing', params: { stage: 'search', since: '2026-09-23T14:20:00.000Z', also: [] } },
        { code: 'sources.reason', params: { diagnosis: 'site_offline' }, join: 'dash' as const },
        { code: 'sources.uses', params: { n: 195 }, join: 'sentence' as const },
      ],
    };
    assert.equal(healthRowEvidence(row).fix, de['Wait for the site to come back, or find other sources for its series.']);
    const cooling = {
      ...row, detail: `down; 195 series use it — ${d.fix}`,
      detailSaid: [
        { code: 'sources.status', params: { status: 'down' } }, { code: 'sources.uses', params: { n: 195 } },
        { code: 'fix.siteOffline', join: 'dash' as const },
      ],
    };
    assert.equal(healthRowEvidence(cooling).fix, null, 'the fix is said twice');
  } finally { setActiveDict({}); }
});

test('a typed, stored or found name takes its own direction', () => {
  // The review's ar-s1m-04: in Arabic the field showed "WALK tale other-name!" as "!WALK tale other-name".
  const names = slice(code(read('components/SourcesSheet.tsx')), 'function OtherNames(', 'const emptyStat');
  assert.match(names, /<input dir="auto" value=\{draft\}/, "the other-name field takes the page's direction");
  assert.match(names, /<span dir="auto" className="block truncate text-sm text-fog-100" title=\{a\.title\}>\{a\.title\}<\/span>/);
  const page = code(read('app/admin/find/page.tsx'));
  assert.match(page, /<p dir="auto" className="line-clamp-2 break-words text-sm text-fog-100">\{c\.theirTitle \|\| c\.sourceSeriesId\}<\/p>/, "a match's title takes the page's direction");
  assert.match(page, /<Link href=\{seriesHref\(it\.seriesId\)\} dir="auto"/, "a series' title takes the page's direction");
  assert.match(code(read('components/FindPickSheet.tsx')), /<input ref=\{inputRef\} dir="auto"/);
});
