// "Finish downloads on their own" (v0.78.0, bff lib/finishDownloads.ts): the switch on Admin → Settings, where the search
// finds it, and the words the add's card and Health's gap rows say. The behaviour is the bff's own test,
// finishDownloads.int.test.ts; this pins what a person sees of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESTINATIONS } from '../lib/destinations';
import { SAID_CODES, saidText } from '../lib/said';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with its comments removed: the comments describe what the code must not do. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${from} not found`);
  return src.slice(a, src.indexOf(to, a + 1));
};

test('Admin → Settings: Finish downloads on their own in Downloads, the one switch, on unless off', () => {
  const schedules = slice(code(read('components/AdminSettings.tsx')), 'function SchedulesSection(', 'export function NightlyModeRow(');
  // Reintroduce `=== true`: a server that does not send the key yet (and every new one, whose column defaults on) would
  // show the switch off while it is on. v0.81.0: it is also the switch for looking for other sources (it was "Use other
  // sources on their own"): both written together, and on only while both are. Reintroduce by saving finishDownloads
  // alone: the search for other sources can no longer be turned off.
  assert.match(schedules, /<SwitchRow id="finish-downloads" label=\{tr\('Finish downloads on their own'\)\}[\s\S]*?on=\{data\.finish_downloads !== false && data\.auto_follow_on_failure !== false\}\s*onChange=\{\(next\) => save\(\{ finishDownloads: next, autoFollowOnFailure: next \}\)\} \/>/);
  assert.match(schedules, /On by default\./, 'the help does not say it is on until turned off');
  assert.match(schedules, /finds a new one/, 'the help does not say it looks for other sources');
  assert.match(schedules, /Off, chapters come only with the library update, from the sources you picked\./, 'the help does not say what off means');
  assert.doesNotMatch(schedules, /Use other sources on their own/, 'a second switch for the same thing');
  // Search lands on the row itself since v0.86.0 (lib/settingsIndex.admin.ts generates it).
  const d = DESTINATIONS.find((x) => x.key === 'admin-finish-downloads');
  assert.equal(d?.href, '/admin/?tab=downloads&section=finish-downloads');
  assert.equal(d?.admin, true);
  assert.ok(d?.keywords?.includes('rate limit'), 'searching "rate limit" does not find it');
});

test('the add card and Health say the new sentences in words, never as codes', () => {
  for (const code of ['job.refusingWillFinish', 'job.stoppedWillFinish', 'job.stoppedRefusingWillFinish', 'gaps.notListed', 'gaps.notListedSeries', 'gaps.notListedNote']) {
    assert.ok(SAID_CODES.includes(code), `${code} has no words`);
  }
  const say = (code: string, params: Record<string, string | number>) => saidText({ code, params }, 'FALLBACK');
  assert.match(say('job.refusingWillFinish', { source: 'MangaPill', status: 'rate_limited' }), /^MangaPill is currently rate-limiting downloads\. The series is saved/);
  assert.match(say('job.stoppedRefusingWillFinish', { source: 'MangaPill', status: 'blocked' }), /blocking downloads\. The rest will download on their own/);
  assert.equal(say('gaps.notListed', { n: 306, ranges: '577-882' }), '306 numbers none of its sources list — 577-882');
  assert.equal(say('gaps.notListed', { n: 1, ranges: '9' }), '1 number none of its sources list — 9');
});
