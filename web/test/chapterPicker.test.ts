// The Find missing chapters picker (lib/chapterPicker.ts): which chapters a source offers, how, and how a tap
// changes the selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { offerOf, runState, runsOf, toggleOne, toggleRun } from '../lib/chapterPicker';
import { followable } from '../lib/scanlators';

test('consecutive chapters are one chip', () => {
  assert.deepEqual(runsOf([12, 13, 14, 20, 22, 23, 13]).map((r) => [r.lo, r.hi]), [[12, 14], [20, 20], [22, 23]]);
  assert.deepEqual(runsOf([]), []);
});

test('a tap on a run selects it whole, and a second clears it', () => {
  const [r] = runsOf([5, 6, 7]);
  const some = new Set([6]);
  assert.equal(runState(r, some), 'some');
  const all = toggleRun(some, r);
  assert.deepEqual([...all].sort(), [5, 6, 7]);
  assert.equal(runState(r, all), 'all');
  assert.equal(runState(r, toggleRun(all, r)), 'none');
  assert.deepEqual([...toggleOne(all, 6)].sort(), [5, 7]);
});

test('each source offers what this person can take from it, and says how', () => {
  const following = new Set(['followed']);
  const opts = (isAdmin: boolean) => ({ following, isAdmin, followable });
  const c = (o: Partial<{ source: string; pinned: boolean; why: string; coverage: number; fillable: number[]; newer: number[] }>) =>
    ({ source: 'x', pinned: false, why: 'nothing_to_fill', coverage: 1, fillable: [], newer: [], ...o });
  // The series' own source: the newer chapters, fetched through the listing. (Reintroduce by offering only
  // `fillable`: the owner's case -- everything he lacked was newer -- offers nothing, as before.)
  assert.deepEqual(offerOf(c({ pinned: true, newer: [51, 52] }), opts(false)), { mode: 'fetch', numbers: [51, 52] });
  // A source already followed: the same.
  assert.deepEqual(offerOf(c({ source: 'followed', fillable: [4], newer: [9] }), opts(false)), { mode: 'fetch', numbers: [4, 9] });
  // Not followed yet: an admin follows it and downloads; a member cannot follow.
  assert.deepEqual(offerOf(c({ newer: [51] }), opts(true)), { mode: 'follow', numbers: [51] });
  assert.deepEqual(offerOf(c({ newer: [51] }), opts(false)), { mode: 'none', numbers: [] });
  // ...but a member can still fill a hole a source brackets, through the fill plan.
  assert.deepEqual(offerOf(c({ why: 'ok', fillable: [5, 6], newer: [51] }), opts(false)), { mode: 'fill', numbers: [5, 6] });
  // Numbering that does not match ours is never followed, and is offered nothing.
  assert.deepEqual(offerOf(c({ coverage: 0.5, why: 'numbering_mismatch', newer: [51] }), opts(true)), { mode: 'none', numbers: [] });
});

test('the dialog downloads the selection now, by whole number, and follows first where it has to', () => {
  const src = readFileSync(join(__dirname, '..', 'components', 'FindMissingDialog.tsx'), 'utf8');
  assert.match(src, /\('\/api\/sources\/fetch', \{ method: 'POST', json: \{ seriesId, numbers: numbers\.slice\(0, max\), floored: true \} \}\)/,
    'the download does not go through the fetch route by whole numbers');
  // Reintroduce by fetching without the follow: a source not yet followed is not in the listing, and nothing lands.
  assert.match(src, /if \(mode === 'follow'\) \{\s*if \(!\(await follow\(c, false\)\)\) return;\s*\}\s*const res = await api/, 'Follow and download does not follow first');
  // The false line the owner read: "Up to date with what you have" over a source holding newer chapters.
  assert.doesNotMatch(src, /Up to date with what you have/);
});
