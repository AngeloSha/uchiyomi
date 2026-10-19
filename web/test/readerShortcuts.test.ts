// The reader's keyboard-shortcuts list (components/ReaderShortcuts.tsx): opened by a toolbar button and by ?, listing the keys in force.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
const list = readFileSync(join(__dirname, '..', 'components/ReaderShortcuts.tsx'), 'utf8');

test('? opens the list, and while it is open ? and Escape close it and no other key reaches the pages', () => {
  assert.match(page, /e\.key === '\?' && !e\.repeat && !\/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(t\?\.tagName \?\? ''\) && !t\?\.isContentEditable[\s\S]{0,120}setShowKeys\(true\)/);
  assert.match(page, /if \(showSettings \|\| showPages \|\| showChapters \|\| showKeys \|\| talkFor\) \{[\s\S]{0,300}setShowKeys\(false\)[\s\S]{0,200}return;/);
  assert.match(page, /showSettings \|\| showPages \|\| showChapters \|\| showKeys \|\| !!talkFor\);/, 'a game controller waits while it is open');
});

test('the list reads the keys in force, not a copy of the defaults', () => {
  assert.match(page, /<ReaderShortcuts keyMap=\{keyMap\}/);
  assert.match(list, /READER_ACTIONS\.filter\(\(a\) => a !== 'exit' && keyMap\[a\]\.length > 0\)/);
});

test('the toolbar button is for a pointer that hovers and is fine, not a phone', () => {
  assert.match(list, /\(hover: hover\) and \(pointer: fine\)/);
  assert.match(page, /\{hasKeyboard && \(\s*<button onClick=\{\(\) => setShowKeys\(true\)\}/);
});

test('? is once a press, and never in something editable', () => {
  // Held, ? repeats: each repeat opened or closed the list, so it flickered until the key came up. Reintroduce by dropping
  // either `!e.repeat`: this fails. A contentEditable field (a note, a comment box) types its ? like any text field.
  assert.match(page, /else if \(e\.key === '\?' && showKeys && !e\.repeat\) setShowKeys\(false\);/);
  assert.match(page, /if \(e\.key === '\?' && !e\.repeat && [^\n]*!t\?\.isContentEditable/);
});
