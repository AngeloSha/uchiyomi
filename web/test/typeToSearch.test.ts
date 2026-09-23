// Type-to-search opens the palette only for plain letters/digits pressed outside a text field or dialog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { typeToSearchKey } from '../lib/typeToSearch';

const k = (key: string, extra: Partial<Parameters<typeof typeToSearchKey>[0]> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra });
const free = { typing: false, modalOpen: false };

test('letters and digits seed the palette, case kept', () => {
  assert.equal(typeToSearchKey(k('o'), free), 'o');
  assert.equal(typeToSearchKey(k('O', {}), free), 'O');
  assert.equal(typeToSearchKey(k('7'), free), '7');
  assert.equal(typeToSearchKey(k('é'), free), 'é');
  assert.equal(typeToSearchKey(k('の'), free), 'の');
});

test('punctuation, whitespace and named keys are left to the page', () => {
  for (const key of ['/', ' ', '?', '.', 'Enter', 'Escape', 'ArrowDown', 'Tab', 'Shift', 'F5', 'Dead']) {
    assert.equal(typeToSearchKey(k(key), free), null, key);
  }
});

test('shortcuts are not text', () => {
  assert.equal(typeToSearchKey(k('k', { ctrlKey: true }), free), null);
  assert.equal(typeToSearchKey(k('c', { metaKey: true }), free), null);
  assert.equal(typeToSearchKey(k('a', { altKey: true }), free), null);
});

test('claimed, composing and held keys are ignored', () => {
  assert.equal(typeToSearchKey(k('a', { defaultPrevented: true }), free), null);
  assert.equal(typeToSearchKey(k('a', { isComposing: true }), free), null);
  assert.equal(typeToSearchKey(k('a', { repeat: true }), free), null);
});

test('never while typing in a field or with a dialog open', () => {
  assert.equal(typeToSearchKey(k('a'), { typing: true, modalOpen: false }), null);
  assert.equal(typeToSearchKey(k('a'), { typing: false, modalOpen: true }), null);
});
