// Health's By series view (lib/healthBySeries.ts, components/HealthBySeries.tsx, v0.72.0, @Squeaks72's idea in #254):
// which ticked series a Remove acts on, what it says after, and how the Health tab offers the view. The grouping itself
// is the server's (bff test/healthBySeries.int.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SERIES_PAGE, allChosen, chosenOf, healthView, removedText, toggleAll } from '../lib/healthBySeries';
import type { SeriesFindings } from '../lib/types';

const row = (seriesId: string): SeriesFindings => ({ seriesId, title: seriesId.toUpperCase(), status: 'warn', findings: [] });
const code = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

test('a Remove acts on the ticked series on the screen, and on nothing that left it', () => {
  // #254's selection outlived its rows: after a re-check, "Remove 3" hid series no longer listed. Reintroduce the bare
  // selection (`[...picked]`): the series that left is removed.
  const shown = [row('a'), row('b'), row('c')];
  assert.deepEqual(chosenOf(new Set(['a', 'c', 'gone']), shown), ['a', 'c']);
  assert.deepEqual(chosenOf(new Set(['gone']), shown), []);
  // Select all ticks what is on the screen, nothing past it; pressed again it clears.
  const all = toggleAll(new Set(['gone']), shown);
  assert.deepEqual([...all].sort(), ['a', 'b', 'c']);
  assert.equal(allChosen(all, shown), true);
  assert.deepEqual([...toggleAll(all, shown)], []);
  assert.equal(allChosen(new Set(), []), false, 'nothing on the screen is not "all ticked"');
  assert.equal(SERIES_PAGE, 50);
});

test('what a Remove said: the Library\'s words for the same route, and never "Removed 0 series"', () => {
  assert.deepEqual(removedText({ hidden: 2, skipped: [] }), { ok: true, text: 'Removed 2 series' });
  assert.deepEqual(removedText({ hidden: 1, skipped: [{ reason: 'busy' }] }), { ok: true, text: 'Removed 1 series · 1 skipped' });
  assert.deepEqual(removedText({ hidden: 0, skipped: [{ reason: 'merged' }, { reason: 'busy' }] }), { ok: false, text: 'Nothing removed · 2 skipped' });
});

test('the view is this device\'s, By check until it chooses, and a private window reads By check', () => {
  assert.equal(healthView(), 'checks', 'no localStorage here: By check');
});

test('the Health tab: a view switch above the findings, the series view on the shared report, keys and the card look', () => {
  const page = code('app/admin/page.tsx');
  const health = page.slice(page.indexOf('function Health()'), page.indexOf('function DesktopUpdateNote()'));
  assert.match(health, /<Segmented square label=\{tr\('Group the findings'\)\} value=\{view\} onChange=\{pickView\}/);
  assert.match(health, /\{view === 'series' && \(data\?\.bySeries\s*\? <HealthBySeries rows=\{data\.bySeries\} checks=\{checks\} \/>/);
  assert.match(health, /\{view === 'checks' && checks\.map\(\(c\) => \{/);
  // One query for every reader of the report on Admin, so a reader asking without the series never replaces it.
  assert.equal((page.match(/useQuery\(\{\s*queryKey: \['admin-health'\]/g) ?? []).length, 0, 'a reader of the report builds its own query');
  assert.equal((page.match(/useQuery\(healthQuery\)/g) ?? []).length, 4);
  const view = code('components/HealthBySeries.tsx');
  // Removing is the bulk route's hide, never N deletes, after a confirmation that counts and names.
  assert.match(view, /api<[\s\S]*?>\('\/api\/admin\/series\/bulk\/hide', \{ json: \{ ids \} \}\)/);
  assert.doesNotMatch(view, /method: 'DELETE'/);
  assert.match(view, /tr\('Remove \{n\} series from the library\?', \{ n: asking\.length \}\)/);
  assert.match(view, /asking\.slice\(0, NAMED\)\.map/, 'the confirmation names the series');
  // What it does is a key; where it goes is a link. Health's card look, with its edge.
  assert.doesNotMatch(view, /<button[^>]*className="text-xs text-accent/, 'an action is a text link');
  assert.match(view, /className="card grad-border full relative overflow-hidden"/);
  assert.match(view, /<StatusEdge tone=\{mark\.tone\} \/>/);
  assert.match(view, /const chosen = chosenOf\(picked, shown\);/);
});
