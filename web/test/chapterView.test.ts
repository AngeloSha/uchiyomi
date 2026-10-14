// #214 (klave7): the chapter list in columns -- the default -- or as one list the page's width, so a long title is read
// whole; and #215 (klave7): a part-read chapter can be marked unread from its own menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAPTER_VIEWS, chapterRowsClass, chapterViewOn, setChapterView } from '../lib/chapterView';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
/** A localStorage for node: a map, or one that throws as a private window's can. */
function storage(throws = false) {
  const m = new Map<string, string>();
  const fail = () => { throw new Error('SecurityError'); };
  (globalThis as any).localStorage = throws
    ? { getItem: fail, setItem: fail, removeItem: fail }
    : { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } };
  return m;
}

test('Columns unless this device chose List; junk and a storage that throws read as Columns', () => {
  const m = storage();
  assert.deepEqual([...CHAPTER_VIEWS], ['columns', 'list']);
  assert.equal(chapterViewOn(), 'columns');
  setChapterView('list');
  assert.equal(chapterViewOn(), 'list');
  setChapterView('columns');
  assert.equal(m.size, 0, 'Columns is the default, so it is stored as nothing at all');
  m.set('uchiyomi.chapterView', 'grid');
  assert.equal(chapterViewOn(), 'columns');
  storage(true);
  assert.equal(chapterViewOn(), 'columns');
  assert.doesNotThrow(() => setChapterView('list'));
  delete (globalThis as any).localStorage;
});

test('Columns is exactly the grid that shipped; List is one list, on every width', () => {
  // Reintroduce a restyle of everyone's default by changing the Columns string: this fails.
  assert.equal(chapterRowsClass('columns'), 'lg:grid lg:gap-x-8 lg:[grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]');
  assert.doesNotMatch(chapterRowsClass('list'), /grid/, 'List still lays the rows out in columns');
});

test('the series page lays its rows out by the device\'s choice, and the toolbar offers it from lg up', () => {
  const src = read('app/series/page.tsx');
  assert.match(src, /<div className=\{chapterRowsClass\(view\)\} data-chapter-rows=\{view\}>\s*\{pageRows\.map/, 'the rows ignore the layout');
  // Read after mount, like the compact list: the static export renders without storage.
  assert.match(src, /const \[view, setView\] = useState<ChapterView>\('columns'\);\s*useEffect\(\(\) => \{ setView\(chapterViewOn\(\)\); \}, \[\]\);/);
  const bar = src.slice(src.indexOf('<div data-chapter-toolbar'), src.indexOf('{group !== ALL_GROUPS && ('));
  assert.match(bar, /<div className="ms-auto hidden lg:block" data-chapter-view=\{view\}>/, 'the control is not in the chapter toolbar, or shows on a phone');
  assert.match(bar, /<Segmented square label=\{tr\('Layout'\)\} value=\{view\} onChange=\{\(v\) => \{ setView\(v\); setChapterView\(v\); \}\}/, 'a choice is not remembered');
  assert.match(bar, /\{ value: 'columns', label: tr\('Columns'\)[^}]*\}[\s\S]*\{ value: 'list', label: tr\('List'\)/);
});

test('#215: a part-read chapter offers Mark read AND Mark unread, and page 0 is unread', () => {
  const src = read('app/series/page.tsx');
  const row = src.slice(src.indexOf('function ChapterRow('), src.indexOf('function GhostRow('));
  // Mark unread writes page 0 (setRead): counted as "reading", the row said "page 0/19". Reintroduce `rp ? 'reading'`: fails.
  assert.match(row, /const state = rp\?\.completed \? 'read' : rp && rp\.page >= 1 \? 'reading' : 'unread';/, 'page 0 reads as reading');
  // Reintroduce the one either/or item: a part-read chapter can only be marked read again.
  assert.match(row, /\.\.\.\(state !== 'read' \? \[\{ label: tr\('Mark read'\), onSelect: \(\) => onMark\('read'\) \}\] : \[\]\),/);
  assert.match(row, /\.\.\.\(state !== 'unread' \? \[\{ label: tr\('Mark unread'\), onSelect: \(\) => onMark\('unread'\) \}\] : \[\]\),/, 'a part-read chapter cannot be marked unread');
});
