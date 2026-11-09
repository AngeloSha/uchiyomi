// The series page's chapter order, kept for every series on the account (#408, @julieminer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { chapterOrderAsc } from '../lib/chapterOrder';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('oldest first unless the account chose newest', () => {
  // Reintroduce `=== 'oldest'`: an account that never chose reads newest first, and every series opens the other way.
  assert.equal(chapterOrderAsc(undefined), true, 'no account');
  assert.equal(chapterOrderAsc({}), true, 'never chosen');
  assert.equal(chapterOrderAsc({ chapterOrder: 'oldest' }), true);
  assert.equal(chapterOrderAsc({ chapterOrder: 'newest' }), false);
  assert.equal(chapterOrderAsc({ chapterOrder: 'sideways' }), true, 'junk reads as the default');
});

test('the series page reads the order from the account and saves a tap for every series', () => {
  // Reintroduce `useState(true)` for the order: each series opens oldest first again, whatever was picked before.
  const src = read('app/series/page.tsx');
  assert.match(src, /const asc = chapterOrderAsc\(user\?\.settings\);/, 'the order is not the account\'s');
  assert.match(src, /setSettings\(\{ chapterOrder \}\);\s*void api\('\/api\/settings', \{ method: 'PUT', json: \{ chapterOrder \} \}\)/, 'a tap is not saved');
  assert.match(src, /<button onClick=\{flipOrder\} className="btn-key">\{asc \? tr\('Oldest'\) : tr\('Newest'\)\}<\/button>/);
  assert.doesNotMatch(src, /useState\(true\);\s*const \[downloaded/, 'the order is page state again');
});
