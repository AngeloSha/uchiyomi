// The compact chapter list is opt-in, and with it off the chapter row is byte-for-byte what it always was.
//
// @Squeaks72's #88 made the leaner desktop row the default: no thumbnail, no status dot, buttons only on hover.
// The default look is deliberate (lib/effects.ts) -- the thumbnail is each chapter's own first page and carries
// the read dimming, the accent progress bar and a deleted chapter's dashed box -- so the lean row became a
// per-device choice instead. These tests pin the OFF strings to the markup that shipped before, so the switch
// can never quietly become a restyle of everyone's list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buttonsClass, compactChaptersOn, dotHide, rowClass, setCompactChaptersOn, thumbHide } from '../lib/compactChapters';

test('off, every class is exactly the row that shipped before', () => {
  // Reintroduce #88's default by returning the compact strings unconditionally: all four fail.
  assert.equal(rowClass(false), 'flex items-center gap-3 py-2.5 lg:gap-2.5');
  assert.equal(thumbHide(false, false), '');
  assert.equal(thumbHide(false, true), '');
  assert.equal(dotHide(false), '');
});

test('on, a computer gets the lean row, and select mode keeps its box', () => {
  assert.match(rowClass(true), /\bgroup\b/);
  assert.match(rowClass(true), /lg:pointer-fine:py-1\.5/);
  assert.equal(thumbHide(true, false), ' lg:pointer-fine:hidden');
  assert.equal(thumbHide(true, true), '', 'the box carries the selection bubble in select mode');
  assert.equal(dotHide(true), ' lg:pointer-fine:hidden');
  // Only on a hovering pointer: `lg:` alone would hide the buttons on a landscape tablet, where hover never fires.
  assert.match(buttonsClass(false), /lg:pointer-fine:opacity-0/);
  assert.doesNotMatch(buttonsClass(false), /(^|\s)lg:opacity-0/);
  assert.doesNotMatch(buttonsClass(true), /opacity-0/, 'an open menu pins the buttons');
});

test('the series page uses them on both kinds of row, and adds no wrapper when off', () => {
  const src = readFileSync(join(__dirname, '..', 'app/series/page.tsx'), 'utf8');
  assert.equal(src.match(/className=\{rowClass\(!!compact\)\}/g)?.length, 2, 'ChapterRow and GhostRow both');
  assert.equal(src.match(/thumbHide\(!!compact, !!selectable\)/g)?.length, 2);
  assert.equal(src.match(/dotHide\(!!compact\)/g)?.length, 2);
  // An extra element around the buttons would move them even when compact is off.
  assert.match(src, /if \(!compact\) return <>\{children\}<\/>;/);
});

test('it is off until this device turns it on, and a storage that throws reads as off', () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  assert.equal(compactChaptersOn(), false);
  setCompactChaptersOn(true);
  assert.equal(compactChaptersOn(), true);
  setCompactChaptersOn(false);
  assert.equal(compactChaptersOn(), false);
  (globalThis as any).localStorage = { getItem() { throw new Error('blocked'); } };
  assert.equal(compactChaptersOn(), false);
  delete (globalThis as any).localStorage;
});
