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
  altKey, altOriginLabel, altRefusal, findEndedRunIds, findEta, findGate, findRunState, findSlotState, findSummary, findWhyLine,
  groupResults, notTriedIds, progressLine, seriesOutcome, startRefusal, FIND_SERIES_MAX_MS,
  type FindResult, type FindRun, type FindStatus,
} from '../lib/findSources';
import { ACTION_COPY } from '../lib/healthCopy';
import { answerView, diagnosisFix, diagnosisReason, evidenceView, healthRowEvidence, type StageLine } from '../lib/sourceEvidence';
import { runProgress, runTitle, type RunCard } from '../lib/jobs';
import { navRing, runName, type SourceJobs } from '../lib/serverDownloads';
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
  ]);
  assert.deepEqual(g.found.map((r) => r.seriesId), ['a', 'h']);
  assert.deepEqual(g.nothing.map((r) => r.seriesId), ['b', 'd'], 'a series never searched reads as nothing found');
  assert.deepEqual(g.skipped.map((r) => r.seriesId), ['e', 'f'], 'a series skipped on purpose reads as nothing found');
  assert.deepEqual(g.notTried.map((r) => r.seriesId), ['c', 'g']);
  assert.deepEqual(notTriedIds(run({ status: 'stopped', results: [res('c', { why: 'not_tried' }), res('b', { why: 'no_match' })] })), ['c']);
});

test('every reason is a sentence, and "not tried" says so rather than "not found"', () => {
  // Reintroduce a missing case (drop 'full' from findWhyLine): it reads the fallback "Nothing found" and fails here.
  const whys = ['no_match', 'refused', 'full', 'posting_order', 'not_tried'];
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
  assert.equal(findSummary(stopped), 'Stopped before it finished · 3 of 10 series · 1 source followed · Nothing found for 1 series · 8 series not tried');
  // A kept run without its results says the counts it carries.
  assert.equal(findSummary({ ...run({ status: 'done', total: 4, done: 4, followed: 0 }), results: undefined }), '0 sources followed');
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
  assert.deepEqual(findRunState(run({ status: 'interrupted', finishedAt: 7 })), { kind: 'failed', finishedAt: 7, reason: 'Interrupted by a restart' });
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
  // The refusals of a start, in words: 409 is another run, 400 an empty scope; anything else is the caller's.
  assert.equal(startRefusal(409, 'busy'), busy, 'another run going reads as a failure');
  assert.equal(startRefusal(400, 'bad_request'), 'No series to search for', 'nothing to search for reads as a failure');
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
  assert.match(find, /onRun: \(\) => \{ void fr\.start\('series', \{ seriesIds: \[id\] \}\); \}/, 'Find more sources does not start a run for this series');
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
  // How long: the pace and the search's own wall per series, rounded up -- or per series when the row does not say.
  assert.equal(FIND_SERIES_MAX_MS, 61_500);
  assert.equal(c.eta({ n: 189 }), 'Up to 4 hours');
  assert.equal(c.eta({ n: 6 }), 'Up to 7 minutes');
  assert.equal(c.eta({}), 'Up to about a minute per series');
  assert.equal(findEta(0), 'Up to about a minute per series');
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

test('the site says it is offline: the page words the code, and the server\'s English stays for everything else', () => {
  // aqua's own "temporarily offline" page, which Health read as "markup may not match this engine". Reintroduce
  // `d?.reason` in answerView (or drop the `site_offline` case): in German the verdict is the server's English, and
  // "the offline verdict is not in the reader's language" fails.
  const d = { code: 'site_offline', reason: 'The site says it is offline (its own page)', fix: 'Wait for the site to come back, or find other sources for its series.' };
  assert.equal(diagnosisReason(d), 'The site says it is offline', "the offline verdict is the server's sentence, not the page's words");
  assert.equal(diagnosisFix(d), 'Wait for the site to come back, or find other sources for its series.', "the offline fix is not the page's words");
  assert.equal(diagnosisReason({ code: 'edge_403', reason: 'Blocked.' }), 'Blocked.', 'another code loses the server\'s words');
  const de = JSON.parse(read('public/locales/de.json'));
  setActiveDict(de);
  try {
    const offline: StageLine = { stage: 'search', state: 'fail', at: null, by: 'sweep', kind: 'site_offline', error: 'Aqua Manga is temporarily offline' };
    const v = answerView({ ok: false, state: 'fail', stage: 'search', diagnosis: d,
      checks: [{ name: 'Search', ok: false, detail: 'offline page', stage: 'search', kind: 'site_offline', error: 'Aqua Manga is temporarily offline' }] });
    assert.equal(v.head?.text, de['The site says it is offline'], 'the offline verdict is not in the reader\'s language');
    assert.equal(v.fix, de['Wait for the site to come back, or find other sources for its series.']);
    assert.equal(v.rows[0].detail, de['the site says it is offline'], 'the Test\'s search line does not say the site is offline');
    assert.equal(evidenceView([offline]).rows[0].detail, de['the site says it is offline'], 'the stage line does not say the site is offline');
    // Health: the fix only where the row's own (English) detail does not already end with the server's fix.
    const row = { evidence: [offline], diagnosis: d, detail: 'Search failing since 2026-09-23 — The site says it is offline (its own page). 195 series use it' };
    assert.equal(healthRowEvidence(row).fix, de['Wait for the site to come back, or find other sources for its series.']);
    assert.equal(healthRowEvidence({ ...row, detail: `down; 195 series use it — ${d.fix}` }).fix, null, 'the fix is said twice, once in English');
  } finally { setActiveDict({}); }
});

/* ================================================================ Library and Server tasks */

test('Library: Find other sources is a row of More for admins, posts the selection, and says where the run shows', () => {
  // Reintroduce the key in the bar from lg up: library.test.ts measures the row. Post `picked.size` instead of the ids,
  // or keep the selection after a start: the matching assertion fails.
  const src = code(read('app/library/page.tsx'));
  const fn = slice(src, 'const findSelected = async () => {', 'const sentinel = useRef');
  assert.match(fn, /api<\{ runId: string; total: number \}>\('\/api\/admin\/sources\/find', \{ method: 'POST', json: \{ seriesIds: \[\.\.\.picked\] \} \}\)/);
  assert.match(fn, /n === 1 \? tr\('Looking for other sources for 1 series… Library → Downloads shows how it goes\.'\)/, 'one series is counted as many');
  // A run that goes on after the notice: the notice turns, and says it is busy (notices.test.ts).
  assert.match(fn, /'info', \{ busy: true \}\);/, 'the notice of a run that goes on does not turn');
  assert.match(fn, /void kickDownloads\(qc\);\s*settle\(\);/, 'the Server tasks card waits 30 s, or the selection stays after a start');
  assert.match(fn, /catch \(e\) \{ toast\(findRefusal\(e\), 'error'\); \}/, 'a refused start (another run, nothing to search) is not said');
  const more = slice(src, "<Sheet title={tr('{n} selected'", '</Sheet>');
  assert.match(more, /\{isAdmin && \([\s\S]*?setMore\(false\); void findSelected\(\);[\s\S]*?\{tr\('Find other sources'\)\}/, 'More has no Find other sources for admins');
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
  assert.match(view, /const cancelRun = \(kind: string\) => call\(kind === 'find_sources' \? '\/api\/admin\/sources\/find\/stop' : `\/api\/sources\/runs\/\$\{kind\}\/cancel`, 'POST'\);/,
    "the run's Stop posts the generic cancel");
  const task = slice(view, 'function TaskRow(', 'function CameInTile(');
  assert.match(task, /\{find \? tr\('Stopping after this series…'\) : tr\('Stopping after this chapter…'\)\}/, 'a find run stops "after this chapter"');
  assert.match(task, /\{find \? tr\('Stop'\) : tr\('Cancel'\)\}/);
  assert.match(task, /\{find && admin && \(\s*<button type="button" onClick=\{\(\) => setResults\(true\)\}/, 'the card has no way to its results');
  assert.match(task, /\{results && <FindResultsSheet onClose=\{\(\) => setResults\(false\)\} \/>\}/);
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
  assert.match(sheet, /return \(\s*<OnBody>\s*<Sheet title=\{tr\('Other-source search'\)\}/, 'the results are rendered inside the card that opened them');
  for (const [id, title] of [['found', 'New sources'], ['nothing', 'Nothing found'], ['skipped', 'Skipped'], ['not-tried', 'Not tried']]) {
    assert.match(sheet, new RegExp(`<Group id="${id}" title=\\{tr\\('${title}'\\)\\}`), `the ${title} group is gone`);
  }
  // What the run never reached can be searched now, through the same one-run rule.
  assert.match(sheet, /again\.start\('retry', \{ seriesIds: untried \}\)/, 'the untried series cannot be searched again');
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
