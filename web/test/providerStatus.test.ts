// #115 on a source's row: a source whose Test or daily check failed says "Failing", not "Healthy".
//
// "Manga Ball (EN)" failed its Test while its Providers card said "ok": the card read the public status, which knows
// only cooldowns and which any download or the nightly lapsed-block reset puts back to 'ok'. The admin rows carry the
// open, confirmed failures (`failing`), and providerStatus overlays them -- for an extension's language in its sheet
// (lib/extensions.ts sourceHealth); since v0.54.0 Admin → Sources reads the server's word for each source (the sources
// overview's `state`, Health's own) and says since when from the same rows. The wiring facts are read from source, as
// healthActions.test.ts does, each guard naming the edit that fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerStatus } from '../lib/providerGroups';
import { sourceMark, SOURCE_STATUSES } from '../lib/status';
import { setActiveLocale } from '../lib/format';
import { failingSince, sourceSays, type OverviewSource } from '../lib/sourcesPanel';

const ROOT = join(__dirname, '..');
/** The file with its comments removed -- several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const read = (p: string) => code(readFileSync(join(ROOT, p), 'utf8'));
const panel = () => read('components/SourcesPanel.tsx');
const sheet = () => read('components/SourceSheet.tsx');

const failing = { failing: [{ stage: 'search' }] };
setActiveLocale('en');

test('a confirmed failure turns a healthy or quiet card into "failing"', () => {
  // Reintroduce by returning `pub ?? 'ok'` alone (the card built from the public status): 'ok' comes back.
  assert.equal(providerStatus('ok', failing), 'failing');
  assert.equal(providerStatus(undefined, failing), 'failing', 'a source with no status yet is no healthier');
  assert.equal(providerStatus('quiet', failing), 'failing', 'a failing step says more than "answers empty"');
  assert.equal(providerStatus('ok', { failing: [] }), 'ok');
  assert.equal(providerStatus('ok', null), 'ok');
  assert.equal(providerStatus('ok'), 'ok');
});

test('a cooldown or a switched-off source keeps its own words', () => {
  for (const st of ['disabled', 'blocked', 'rate_limited', 'down'] as const) {
    assert.equal(providerStatus(st, failing), st, `${st} became "failing"`);
  }
});

test('"failing" has an amber mark and its own word, and a failing source says since when', () => {
  assert.deepEqual(sourceMark('failing'), { tone: 'warn', label: 'Failing' });
  assert.ok(SOURCE_STATUSES.includes('failing'), 'sourceMark does not know failing');
  // Since when: the oldest open failure, else the last failure. Reintroduce the newest: a source failing for a week
  // reads as failing since this morning.
  const since = failingSince({ source_id: 'x', last_fail_at: '2026-10-02T08:00:00Z', failing: [
    { stage: 'search', since: '2026-09-29T08:00:00Z', error: null, kind: 'test', by: 'sweep', streak: 3 },
    { stage: 'pages', since: '2026-09-23T08:00:00Z', error: null, kind: 'use', by: 'update', streak: 3 },
  ] });
  assert.equal(since, '2026-09-23T08:00:00Z', 'a source failing for days says since its latest failure');
  assert.equal(failingSince({ source_id: 'x', last_fail_at: '2026-10-02T08:00:00Z' }), '2026-10-02T08:00:00Z');
  assert.equal(failingSince(undefined), null);
  const s: OverviewSource = { id: 'ball', name: 'Manga Ball (EN)', kind: 'extension', lang: 'en', standing: 'failing', state: 'failing', stage: 'search', main: 2, followed: 0, withBackup: 0 };
  const says = sourceSays(s, since);
  assert.match(says.word, /^Failing since /, 'a failing source does not say since when');
  assert.equal(says.tone, 'warn');
  assert.equal(says.reason, 'Search step', 'the step it fails at is not said');
  // The row and the sheet read since when from the admin rows the panel holds.
  assert.match(panel(), /since=\{failingSince\(evidence\.get\(s\.id\)\)\}/, 'a row does not say since when');
  assert.match(sheet(), /const says = s \? sourceSays\(s, failingSince\(row\)\) : null;/, 'the sheet does not say since when');
});

test('an extension\'s language reads its status through providerStatus, from the admin rows', () => {
  // Reintroduce `sourceMark(pub?.status ?? 'ok')` in lib/extensions.ts sourceHealth: the overlay never happens and the
  // language says Healthy over a confirmed failure.
  assert.match(read('lib/extensions.ts'), /const st = providerStatus\(pub\?\.status \?\? 'ok', adminRows\?\.get\(id\) \?\? null\);/);
});

test('"Working normally." is never the page\'s own fallback', () => {
  // It is said only by lib/sourceEvidence.ts answerView, and only under a passing Test with no ✗ on screen.
  // Reintroduce `{d.reason || 'Working normally.'}` in the sheet: this fails.
  assert.doesNotMatch(read('app/admin/page.tsx') + panel() + sheet(), /Working normally/);
  assert.match(sheet(), /<SourceEvidence answer=\{answer\}/, 'the sheet no longer shows a live Test through SourceEvidence');
  assert.match(sheet(), /<SourceEvidence lines=\{row\?\.evidence\} tested=\{row\?\.live\}/, 'a reload loses the verdict: the stored evidence is not shown');
  // A failed Test is red only while the source still fails (lib/sourceEvidence.ts testedLine, sourceEvidence.test.ts).
  assert.match(sheet(), /tested=\{row\?\.live\} failing=\{!!row\?\.failing\?\.length\}/, 'the sheet does not say whether it is still failing');
});

test('a Test, a cleared block or a switched-off source refreshes Health and the header mark too', () => {
  // Reintroduce by dropping the Health keys from the panel's `changed` (or `onChanged` from the sheet's run): Health
  // keeps saying what it said before the Test.
  const changed = panel().slice(panel().indexOf('const changed = () => Promise.all(['), panel().indexOf(']);', panel().indexOf('const changed = ')));
  assert.match(changed, /qc\.invalidateQueries\(\{ queryKey: \['admin-health'\] \}\)/, 'a change here does not refresh Health');
  assert.match(changed, /qc\.invalidateQueries\(\{ queryKey: \['health-summary'\] \}\)/, 'a change here does not refresh the header mark');
  assert.match(changed, /qc\.invalidateQueries\(\{ queryKey: \['sources'\] \}\)/, 'a change here does not refresh the lists');
  const run = sheet().slice(sheet().indexOf('const run = async ('), sheet().indexOf('const test = () =>'));
  assert.match(run, /await onChanged\(\);/, 'the sheet\'s keys do not ask the lists and Health again');
  assert.match(panel(), /<SourceSheet [\s\S]*?onChanged=\{changed\} \/>/, 'the sheet is not handed the panel\'s refresh');
});

test('the Test key ticks against the limit, and Test all says where it has got to', () => {
  // Reintroduce `'Testing…'` as the running label: the clock is gone and a 50-second Test reads as stuck.
  assert.match(sheet(), /busy === 'test' \? testClock\(now - testFrom, testMs\) : tr\('Test'\)/);
  assert.match(sheet(), /const now = useTicker\(busy === 'test'\);/);
  assert.match(panel(), /testMs=\{adminRows\?\.testMs\}/, 'the clock does not know the limit');
  assert.match(panel(), /progress: \(p\) => \{ setChecking\(true\); setProgress\(p\); \}/, 'the progress never reaches the line');
  assert.match(panel(), /void run\.follow\(\);/, 'a sweep already running when the tab opens is not followed');
});
