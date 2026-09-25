// Type-to-search opens the palette only for plain letters/digits pressed outside a text field or dialog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedFor, setTypeToSearchOn, typeToSearchKey, typeToSearchOn } from '../lib/typeToSearch';

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

const plain = { key: 'w', ctrlKey: false, metaKey: false, altKey: false };
const idle = { typing: false, modalOpen: false };

test('an IME keystroke is left alone in every spelling a browser uses', () => {
  // Safari reports it as keyCode 229 with key "Process" and no isComposing.
  assert.equal(typeToSearchKey({ ...plain, keyCode: 229 }, idle), null);
  assert.equal(typeToSearchKey({ ...plain, key: 'Process' }, idle), null);
  assert.equal(typeToSearchKey({ ...plain, isComposing: true }, idle), null);
  assert.equal(typeToSearchKey(plain, idle), 'w', 'an ordinary letter still opens search');
});

test('under a Japanese or Chinese interface the palette opens empty, never holding a raw Latin letter', () => {
  // Nothing focused means no IME, so the letter arrived raw and the IME composed after it: "w" + "あんぴーす".
  // Reintroduce by returning `ch` for every language: the ja and zh cases fail.
  for (const lang of ['ja', 'ja-JP', 'zh', 'zh-CN', 'ZH-TW']) assert.equal(seedFor('w', lang), '', lang);
  for (const lang of ['en', 'de', 'ar', 'pt-BR', 'ru', '']) assert.equal(seedFor('w', lang), 'w', lang);
});

test('single-key search shortcuts can be switched off on this device, and are on until they are', () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  assert.equal(typeToSearchOn(), true, 'on by default');
  setTypeToSearchOn(false);
  assert.equal(typeToSearchOn(), false);
  setTypeToSearchOn(true);
  assert.equal(typeToSearchOn(), true);
  delete (globalThis as any).localStorage;
  assert.equal(typeToSearchOn(), true, 'no storage (a private window): still on, never a throw');
});
