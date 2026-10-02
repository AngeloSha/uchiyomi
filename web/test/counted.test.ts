// The last frozen singulars (v0.52.0): counts English does not inflect -- "3 selected", "3 deleted", "3 not here yet" --
// shipped as one plural key apiece, so every language that agrees the word with its count read wrong at 1 ("1
// seleccionados", "1 supprimés"). Each now has its singular, and localeCoverage.test.ts's AGREEING_UNPAIRED is empty.
// English reads the same either way at 1, so these look at the KEY each count is said with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { setActiveDict } from '../lib/i18n';
import { deletedText, selectedText, skippedBookmarkedText, skippedNotOursText } from '../lib/counted';
import { supplyLine, type SupplyInput } from '../lib/supplyLine';

const ROOT = join(__dirname, '..');

test('one of a count is said with its own key, wherever it is counted', () => {
  // Reintroduce by answering the plural for every count in lib/counted.ts (or dropping the supply line's `=== 1`):
  // "one is said with the plural key" fails by the helper's name.
  // The singular's stand-in is a word, never what the plural's says at 1, or a plural answered for one would pass.
  setActiveDict({
    '1 selected': 'S-one', '{n} selected': 'S{n}', '1 deleted': 'D-one', '{n} deleted': 'D{n}',
    '1 skipped: not downloaded by Uchiyomi': 'N-one', '{n} skipped: not downloaded by Uchiyomi': 'N{n}',
    '1 skipped: bookmarked by a reader': 'B-one', '{n} skipped: bookmarked by a reader': 'B{n}',
  });
  try {
    for (const [name, fn, k] of [['selectedText', selectedText, 'S'], ['deletedText', deletedText, 'D'],
      ['skippedNotOursText', skippedNotOursText, 'N'], ['skippedBookmarkedText', skippedBookmarkedText, 'B']] as const) {
      assert.equal(fn(1), `${k}-one`, `${name}: one is said with the plural key`);
      assert.equal(fn(3), `${k}3`, `${name}: three is not the plural`);
      assert.equal(fn(0), `${k}0`, `${name}: none is the plural, "0 selected"`);
    }
  } finally { setActiveDict({}); }
  const base: SupplyInput = {
    sources: [{ sourceId: 'mangadex', name: 'MangaDex', primary: true, registered: true }], groups: [], notHere: 1, listedTotal: 7,
    booksCount: 3, checkedAt: null, autoUpdate: true, groupsError: false, isAdmin: false,
  };
  const keys = (n: number) => supplyLine({ ...base, notHere: n, checkedAt: new Date().toISOString() }, false)!
    .filter((p) => p.kind === 'text').map((p) => (p as { key: string }).key);
  assert.ok(keys(1).includes('1 not here yet'), 'the supply line says one chapter not here yet with the plural key');
  assert.ok(keys(4).includes('{n} not here yet'));
});

test('no screen says these counts with the plural key alone any more', () => {
  // The call sites go through lib/counted.ts or a pair of their own. Reintroduce `tr('{n} selected', …)` on any screen:
  // its file is named here.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) files.push(full);
    }
  };
  for (const d of ['app', 'components', 'lib']) walk(join(ROOT, d));
  const bare = /tr\('\{n\} (selected|deleted|skipped: not downloaded by Uchiyomi|skipped: bookmarked by a reader)'/;
  const left = files.filter((f) => !f.endsWith(join('lib', 'counted.ts')) && bare.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
  assert.deepEqual(left, [], `a count is still said with its plural key alone in ${left.join(', ')}`);
  assert.match(readFileSync(join(ROOT, 'app/admin/page.tsx'), 'utf8'), /l\.pinned === 1 \? tr\('1 filed by hand'\) : tr\('\{n\} filed by hand', \{ n: l\.pinned \}\)/);
  assert.match(readFileSync(join(ROOT, 'app/moments/page.tsx'), 'utf8'), /g\.items\.length === 1 \? tr\('1 saved'\) : tr\('\{n\} saved', \{ n: g\.items\.length \}\)/);
});
