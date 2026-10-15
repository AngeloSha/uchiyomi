// A cover changed here is fetched again on every card, not read from the browser's day-long copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bustCover, withCoverBust } from '../lib/coverBust';
import { img } from '../lib/api';

test('a thumbnail address is left alone until its series cover changes, then carries the change time', () => {
  const before = img.seriesThumb('s_1');
  assert.equal(withCoverBust(before), before);
  bustCover('s_1');
  const after = withCoverBust(before);
  assert.match(after, /^\/img\/series\/s_1\/thumb\?v=2&cb=\d+$/);
  assert.equal(withCoverBust(img.seriesThumb('s_2')), img.seriesThumb('s_2'), 'another series is not touched');
  assert.match(withCoverBust(img.seriesThumb('s_1', 7, 800)), /&av=7&w=800&cb=\d+$/, 'the series page address keeps its art version');
});

test('only a series thumbnail is changed', () => {
  bustCover('s_1');
  for (const u of ['/img/books/s_1/thumb', '/img/sources/cover?u=x', 'https://example.com/a.jpg', '']) assert.equal(withCoverBust(u), u);
});

test('the picker is wired on the series page for an admin, and a changed cover is busted', async () => {
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const page = read('app/series/page.tsx');
  assert.match(page, /data-cover-button/);
  // Opened from More's admin group (a phone) and the desktop poster: never a key under the art (phoneSeries.test.ts).
  assert.doesNotMatch(page, /data-cover-key/, 'the always-visible Change cover key is back under the art');
  assert.match(page, /case 'cover': setCoverPicker\(true\); break;/);
  assert.match(page, /<CoverPickerSheet seriesId=\{id\}/);
  const picker = read('components/CoverPickerSheet.tsx');
  assert.match(picker, /mode: 'source'/);
  assert.match(picker, /mode: 'upload'/);
  assert.match(picker, /data-cover-use/);
  assert.match(picker, /bustCover\(seriesId\)/);
  assert.match(read('components/ui.tsx'), /withCoverBust\(fellBack/);
  // Read as a card renders, never a store every Img of a Library grid subscribes to (the v0.67.2 perf work).
  assert.doesNotMatch(read('components/ui.tsx'), /useCoverBust|useSyncExternalStore/, 'every Img subscribes to the cover store again');
  // One upload limit and reader, the editor's and the picker's.
  assert.match(read('components/CoverPickerSheet.tsx'), /from '@\/lib\/artUpload'/);
  assert.doesNotMatch(read('components/CoverPickerSheet.tsx'), /const ART_MAX_MB|readAsDataURL/, 'the picker has its own copy of the upload code');
  assert.match(read('components/SeriesEditor.tsx'), /if \(kind === 'cover'\) bustCover\(id\)/);
});
