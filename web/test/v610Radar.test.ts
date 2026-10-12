// Where the release radar shows (v0.61.0): one muted line under the series page's reading progress, the reader's end
// card, Updates' Expected this week, the Library's Releasing soon cards, and Admin → Settings' Smart update checks.
//
// Static reads of the surfaces, as the other release tests do: the words themselves are radar.test.ts's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sortValue } from '../lib/sortValue';
import { DESTINATIONS } from '../lib/destinations';
import type { Series } from '../lib/types';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with its comments removed: the comments describe what the code must not do. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

test('the series page says what is coming in one muted line, directly under the reading progress', () => {
  // Reintroduce the line anywhere else (above the button, in the meta row): the order below fails. A second line, or a
  // capsule, fails too: the owner's series page has one reading button, its progress, and the keys.
  const page = code(read('app/series/page.tsx'));
  assert.match(page, /\{readLine && <ReadProgress read=\{readCount\.read\} total=\{readCount\.total\} text=\{readLine\} \/>\}\s*\{outlook && <p data-series-outlook className="[^"]*text-fog-500[^"]*">\{outlook\}<\/p>\}\s*(?:\{\}\s*)*<div data-series-keys/);
  assert.equal(page.match(/data-series-outlook/g)?.length, 1);
  assert.match(page, /const outlook = radarText\(series\?\.yomi\?\.radar, \{ autoUpdate: series\?\.autoUpdate !== false \}\);/,
    'the line does not go quiet for a series nothing updates');
});

test('the reader\'s end card: its label and line come from the radar, only at the end of the series', () => {
  // The reader page belongs to another piece of work: it mounts the label and the line once each, never offline, where
  // "End of your downloads" stays. Reintroduce a plain tr('You finished'): every caught-up reader is told it is over.
  const reader = code(read('app/reader/page.tsx'));
  assert.match(reader, /\{offlineEnd \? tr\('End of your downloads'\) : <ReaderEndLabel seriesId=\{activeSeriesId\} \/>\}/);
  assert.match(reader, /<h2 className="mt-1\.5 font-display text-2xl font-bold text-white">\{activeChapter\?\.seriesTitle \|\| tr\('This series'\)\}<\/h2>\s*\{!offlineEnd && <ReaderEndRadar seriesId=\{activeSeriesId\} \/>\}/);
  assert.equal(reader.match(/<ReaderEndRadar /g)?.length, 1);
  assert.equal(reader.match(/<ReaderEndLabel /g)?.length, 1);
  assert.doesNotMatch(reader, /tr\('You finished'\)/, 'the old label is still on the reader page');
  // The component reads the series under the series page's own key and endpoint (queryKeys.test.ts).
  assert.match(code(read('components/ReaderEndRadar.tsx')), /queryKey: \['series', seriesId\],\s*queryFn: \(\) => api<Series>\(`\/api\/series\/\$\{seriesId\}`\)/);
});

test('Updates: Expected this week sits under the list and the empty state, with its own query key, gone when empty', () => {
  const page = code(read('app/updates/page.tsx'));
  const section = slice(page, 'function ExpectedThisWeek(', 'export default function UpdatesPage(');
  // Reintroduce ['updates'] as its key: the new-chapters list renders the expected series' DTOs (queryKeys.test.ts).
  assert.match(section, /queryKey: \['updates-expected'\], queryFn: \(\) => api<\{ content: Series\[\] \}>\('\/api\/updates\/expected'\)/);
  assert.match(section, /if \(!list\.length\) return null;/, 'an empty heading on a quiet week');
  assert.match(section, /<section data-expected /);
  assert.match(section, /\{tr\('Expected this week'\)\}/);
  assert.match(section, /\{tr\('Estimated from when chapters usually arrive, not promised\.'\)\}/, 'the honesty note is gone');
  // After the list-or-empty-state ternary, so it shows under both.
  assert.match(page, /\)\}\s*<ExpectedThisWeek \/>\s*<\/div>\s*\);\s*\}\s*$/);
});

test('a Releasing soon card says the radar\'s note', () => {
  const s = (radar: any, over: Partial<Series> = {}) => ({ booksCount: 10, yomi: { favorite: false, rating: null, radar }, ...over }) as Series;
  const soon = { nextAt: new Date(Date.now() + 4 * 86_400_000).toISOString(), dueUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    quietAfter: new Date(Date.now() + 20 * 86_400_000).toISOString(), lastAt: null, every: 7, kind: 'weekly', steady: false, ended: false, basis: 'source' };
  assert.equal(sortValue(s(soon), 'soon')?.kind, 'soon');
  assert.match(sortValue(s(soon), 'soon')!.text, /^~\w+$/);
  assert.equal(sortValue(s(soon, { autoUpdate: false }), 'soon'), null, 'a series nothing updates has no next chapter coming');
  assert.equal(sortValue(s(null), 'soon'), null);
  assert.equal(sortValue(s(soon), 'updated'), null, 'only under its own order');
});

test('Admin → Settings: Smart update checks under the update interval, saved as updateSmart, off unless on', () => {
  const settings = code(read('components/AdminSettings.tsx'));
  const schedules = slice(settings, 'function SchedulesSection(', 'export function NightlyModeRow(');
  // Reintroduce `!== false`: a server older than v0.61.0 (no key) would show the switch on.
  assert.match(schedules, /<SwitchRow label=\{tr\('Smart update checks'\)\}[\s\S]*?on=\{data\.update_smart === true\} onChange=\{\(next\) => save\(\{ updateSmart: next \}\)\} \/>/);
  assert.ok(schedules.indexOf("tr('Smart update checks')") > schedules.indexOf("tr('Library update interval (hours)')"), 'not under the update interval');
  assert.match(schedules, /at least every 3 days/, 'the help does not say the limit');
  assert.match(schedules, /Check now always asks at once/, 'the help does not say Check now is never kept waiting');
  // And the search palette finds it by name, where it is.
  const d = DESTINATIONS.find((x) => x.label === 'Smart update checks');
  assert.equal(d?.href, '/admin/?tab=Settings&section=schedules');
  assert.equal(d?.admin, true);
});
