// A right or middle click is not a tap in the reader: it used to turn the page or toggle the controls, as a left click does.
// The pointer handler lives in the reader's page component, which is too big to mount here, so this reads the guard from its
// source, as the other reader-page tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '..', 'app', 'reader', 'page.tsx'), 'utf8');

test('the reader ignores a mouse press that is not the primary button', () => {
  const down = page.slice(page.indexOf('const onPointerDown'), page.indexOf('const onPointerMove'));
  // Reintroduce by dropping the guard: a right click turns the page again.
  assert.match(down, /e\.pointerType === 'mouse' && e\.button !== 0\) \{ tap\.current = null; return; \}/);
  assert.ok(down.indexOf('e.button !== 0') < down.indexOf('tap.current = { x'), 'the guard comes before a tap is recorded');
});
