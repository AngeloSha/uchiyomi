// Discover keeps up with the sources it is asking now, and with its own buttons.
//
// Three things were wrong. Turning Show 18+ off left every adult source's covers on the wall, under a chip counting
// fewer sources than the wall showed, and counted them as answered in "{done} of {total} sources". A source chosen
// alone stayed chosen after it left the list: its chip read its raw id and a search asked only it. And flipping
// Newest/Popular dropped the chosen source. Read from source, like discoverSearch.test.ts and wall.test.ts; each guard
// names the edit that fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
/** The file with its comments removed -- the comments quote the code they replaced. */
const code = page.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the wall shows only the sources asked now', () => {
  // Reintroduce `if (!key.startsWith(`${listMode}:`)) continue;`: a source hidden by Show 18+ keeps its covers.
  assert.match(code, /const asked = new Set\(budget\.map\(\(s\) => kOf\(s\.id\)\)\);\s*for \(const key of order\) \{\s*if \(!asked\.has\(key\)\) continue;/,
    'the wall reads every source that ever answered, not the ones asked now');
  assert.doesNotMatch(code, /for \(const key of order\) \{\s*if \(!key\.startsWith\(/, 'the wall reads every source that ever answered');
});

test('"done" counts only the sources asked now', () => {
  // Reintroduce `order.filter((k) => k.startsWith(`${listMode}:`)).length`: a hidden source counts as answered.
  assert.match(code, /const settled = budget\.filter\(\(s\) => order\.includes\(kOf\(s\.id\)\)\)\.length;/, 'settled counts sources no longer asked');
});

test('a chosen source that has left the list is let go', () => {
  // Drop the effect: with Show 18+ off an adult source stays chosen, its chip reads its id and a search asks only it.
  assert.match(code, /useEffect\(\(\) => \{\s*if \(!sourcesData \|\| !selected \|\| budget\.some\(\(s\) => s\.id === selected\)\) return;\s*setSelected\(null\);\s*\}, \[sourcesData, budget, selected\]\);/,
    'a source no longer on the list stays chosen');
});

test('flipping Newest/Popular keeps the source chosen where the other listing has it', () => {
  // Reintroduce `setSelected(null)` in onMode: one source's Newest flips to every source's Popular.
  const onMode = code.slice(code.indexOf('onMode={'), code.indexOf('/>', code.indexOf('onMode={')));
  assert.ok(onMode.length > 0, 'the picker has no onMode');
  assert.match(onMode, /setSelected\(selected && budgetForMode\(sources, m, Infinity\)\.some\(\(s\) => s\.id === selected\) \? selected : null\);/,
    'a mode change drops the chosen source');
  assert.doesNotMatch(onMode, /setSelected\(null\)/, 'a mode change drops the chosen source');
});

test('the empty wall says "could not be reached" of the sources asked now', () => {
  // Reintroduce `Object.values(states).every((s) => s === 'blocked')`: with Show 18+ off, or after a flip, a source no
  // longer asked decides whether the sources asked now "could not be reached".
  assert.match(code, /: budget\.every\(\(s\) => states\[kOf\(s\.id\)\] === 'blocked'\)\s*\? tr\('No source could be reached right now\.'\)/);
  assert.doesNotMatch(code, /Object\.values\(states\)\.every/, 'every source that ever answered, in either listing');
});
