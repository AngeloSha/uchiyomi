// The webtoon column's width on THIS device (lib/readerWidth.ts): kept in the browser, clamped, and never part of the
// account's reader settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function stubStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
  return m;
}

test('the column width defaults to the full width, is clamped, and 100 stores nothing', async () => {
  const m = stubStorage();
  const { readWidth, setWidth, WIDTH_MIN, WIDTH_MAX } = await import('../lib/readerWidth');
  assert.equal(readWidth(), WIDTH_MAX);
  setWidth(60);
  assert.equal(readWidth(), 60);
  setWidth(5);
  assert.equal(readWidth(), WIDTH_MIN, 'a width below the minimum is raised to it');
  setWidth(250);
  assert.equal(readWidth(), WIDTH_MAX);
  assert.equal(m.size, 0, 'the default is the absence of a value');
  m.set('yomi_reader_width', 'junk');
  assert.equal(readWidth(), WIDTH_MAX, 'a junk value reads as the default');
  m.set('yomi_reader_width', '10');
  assert.equal(readWidth(), WIDTH_MAX, 'an out-of-range value reads as the default');
});

test('the column width is wired into the reader and its sheet, and kept out of the account prefs', () => {
  assert.doesNotMatch(read('lib/readerPrefs.ts'), /readerWidth|yomi_reader_width/);
  assert.match(read('app/reader/page.tsx'), /\* \(widthPct \/ 100\)/);
  assert.match(read('components/ReaderSettings.tsx'), /data-reader-width/);
});
