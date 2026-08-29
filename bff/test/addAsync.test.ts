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
  const route = t.slice(at, at + 900);
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
