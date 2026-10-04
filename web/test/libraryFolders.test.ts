// Several folders per library (v0.55.1, #148): Admin → Content → Library's dialog keeps a list of folders, its folder
// browser ticks folders in and out of it, and the card says the first and how many more.
//
// The rules are lib/libraryFolders.ts, tested as functions; the dialog and the cards are read from source, like
// library.test.ts. Each guard names the edit that fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setActiveDict } from '../lib/i18n';
import { setActiveLocale } from '../lib/format';
import {
  addFolder, foldersOf, heldByOthers, heldByText, moreFoldersText, previewQuery, previewText, sameFolders, toggleFolder, typedFolder,
  wouldMoveText,
} from '../lib/libraryFolders';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments quote the code they replaced. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

test('the browser ticks a folder into the list and out again, and a typed one is added once', () => {
  // Reintroduce the "Use" key's rule (the folder REPLACES the list): "a second tick replaced the first" fails.
  let list = toggleFolder([], 'Aqua Manga (EN)');
  list = toggleFolder(list, 'Mangafreak (EN)');
  assert.deepEqual(list, ['Aqua Manga (EN)', 'Mangafreak (EN)'], 'a second tick replaced the first');
  assert.deepEqual(toggleFolder(list, 'Aqua Manga (EN)'), ['Mangafreak (EN)'], 'a second tick did not take it out');
  list = addFolder(list, '  /ManhuaPlus (EN)/ ');
  assert.deepEqual(list, ['Aqua Manga (EN)', 'Mangafreak (EN)', 'ManhuaPlus (EN)'], 'a typed folder is not trimmed to the list\'s form');
  assert.deepEqual(addFolder(list, 'Mangafreak (EN)/'), list, 'the same folder typed again was added twice');
  assert.deepEqual(addFolder(list, ' / '), list, 'nothing typed added an empty folder');
  assert.equal(typedFolder('//Manga/Seinen///'), 'Manga/Seinen');
  // Order counts: the first folder is the one a rollback to v0.55.0 files by.
  assert.ok(sameFolders(['a', 'b'], ['a', 'b']));
  assert.ok(!sameFolders(['a', 'b'], ['b', 'a']), 'a new first folder reads as unchanged');
  assert.ok(!sameFolders(['a'], ['a', 'b']));
});

test('a library\'s folders: `paths`, or `path` from an older server, and none for the default library', () => {
  assert.deepEqual(foldersOf({ path: 'Manga', paths: ['Manga', 'Webtoons'] }), ['Manga', 'Webtoons']);
  assert.deepEqual(foldersOf({ path: 'Manga' }), ['Manga'], 'a v0.55.0 server\'s one folder is lost');
  assert.deepEqual(foldersOf({ path: '', paths: [] }), []);
  assert.deepEqual(foldersOf({ path: '' }), [], 'the default library holds its empty path as a folder');
});

test('what other libraries hold is taken, and the library being edited keeps its own', () => {
  // Reintroduce a check of each library's first folder only: Webtoons, the second folder of Picks, reads as free.
  const libs = [
    { id: 'lib', name: 'Library', path: '', paths: [] },
    { id: 'picks', name: 'Picks', path: 'Manga', paths: ['Manga', 'Webtoons'] },
    { id: 'adult', name: '18+', path: 'Manga/18', paths: ['Manga/18'] },
  ];
  const held = heldByOthers(libs, 'adult');
  assert.equal(held.get('Webtoons'), 'Picks', 'a second folder of another library reads as free');
  assert.equal(held.get('Manga'), 'Picks');
  assert.ok(!held.has('Manga/18'), 'the library being edited cannot keep its own folder');
  assert.ok(!held.has(''), 'the default library\'s empty path is a folder');
  assert.equal(heldByOthers(libs, null).get('Manga/18'), '18+', 'a new library may take an existing library\'s folder');
});

test('the preview asks about every folder, one `paths` each, and the library being edited', () => {
  // Reintroduce `path=` with the first folder only: "the preview asks about one folder" fails.
  assert.equal(previewQuery(null, ['Aqua Manga (EN)', 'a,b']), 'paths=Aqua%20Manga%20(EN)&paths=a%2Cb', 'the preview asks about one folder');
  assert.equal(previewQuery('lib_1', ['x']), 'id=lib_1&paths=x', 'an edit is previewed as a new library');
});

test('the card says the first folder and how many more, a count said as a pair', () => {
  // Reintroduce one key for every count: "one more is said with the plural key" fails.
  setActiveDict({ '+1 more': 'M-one', '+{n} more': 'M{n}', '1 series would move': 'W-one', '{n} series would move': 'W{n}', 'Held by {name}': 'H:{name}' });
  try {
    assert.equal(moreFoldersText(['a']), '', 'one folder says "+0 more"');
    assert.equal(moreFoldersText(['a', 'b']), 'M-one', 'one more is said with the plural key');
    assert.equal(moreFoldersText(['a', 'b', 'c', 'd']), 'M3');
    assert.equal(wouldMoveText(1), 'W-one', 'one series is said with the plural key');
    assert.equal(wouldMoveText(12), 'W12');
    // The name is isolated (FSI … PDI), so an Arabic line keeps a Latin library's name whole.
    assert.equal(heldByText('Picks 18+'), 'H:\u2068Picks 18+\u2069');
  } finally { setActiveDict({}); }
});

test('the preview names its titles the reader\'s way, and a list that goes on ends on "…" alone', () => {
  // v0.55.1 integration: the line read "…, including Tales of Demons and Gods, Martial Peak…. No files are deleted." in
  // every language. Reintroduce the full stop after "…" (`'period'` whatever the list): "an ellipsis takes no full stop
  // after it" fails. Reintroduce `.join(', ')`: "an Arabic line joins its titles with the Arabic comma" fails.
  setActiveDict({ including: 'including', 'No files are deleted.': 'No files are deleted.' });
  const fsi = (t: string) => `\u2068${t}\u2069`;
  const five = ['Tales of Demons and Gods', 'Martial Peak', 'Solo Leveling', 'Omniscient Reader', 'Eleceed'];
  try {
    setActiveLocale('en');
    assert.equal(previewText(5, five),
      `5 series would move, including ${fsi('Tales of Demons and Gods')}, ${fsi('Martial Peak')}, ${fsi('Solo Leveling')}… No files are deleted.`,
      'an ellipsis takes no full stop after it');
    assert.equal(previewText(2, five.slice(0, 2)), `2 series would move, including ${fsi('Tales of Demons and Gods')}, ${fsi('Martial Peak')}. No files are deleted.`);
    assert.equal(previewText(1, []), '1 series would move. No files are deleted.', 'a preview with no titles');
    setActiveLocale('ar');
    assert.equal(previewText(5, five),
      `5 series would move، including ${fsi('Tales of Demons and Gods')}، ${fsi('Martial Peak')}، ${fsi('Solo Leveling')}… No files are deleted.`,
      'an Arabic line joins its titles with the Arabic comma');
    setActiveLocale('ja');
    assert.equal(previewText(2, five.slice(0, 2)), `2 series would move、including ${fsi('Tales of Demons and Gods')}、${fsi('Martial Peak')}。No files are deleted.`,
      'a Japanese line takes its own marks');
    setActiveLocale('zh');
    assert.match(previewText(2, five.slice(0, 2)), /would move，including .+、.+。No files/, 'Chinese: a clause comma, then the list mark');
  } finally { setActiveDict({}); setActiveLocale('en'); }
  // The dialog draws the line, and nothing of its own around it.
  const dialog = slice(code(read('app/admin/page.tsx')), 'function LibraryDialog(', 'function LibrariesSection(');
  assert.match(dialog, /data-library-preview=\{preview\.series\}>\s*\{previewText\(preview\.series, preview\.sample\)\}\s*<\/p>/, 'the dialog builds the line itself');
});

test('the dialog keeps a list of folders, sends `paths`, and the browser\'s rows are checks, not "Use"', () => {
  const admin = code(read('app/admin/page.tsx'));
  const picker = slice(admin, 'function FolderPicker(', 'function LibraryDialog(');
  // Reintroduce the "Use" key (`onPick(f.path)` replacing the folder): "the browser's rows do not tick" fails.
  assert.match(picker, /<input type="checkbox" checked=\{on\} disabled=\{!!holder && !on\} onChange=\{\(\) => onToggle\(f\.path\)\}/, 'the browser\'s rows do not tick');
  assert.doesNotMatch(picker, /tr\('Use'\)/, 'the browser still offers "Use"');
  assert.match(picker, /\{holder && <span[^>]*data-folder-held>\{heldByText\(holder\)\}<\/span>\}/, 'a folder another library holds is not shown as taken');
  assert.match(picker, /data-lenis-prevent className="max-h-52 overflow-y-auto/, 'the browser scrolls under Lenis');
  const dialog = slice(admin, 'function LibraryDialog(', 'function LibrariesSection(');
  assert.match(dialog, /const folders = addFolder\(paths, typed\);/, 'Save forgets a folder typed and not added');
  // Reintroduce `path: path.trim()` in either request: "the create does not send paths" / "the edit does not".
  assert.match(dialog, /json: \{ name: name\.trim\(\), paths: folders, ageRating \}/, 'the create does not send paths');
  assert.match(dialog, /if \(!isLib && !unchanged\) body\.paths = folders;/, 'the edit does not send paths');
  assert.match(dialog, /<FolderPicker chosen=\{paths\} held=\{held\} onToggle=\{toggle\} \/>/);
  assert.match(dialog, /setPaths\(\(cur\) => toggleFolder\(cur, p\)\)/, 'a tick does not toggle the list');
  assert.match(dialog, /onClick=\{\(\) => setPaths\(\(cur\) => cur\.filter\(\(x\) => x !== p\)\)\}/, 'a chosen folder has no key of its own to take it out');
  assert.match(dialog, /\/api\/admin\/libraries\/preview\?\$\{previewQuery\(editing\?\.id \?\? null, folders\)\}/, 'the preview does not ask about every folder');
  assert.match(dialog, /const canSave = !!name\.trim\(\) && \(isLib \|\| \(folders\.length > 0 && !taken\)\);/, 'Save is offered with a folder another library holds');
  // Folder names in <bdi>, a typed one dir="auto": an Arabic page keeps "Aqua Manga (EN)" whole.
  assert.match(dialog, /<bdi>\{p\}<\/bdi>/);
  assert.match(dialog, /dir="auto"/);
  // One filled key: Save.
  assert.equal(dialog.match(/btn-key-primary/g)?.length, 1, 'the dialog has more or fewer than one filled key');
});

test('a library card and Move to library say the first folder and "+{n} more"', () => {
  // Reintroduce `{l.path || tr('everything not in another library')}` on the card: "the card shows one folder" fails.
  const admin = code(read('app/admin/page.tsx'));
  const section = slice(admin, 'function LibrariesSection(', 'function LibraryAccessDialog(');
  assert.match(section, /<LibraryFolders paths=\{foldersOf\(l\)\} className="text-\[11px\] text-fog-500" \/>/, 'the card shows one folder');
  // The suggested folders still open the dialog on that folder, and named after it.
  assert.match(section, /onClick=\{\(\) => openNew\(\{ name: c\.path\.split\('\/'\)\.pop\(\) \|\| c\.path, paths: \[c\.path\] \}\)\}/, 'a suggested folder no longer opens the dialog on itself');
  const line = code(read('components/LibraryFolders.tsx'));
  assert.match(line, /const more = moreFoldersText\(paths\);/);
  assert.match(line, /<bdi className="min-w-0 truncate font-mono">\{paths\[0\]\}<\/bdi>\s*\{more && <span className="shrink-0/, 'the count can be truncated away by a long first folder');
  const library = code(read('app/library/page.tsx'));
  assert.match(library, /<LibraryFolders paths=\{foldersOf\(l\)\} className="text-\[11px\] text-fog-500" \/>/, 'Move to library shows one folder');
});
