// Connect sources on the web (v0.49.0): the pure helpers in lib/linkBatch.ts, called; and the wiring that
// shipped wrong or missing once, read from source like library.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ranges, preselect, needsOverride, type LinkItem, type LinkCandidate } from '../lib/linkBatch';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const cand = (p: Partial<LinkCandidate>): LinkCandidate => ({
  id: 'c', item_id: 'i', source: 's', name: 'S', source_series_id: 'x', their_title: 'T', cover: null, our_name: null, their_name: null,
  coverage_fwd: 1, coverage_back: 1, verdict: 'ok', manual: false, status: null, ...p,
});
const item = (p: Partial<LinkItem>): LinkItem => ({
  id: 'i', ord: 0, series_id: 's1', title: 'Solo Leveling', names: ['Solo Leveling'], state: 'done', asked: 3, unreachable: 0,
  primary: null, following: [], freeSlots: 2, candidates: [], ...p,
});

test('missing chapters read as runs, decimals alone, long lists cut', () => {
  assert.equal(ranges([1, 2, 3, 5, 7, 8]), '1–3, 5, 7–8');
  assert.equal(ranges([3, 1, 2, 2]), '1–3', 'unsorted and duplicated input');
  assert.equal(ranges([12, 12.5, 13]), '12, 12.5, 13', 'a decimal never joins a run');
  assert.match(ranges(Array.from({ length: 20 }, (_, i) => i * 3), 5), /^0, 3, 6, 9, 12 \+ 15 more$/);
  assert.equal(ranges([]), '');
});

test('"Select exact matches" picks only green candidates, best first, up to the free slots', () => {
  // Reintroduce by picking warnings too: an amber source is followed on a default nobody chose.
  const it = item({
    freeSlots: 1,
    candidates: [
      cand({ id: 'a', coverage_fwd: 0.92, coverage_back: 0.95 }),
      cand({ id: 'b', coverage_fwd: 1, coverage_back: 1 }),
      cand({ id: 'w', verdict: 'numbering_differs' }),
      cand({ id: 'done', status: 'linked' }),
    ],
  });
  assert.deepEqual([...preselect([it])], ['b']);
  assert.deepEqual([...preselect([{ ...it, freeSlots: 0 }])], [], 'a full series gets nothing');
  assert.equal(needsOverride({ verdict: 'ok' }), false);
  assert.equal(needsOverride({ verdict: 'too_few' }), true);
});

test('the review shows a candidate\'s chapters before it is ticked, and the manual pick can too', () => {
  const page = code(read('app/admin/link/page.tsx'));
  assert.match(page, /onClick=\{\(\) => onChapters\(c\)\}[^>]*>\{tr\('Chapters'\)\}/, 'the candidate row has no Chapters button');
  assert.match(page, /<LinkChapterList itemId=\{it\.id\} source=\{c\.source\} sourceSeriesId=\{c\.source_series_id\} \/>/, 'the sheet does not show the list');
  const pick = code(read('components/LinkPickSheet.tsx'));
  assert.match(pick, /preview && pending \? \(\s*<LinkChapterList itemId=\{item\.id\} source=\{pending\.source\} sourceSeriesId=\{pending\.sourceId\} \/>/, 'a pick cannot be previewed before it is checked');
  assert.match(code(read('components/LinkChapterList.tsx')), /\/api\/admin\/link\/items\/\$\{itemId\}\/chapters\?source=/);
});

test('the library filters by main source and by any source, through the one URL writer', () => {
  const page = code(read('app/library/page.tsx'));
  assert.match(page, /if \(src\) all\.push\(\{ mainSource: \{ operator: 'is', value: src \} \}\);/);
  assert.match(page, /if \(anysrc\) all\.push\(\{ anySource: \{ operator: 'is', value: anysrc \} \}\);/);
  assert.match(page, /queryKey: \['library', active\.key, read, status, genres\.join\(','\), lib, src, anysrc\]/, 'a source change does not refetch');
  assert.match(page, /\+ \(src \? 1 : 0\) \+ \(anysrc \? 1 : 0\)/, 'the source filters are not counted as active');
  const panel = code(read('components/LibraryFilters.tsx'));
  assert.match(panel, /onPick=\{\(id\) => onSet\('src', id\)\}/);
  assert.match(panel, /onPick=\{\(id\) => onSet\('anysrc', id\)\}/);
  assert.match(panel, /'\/api\/library\/sources'/);
});

test('the edit dialog shows every linked source, its state, and unlinks a follower but never the main one', () => {
  const src = code(read('app/series/page.tsx'));
  const modal = src.slice(src.indexOf('function SeriesEditModal('), src.indexOf('interface CollectionRow'));
  assert.match(modal, /data-link-status/);
  assert.match(modal, /\{!x\.primary && \(\s*<button type="button" onClick=\{\(\) => unlink\(x\.sourceId, x\.name\)\}/, 'the main source can be unlinked, or no follower can');
  assert.match(modal, /\/api\/admin\/series\/\$\{id\}\/sources\/\$\{encodeURIComponent\(sourceId\)\}`, \{ method: 'DELETE' \}/);
  assert.match(modal, /x\.health === 'cooldown'/, 'the source state is not shown');
  assert.match(modal, /'\/api\/admin\/link\/batches', \{ json: \{ seriesIds: \[id\] \} \}/, 'no way to connect more sources from here');
});

test('a finished run goes back where it started, and waits only on what the server runs', async () => {
  // Reported: after "Connect selected" the page stayed on the review -- the server puts the batch back to
  // `review` while any candidate is unticked, so it looked like nothing happened. Reintroduce by deleting
  // the effect that pushes the router: "a finished run does not leave the review" fails.
  const { mayRun } = await import('../lib/linkBatch');
  assert.equal(mayRun({ verdict: 'ok', manual: false }, false), true);
  assert.equal(mayRun({ verdict: 'numbering_differs', manual: false }, false), false, 'held without the override');
  assert.equal(mayRun({ verdict: 'numbering_differs', manual: false }, true), true);
  assert.equal(mayRun({ verdict: 'title_differs', manual: false }, true), false, 'the server never runs this one');
  assert.equal(mayRun({ verdict: 'title_differs', manual: true }, true), true);
  const page = code(read('app/admin/link/page.tsx'));
  assert.match(page, /setRunIds\(new Set\(chosen\.filter\(\(c\) => mayRun\(c, override\)\)\.map\(\(c\) => c\.id\)\)\)/, 'runIds waits on candidates the server holds back');
  assert.match(page, /if \(sent\.length < runIds\.size \|\| sent\.some\(\(c\) => !c\.status\)\) return;/);
  assert.match(page, /router\.push\(items\.length === 1 \? `\/series\/\?id=\$\{items\[0\]\.series_id\}` : '\/library\/'\)/, 'a finished run does not leave the review');
});
