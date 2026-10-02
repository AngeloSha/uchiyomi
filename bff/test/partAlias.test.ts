// Chapter parts that sources number or split differently (lib/partAlias.ts), the pure half.
//
// The shapes are the live ones from 1 October, when the sweep downloaded about a hundred chapters it already had:
// Tales of Demons and Gods' two conventions (mangapill N / N.5, mangaread N.1 / N.6), natomanga's ten-part 78
// against a 78 held as one file, and Onepunch-Man's whole chapters against followers' halves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { aliasParts, partRulesApply, type HeldPart } from '../src/lib/partAlias';
import type { SourceChapter } from '../src/lib/sources/types';

const ch = (source: string, number: number, extra: Partial<SourceChapter> = {}): SourceChapter =>
  ({ sourceId: `${source}/${number}`, number, title: `Chapter ${number}`, source, ...extra });
const held = (number: number, sourceId: string | null = 'aqua'): HeldPart => ({ number, sourceId });
/** The listing after the rules, as `source number<-own` per copy, and the covered numbers. */
const run = (tagged: SourceChapter[], disk: HeldPart[], primary: string | null = 'aqua', sourceRank?: (s?: string) => number) => {
  const r = aliasParts({ tagged, held: disk, primary, sourceRank });
  return {
    copies: r.tagged.map((c) => `${c.source} ${c.number}${c.sourceNumber !== undefined ? `<-${c.sourceNumber}` : ''}`),
    covered: [...r.covered].sort((a, b) => a - b),
    out: r.tagged,
  };
};

test('R1: a follower\'s N.1 and N.6 are the N and N.5 on disk, and nothing is fetched or covered', () => {
  // Reintroduce by never recording a move (drop the `moves.set` in aliasParts): the follower keeps 335.1 and
  // 335.6, two numbers the disk does not hold, and the sweep downloads chapter 335 a second time.
  const r = run([ch('mangaread', 335.1), ch('mangaread', 335.6), ch('mangaread', 336.1), ch('mangaread', 336.6)],
    [held(335, 'mangapill'), held(335.5, 'mangapill'), held(336, 'mangapill'), held(336.5, 'mangapill')]);
  assert.deepEqual(r.copies, ['mangaread 335<-335.1', 'mangaread 335.5<-335.6', 'mangaread 336<-336.1', 'mangaread 336.5<-336.6']);
  assert.deepEqual(r.covered, [], 'every part is on disk under the reference number');
});

test('R1: with nothing on disk the primary\'s list is the reference, and the original copy objects are untouched', () => {
  const pri = [ch('aqua', 12), ch('aqua', 12.5)];
  const fol = [ch('mangaread', 12.1, { scanlator: 'Group B' }), ch('mangaread', 12.6, { title: 'Chapter 12.6: The Return' })];
  const r = run([...pri, ...fol], []);
  assert.deepEqual(r.copies, ['aqua 12', 'aqua 12.5', 'mangaread 12<-12.1', 'mangaread 12.5<-12.6']);
  assert.equal(r.out[0], pri[0], 'a copy the rules did not move is the very object handed in');
  assert.equal(fol[0].number, 12.1, 'a moved copy is a new object: the adapter\'s list is not written into');
  assert.equal(r.out[2].scanlator, 'Group B', 'and it keeps everything else it carried');
  // Reintroduce by keeping the title: the file saved as chapter 12 is named "Chapter 12.1".
  assert.deepEqual([r.out[2].title, r.out[3].title], [undefined, 'The Return'], 'a moved copy\'s title drops the number it no longer has');
});

test('R1: two followers disagreeing with nothing on disk land on the series\' own convention, not the first follower\'s', () => {
  // TDG chapter 531 with aqua offline: mangapill (ranked first) writes 531 / 531.5, mangaread 531.1 / 531.6, and
  // most two-part chapters on disk are .1 / .6. Reintroduce by dropping the convention step (`ref = own`):
  // mangapill's 531 / 531.5 become the reference and the files are named against the series' numbering.
  const disk = [held(529.1), held(529.6), held(530.1), held(530.6), held(528), held(528.5, 'mangapill')];
  const r = run([ch('mangapill', 531), ch('mangapill', 531.5), ch('mangaread', 531.1), ch('mangaread', 531.6)], disk);
  assert.deepEqual(r.copies, ['mangapill 531.1<-531', 'mangapill 531.6<-531.5', 'mangaread 531.1', 'mangaread 531.6']);
  assert.deepEqual(r.covered, []);
});

test('R1: with no convention for that many parts, the first source in rank order speaks for N', () => {
  const tagged = [ch('mangapill', 7), ch('mangapill', 7.5), ch('mangaread', 7.1), ch('mangaread', 7.6)];
  assert.deepEqual(run(tagged, []).copies, ['mangapill 7', 'mangapill 7.5', 'mangaread 7<-7.1', 'mangaread 7.5<-7.6'],
    'the order they were gathered in, with no rank');
  const mangareadFirst = (s?: string) => (s === 'mangaread' ? 0 : 1);
  assert.deepEqual(run(tagged, [], 'aqua', mangareadFirst).copies,
    ['mangapill 7.1<-7', 'mangapill 7.6<-7.5', 'mangaread 7.1', 'mangaread 7.6'], 'the chooser\'s rank, when it has one');
});

test('a different count of parts is a different split: genuine extras from the source we have N from are fetched', () => {
  // Reintroduce by covering regardless of origin (drop the `[...who].some(...)` test): the N.5 the very source
  // of our N lists -- a part of its own numbering, or a real extra -- is never fetched.
  const r = run([ch('mangapill', 40), ch('mangapill', 40.5)], [held(40, 'mangapill')], 'mangapill');
  assert.deepEqual(r.copies, ['mangapill 40', 'mangapill 40.5'], 'one part on disk against two listed: nothing renumbered');
  assert.deepEqual(r.covered, [], 'N.5 from the source our N came from is its own chapter');
});

test('R2: a whole chapter on disk covers another site\'s ten-part split of it', () => {
  // The Great Mage Returns After 4000 Years' 78. Reintroduce by never covering (drop `coveredKeys.add`): 78.1 ...
  // 78.9 read as nine missing chapters.
  const parts = [78, 78.1, 78.2, 78.3, 78.4, 78.5, 78.6, 78.7, 78.8, 78.9];
  const r = run(parts.map((n) => ch('natomanga', n)), [held(77), held(78)]);
  assert.deepEqual(r.copies, parts.map((n) => `natomanga ${n}`), 'ten parts against one file: nothing renumbered');
  assert.deepEqual(r.covered, parts.slice(1));
});

test('R2: a file with no recorded origin counts as another source\'s', () => {
  const r = run([ch('aqua', 9), ch('aqua', 9.5)], [held(9, null)]);
  assert.deepEqual(r.covered, [9.5]);
});

test('R3: with nothing on disk, a new chapter is split one way, the first-ranked source\'s', () => {
  // {540, 540.5} on the primary, {540, 540.1, 540.2} on a follower, nothing of 540 here: R1 needs equal counts and R2
  // a file, so both splits were downloaded in the same sweep. Reintroduce by dropping R3 in aliasParts: "a second
  // split of a chapter nothing of is here" finds nothing covered.
  const tagged = [ch('aqua', 540), ch('aqua', 540.5), ch('mangaread', 540), ch('mangaread', 540.1), ch('mangaread', 540.2), ch('mangaread', 541)];
  const r = run(tagged, [held(539)]);
  assert.deepEqual(r.copies, tagged.map((c) => `${c.source} ${c.number}`), 'different counts: nothing renumbered');
  assert.deepEqual(r.covered, [540.1, 540.2], 'a second split of a chapter nothing of is here');
  // The owner is the chooser's first: ranked the other way round, the follower's split is the one taken. And 541,
  // which only the follower lists, is its own and fetched either way.
  assert.deepEqual(run(tagged, [held(539)], 'aqua', (s) => (s === 'mangaread' ? 0 : 1)).covered, [540.5]);
});

test('three parts on disk against two listed: no renumbering, and the extra part is covered', () => {
  const r = run([ch('mangaread', 50), ch('mangaread', 50.5)], [held(50), held(50.3), held(50.6)]);
  assert.deepEqual(r.copies, ['mangaread 50', 'mangaread 50.5']);
  assert.deepEqual(r.covered, [50.5]);
});

test('the same ten parts on both sides change nothing', () => {
  const parts = [61, 61.1, 61.2, 61.3, 61.4, 61.5, 61.6, 61.7, 61.8, 61.9];
  const r = run(parts.map((n) => ch('natomanga', n)), parts.map((n) => held(n, 'mangakakalot')));
  assert.deepEqual(r.copies, parts.map((n) => `natomanga ${n}`));
  assert.deepEqual(r.covered, []);
});

test('one part has no order to go by: k = 1 is never renumbered, only covered', () => {
  // Onepunch-Man: a follower's lone 35.5 beside the whole 35 on disk.
  const r = run([ch('mangaread', 35.5), ch('mangaread', 36)], [held(35)]);
  assert.deepEqual(r.copies, ['mangaread 35.5', 'mangaread 36']);
  assert.deepEqual(r.covered, [35.5], '36 has nothing on disk under it and is simply new');
  // And the other way round: two parts on disk, the follower's whole chapter is another split of them.
  assert.deepEqual(run([ch('mangaread', 44)], [held(44.1), held(44.6)]).covered, [44]);
});

test('float4: a number read back from a real column is the same part', () => {
  // lib_books.number is a real: 250.1 read through float8 is 250.10000610351562. Reintroduce by keying parts on
  // the raw number (drop numKey in partsByWhole): the reference is 250.10000610351562, the follower's copy is
  // renumbered to it, and the sweep compares that float against the 250.1 the have-set holds.
  const disk = [held(Math.fround(250.1)), held(Math.fround(250.6))];
  assert.notEqual(Math.fround(250.1), 250.1, 'PREMISE: the float4 spelling is not the float8 one');
  const r = run([ch('mangapill', 250), ch('mangapill', 250.5)], disk);
  assert.deepEqual(r.copies, ['mangapill 250.1<-250', 'mangapill 250.6<-250.5']);
  assert.deepEqual(r.covered, []);
});

test('posting order, or a numbering change in hand, turns both rules off; a posting number already stamped stays', () => {
  // The updater skips aliasParts on these (lib/updater.ts); this is the predicate it asks.
  assert.equal(partRulesApply({ numbering: null, numbering_pending: null, renumber_plan: null }), true);
  assert.equal(partRulesApply({ numbering: 'source' }), true);
  assert.equal(partRulesApply({ numbering: 'posting_order' }), false);
  assert.equal(partRulesApply({ numbering: null, numbering_pending: 'posting_order' }), false);
  assert.equal(partRulesApply({ numbering: null, renumber_plan: { moves: [] } }), false);
  const r = run([ch('mangaread', 3.1, { sourceNumber: 17 }), ch('mangaread', 3.6)], [held(3), held(3.5)]);
  assert.deepEqual(r.copies, ['mangaread 3<-17', 'mangaread 3.5<-3.6'], 'the number the source gave, not an intermediate one');
});

test('the rules are pure: nothing they import reaches the database', () => {
  // The updater runs them inside every sweep and they are tested without a database. Reintroduce by importing
  // anything from './db' (or './library'): this file then does not load at all.
  const src = join(__dirname, '..', 'src', 'lib');
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/^\s*import\s+(?!type\b)[^'"]*from\s+'([^']+)'/gm)) {
      assert.ok(m[1].startsWith('.'), `${file} imports the package ${m[1]}`);
      walk(join(dirname(file), m[1]) + '.ts');
    }
  };
  walk(join(src, 'partAlias.ts'));
  assert.deepEqual([...seen].map((f) => f.slice(src.length + 1)).sort(), ['naming.ts', 'partAlias.ts', 'postingOrder.ts', 'releases.ts']);
});
