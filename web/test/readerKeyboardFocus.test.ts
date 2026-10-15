// Bringing one page of a double spread into frame from the keyboard (app/reader/page.tsx), the keyboard's version of tapping a page.
// The reader's page component is too big to mount here, so this reads its source, as the other reader-page tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '..', 'app', 'reader', 'page.tsx'), 'utf8');

test('Z toggles the focus, above Escape, never in a field and never from a key the reader has bound', () => {
  assert.match(page, /e\.key\.toLowerCase\(\) === 'z' && !e\.shiftKey && !\/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/[\s\S]{0,200}READER_ACTIONS\.some\(\(a\) => keyMap\[a\]\.some\(\(k\) => k\.toLowerCase\(\) === 'z'\)\)\) \{\s*if \(focusKeys\.current\.toggleFocus\(\)\) e\.preventDefault\(\);/);
  assert.ok(page.indexOf("toLowerCase() === 'z'") < page.indexOf("if (e.key === 'Escape') { if (!e.repeat) back(); return; }"), 'Escape is still the reader\'s first word');
});

test('the arrows step between the two pages while one is in frame, for a key or a button but not for a tap', () => {
  assert.match(page, /if \(!o\.tap && \(action === 'pageLeft' \|\| action === 'pageRight'\) && stepFocus\(action === 'pageLeft' \? -1 : 1\)\) return;/);
});

test('a page in frame says so, with its own number', () => {
  assert.match(page, /\{focused && flat\[focused\.page\] && \(/);
  assert.match(page, /tr\('Page \{n\} · tap, or press Z, to see both', \{ n: flat\[focused\.page\]\.number \}\)/);
});
