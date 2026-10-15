// The reader's right-click menu (app/reader/page.tsx): the mouse's right button only, and the keys are the menu's while it is open.
// The reader's page component is too big to mount here, so this reads its source, as the other reader-page tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '..', 'app', 'reader', 'page.tsx'), 'utf8');

test('both tracks open the reader\'s menu on a right click, and the hook\'s touch long-press is not spread', () => {
  assert.match(page, /const readerMenu = useContextMenu\(\(\): MenuItem\[\] =>/);
  assert.equal((page.match(/onDoubleClick=\{onTrackDoubleClick\} \{\.\.\.menuBind\}/g) ?? []).length, 2);
  assert.match(page, /const menuBind = \{\s*onContextMenu: \(e: React\.MouseEvent<HTMLElement>\) => \{[\s\S]{0,200}readerMenu\.bind\.onContextMenu\(e\);/);
  assert.doesNotMatch(page, /\{\.\.\.readerMenu\.bind\}/, 'a touch long-press would open it over the reader\'s own gestures');
  assert.match(page, /\{readerMenu\.element\}/);
});

test('while the menu is open the keys are its: Escape closes the menu, not the reader', () => {
  // The menu's guard comes first: before the sheets, the key list's ? and Escape leaving the reader.
  assert.match(page, /if \(menuOpen\.current\) return;[\s\S]{0,2000}if \(e\.key === 'Escape'\) \{ if \(!e\.repeat\) back\(\)/);
  assert.match(page, /menuOpen\.current = readerMenu\.open;/);
});

test('the menu offers the page, the chapter, the layout and the way out', () => {
  const menu = page.slice(page.indexOf('const readerMenu = useContextMenu'), page.indexOf('const menuBind'));
  for (const label of ['Zoom in', 'Bookmark this page', 'Jump to a page', 'Next chapter', 'Previous chapter', 'Chapters', 'Full screen', 'Reader settings', 'Open the series', 'Leave the reader']) {
    assert.ok(menu.includes(`tr('${label}')`), label);
  }
  // Next and previous are greyed at the ends of the series rather than missing.
  assert.match(menu, /tr\('Next chapter'\), onSelect: \(\) => goChapter\(nextId\), disabled: !nextId/);
});

test('a touch long-press keeps the browser\'s own menu', () => {
  // Android Chrome and Windows touch send `contextmenu` on a long-press, where saving or sharing the image is what holding a
  // page is for. Reintroduce by spreading the hook's handler as it is: a long-press on a page opens the reader's menu.
  const bind = page.slice(page.indexOf('const menuBind = {'), page.indexOf('readerMenu.bind.onContextMenu(e);'));
  assert.match(bind, /\(\(e\.nativeEvent as Partial<PointerEvent>\)\.pointerType \|\| lastPointer\.current\) === 'touch'\) return;/);
  // Safari's contextmenu names no pointer, so the page's last press does: recorded before anything else in the handler.
  const down = page.slice(page.indexOf('const onPointerDown'), page.indexOf('const onPointerMove'));
  assert.match(down, /^const onPointerDown = \(e: React\.PointerEvent\) => \{\s*lastPointer\.current = e\.pointerType;/);
});
