// Adding a series must answer when the DECISION is made, not when the download finishes.
//
// Measured on a live install before this changed: 15.5s, 48.3s and 59.2s for one POST, because the request
// downloaded the whole first chapter before replying -- pages fetched one at a time at up to 45s each,
// behind an unbounded queue, every step a Cloudflare challenge solve. The job row was created BEFORE that
// download, so the Discover strip knew the download had started while the button still said "Working…".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');
const addFn = () => {
  const t = read('routes', 'sources.ts');
  return t.slice(t.indexOf('export async function addSeriesFromSource'), t.indexOf('/** Best single cross-source match'));
};

/** Source with comment lines removed. The first version of the guard below matched the COMMENT explaining
 *  `wait: false` rather than the call itself, so it passed happily with the bug put back -- the same trap
 *  that made an earlier guard in this repo match the comment describing a fix instead of the fix. */
const code = (text: string) =>
  text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('THE WAIT: the route does not hold the reply for the download', () => {
  // Reintroduce by dropping `wait: false` at the route: the POST goes back to holding the button for the
  // length of a chapter download, which is what this whole change exists to stop.
  const t = code(read('routes', 'sources.ts'));
  const at = t.indexOf("app.post('/api/sources/add'");
  assert.ok(at > 0, 'the add route is gone');
  // The whole route, to its closing brace: a fixed byte window silently shrank to "the first N characters"
  // as the body schema grew (the alsoFollow line of v0.36.0 pushed the call past it) and the guard failed
  // for a reason that was never the wait.
  const end = t.indexOf('\n  });', at);
  assert.ok(end > at, 'the add route has no closing brace');
  const route = t.slice(at, end);
  assert.match(route, /addSeriesFromSource\([^)]*wait:\s*false/, 'the add route awaits the download again');
});

test('the work is behind the reply, and the decisions are not', () => {
  const fn = addFn();
  const at = fn.indexOf('const run = async');
  assert.ok(at > 0, 'the download half is no longer separated from the decision half');

  // Everything that decides what to TELL the caller must stay inline, or the interactive answers are lost:
  // the duplicate prompt has an "Add anyway" button, which cannot be a background job.
  const decide = fn.slice(0, at);
  for (const [needle, why] of [
    ["error: 'disabled'", 'the disabled answer'],
    ["'already in library'", 'the already-present answer'],
    ["error: 'duplicate'", 'the duplicate prompt'],
    ["error: 'no_chapters'", 'the no-chapters answer'],
  ] as const) {
    assert.ok(decide.includes(needle), `${why} moved behind the reply, where nobody can answer it`);
  }
  // ...and the expensive part must not be among them.
  assert.ok(!decide.includes('downloadChapter('), 'the chapter download is back in the inline half');
});

test('the two inline lookups are bounded, parallel, and shared with the dialog', () => {
  // These are the only network calls left before the reply and they had no timeout at all. Worse, `add` ran
  // them one after the other while `/api/sources/detail` -- which the add dialog calls seconds earlier for
  // the very same two facts -- ran them together. So opening the dialog and pressing Add paid for four
  // challenge solves to learn two things, measured at 22.8s for an add that had already backgrounded its
  // downloading.
  //
  // Reintroduce by removing a withTimeout, by awaiting them in sequence, or by having either caller fetch
  // directly instead of through the shared helper.
  const t = code(read('routes', 'sources.ts'));
  const helper = t.slice(t.indexOf('async function seriesAndChapters'), t.indexOf('export function clearDetailCache'));
  assert.match(helper, /withTimeout\(src\.getSeries\(/, 'getSeries is unbounded');
  assert.match(helper, /withTimeout\(src\.listChapters\(/, 'listChapters is unbounded');
  assert.match(helper, /Promise\.all\(/, 'the two lookups are sequential again, so an add pays the sum');
  assert.match(helper, /detailCache\.set/, 'nothing is cached, so the dialog and the add each pay in full');

  // Both callers must go through it, or the caching is pointless.
  assert.match(addFn(), /seriesAndChapters\(src, sourceId\)/, 'add fetches its own copy again');
  const detail = t.slice(t.indexOf("app.get('/api/sources/detail'"), t.indexOf("app.get('/api/sources/detail'") + 900);
  assert.match(detail, /seriesAndChapters\(src, sourceId\)/, 'detail does not populate the cache the add reads');
});

test('a failed background download leaves the failure behind; an awaited one does not', () => {
  // The caller has already been told the download started, so the job card IS the failure report. But the
  // bulk importer awaits and counts its own results, and would otherwise strand one card per failed title.
  //
  // Reintroduce by deleting the job on failure regardless of `wait`.
  const fn = addFn();
  const fail = fn.slice(fn.indexOf('if (!firstPages)'), fn.indexOf('const j0 ='));
  assert.match(fail, /opts\.wait === false/, 'the failure path treats a detached add like an awaited one');
  assert.match(fail, /status = 'error'/, 'a detached failure records nothing for the user to find');
  assert.match(fail, /jobs\.delete/, 'an awaited failure strands a card the caller cannot see');
});

test('a finished job ages out, a failed one waits to be dismissed', () => {
  // `jobs.delete` had exactly one call site, so a successful job was never removed and the strip filled up
  // with green cards until a restart. A FAILED one must not age out: it is the only record that the
  // download did not work.
  //
  // Reintroduce by sweeping on any terminal status.
  const t = read('routes', 'sources.ts');
  const sweep = t.slice(t.indexOf('function sweepJobs'), t.indexOf('function sweepJobs') + 400);
  assert.match(sweep, /status === 'done'/, 'the sweep does not distinguish finished from failed');
  assert.doesNotMatch(sweep, /status === 'error'/, 'a failure is being swept away before it can be read');
  assert.match(t, /app\.delete\('\/api\/sources\/jobs\/:folder'/, 'nothing can dismiss a finished job');
});

/**
 * #67: the add answers with the id of the series it landed on, and the route hands that id out only to a
 * caller who may see the series.
 *
 * Before this, no branch answered with an id at all, so "Open in library" re-found the series by title
 * search and fell back to the first result -- a confident wrong navigation. addSeries.int.test.ts drives
 * every branch for real; this pins the lines, the way this file pins the rest of the route.
 *
 * ⚠️ Matched against the code with its comment lines stripped, as the header of this file warns: an
 * earlier version of a guard here matched the COMMENT that described a fix instead of the fix.
 */
test('THE ID: every add that can name its series does, and the route gates it on the viewer', () => {
  // Reintroduce by dropping `seriesId` from any one of these returns: the matching assertion fails, and
  // addSeries.int.test.ts's "every add answers with the series id it created or revived" fails with it.
  const fn = code(addFn());
  assert.match(fn, /seriesId: existing\.id/, 'the already-in-library branch answers without the id it just read');
  assert.match(fn, /nothing: true, seriesId: id/, 'the nothing-yet branch answers without the id it just minted');
  assert.match(fn, /alreadyHere: selected\.length, seriesId: heldId/, 'the "nothing left to fetch" branch answers without an id');
  assert.match(fn, /seriesId: seriesId \?\? existing\?\.id/, 'an awaited add answers without the id its own scan created');
  assert.match(fn, /card\.seriesId = seriesId/, 'the id never reaches the job card, so a fresh download can only be found by title again');

  // The route is where the viewer lives: `addSeriesFromSource` is shared with the bulk importer and has
  // none. Reintroduce by forwarding `r.seriesId` or `r.existing` whole: "a member who cannot see the
  // series is not given its id" in addSeries.int.test.ts hands out both.
  const t = code(read('routes', 'sources.ts'));
  const at = t.indexOf("app.post('/api/sources/add'");
  assert.ok(at > 0, 'the add route is gone');
  const end = t.indexOf('\n  });', at);
  const route = t.slice(at, end);
  assert.match(route, /seriesVisible\(r\.seriesId, vc\(req\)\)/, 'the 200 hands out an id without asking whether this caller may see the series');
  assert.match(route, /seriesVisible\(r\.existing\.id, vc\(req\)\)/, 'the 409 hands out an id without the same check');
  assert.doesNotMatch(route, /existing: r\.existing[,\s}]/, 'the duplicate body forwards the row whole again, id and all');
});

/**
 * #65: the add filters its selection against what the library already holds, and has a branch for the
 * case where that leaves nothing.
 *
 * `lib/downloader.ts` can only ever check one path under DL_ROOT, so a chapter the scanner indexed under
 * a read-only root -- 33,854 of them on the owner's install -- was invisible and got downloaded again,
 * then filed a second time. Reintroduce any one of these and the matching case in addSeries.int.test.ts
 * ("an add never re-downloads what the library already holds") fails.
 */
test('THE HAVE-SET: the add never queues a chapter the library already holds', () => {
  const fn = code(addFn());
  assert.match(fn, /FROM lib_books b JOIN lib_series s ON s\.id = b\.series_id/, 'the have-set is not read from the library at all');
  assert.match(fn, /WHERE s\.folder = \$1 AND b\.pruned_at IS NULL/,
    'the have-set is keyed on something other than the folder, or counts a tombstone as held');
  assert.doesNotMatch(fn, /heldBooks\(/,
    'the add now uses the sweep\'s rule, so a chapter deleted with "Delete files" can never be fetched again');
  assert.match(fn, /const toFetch = selected\.filter\(\(c\) => !have\.has\(c\.number\)\)/, 'the selection is not filtered against the have-set');
  assert.match(fn, /jobs\.set\(folder, \{ title, total: toFetch\.length/, 'the progress bar counts chapters that are not being fetched');
  assert.match(fn, /if \(!toFetch\.length\) \{/,
    'the "nothing left to fetch" branch is gone: the add answers 422 undownloadable for a series it holds in full');
  // The floor records what was ASKED for. Computed from `toFetch` it would be `Math.min()` of an empty
  // list -- Infinity -- and the series would be floored above every chapter it will ever be offered.
  assert.match(fn, /\? Math\.min\(\.\.\.selected\.map\(\(c\) => c\.number\)\) : null/, 'the chapter floor is computed from something other than the selection');
});
