// Guards on leaving a chapter (lib/readerNav.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ARM_MS, NEAR_END_PAGES, gapsBetween, pagesAfter, skipNeedsConfirm, stillArmed } from '../lib/readerNav';

test('skipping ahead from mid-chapter asks twice; the last pages do not', () => {
  assert.equal(skipNeedsConfirm(30), true);
  assert.equal(skipNeedsConfirm(NEAR_END_PAGES), true);
  assert.equal(skipNeedsConfirm(NEAR_END_PAGES - 1), false, 'one page left is finishing, not skipping');
  assert.equal(skipNeedsConfirm(0), false);
});

test('the arm lapses, and never arms itself', () => {
  assert.equal(stillArmed(null, 5000), false);
  assert.equal(stillArmed(1000, 1000 + ARM_MS), true);
  assert.equal(stillArmed(1000, 1000 + ARM_MS + 1), false);
});

test('pagesAfter counts only the current chapter', () => {
  const flow = [{ ci: 0 }, { ci: 0 }, { ci: 0 }, { ci: 1 }, { ci: 1 }];
  assert.equal(pagesAfter(flow, 0), 2);
  assert.equal(pagesAfter(flow, 2), 0, 'the next chapter\'s pages are not this chapter\'s');
  assert.equal(pagesAfter(flow, 9), 0);
});

test('gapsBetween names the series\' missing runs that lie between two neighbours, and nothing else', () => {
  // The runs are the server's (GET /api/series/:id/gaps): 44-99 and 101 missing, 3-7 held by one file, so no run.
  const runs = [{ lo: 44, hi: 99 }, { lo: 101, hi: 101 }, { lo: 150, hi: 160 }];
  assert.deepEqual(gapsBetween(runs, 43, 100), [{ lo: 44, hi: 99 }]);
  assert.deepEqual(gapsBetween(runs, 100, 102), [{ lo: 101, hi: 101 }]);
  assert.deepEqual(gapsBetween(runs, 43, 102), [{ lo: 44, hi: 99 }, { lo: 101, hi: 101 }], 'a held chapter between two runs');
  assert.deepEqual(gapsBetween(runs, 155, 170), [{ lo: 156, hi: 160 }], 'cut to the numbers between the two');
  assert.deepEqual(gapsBetween(runs, 43.5, 99.5), [{ lo: 44, hi: 99 }], 'half chapters at either end');
  // Reintroduce counting from the chapters' own numbers (the PR's chapterGap): a file holding 1 to 7 then chapter 8 reads
  // "2-7 missing". By the server's runs there is none there.
  assert.deepEqual(gapsBetween(runs, 1, 8), []);
  assert.deepEqual(gapsBetween(runs, 99.5, 100), []);
  assert.deepEqual(gapsBetween(runs, 5, 5), []);
  assert.deepEqual(gapsBetween(runs, 120, 40), [], 'an order that does not run forward warns of nothing');
  assert.deepEqual(gapsBetween(runs, undefined, 100), []);
  assert.deepEqual(gapsBetween(runs, 43, null), []);
  assert.deepEqual(gapsBetween(runs, NaN, 100), []);
  assert.deepEqual(gapsBetween([], 43, 100), [], 'no runs, nothing said: offline, or the series is whole');
});

test('the reader says so as it reaches the next chapter, and on every way to Next chapter', () => {
  const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  // From the server's runs, never from the reader's chapter list.
  assert.match(src, /api<\{ gaps: GapRun\[\] \}>\(`\/api\/series\/\$\{chapters\[0\]!\.seriesId\}\/gaps`\)/);
  assert.match(src, /gapsBetween\(gapData\?\.gaps \?\? \[\],/);
  // As the next chapter is reached, once a chapter -- not as it is appended four pages early.
  assert.match(src, /warnedGaps\.current\.add\(to\.id\);\n\s*warnGap\(chapters\[activeCi - 1\]\?\.id, to\.id\);/);
  assert.doesNotMatch(src, /if \(outcome === 'ok'\) warnGap/);
  // The footer, a key or a controller (perform) and the right-click menu all go through goNextChapter. Reintroduce
  // `goChapter(nextId)` on any of them: `]` skips a hole in silence.
  assert.match(src, /const goNextChapter = \(\) => \{ if \(!nextId\) return; warnGap\(activeChapter\?\.id, nextId\); goChapter\(nextId\); \};/);
  assert.match(src, /if \(action === 'nextChapter'\) goNextChapter\(\);/);
  assert.match(src, /label: tr\('Next chapter'\), onSelect: \(\) => goNextChapter\(\)/);
  assert.match(src, /setArmedNext\(null\); goNextChapter\(\); return;/);
  assert.doesNotMatch(src, /goChapter\(nextId\)(?!; \};)/, 'no way to the next chapter around the warning');
});
