// Compare a chapter file with another source's copy, then replace it. Read from source, like seriesPage.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('a chapter row offers Replace from another source to an admin when another source has a copy, and the compare leads to the confirm', () => {
  const src = read('app/series/page.tsx');
  assert.match(src, /onReplaceFrom=\{isAdmin && b\.owned !== false && versionsOf\.get\(b\.number\)\?\.some\(\(c\) => !c\.onDisk\)/);
  assert.match(src, /tr\('Replace from another source…'\)/);
  assert.match(src, /<CompareCopiesDialog [^>]*seriesId=\{id\}/);
  assert.match(src, /setComparing\(null\); setReplacing\(\{ book: b, copy \}\)/, 'the compare closes, then the existing confirm opens');
});

test('the dialog reads the copy through the admin routes and changes nothing itself', () => {
  const cmp = read('components/CompareCopiesDialog.tsx');
  assert.match(cmp, /copy-pages\?source=/);
  assert.match(cmp, /copy-page\?source=/);
  assert.match(cmp, /data-compare-replace/);
  assert.doesNotMatch(cmp, /method: 'POST'/);
});
