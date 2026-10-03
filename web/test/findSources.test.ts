// Find other sources, the other names, and "the site says it is offline" (v0.49.1): the web half.
//
// aqua, the owner's main source, served only its own "temporarily offline" page for days; 189 of its 195 series had
// no second source, and Health blamed the site's markup. The server runs ONE calm search at a time for other sources
// (POST /api/admin/sources/find) and words nothing itself; these hold what the page makes of it -- the words, the four
// groups of results ('not tried' is never 'nothing found'), the one-run-at-a-time gate, which answer ends a press,
// where each key posts, and the wording of the new diagnosis. The pure rules are lib/findSources.ts; the wiring is read
// from source, as healthActions.test.ts does. The idea, the other-names list and the name parsing are @TIGamingTV's
// (PR #119).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setActiveDict } from '../lib/i18n';
import {
  altKey, altOriginLabel, altRefusal, amberNote, bulkOutcome, decideRefusal, earlierRuns, findEndedRunIds, findEta, findGate, findReviewFirst,
  findRunState, findSlotState, findSummary, findWhyLine, greenToFollow, groupResults, lineUpText, notTriedIds, progressLine, promoteRefusal,
  seriesOutcome, setFindReviewFirst, startRefusal, FIND_SERIES_MAX_MS,
  type FindProposal, type FindResult, type FindRun, type FindRunSummary, type FindStatus,
} from '../lib/findSources';
import { ACTION_COPY, runStatusWord } from '../lib/healthCopy';
import { answerView, evidenceView, healthRowEvidence, type StageLine } from '../lib/sourceEvidence';
import { diagnosisFix, diagnosisReason } from '../lib/said';
import { runProgress, runTitle, type RunCard } from '../lib/jobs';
import { navRing, runName, runWaitLine, type SourceJobs } from '../lib/serverDownloads';
import { FindResultRow, FindRunRow, SeriesReview } from '../components/FindSources';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

const res = (seriesId: string, o: Partial<FindResult> = {}): FindResult => ({ seriesId, title: seriesId.toUpperCase(), followed: [], ...o });
const followed = (name: string, chapters: number | null = 120) => ({ sourceId: name.toLowerCase(), name, chapters });
const run = (o: Partial<FindRun> = {}): FindRun => ({
  id: 'r1', status: 'running', total: 189, done: 12, followed: 3, startedBy: 'u1', startedAt: '2026-09-28T10:00:00Z', finishedAt: null, results: [], ...o,
});
const status = (o: Partial<FindStatus> = {}): FindStatus => ({ running: false, run: null, recent: [], ...o });

/* ================================================================ what a run did */

test("'not tried' is never 'nothing found': four groups, each in the run's order", () => {
  // The owner's rule: a series the run never reached (a stop, or out of time) is not a series no source has. Reintroduce
  // by folding `not_tried` into `nothing` in groupResults: "a series never searched reads as nothing found" fails.
  const g = groupResults([
    res('a', { followed: [followed('MangaDex')] }),
    res('b', { why: 'no_match' }),
    res('c', { why: 'not_tried' }),
    res('d', { why: 'refused' }),
    res('e', { why: 'full' }),
    res('f', { why: 'posting_order' }),
    res('g', { why: 'not_tried' }),
    // A follow wins over any reason sent beside it.
    res('h', { followed: [followed('Asura')], why: 'full' }),
    // The v0.49.1 review's m2/m3: decided without a search (too few chapters, no source to ask) is skipped; asked with
    // no answer was searched.
    res('i', { why: 'too_few' }),
    res('j', { why: 'no_source' }),
    res('k', { why: 'no_answer' }),
    // Searched, and only the source it already follows lists it (the server's reason since its review).
    res('l', { why: 'followed_already' }),
  ]);
  assert.deepEqual(g.found.map((r) => r.seriesId), ['a', 'h']);
  assert.deepEqual(g.nothing.map((r) => r.seriesId), ['b', 'd', 'k', 'l'], 'a series never searched reads as nothing found');
  assert.deepEqual(g.skipped.map((r) => r.seriesId), ['e', 'f', 'i', 'j'], 'a series nobody searched for reads as nothing found');
  assert.deepEqual(g.notTried.map((r) => r.seriesId), ['c', 'g']);
  assert.deepEqual(notTriedIds(run({ status: 'stopped', results: [res('c', { why: 'not_tried' }), res('b', { why: 'no_match' })] })), ['c']);
});

test('every reason is a sentence, and "not tried" says so rather than "not found"', () => {
  // Reintroduce a missing case (drop 'full' from findWhyLine): it reads the fallback "Nothing found" and fails here.
  const whys = ['no_match', 'followed_already', 'refused', 'full', 'posting_order', 'too_few', 'no_source', 'no_answer', 'not_tried'];
  const lines = whys.map(findWhyLine);
  for (const [i, why] of whys.entries()) {
    assert.ok(lines[i] && lines[i] !== why && !/\b[a-z]+_[a-z]+\b/.test(lines[i]), `'${why}' has no words`);
    assert.notEqual(lines[i], findWhyLine(undefined), `'${why}' reads the fallback`);
  }
  assert.equal(new Set(lines).size, whys.length, 'two reasons read the same');
  assert.match(findWhyLine('not_tried'), /^Not tried: /);
  assert.doesNotMatch(findWhyLine('not_tried'), /not found|nothing found/i, "'not tried' says 'not found'");
  // A posting-order series is Health's sentence for the same fact, not a second wording of it.
  assert.equal(findWhyLine('posting_order'), 'Numbered by posting order: no other source’s numbers line up with it');
});

test('a run says how far it got, what it followed, and every group that is not empty, counted in pairs', () => {
  // Reintroduce `tr('{n} sources followed', { n })` for every count: "1 sources followed" fails.
  assert.equal(progressLine(run()), '12 of 189 series · 3 sources followed');
  assert.equal(progressLine(run({ followed: 1 })), '12 of 189 series · 1 source followed', '"1 sources followed"');
  assert.equal(progressLine(run({ total: 1, done: 0, followed: 0 })), '', 'a run for one series counts "0 of 1 series"');
  const done = run({
    status: 'done', done: 6, total: 6, followed: 2, finishedAt: '2026-09-28T10:05:00Z',
    results: [res('a', { followed: [followed('A'), followed('B')] }), res('b', { why: 'no_match' }), res('c', { why: 'refused' }),
      res('d', { why: 'full' }), res('e', { why: 'not_tried' }), res('f', { why: 'posting_order' })],
  });
  assert.equal(findSummary(done), '2 sources followed · Nothing found for 2 series · 2 series skipped · 1 series not tried');
  // Stopped: said first, with how far it got; a series the server never reached counts as not tried even with no row.
  const stopped = run({ status: 'stopped', total: 10, done: 3, followed: 1, results: [res('a', { followed: [followed('A')] }), res('b', { why: 'no_match' }), res('c', { why: 'not_tried' })] });
  // Its `done` counts c, the series a stop caught in flight and listed as not tried: 2 of the 10 were searched.
  assert.equal(findSummary(stopped), 'Stopped before it finished · 2 of 10 series · 1 source followed · Nothing found for 1 series · 8 series not tried');
  // A kept run without its results says the counts it carries.
  assert.equal(findSummary({ ...run({ status: 'done', total: 4, done: 4, followed: 0 }), results: undefined }), 'No source followed');
});

test('a stopped run counts only the series it searched, and a follow only when there is one', () => {
  // The walk stopped a run over 4 series while its first was in flight: the server settles that one as not tried and
  // counts it in `done`, and the results read "1 of 4 series · 0 sources followed · 4 series not tried". Reintroduce
  // `run.done` as the count: "a series a stop caught in flight counts as searched"; `followedText` for 0: "a run that
  // followed nothing says 0 sources followed".
  const caught = run({ status: 'stopped', total: 4, done: 1, followed: 0, results: ['a', 'b', 'c', 'd'].map((id) => res(id, { why: 'not_tried' })) });
  const line = findSummary(caught);
  assert.doesNotMatch(line, /1 of 4 series/, 'a series a stop caught in flight counts as searched');
  assert.doesNotMatch(line, /0 sources followed/, 'a run that followed nothing says 0 sources followed');
  assert.equal(line, 'Stopped before it finished · 4 series not tried');
  // One searched before the stop, one caught in flight, two never reached.
  const later = run({ status: 'stopped', total: 4, done: 2, followed: 1, results: [res('a', { followed: [followed('A')] }), res('b', { why: 'not_tried' }), res('c', { why: 'not_tried' }), res('d', { why: 'not_tried' })] });
  assert.equal(findSummary(later), 'Stopped before it finished · 1 of 4 series · 1 source followed · 3 series not tried');
  // A follow caught by the stop stands: that series was searched (its row has no reason).
  const held = run({ status: 'stopped', total: 2, done: 1, followed: 1, results: [res('a', { followed: [followed('A')] }), res('b', { why: 'not_tried' })] });
  assert.equal(findSummary(held), 'Stopped before it finished · 1 of 2 series · 1 source followed · 1 series not tried');
  // Without its results, and nothing followed: that much is said, never an empty line.
  assert.equal(findSummary({ ...run({ status: 'done', total: 3, done: 3, followed: 0 }), results: undefined }, { status: false }), 'No source followed',
    'a run with nothing else to say leaves an empty line');
});

test('a run as a status line: working with its Stop, then what it did -- amber when it stopped or left one untried', () => {
  // Reintroduce `partial: run.status === 'stopped'` alone: a run that ran out of time before three series reads as a
  // clean success in the accent colour, and "a run that left series untried is amber" fails.
  const stop = () => {};
  const w = findRunState(run({ current: { seriesId: 's9', title: 'Solo Leveling' } }), { onStop: stop });
  assert.equal(w.kind, 'working');
  if (w.kind === 'working') {
    assert.equal(w.step, '12 of 189 series · 3 sources followed');
    assert.equal(w.detail, 'Solo Leveling');
    assert.equal(w.onStop, stop, 'the run cannot be stopped from its row');
    assert.equal(w.startedAt, Date.parse('2026-09-28T10:00:00Z'));
    assert.ok(w.progress && Math.abs(w.progress - 12 / 189) < 1e-9, 'the bar does not fill with done/total');
  }
  const one = findRunState(run({ total: 1, done: 0, followed: 0 }));
  assert.ok(one.kind === 'working' && one.step === 'Searching other sources' && one.progress === undefined, 'a run of one counts "0 of 1"');
  const clean = findRunState(run({ status: 'done', done: 2, total: 2, followed: 1, finishedAt: '2026-09-28T10:02:00Z', results: [res('a', { followed: [followed('A')] }), res('b', { why: 'no_match' })] }));
  assert.deepEqual(clean, { kind: 'done', finishedAt: Date.parse('2026-09-28T10:02:00Z'), tookMs: 120_000, outcome: '1 source followed · Nothing found for 1 series', partial: undefined });
  const untried = findRunState(run({ status: 'done', results: [res('a', { why: 'not_tried' })], finishedAt: '2026-09-28T10:02:00Z' }));
  assert.ok(untried.kind === 'done' && untried.partial === true, 'a run that left series untried is amber');
  const stopped = findRunState(run({ status: 'stopped', finishedAt: 5 }));
  assert.ok(stopped.kind === 'done' && stopped.partial === true && /^Stopped before it finished/.test(stopped.outcome));
  assert.deepEqual(findRunState(run({ status: 'failed', finishedAt: 7 })), { kind: 'failed', finishedAt: 7, reason: 'The search failed; the server log says why' });
  assert.deepEqual(findRunState(null), { kind: 'idle' });
});

test("one series' outcome, for the Sources sheet: what it followed, or why nothing, or that it was never reached", () => {
  // Reintroduce `return null` for a run that is over and has no row for the series: the sheet's key reads "Done" over a
  // series nobody searched for.
  const r = run({ status: 'done', results: [res('a', { followed: [followed('MangaDex'), followed('Asura Scans')] }), res('b', { why: 'refused' })] });
  assert.deepEqual(seriesOutcome(r, 'a'), { text: 'Followed MangaDex, Asura Scans' });
  assert.deepEqual(seriesOutcome(r, 'b'), { text: findWhyLine('refused'), partial: true });
  assert.deepEqual(seriesOutcome(run({ status: 'stopped' }), 'z'), { text: findWhyLine('not_tried'), partial: true }, 'a series never reached reads as done');
  assert.equal(seriesOutcome(run(), 'z'), null, 'a series the running run has not reached yet has an outcome');
  assert.equal(seriesOutcome(null, 'a'), null);
});

/* ================================================================ following one run */

test('a press ends when the answer shows ITS run finished, never because an older answer does not show it yet', () => {
  // ⚠️ The press's POST answers with the run's id; an answer read before the run began shows the PREVIOUS run as the
  // newest one, finished. Reintroduce `if (id !== live) out.add(id)` for every awaited id: "an answer from before the
  // press ended the run" fails -- and the row read the previous run's outcome.
  const before = status({ run: run({ id: 'old', status: 'done' }) });
  assert.deepEqual(findEndedRunIds(null, before, ['new']), [], 'an answer from before the press ended the run');
  assert.deepEqual(findEndedRunIds(null, status({ running: true, run: run({ id: 'new' }) }), ['new']), [], 'a running run ended');
  assert.deepEqual(findEndedRunIds(null, status({ run: run({ id: 'new', status: 'done' }) }), ['new']), ['new']);
  // Over, and already replaced as the newest by another run: still over, from `recent`.
  const replaced = status({ running: true, run: run({ id: 'next' }), recent: [{ ...run({ id: 'new', status: 'stopped' }) }] });
  assert.deepEqual(findEndedRunIds(null, replaced, ['new']), ['new']);
  // Seen running at the last answer and not now: over, whoever started it.
  assert.deepEqual(findEndedRunIds(status({ running: true, run: run({ id: 'x' }) }), status({ run: run({ id: 'x', status: 'done' }) }), []), ['x']);
  assert.deepEqual(findEndedRunIds(status({ running: true, run: run({ id: 'x' }) }), status({ running: true, run: run({ id: 'x' }) }), []), []);
});

test('the key that started a run says what it is doing, then what it did; a refusal is amber, a failure red', () => {
  const stop = () => {};
  assert.deepEqual(findSlotState(undefined, null), { kind: 'idle' });
  assert.deepEqual(findSlotState({ phase: 'starting', startedAt: 1 }, null), { kind: 'starting' });
  assert.deepEqual(findSlotState({ phase: 'refused', startedAt: 1, reason: 'busy words' }, null), { kind: 'refused', reason: 'busy words' });
  assert.deepEqual(findSlotState({ phase: 'failed', startedAt: 1, finishedAt: 2, reason: 'x' }, null), { kind: 'failed', finishedAt: 2, reason: 'x' });
  // Pressed, and the status has not shown the run yet: working from the press; then the run's own progress and Stop.
  assert.deepEqual(findSlotState({ phase: 'awaiting', startedAt: 5, runId: 'r1' }, null), { kind: 'working', startedAt: 5, step: 'Working…' });
  const w = findSlotState({ phase: 'awaiting', startedAt: 5, runId: 'r1', stopping: true }, run(), stop);
  assert.ok(w.kind === 'working' && w.onStop === stop && w.stopping === true, 'the running run has no Stop, or forgets it was asked to stop');
  // Over, and the page is being asked again: "Checking the result…" until it has answered (the v0.48.3 rule).
  assert.deepEqual(findSlotState({ phase: 'settling', startedAt: 5, runId: 'r1' }, run({ status: 'done' })), { kind: 'working', startedAt: 5, step: 'Checking the result…' });
  const ended = findSlotState({ phase: 'ended', startedAt: 5, runId: 'r1', finishedAt: 9 }, run({ status: 'done', finishedAt: 9, results: [res('a', { followed: [followed('A')] })], followed: 1 }));
  assert.ok(ended.kind === 'done' && ended.outcome === '1 source followed');
});

test('one run at a time: a key waits, saying why, while another goes; its own run keeps it live as the Stop', () => {
  // Reintroduce `findGate = () => ({})`: every key offers a press the server answers 409 busy.
  const busy = 'Another search for other sources is running; this can start when it ends';
  assert.deepEqual(findGate(status({ running: true, run: run() }), false), { disabled: true, disabledWhy: busy }, 'a key offers a press the server answers 409 busy');
  assert.deepEqual(findGate(status({ running: true, run: run() }), true), {}, 'the key whose own run is going is disabled (it is the Stop)');
  assert.deepEqual(findGate(status(), false), {});
  assert.deepEqual(findGate(undefined, false), {});
  // The refusals of a start, in words: 409 is another run, 400 `empty_scope` nothing to search (m10 has the rest).
  assert.equal(startRefusal(409, 'busy'), busy, 'another run going reads as a failure');
  assert.equal(startRefusal(400, 'empty_scope'), 'No series to search for', 'nothing to search for reads as a failure');
  assert.equal(startRefusal(500, null), null);
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

test('the Sources sheet: Find more sources for this one series, and the other names below Translated by, for admins', () => {
  // Reintroduce the names or the key ABOVE Translated by: at 390 px Prefer and Block -- only reachable there -- move
  // further under the fold ("… push Prefer and Block down"). Post the series' title instead of its id, or let the key
  // start while another run goes: the matching assertion fails.
  const sheet = code(read('components/SourcesSheet.tsx'));
  const find = slice(sheet, 'function FindMore(', 'function OtherNames(');
  // v0.51.0: in the mode chosen inline above the key (a dialog opened from this Sheet would sit under it), remembered.
  assert.match(find, /onRun: \(\) => \{ setFindReviewFirst\(review\); void fr\.start\('series', \{ seriesIds: \[id\], \.\.\.\(review \? \{ review \} : \{\}\) \}\); \}/,
    'Find more sources does not start a run for this series');
  assert.match(find, /\.\.\.findGate\(fr\.status, busy\),/, 'Find more sources starts while another run goes');
  assert.match(find, /const mine = slot\?\.phase === 'ended' \? seriesOutcome\(run, id\) : null;/, 'the sheet says the run\'s counts, not what it did for this series');
  assert.match(find, /<ActionKeys actions=\{\[spec\]\} \/>\s*<ActionStatus state=\{state\} \/>/, 'the key has no status line');
  const body = slice(sheet, 'export function SourcesSheet(', '');
  const translated = body.indexOf("<Eyebrow>{tr('Translated by')}</Eyebrow>");
  const names = body.indexOf('<OtherNames id={id} />');
  const more = body.indexOf('<FindMore id={id}');
  assert.ok(translated > 0 && names > translated, 'the other names push Prefer and Block down');
  assert.ok(more > names, 'Find more sources pushes Prefer and Block down, or sits away from the names it searches with');
  assert.match(body, /\{adminAccount && <OtherNames id=\{id\} \/>\}/, 'a member sees the admin\'s other names');
  assert.match(body, /\{adminAccount && \(\s*<FindMore id=\{id\}/, 'a member is offered Find more sources');
});

/* ================================================================ Health */

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

test("Health's key: what it does for how many series, how, and how long before the press", () => {
  // Reintroduce the count into a plural sentence for one series ("the 1 series that come"): "one series" fails.
  const c = ACTION_COPY.find_sources;
  assert.equal(c.label({}), 'Find other sources');
  assert.match(c.what({ n: 189 }), /^Searches the other sources for the 189 series that come from this source/);
  assert.match(c.what({ n: 1 }), /for the 1 series that comes from this source/, 'one series');
  assert.match(c.what({}), /for every series that comes from this source/, 'the legend, with no count, says a number');
  // The words are what the run does (FEATURE.md: 1.5 s pace, sweep/repair/daily check, 3 names, never the main source).
  const how = c.how!({});
  for (const fact of [/1\.5 seconds apart/, /chapter sweep, a repair or the daily check/, /up to 3 other names/, /never asks this source/, /posting order is skipped/]) {
    assert.match(how, fact);
  }
  // How long: the pace and the run's own wall per series, rounded up -- or per series when the row does not say (the
  // test "m7: the estimate is the run's own wall" below).
  assert.equal(c.eta({ n: 189 }), 'Up to 5 hours');
  assert.equal(c.eta({ n: 6 }), 'Up to 10 minutes');
  assert.equal(c.eta({}), 'Up to about a minute and a half per series');
  assert.equal(findEta(0), 'Up to about a minute and a half per series');
});

test('a Health row: Find other sources posts the source, and its run has a key group and a status line of its own', () => {
  // The run takes minutes or hours. Reintroduce the key into the row's one group (`const specs = actions.map(spec)…`
  // without the split): while it runs, Test, Clear block and Turn off -- disabled beside any busy key -- are gone for
  // hours, and "the find key shares the row's group" fails.
  const src = code(read('components/HealthActions.tsx'));
  const row = slice(src, 'export function HealthRow', 'const SCAN_CHECKS');
  assert.match(row, /const fr = useFindRun\(\);/);
  assert.match(row, /const findNow = findSlotState\(findSlot, fr\?\.runOf\(slotKey\), \(\) => \{ void fr\?\.stop\(slotKey\); \}\);/, 'the row does not follow its run');
  const arm = slice(row, "case 'find_sources':", "case 'renumber':");
  assert.match(arm, /\.\.\.findGate\(fr\?\.status, findNow\.kind === 'working' \|\| findNow\.kind === 'starting'\),/, 'the key starts while another run goes');
  assert.match(arm, /state: findNow, what: copy\.what\(\{ \.\.\.ctx, n: item\.findSeries \}\)/, 'the key does not carry its run, or its count');
  assert.match(row, /const specs = all\.filter\(\(s\) => s\.id !== 'find_sources'\);\s*const finds = all\.filter\(\(s\) => s\.id === 'find_sources'\);/,
    'the find key shares the row\'s group');
  assert.match(row, /\{specs\.length > 0 && <ActionKeys actions=\{specs\} \/>\}\s*\{finds\.length > 0 && <ActionKeys actions=\{finds\} \/>\}/);
  assert.match(row, /<ActionStatus state=\{rowNow\} \/>\s*\{finds\.length > 0 && <ActionStatus state=\{findNow\} \/>\}/, 'the run has no status line on its row');
  // The page follows find runs once, for every row and the card, and asks Health again when one ENDS.
  const page = code(read('app/admin/page.tsx'));
  const health = slice(page, 'function Health()', 'function DesktopUpdateNote(');
  assert.match(health, /<FindRunProvider onEnded=\{recheck\}>/, 'no follower of find runs on Health');
  assert.match(health, /<FindRunCard \/>\s*<RepairHistory \/>/, 'Health has no card for the run and its results');
  const hook = code(read('lib/useFindRun.tsx'));
  assert.match(hook, /api<\{ runId: string; total: number \}>\('\/api\/admin\/sources\/find', \{ method: 'POST', json: scope \}\)/);
  assert.match(hook, /api\('\/api\/admin\/sources\/find\/stop', \{ method: 'POST' \}\)/);
  // Health is asked again once per ended run, when it ends -- never at the press.
  const start = slice(hook, 'const start = useCallback', 'const stop = useCallback');
  assert.doesNotMatch(start, /ended\.current/, 'the page is asked again at the press');
  assert.match(hook, /mark\(ids, 'settling'\);\s*void \(async \(\) => \{\s*try \{ await ended\.current\?\.\(\); \} finally \{ mark\(ids, 'ended'\); \}/,
    'the row wakes before the page has answered');
});

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

/* ================================================================ Library and Server tasks */

test('Library: Find other sources is a row of More for admins, posts the selection, and says where the run shows', () => {
  // Reintroduce the key in the bar from lg up: library.test.ts measures the row. Post `picked.size` instead of the ids,
  // or keep the selection after a start: the matching assertion fails.
  const src = code(read('app/library/page.tsx'));
  const fn = slice(src, 'const findSelected = async (review: boolean) => {', 'const sentinel = useRef');
  assert.match(fn, /api<\{ runId: string; total: number \}>\('\/api\/admin\/sources\/find', \{ method: 'POST', json: \{ seriesIds: \[\.\.\.picked\], \.\.\.\(review \? \{ review \} : \{\}\) \} \}\)/);
  assert.match(fn, /n === 1 \? tr\('Looking for other sources for 1 series… Library → Downloads shows how it goes\.'\)/, 'one series is counted as many');
  // A run that goes on after the notice: the notice turns, and says it is busy (notices.test.ts).
  assert.match(fn, /'info', \{ busy: true \}\);/, 'the notice of a run that goes on does not turn');
  assert.match(fn, /void kickDownloads\(qc\);\s*settle\(\);/, 'the Server tasks card waits 30 s, or the selection stays after a start');
  assert.match(fn, /catch \(e\) \{ toast\(findRefusal\(e\), 'error'\); \}/, 'a refused start (another run, nothing to search) is not said');
  const more = slice(src, '<Sheet title={selectedText(picked.size)}', '</Sheet>');
  // v0.51.0: through the start dialog, which asks how to follow what it finds.
  assert.match(more, /\{isAdmin && \([\s\S]*?setMore\(false\); setFinding\(true\);[\s\S]*?\{tr\('Find other sources'\)\}/, 'More has no Find other sources for admins');
  assert.match(src, /\{finding && <FindStartDialog onClose=\{\(\) => setFinding\(false\)\} onStart=\{\(review\) => \{ setFinding\(false\); void findSelected\(review\); \}\} \/>\}/,
    'the start dialog does not start the search it chose');
});

test("Server tasks: the run's card is named as a noun, counts its follows, stops through its own route, and shows its results", () => {
  // Reintroduce the generic cancel for every kind: Stop posts /api/sources/runs/find_sources/cancel, which the run does
  // not read, and "the run's Stop posts the generic cancel" fails.
  assert.equal(runTitle('find_sources'), 'Other-source search');
  const card: RunCard = { kind: 'find_sources', startedAt: 0, status: 'running', done: 12, total: 189, fetched: 0, failed: 0, followed: 3, current: { id: 's9', title: 'Solo Leveling' } };
  assert.equal(runName(card), 'Other-source search');
  assert.equal(runProgress(card), '12 of 189 series · 3 sources followed');
  assert.equal(runProgress({ ...card, followed: 1 }), '12 of 189 series · 1 source followed');
  const view = code(read('components/ServerDownloadsView.tsx'));
  // v0.55.0: Fix everything's run, too, stops through its own route (test/autofix.test.ts).
  assert.match(view, /const cancelRun = \(kind: string\) => \{\s*if \(kind !== 'autofix'\) return call\(kind === 'find_sources' \? '\/api\/admin\/sources\/find\/stop' : `\/api\/sources\/runs\/\$\{kind\}\/cancel`, 'POST'\);/,
    "the run's Stop posts the generic cancel");
  const task = slice(view, 'function TaskRow(', 'function CameInTile(');
  assert.match(task, /const stops = find \|\| r\.kind === 'autofix';/);
  assert.match(task, /\{stops \? tr\('Stopping…'\) : tr\('Stopping after this chapter…'\)\}/, 'a find run stops "after this chapter", or "after this series"');
  assert.match(task, /\{stops \? tr\('Stop'\) : tr\('Cancel'\)\}/);
  assert.match(task, /\{find && admin && \(\s*<button type="button" onClick=\{\(\) => setResults\(true\)\}/, 'the card has no way to its results');
  assert.match(task, /\{results && <FindResultsSheet onClose=\{\(\) => setResults\(false\)\} \/>\}/);
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

test('the results open on <body>, whatever card opened them, and each group is its own section', () => {
  // The Server tasks card and Health's card are `.card`s, whose backdrop blur makes each the containing block of a
  // `fixed` sheet inside it (the slow archive's s14 MAJOR). Reintroduce `return (<Sheet` without OnBody: this names it.
  const src = code(read('components/FindSources.tsx'));
  const sheet = slice(src, 'export function FindResultsSheet(', 'export function FindRunCard(');
  assert.match(sheet, /return \(\s*<OnBody>\s*<Sheet title=\{run && isReplace\(run\) \? replaceRunTitle\(run\.sourceName\) : tr\('Other-source search'\)\}/, 'the results are rendered inside the card that opened them');
  // The skipped group has a key of its own (v0.52.0): the shared "Skipped" is also a match's state and an import row's,
  // and the heading is about series, which es, fr and pt agree it with. Reintroduce the shared key: this fails.
  for (const [id, title] of [['found', 'New sources'], ['nothing', 'Nothing found'], ['skipped', 'Skipped series'], ['not-tried', 'Not tried']]) {
    assert.match(sheet, new RegExp(`<Group id="${id}" title=\\{tr\\('${title}'\\)\\}`), `the ${title} group is gone`);
  }
  // What the run never reached can be searched now, through the same one-run rule.
  // In the run's own mode (v0.51.0): what a review never reached is searched for review too.
  assert.match(sheet, /again\.start\('retry', \{ seriesIds: untried, \.\.\.\(run\.review \? \{ review: true \} : \{\}\) \}\)/, 'the untried series cannot be searched again');
  assert.match(sheet, /untried\.length === 1 \? tr\('Search the 1 series not tried'\) : tr\('Search the \{n\} series not tried', \{ n: untried\.length \}\)/);
  // Health's card polls nothing of its own: the page's follower does.
  assert.match(slice(src, 'export function FindRunCard(', ''), /<FindResultsSheet poll=\{false\}/, 'Health polls the run twice');
});

test('the run row renders its Stop while it runs, no key once it is over, and says a stop once', () => {
  // Reintroduce `onRun: onStop` for a finished run: a Stop key sits under a run that ended. Reintroduce the status in
  // the row's second line (`what: [runStatusWord(run.status), whenLine(run)]…`) or in the outcome under the sheet's
  // status label: "Stopped before it finished" twice, one line above the other.
  const running = renderToStaticMarkup(createElement(FindRunRow, { run: run(), onStop: () => {} }));
  assert.match(running, /data-find-stop/, 'a running run has no Stop');
  assert.match(running, />Stop</);
  assert.match(running, /12 of 189 series · 3 sources followed/);
  const over = renderToStaticMarkup(createElement(FindRunRow, { run: run({ status: 'done', finishedAt: '2026-09-28T10:30:00Z' }), onStop: () => {} }));
  assert.doesNotMatch(over, /<button/, 'a Stop key sits under a run that ended');
  assert.match(over, /Other-source search/);
  assert.match(over, /3 sources followed/);
  const stopped = run({ status: 'stopped', finishedAt: '2026-09-28T10:30:00Z' });
  // What is SEEN: the status line's live region (sr-only) repeats it for a screen reader, which is its job.
  const seen = (html: string) => html.replace(/<span role="status"[^>]*>[^<]*<\/span>/g, '');
  const card = seen(renderToStaticMarkup(createElement(FindRunRow, { run: stopped })));
  assert.equal(card.split('Stopped before it finished').length - 1, 1, 'the card says the stop twice');
  const head = seen(renderToStaticMarkup(createElement(FindRunRow, { run: stopped, label: 'Stopped before it finished' })));
  assert.equal(head.split('Stopped before it finished').length - 1, 1, "the sheet's head says the stop twice");
  assert.match(head, /12 of 189 series · 3 sources followed/, "the sheet's head lost how far the run got");
});

/* ================================================================ the v0.49.1 review's findings, each by its number */

test('M1: a run a restart cut short reads like a stopped one -- amber, counted, its unreached series offered again', () => {
  // The server lists every series an interrupted run never reached as `not_tried`, exactly as a stop's. Reintroduce the
  // red `failed` state for 'interrupted' in findRunState: "an interrupted run reads as a failure" fails. Reintroduce
  // `run.status === 'stopped'` alone in findSummary's count: "an interrupted run counts none of the series it never
  // reached" fails.
  const rows = [res('a', { followed: [followed('A')] }), res('b', { why: 'no_match' }), res('c', { why: 'not_tried' }), res('d', { why: 'not_tried' })];
  const cut = run({ status: 'interrupted', total: 4, done: 2, followed: 1, finishedAt: '2026-09-28T11:00:00Z', results: rows });
  const s = findRunState(cut);
  assert.equal(s.kind, 'done', 'an interrupted run reads as a failure');
  if (s.kind === 'done') {
    assert.equal(s.partial, true, 'an interrupted run reads as a clean success');
    assert.equal(s.outcome, 'Interrupted by a restart · 2 of 4 series · 1 source followed · Nothing found for 1 series · 2 series not tried');
    // Closed when the server came back, not when it went down: no "Took".
    assert.equal(s.tookMs, undefined, 'an interrupted run says it took until the server came back');
  }
  // Exactly a stop's words but the first, and without it where a label already says it.
  assert.equal(findSummary({ ...cut, status: 'stopped' }), 'Stopped before it finished · 2 of 4 series · 1 source followed · Nothing found for 1 series · 2 series not tried');
  assert.equal(findSummary(cut, { status: false }), '2 of 4 series · 1 source followed · Nothing found for 1 series · 2 series not tried');
  // A series with no row at all (a run closed before the server listed them) still counts as not tried.
  assert.equal(findSummary({ ...cut, total: 7 }, { status: false }), '2 of 7 series · 1 source followed · Nothing found for 1 series · 5 series not tried',
    'an interrupted run counts none of the series it never reached');
  // The retry key: every finished run's not-tried rows, an interrupted one's included.
  assert.deepEqual(notTriedIds(cut), ['c', 'd']);
  const sheet = slice(code(read('components/FindSources.tsx')), 'export function FindResultsSheet(', 'export function FindRunCard(');
  assert.match(sheet, /const untried = run && run\.status !== 'running' \? notTriedIds\(run\) : \[\];/, 'the retry key is offered after a stop only');
});

test('m1: a series the viewer may not list keeps its row -- a placeholder, its reason, and no link', () => {
  // The server drops the title of a series hidden by the 18+ filter; the row rendered an empty link, a blank line
  // between two series (the review's s5-01). Reintroduce the plain `<Link …>{r.title}</Link>`: "a hidden series reads
  // as a blank link" fails.
  const hidden = renderToStaticMarkup(createElement(FindResultRow, { r: { seriesId: 'x', followed: [], why: 'no_match' }, onOpen: () => {} }));
  assert.doesNotMatch(hidden, /<a\b/, 'a hidden series reads as a blank link');
  assert.match(hidden, /data-find-hidden[^>]*>Hidden by the 18\+ filter</, 'a hidden series has no words in place of its title');
  assert.match(hidden, /No other source lists it under its title or other names/, 'a hidden series loses its reason');
  // A named one is a link to its series, in its own direction.
  const shown = renderToStaticMarkup(createElement(FindResultRow, { r: res('y', { why: 'no_match' }), onOpen: () => {} }));
  assert.match(shown, /<a [^>]*href="[^"]*id=y"[^>]*>Y<\/a>/);
  assert.doesNotMatch(shown, /data-find-hidden/);
});

test('m2/m3: every reason in its own words -- too few chapters, no source to ask and no answer are not "not tried"', () => {
  // Reintroduce the old not_tried sentence ("…was stopped or ran out of time…"): the series a restart cut off read as
  // stopped, and "not_tried leaves the restart out" fails. Drop one of the new cases: it reads "Nothing found".
  assert.equal(findWhyLine('too_few'), 'Too few chapters to compare (fewer than 3)', "'too_few' is not said as the review words it");
  assert.equal(findWhyLine('no_source'), 'No other source could be asked', "'no_source' is not said as the review words it");
  assert.equal(findWhyLine('no_answer'), 'No other source answered', "'no_answer' is not said as the review words it");
  // The server's extra reason (its review's nit): "no other source lists it" would be false -- the one it follows does.
  // Drop its case: it reads the fallback "Nothing found".
  assert.equal(findWhyLine('followed_already'), 'No other source lists it besides the one it already follows',
    "'followed_already' reads as nothing found");
  assert.equal(findWhyLine('refused'), 'Found a possible match, but it did not pass the title and chapter-number check');
  assert.equal(findWhyLine('not_tried'), 'Not tried: the search was stopped, ran out of time or was interrupted by a restart before it got there',
    'not_tried leaves the restart out');
  const sheet = code(read('components/FindSources.tsx'));
  assert.match(sheet, /note=\{tr\('The search was stopped, ran out of time or was interrupted by a restart before it got to these\.'\)\}/,
    "the Not tried section's note leaves the restart out");
  // Decided without a search is skipped; asked, with no answer, was searched.
  const r = run({ status: 'done', done: 3, total: 3, followed: 0, results: [res('a', { why: 'too_few' }), res('b', { why: 'no_source' }), res('c', { why: 'no_answer' })] });
  assert.equal(findSummary(r), 'Nothing found for 1 series · 2 series skipped', 'a series decided without a search counts as nothing found');
});

test('m5: no status is said twice -- an earlier search, and the head of a run a restart cut short', () => {
  // Reintroduce `findSummary(r)` under Earlier searches: "Stopped before it finished · 6m ago · Stopped before it
  // finished · 3 of 7 series" (the review's s6-02), and "an earlier search says its status twice" fails.
  const sheet = code(read('components/FindSources.tsx'));
  const earlier = slice(sheet, "{tr('Earlier searches')}", '</section>');
  assert.match(earlier, /<span className="text-fog-300">\{runStatusWord\(r\.status\)\}<\/span>/);
  assert.match(earlier, /\{findSummary\(r, \{ status: false \}\)\}/, 'an earlier search says its status twice');
  // The head of an interrupted run: its label says it once, and the line under it what the run did.
  const seen = (html: string) => html.replace(/<span role="status"[^>]*>[^<]*<\/span>/g, '');
  const cut = run({ status: 'interrupted', total: 7, done: 1, followed: 0, finishedAt: '2026-09-28T11:00:00Z', results: [res('a', { why: 'no_match' })] });
  const head = seen(renderToStaticMarkup(createElement(FindRunRow, { run: cut, label: runStatusWord('interrupted') })));
  assert.equal(head.split('Interrupted by a restart').length - 1, 1, "the interrupted head says 'Interrupted by a restart' twice");
  assert.match(head, /1 of 7 series · Nothing found for 1 series · 6 series not tried/, 'the interrupted head does not say what the run did');
  // Health's card, named as a run: the restart leads its line, once.
  const card = seen(renderToStaticMarkup(createElement(FindRunRow, { run: cut })));
  assert.equal(card.split('Interrupted by a restart').length - 1, 1, 'the card says the restart twice, or not at all');
});

test('m6: a run waiting for a sweep, a repair or the daily check says so, on the row and the card', () => {
  // While it waits, `current` still names the series it asked about last. Reintroduce `detail: run.current?.title`
  // alone: the row reads "12 of 189 series · Solo Leveling" for as long as the sweep takes, and "the waiting run says
  // it is on a series" fails.
  const waiting = run({ waiting: 'check', current: { seriesId: 's9', title: 'Solo Leveling' } });
  const w = findRunState(waiting);
  assert.ok(w.kind === 'working');
  if (w.kind === 'working') {
    assert.equal(w.step, '12 of 189 series · 3 sources followed');
    assert.equal(w.detail, 'Waiting for the source check to finish', 'the waiting run says it is on a series');
  }
  // The slow archive's words for the same three waits (lib/archive.ts waitingText).
  const sweep = findRunState(run({ total: 1, done: 0, followed: 0, waiting: 'sweep', current: { seriesId: 's9', title: 'Solo Leveling' } }));
  assert.ok(sweep.kind === 'working' && sweep.step === 'Waiting for the scheduled check to finish' && sweep.detail === undefined,
    'a run of one that waits says it is searching');
  const repair = findRunState(run({ waiting: 'repair' }));
  assert.ok(repair.kind === 'working' && repair.detail === 'Waiting for the library repair to finish');
  const on = findRunState(run({ waiting: null, current: { seriesId: 's9', title: 'Solo Leveling' } }));
  assert.ok(on.kind === 'working' && on.detail === 'Solo Leveling', 'a run that is not waiting lost the series it is on');
  // Health's card (FindRunRow) and a row's key (findSlotState) both say it.
  const card = renderToStaticMarkup(createElement(FindRunRow, { run: waiting, onStop: () => {} }));
  assert.match(card, /12 of 189 series · 3 sources followed · Waiting for the source check to finish/, 'the card does not say the run waits');
  const key = findSlotState({ phase: 'awaiting', startedAt: 5, runId: 'r1' }, waiting, () => {});
  assert.ok(key.kind === 'working' && key.detail === 'Waiting for the source check to finish', "the row's key does not say the run waits");
});

test("m7: the estimate is the run's own wall per series (90 s) plus the 1.5 s pace", () => {
  // Reintroduce the hunt's wall (`1_500 + 60_000`): aqua's 189 series read "Up to 4 hours" for a run that may take
  // nearly five, and "the estimate is the hunt's wall, not the run's" fails.
  assert.equal(FIND_SERIES_MAX_MS, 91_500, "the estimate is the hunt's wall, not the run's");
  assert.equal(findEta(189), 'Up to 5 hours');
  assert.equal(findEta(6), 'Up to 10 minutes');
  assert.equal(findEta(1), 'Up to 2 minutes');
  assert.equal(findEta(null), 'Up to about a minute and a half per series');
});

test('m10: a refused start is read by its code first -- too many series is not "no series"', () => {
  // Reintroduce `if (status === 400) return tr('No series to search for')`: a Library selection of 600 read "No series
  // to search for", and "more than 500 series reads as none" fails.
  assert.equal(startRefusal(400, 'bad_request'), 'Too many series for one search: 500 at most', 'more than 500 series reads as none');
  assert.equal(startRefusal(400, 'empty_scope'), 'No series to search for');
  // Anything else is the caller's: the server's own message, or "Could not start the search".
  assert.equal(startRefusal(400, 'something_new'), null, 'an unknown refusal reads as no series');
  assert.equal(startRefusal(400, null), null);
  // Every key and the Library read it through findRefusal: the words, else the server's own message.
  const hook = code(read('lib/useFindRun.tsx'));
  assert.match(hook, /startRefusal\(e instanceof ApiError \? e\.status : null, codeOf\(e\)\) \?\? msgOf\(e, tr\('Could not start the search'\)\)/);
});

test('m11: a typed or source name takes its own direction', () => {
  // The review's ar-s1m-04: in Arabic the field showed "WALK tale other-name!" as "!WALK tale other-name". Reintroduce
  // the field without `dir="auto"`: "the other-name field takes the page's direction" fails.
  const names = slice(code(read('components/SourcesSheet.tsx')), 'function OtherNames(', 'const emptyStat');
  assert.match(names, /<input dir="auto" value=\{draft\}/, "the other-name field takes the page's direction");
  assert.match(names, /<span dir="auto" className="block truncate text-sm text-fog-100" title=\{a\.title\}>\{a\.title\}<\/span>/, "a stored name takes the page's direction");
  assert.match(names, /<p dir="auto" className="text-xs text-rose-300">\{msgOf\(error, tr\('Could not load the other names'\)\)\}<\/p>/,
    "the server's English message takes the page's direction");
  // The run card's series name is a run of its own inside the translated sentence.
  const task = slice(code(read('components/ServerDownloadsView.tsx')), 'function TaskRow(', 'function CameInTile(');
  assert.match(task, /const \[nowBefore, nowAfter\] = tr\('Now: \{title\}'\)\.split\('\{title\}'\);/);
  assert.match(task, /\{nowBefore\}<\/span>\s*<bdi dir="auto"[^>]*>\{r\.current\.title\}<\/bdi>\s*\{nowAfter && <span[^>]*>\{nowAfter\}<\/span>\}/,
    "the run card's series name is not isolated");
  // The results: a title in its own direction, a followed source's name isolated.
  const row = renderToStaticMarkup(createElement(FindResultRow, { r: res('a', { followed: [followed('Asura Scans!')] }), onOpen: () => {} }));
  assert.match(row, /<a [^>]*dir="auto"[^>]*>A<\/a>/);
  assert.match(row, /<bdi[^>]*>Asura Scans!<\/bdi>/);
});

test("m13: a Health row's key says how many series it searches for, counted in pairs", () => {
  // On a row of "Series that can no longer update" the key searches EVERY series of that source, and the count was
  // only in its tooltip. Reintroduce `label: tr('Find other sources')` in HealthRow's arm: "the row's key does not say
  // how many series" fails.
  const c = ACTION_COPY.find_sources;
  assert.equal(c.label({ n: 189 }), 'Find other sources (189 series)');
  assert.equal(c.label({ n: 1 }), 'Find other sources (1 series)');
  assert.equal(c.label({}), 'Find other sources', "the card's legend says a count it does not have");
  const row = slice(code(read('components/HealthActions.tsx')), 'export function HealthRow', 'const SCAN_CHECKS');
  const arm = slice(row, "case 'find_sources':", "case 'renumber':");
  assert.match(arm, /label: copy\.label\(\{ \.\.\.ctx, n: item\.findSeries \}\)/, "the row's key does not say how many series");
  // One key per number, so a language that inflects the noun can: "(1 Serie)", "(189 Serien)".
  const de = JSON.parse(read('public/locales/de.json'));
  setActiveDict(de);
  try {
    assert.equal(c.label({ n: 1 }), de['Find other sources (1 series)']);
    assert.equal(c.label({ n: 189 }), de['Find other sources ({n} series)'].replace('{n}', '189'));
  } finally { setActiveDict({}); }
});

test('nit: Find more sources says it follows the sources that match -- a run can follow two', () => {
  // Reintroduce "…and follows one whose title and chapter numbers match": "Find more sources promises one source" fails.
  const find = slice(code(read('components/SourcesSheet.tsx')), 'function FindMore(', 'function OtherNames(');
  assert.match(find, /what: tr\('Searches the other sources under this title and its other names, and follows the ones whose title and chapter numbers match\.'\),/,
    'Find more sources promises one source');
});

/* ================================================================ review first (v0.51.0) */

const prop = (sourceId: string, o: Partial<FindProposal> = {}): FindProposal => ({
  sourceId, sourceName: `Name ${sourceId}`, sourceSeriesId: `${sourceId}|x`, title: 'Alpha Tale', coverUrl: `https://${sourceId}.example/c.jpg`,
  chapters: 15, ours: { lined: 13, of: 14 }, theirs: { lined: 13, of: 15 }, coverage: 0.93, verdict: 'green', ...o,
});
const reviewRun = () => run({
  status: 'done', review: true, total: 5, done: 5, followed: 1, finishedAt: '2026-09-28T10:05:00Z', results: [
    res('a', { proposals: [prop('s1'), prop('s2', { verdict: 'amber', amber: 'numbering', ours: { lined: 0, of: 14 } }), prop('s3', { state: 'dismissed' })] }),
    res('b', { proposals: [prop('s4', { verdict: 'amber', amber: 'other_name' })] }),
    // Hidden by the 18+ filter: the server sends no title for it, nor its matches'.
    { seriesId: 'c', followed: [], proposals: [prop('s5', { title: undefined, coverUrl: undefined })] },
    res('d', { followed: [followed('Name s6', 15)], proposals: [prop('s6', { state: 'followed' }), prop('s7')] }),
    res('e', { why: 'no_match' }),
  ],
});

test('review first: green and amber in words, and Follow all green follows only the green matches nobody decided', () => {
  // #132 (@TIGamingTV): a person confirms each match by its cover. Reintroduce the bulk over every open match (drop
  // `p.verdict === 'green' &&` in greenToFollow): the amber ones are followed unseen, and the named assertion fails.
  const r = reviewRun();
  // Every series with matches is the review's, decided or not; a series without them keeps its group. Reintroduce
  // groupResults without its review arm: the named assertion fails.
  const g = groupResults(r.results);
  assert.deepEqual(g.review.map((x) => x.seriesId), ['a', 'b', 'c', 'd'], "a review's series reads as found or nothing found");
  assert.deepEqual([g.found.length, g.nothing.map((x) => x.seriesId)], [0, ['e']]);
  assert.deepEqual(greenToFollow(r), [{ seriesId: 'a', sourceId: 's1' }, { seriesId: 'd', sourceId: 's7' }],
    'Follow all green follows a match it must leave: an amber one, a decided one, or one nobody could see');
  assert.deepEqual(greenToFollow(null), []);
  assert.equal(findSummary(r), '1 source followed · 4 series to review · Nothing found for 1 series');
  // The words: the line-up both ways, and why a match is amber.
  assert.equal(lineUpText(prop('s1')), '13 of our 14 chapters line up · We list 13 of its 15');
  assert.equal(amberNote(prop('s1')), null, 'a green match says it is amber');
  assert.match(amberNote(prop('s2', { verdict: 'amber', amber: 'numbering' }))!, /^Amber: a name matches, but the chapter numbers do not line up\./);
  assert.match(amberNote(prop('s4', { verdict: 'amber', amber: 'other_name' }))!, /^Amber: it matched only under another name of this series/);
  // The Sources sheet's line for its own series, and the bulk's.
  assert.deepEqual(seriesOutcome(r, 'b'), { text: '1 match to review' });
  assert.deepEqual(seriesOutcome(r, 'a'), { text: '2 matches to review' });
  assert.deepEqual(seriesOutcome(run({ status: 'done', review: true, results: [res('z', { proposals: [prop('s1', { state: 'dismissed' })] })] }), 'z'),
    { text: 'No source followed', partial: true });
  assert.deepEqual(bulkOutcome(3, 0), { outcome: '3 sources followed' });
  assert.deepEqual(bulkOutcome(1, 1), { outcome: '1 source followed · 1 could not be followed', partial: true });
  // A refusal is the reason in words; the cap and posting order are the run's own sentences for them.
  assert.equal(decideRefusal('full'), findWhyLine('full'));
  assert.equal(decideRefusal('posting_order'), findWhyLine('posting_order'));
  assert.equal(decideRefusal('busy'), null);
  // v0.52.0: a match kept from before the language guard is refused by its language, in words. Reintroduce by dropping
  // its case: the refusal falls through to the server's English.
  assert.equal(decideRefusal('language_differs'), 'That source is in another language than this series', 'a refusal for its language is not worded');
  // v0.54.0, Replace's review: Make main's refusals with no words of the server's own (it says the main-source switch's
  // by their codes). Reintroduce by wording `decided` alone: a series at the follower cap reads the server's English.
  assert.equal(promoteRefusal('decided'), 'Made main or skipped already');
  assert.equal(promoteRefusal('full'), findWhyLine('full'), 'a match refused at the follower cap is not worded');
  assert.equal(promoteRefusal('posting_order'), null, 'a refusal the server words is worded twice');
});

test("review first: each match beside the series' own cover, its title in its own direction, and Follow / Skip until decided", () => {
  // Reintroduce the keys on every match (drop `p.state ?` in ProposalRow): a followed match offers Follow again.
  const r = reviewRun().results[0];
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(SeriesReview, { runId: 'r1', r })));
  // Both covers, side by side: the series' own and the match's, through the cover proxy.
  assert.ok(html.includes('src="/img/series/a/thumb'), "the series' own cover is missing");
  assert.ok(html.includes(`src="/img/sources/cover?source=s1&amp;u=${encodeURIComponent('https://s1.example/c.jpg')}`), "the match's cover is not through the proxy");
  assert.match(html, /<p dir="auto"[^>]*>Alpha Tale<\/p>/, "a match's title takes the page's direction");
  assert.ok(html.includes('13 of our 14 chapters line up · We list 13 of its 15'));
  assert.equal((html.match(/data-review-follow="/g) ?? []).length, 2, 'a decided match offers Follow again');
  assert.ok(html.includes('data-review-state="dismissed"'), 'a skipped match does not say so');
  assert.ok(html.includes('data-amber-note'), 'an amber match does not say why');
  assert.doesNotMatch(html, /rounded-full/, 'a capsule in the review');
});

test('an earlier search opens in the sheet by its id, and the latest is a key away', () => {
  // v0.52.0: only the newest run was read in full, so a review-first run with matches still waiting could not be
  // reopened once another search had run. Reintroduce the earlier lines as plain text (no key): "an earlier search
  // cannot be opened" fails.
  const sum = (id: string): FindRunSummary => ({ id, status: 'done', total: 1, done: 1, followed: 0, startedBy: null, startedAt: '2026-10-01T10:00:00Z' });
  const recent = ['r6', 'r5', 'r4', 'r3', 'r2', 'r1', 'r0'].map(sum);
  // The newest is the sheet's own view, and the one open now is not listed under itself; five at most.
  assert.deepEqual(earlierRuns(recent, null).map((r) => r.id), ['r5', 'r4', 'r3', 'r2', 'r1']);
  assert.deepEqual(earlierRuns(recent, 'r4').map((r) => r.id), ['r5', 'r3', 'r2', 'r1', 'r0']);
  assert.deepEqual(earlierRuns(undefined, null), []);
  const sheet = slice(code(read('components/FindSources.tsx')), 'export function FindResultsSheet(', 'export function FindRunCard(');
  assert.match(sheet, /<button type="button" onClick=\{\(\) => setOpenId\(r\.id\)\} data-find-earlier=\{r\.id\}/, 'an earlier search cannot be opened');
  assert.match(sheet, /queryFn: \(\) => fetchFindRun\(openId!\)/, 'the opened search is not read by its id');
  assert.match(read('lib/useFindRun.tsx'), /api<FindStatus>\(`\/api\/admin\/sources\/find\?runId=\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(sheet, /onClick=\{\(\) => setOpenId\(null\)\} data-find-latest/, 'there is no way back to the latest search');
  // The keys sit under the results: the run they open starts at the sheet's top, not a screen above the reader.
  assert.match(sheet, /useEffect\(\(\) => \{\s*if \(shown\.current === openId\) return;\s*shown\.current = openId;\s*top\.current\?\.scrollIntoView\(\{ block: 'start' \}\);\s*\}, \[openId\]\);/,
    'an opened run begins a screen above where the reader is');
  assert.match(sheet, /<div data-find-results ref=\{top\}/);
  // A match's state has a key of its own too: one match, beside "Followed" (and v0.54.0's "Made main"), in the number
  // and gender it agrees with.
  assert.match(code(read('components/FindSources.tsx')), /p\.state === 'followed' \? tr\('Followed'\) : p\.state === 'promoted' \? tr\('Made main'\) : tr\('Skipped for good'\)/);
});

test('the start dialog remembers the last choice on this device; storage that throws reads as automatic', () => {
  // Reintroduce the read without its try/catch: a private window, whose storage throws, breaks every start point.
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
  try {
    Object.defineProperty(g, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: storage is off'); } });
    assert.doesNotThrow(() => findReviewFirst(), 'storage that throws breaks the start dialog');
    assert.equal(findReviewFirst(), false);
    assert.doesNotThrow(() => setFindReviewFirst(true), 'storage that throws breaks Start');
    const store = new Map<string, string>();
    Object.defineProperty(g, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
    });
    assert.equal(findReviewFirst(), false, 'automatic is not the default');
    setFindReviewFirst(true);
    assert.equal(findReviewFirst(), true, 'the last choice is not remembered');
    setFindReviewFirst(false);
    assert.deepEqual([findReviewFirst(), store.size], [false, 0]);
  } finally {
    if (had) Object.defineProperty(g, 'localStorage', had);
    else delete g.localStorage;
  }
  // Every start point asks: Health's row and the Library's More through the dialog, the Sources sheet inline. The
  // dialog opens on the last choice and remembers the one it starts with.
  const comp = code(read('components/FindSources.tsx'));
  const dialog = slice(comp, 'export function FindStartDialog(', 'function useReviewActions(');
  assert.match(dialog, /const \[review, setReview\] = useState\(findReviewFirst\);/, 'the dialog forgets the last choice');
  assert.match(dialog, /onClick=\{\(\) => \{ setFindReviewFirst\(review\); onStart\(review\); \}\}/, 'Start does not remember the choice');
  const health = code(read('components/HealthActions.tsx'));
  assert.match(health, /\{asking === 'find' && \(\s*<FindStartDialog onClose=\{\(\) => setAsking\(null\)\}\s*onStart=\{\(review\) => \{ setAsking\(null\); if \(item\.sourceId\) void fr\?\.start\(slotKey, \{ sourceId: item\.sourceId, \.\.\.\(review \? \{ review \} : \{\}\) \}\); \}\} \/>/,
    "Health's dialog does not start the run it chose");
  const sheet = slice(code(read('components/SourcesSheet.tsx')), 'function FindMore(', 'function OtherNames(');
  assert.match(sheet, /<FindModeChoice review=\{review\} onChange=\{setReview\} \/>/, 'the Sources sheet does not offer the choice');
  assert.match(sheet, /\{mineRow && run && <SeriesReview runId=\{run\.id\} r=\{mineRow\} onFollowed=\{onFound\} onAddEdition=\{onAddEdition\} \/>\}/, "the sheet does not show its series' matches");
});
