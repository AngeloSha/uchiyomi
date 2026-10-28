// A button can open the command palette (a phone has no Ctrl+K or "/"): lib/palette.ts is the event, AppShell the listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PALETTE_EVENT, openPalette } from '../lib/palette';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('openPalette sends the event with the text to start with, and nothing without a window', () => {
  assert.doesNotThrow(() => openPalette('x'), 'throws where there is no window (the static export renders without one)');
  const seen: unknown[] = [];
  const target = new EventTarget();
  target.addEventListener(PALETTE_EVENT, (e) => seen.push((e as CustomEvent<string>).detail));
  (globalThis as { window?: unknown }).window = target;
  try {
    openPalette();
    openPalette('one p');
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
  assert.deepEqual(seen, ['', 'one p']);
});

test('the shell listens for it, signed in only, and the Search page has the button (phones only)', () => {
  const shell = read('components/AppShell.tsx');
  assert.match(shell, /window\.addEventListener\(PALETTE_EVENT, on\);\s*return \(\) => window\.removeEventListener\(PALETTE_EVENT, on\);/);
  assert.match(shell, /if \(status !== 'authed'\) return;\s*const on = \(e: Event\) => \{ setPaletteSeed\(/);
  const search = read('app/search/page.tsx');
  assert.match(search, /onClick=\{\(\) => openPalette\(q\)\} data-search-palette className="[^"]*lg:hidden"/);
});
