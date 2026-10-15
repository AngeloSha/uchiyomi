// Keyboard chords: "g" then a letter goes somewhere, "?" lists them (lib/shortcuts.ts, components/Shortcuts.tsx).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chords, shortcutKeyOk, CHORD_MS } from '../lib/shortcuts';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const all = { admin: true, mayDownload: true, desktop: false };

test('chords: Discover and Downloads need canDownload, Admin needs admin, the device copies are gone on desktop', () => {
  const k = (c: Parameters<typeof chords>[0]) => chords(c).map((x) => x.key).join('');
  assert.ok(!k({ admin: false, mayDownload: false, desktop: false }).match(/[dvoa]/));
  assert.ok(k(all).includes('a'));
  assert.ok(k({ admin: false, mayDownload: true, desktop: false }).match(/d.*v.*o/));
  assert.ok(!k({ admin: false, mayDownload: true, desktop: true }).includes('o'));
});

test('no two chords share a key, and none is "g" itself or a non-letter', () => {
  const keys = chords(all).map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'two chords share a key');
  for (const k of keys) assert.match(k, /^[a-fh-z]$/, k);
});

test('every chord goes to a page the app has', () => {
  for (const c of chords(all)) {
    const seg = c.href.split('?')[0].split('/').filter(Boolean)[0];
    assert.ok(seg === undefined || existsSync(join(root, 'app', seg, 'page.tsx')), `${c.key}: ${c.href} has no page`);
  }
});

test('shortcuts stand down while typing, under a dialog, with a modifier, mid-composition and on a held key', () => {
  const e = { ctrlKey: false, metaKey: false, altKey: false };
  const free = { typing: false, modalOpen: false };
  assert.equal(shortcutKeyOk(e, free), true);
  assert.equal(shortcutKeyOk(e, { typing: true, modalOpen: false }), false);
  assert.equal(shortcutKeyOk(e, { typing: false, modalOpen: true }), false);
  for (const m of ['ctrlKey', 'metaKey', 'altKey'] as const) assert.equal(shortcutKeyOk({ ...e, [m]: true }, free), false, m);
  assert.equal(shortcutKeyOk({ ...e, isComposing: true }, free), false);
  assert.equal(shortcutKeyOk({ ...e, keyCode: 229 }, free), false);
  assert.equal(shortcutKeyOk({ ...e, repeat: true }, free), false);
  assert.equal(shortcutKeyOk({ ...e, defaultPrevented: true }, free), false);
});

test('the chord waits long enough to type a second key and not long enough to hold up a search', () => {
  assert.ok(CHORD_MS >= 800 && CHORD_MS <= 2000);
});

test('the shell binds them only when signed in and outside the reader, behind the same switch as type-to-search', () => {
  const shell = read('components/AppShell.tsx');
  assert.match(shell, /useGoShortcuts\(\{\s*enabled: status === 'authed' && !path\.startsWith\('\/reader'\)/);
  assert.match(shell, /status === 'authed' && help && <ShortcutsDialog ctx=\{shortcutCtx\}/);
  const sc = read('components/Shortcuts.tsx');
  assert.match(sc, /typeToSearchOn\(\)/);
  assert.match(sc, /window\.addEventListener\('keydown', onKey, true\)/);
});

test('the help dialog lists only keys that do something: Ctrl+K, /, ? and Esc', () => {
  const sc = read('components/Shortcuts.tsx');
  assert.match(sc, /\['Ctrl', 'K'\]/);
  assert.match(sc, /\[\['\/'\]/);
  assert.match(sc, /\[\['\?'\]/);
  assert.match(read('components/CommandPalette.tsx'), /e\.key\.toLowerCase\(\) === 'k'/);
  assert.match(read('components/CommandPalette.tsx'), /e\.key === '\/'/);
  assert.match(sc, /e\.key === '\?'/);
  assert.match(read('components/ConfirmDialog.tsx'), /Escape/);
});
