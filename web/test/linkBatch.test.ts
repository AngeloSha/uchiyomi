// Connect sources on the web: the pure helpers in lib/linkBatch.ts, called; and the wiring that
// shipped wrong or missing once, read from source like library.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ranges, preselect, mayRun, type LinkItem, type LinkCandidate } from '../lib/linkBatch';

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
  assert.equal(mayRun({ verdict: 'ok' }), true);
  assert.equal(mayRun({ verdict: 'numbering_differs' }), false);
  assert.equal(mayRun({ verdict: 'too_few' }), false, 'an older server\'s warning is never run either');
});

test('the review shows a candidate\'s chapters before it is ticked, and the manual pick can too', () => {
  const page = code(read('app/admin/link/page.tsx'));
  assert.match(page, /onClick=\{\(\) => onChapters\(c\)\}[^>]*>\{tr\('Chapters'\)\}/, 'the candidate row has no Chapters button');
  assert.match(page, /<LinkChapterList itemId=\{it\.id\} source=\{c\.source\} sourceSeriesId=\{c\.source_series_id\} \/>/, 'the sheet does not show the list');
  const pick = code(read('components/LinkPickSheet.tsx'));
  assert.match(pick, /preview && pending \? \(\s*<LinkChapterList itemId=\{item\.id\} source=\{pending\.source\} sourceSeriesId=\{pending\.sourceId\} \/>/, 'a pick cannot be previewed before it is checked');
  assert.match(code(read('components/LinkChapterList.tsx')), /\/api\/admin\/link\/items\/\$\{itemId\}\/chapters\?source=/);
});

test('the source list lives in the Sources sheet only; Edit series does not repeat it', () => {
  // Review of #119: the list in Edit series duplicated the Sources & translations sheet. Connect sources for
  // one series is a chip in that sheet instead, and not offered to a series numbered by posting order.
  const series = code(read('app/series/page.tsx'));
  const modal = series.slice(series.indexOf('function SeriesEditModal('), series.indexOf('interface CollectionRow'));
  assert.doesNotMatch(modal, /data-link-status|\/api\/admin\/link\/batches/, 'Edit series lists sources again');
  assert.match(series, /postingOrder=\{listing\?\.numbering\?\.mode === 'posting_order'\}/);
  const sheet = code(read('components/SourcesSheet.tsx'));
  assert.match(sheet, /const mayConnect = !postingOrder && sources\.filter\(\(s\) => !s\.primary\)\.length < 2;/);
  assert.match(sheet, /'\/api\/admin\/link\/batches', \{ json: \{ seriesIds: \[id\] \} \}/);
});

test('an amber candidate is never ticked for the run: it is connected on its own, confirmed, from its chapters', () => {
  // Review of #119: one confirmation used to cover every selected warning across every series -- the
  // wrong-book case in bulk. Reintroduce by sending `override` again, or by giving an amber row a checkbox.
  const page = code(read('app/admin/link/page.tsx'));
  assert.doesNotMatch(page, /override/, 'the bulk override is back');
  assert.match(page, /const tickable = open && mayRun\(c\);/);
  assert.match(page, /const chosen = all\.filter\(\(c\) => selected\.has\(c\.id\) && mayRun\(c\)\);/);
  assert.match(page, /`\/api\/admin\/link\/candidates\/\$\{id\}\/follow`, \{ json: \{ confirm: true \} \}/);
  assert.match(page, /setConfirmSingle\(c\.id\)/, 'the single connect is not behind a confirmation');
});

test('a finished run goes back where it started, and waits only on what the server runs', async () => {
  // Reported: after "Connect selected" the page stayed on the review -- the server puts the batch back to
  // `review` while any candidate is unticked, so it looked like nothing happened. Reintroduce by deleting
  // the effect that pushes the router: "a finished run does not leave the review" fails.
  const page = code(read('app/admin/link/page.tsx'));
  assert.match(page, /setRunIds\(new Set\(r\.ids \?\? chosen\.filter\(\(c\) => mayRun\(c\)\)\.map\(\(c\) => c\.id\)\)\)/, 'runIds waits on candidates the server holds back');
  assert.match(page, /if \(sent\.length < runIds\.size \|\| sent\.some\(\(c\) => !c\.status\)\) return;/);
  assert.match(page, /router\.push\(items\.length === 1 \? `\/series\/\?id=\$\{items\[0\]\.series_id\}` : '\/library\/'\)/, 'a finished run does not leave the review');
});

test('the manual search keeps asking while sources are pending, instead of reading an early answer as "nobody"', () => {
  // Reported: the wizard's manual search returned nothing. The server answers 1.5 s after the first source
  // with a hit -- nearly always the series' own main source, which this sheet hides -- with the rest still
  // pending, and the sheet asked once. Reintroduce by dropping `refetchInterval`: this fails.
  const src = code(read('components/LinkPickSheet.tsx'));
  assert.match(src, /refetchInterval: \(qy\) => \(qy\.state\.data\?\.pending \? POLL_MS : false\)/);
  assert.match(src, /&wait=\$\{first \? FIRST_WAIT_MS : POLL_WAIT_MS\}/, 'polls wait the long first wait');
  assert.match(src, /pendingSources > 0\s*\?[\s\S]{0,120}tr\('Still asking \{n\} sources…'/, '"Nobody has that title" is shown while sources are still being asked');
});

test('the typed search runs on Enter, never per keystroke', () => {
  // Reported: typing a title into the wizard's search returned nothing. A 300 ms debounce fanned every
  // partial term out to every source, and the finished title queued behind them in the shared search
  // slots. Reintroduce by putting a setTimeout(setDebounced) effect back on `term`: this fails.
  const src = code(read('components/LinkPickSheet.tsx'));
  assert.doesNotMatch(src, /setTimeout\(\(\) => setDebounced/, 'the search is debounced per keystroke again');
  assert.match(src, /<form role="search" onSubmit=\{\(e\) => \{ e\.preventDefault\(\); search\(term\); \}\}/);
  assert.match(src, /onClick=\{\(\) => search\(n\)\}/, 'a name chip does not search');
});
