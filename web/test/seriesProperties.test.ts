// "Properties…" on a series card's menu: where it is, and who sees it. Source checks, like the repo's other
// UI-shape tests: the sheet is a component, and what must not drift is what it offers and to whom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

test('the series menu offers Properties to an admin only, and renders the sheet with the menu', () => {
  const menu = read('components/SeriesMenu.tsx');
  assert.match(menu, /\.\.\.\(isAdmin \? \[\{ label: tr\('Properties…'\), divider: true, onSelect: \(\) => setProperties\(true\) \}\] : \[\]\)/, 'Properties is not admin-only');
  assert.match(menu, /\{menu\.element\}\{properties && <SeriesPropertiesSheet series=\{series\} onClose=\{\(\) => setProperties\(false\)\} \/>\}/, 'the sheet does not ride on the menu element');
});

test('the sheet holds the age rating, library, direction, type, sources and a check, saved through the meta route', () => {
  const sheet = read('components/SeriesPropertiesSheet.tsx');
  assert.match(sheet, /isAdmin && data && <AdminFields/);
  for (const f of ['Age rating', 'Reading direction', 'Series type', 'Check for new chapters']) assert.ok(sheet.includes(`tr('${f}')`), f);
  assert.match(sheet, /<LibraryRow /);
  assert.match(sheet, /\/api\/admin\/series\/\$\{id\}\/meta/);
  assert.match(sheet, /\/api\/admin\/series\/\$\{id\}\/sources\/\$\{encodeURIComponent\(s\.sourceId\)\}/, 'a follower cannot be detached');
  assert.match(sheet, /\{!s\.primary && \(/, 'the main source can be detached');
});

test('the sheet reuses the editor\'s rows rather than copying them', () => {
  const editor = read('components/SeriesEditor.tsx');
  for (const n of ['export const DIRECTIONS', 'export function autoDirectionChoice', 'export const ages', 'export function ChoiceRow', 'export function LibraryRow']) assert.ok(editor.includes(n), n);
});

test('the sheet scrolls under Lenis\' hands-off marker', () => {
  assert.match(read('components/SeriesPropertiesSheet.tsx'), /data-lenis-prevent/);
});
