// The Find missing chapters picker (lib/chapterPicker.ts): which chapters a source offers, how, and how a tap
// changes the selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { offerOf, runState, runsOf, scanPoll, stillAsking, toggleOne, toggleRun } from '../lib/chapterPicker';
import { followable } from '../lib/scanlators';
import { fetchingLabel, fetchingToast, joinSentences } from '../lib/jobs';

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
  assert.match(src, /if \(mode === 'follow'\) \{\s*if \(!\(await follow\(c, false\)\)\) return;\s*followedNow = true;\s*\}\s*const res = await api/, 'Follow and download does not follow first');
  // A slow source that has not listed yet is not an error once it is followed, and a stale scan is asked again.
  assert.match(src, /else if \(followedNow && code === 'nothing_to_fetch'\) toast\(tr\('Now following \{s\}\. It is still listing its chapters/);
  assert.match(src, /if \(code === 'plan_stale'\) stale\(\);/);
  // The false line the owner read: "Up to date with what you have" over a source holding newer chapters.
  assert.doesNotMatch(src, /Up to date with what you have/);
});

test('one chapter reads as one chapter, in the dialog, the toasts and the pill, in every language', () => {
  // The owner's check read "Follow fake-b and download 1 chapters", and every ☁ on a single ghost chapter toasted
  // "Fetching 1 chapters…". Reintroduce by dropping a singular branch below, or one locale's entry.
  assert.equal(fetchingToast(1), 'Fetching 1 chapter…');
  assert.equal(fetchingToast(3), 'Fetching 3 chapters…');
  assert.equal(fetchingLabel(1), 'Fetching 1 chapter');
  assert.equal(joinSentences('Downloading 1 chapter.', '1 could not be fetched now.'), 'Downloading 1 chapter. 1 could not be fetched now.');
  assert.equal(joinSentences('正在下载 2 章。', '1 章暂时无法获取。'), '正在下载 2 章。1 章暂时无法获取。', 'a CJK full stop took a space after it');
  const root = join(__dirname, '..');
  const src = readFileSync(join(root, 'components', 'FindMissingDialog.tsx'), 'utf8');
  const singulars = [
    'Follow {s} and download 1 chapter', 'Fetch 1 chapter from {s}', 'Download 1 chapter', '1 chapter newer than yours',
    'Has 1 chapter newer than yours; an admin can follow it', 'Downloading 1 chapter.', '1 is not listed yet and comes with the next check.',
    '1 could not be fetched now.', 'Fetch 1 older chapter from {s}', 'You have 1 chapter',
  ];
  for (const k of singulars) assert.ok(src.includes(`tr('${k}'`), `the dialog never says "${k}"`);
  // Every "Fetching n chapters" goes through lib/jobs.ts, which knows about one.
  for (const f of ['app/series/page.tsx', 'components/FindMissingDialog.tsx', 'components/AddSeriesDialog.tsx', 'components/DownloadsIndicator.tsx']) {
    assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), /tr\('Fetching \{n\} chapters/, `${f} counts chapters itself`);
  }
  const keys = [...singulars, 'Fetching 1 chapter…', 'Fetching 1 chapter', 'Downloading {n} chapters.', '{m} are not listed yet and come with the next check.', '{m} could not be fetched now.'];
  for (const f of readdirSync(join(root, 'public', 'locales')).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(root, 'public', 'locales', f), 'utf8'));
    for (const k of keys) {
      assert.ok(String(d[k] ?? '').trim(), `${f} has no "${k}"`);
      for (const ph of k.match(/\{\w+\}/g) ?? []) assert.ok(d[k].includes(ph), `${f}: "${k}" lost ${ph}`);
    }
  }
});

test('a scan still asking its sources is read again every two seconds, and says who it waits for (v0.48.4)', () => {
  // The owner's scans failed: one request waited for the slowest source and the proxy gave up first. Now the
  // server answers at once and the dialog reads the rest. Reintroduce by never polling: the cards of every
  // source slower than the first answer never arrive.
  assert.equal(scanPoll({ done: false }), 2000);
  assert.equal(scanPoll({ done: true }), false);
  assert.equal(scanPoll({}), false, 'a scan that never started (too few chapters) is polled');
  assert.equal(scanPoll(undefined), false);
  assert.deepEqual(stillAsking([{ name: 'aqua' }, { name: 'MangaDex' }], 0), { names: ['aqua', 'MangaDex'], more: 0 });
  assert.deepEqual(stillAsking([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }], 2), { names: ['a', 'b', 'c'], more: 3 });
  assert.equal(stillAsking([], 0), null);
  const root = join(__dirname, '..');
  const src = readFileSync(join(root, 'components', 'FindMissingDialog.tsx'), 'utf8');
  assert.match(src, /api<Scan>\(`\/api\/sources\/fill\/scan\/\$\{encodeURIComponent\(cur\.id\)\}`\)/, 'the dialog never reads the scan as it goes');
  assert.match(src, /refetchInterval: \(qy\) => scanPoll\(qy\.state\.data\)/, 'the dialog does not read a running scan again');
  // "No source could supply what is missing" is a verdict, and there is none while sources are still answering.
  assert.match(src, /!offering\.length && !scan\.isLoading && d\.done !== false/, 'the dialog says nothing can supply it while sources are still being asked');
  for (const f of readdirSync(join(root, 'public', 'locales')).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(root, 'public', 'locales', f), 'utf8'));
    for (const k of ['Still asking 1 source…', 'Still asking {n} sources…', 'Still asking {s}…', 'The scan failed. Try again.', 'and {n} more']) {
      assert.ok(String(d[k] ?? '').trim(), `${f} has no "${k}"`);
      for (const ph of k.match(/\{\w+\}/g) ?? []) assert.ok(d[k].includes(ph), `${f}: "${k}" lost ${ph}`);
    }
  }
});
