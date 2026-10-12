// The reader's keys as actions (v0.61.0, lib/readerKeys.ts): the defaults must be v0.60's handler, key for key, and a
// device's own bindings must never reach the keys that are not the reader's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_KEYS_PAGED, DEFAULT_KEYS_VERTICAL, READER_ACTIONS, actionForKey, bindKey, bindable, cleanKeyOverrides, keyMapFor,
  normalize, unbindKey, type ReaderAction,
} from '../lib/readerKeys';

interface Press { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean }

/**
 * v0.60's keyboard handler (app/reader/page.tsx before v0.61.0), as a decision: which action a key press took, or null.
 * Copied, not imported -- it no longer exists -- so it is the reference the new map is held to.
 */
function v060(e: Press, mode: 'paged' | 'vertical', owned: boolean): ReaderAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  const paged = mode === 'paged';
  if (e.repeat && (e.key === '[' || e.key === ']' || e.key === 'f' || e.key === 'Escape')) return null;
  if (e.key === '[') return 'prevChapter';
  if (e.key === ']') return 'nextChapter';
  if (e.key === 'f') return 'fullscreen';
  if (e.key === 'Escape') return 'exit';
  if (paged && !owned && e.key === 'ArrowRight') return 'pageRight';
  if (paged && !owned && e.key === 'ArrowLeft') return 'pageLeft';
  if (paged && !owned && ((e.key === ' ' && !e.shiftKey) || e.key === 'ArrowDown' || e.key === 'PageDown')) return 'next';
  if (paged && !owned && ((e.key === ' ' && e.shiftKey) || e.key === 'ArrowUp' || e.key === 'PageUp')) return 'prev';
  if (!paged && !owned && ((e.key === ' ' && !e.shiftKey) || e.key === 'ArrowDown')) return 'next';
  if (!paged && !owned && ((e.key === ' ' && e.shiftKey) || e.key === 'ArrowUp')) return 'prev';
  return null;
}

/** v0.61's handler as the reader runs it: Escape is reserved and handled first, everything else goes through the map. */
function v061(e: Press, mode: 'paged' | 'vertical', owned: boolean, overrides = {}): ReaderAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === 'Escape') return e.repeat ? null : 'exit';
  return actionForKey(e, keyMapFor(mode, overrides), { owned });
}

const KEYS = [' ', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Enter', 'Tab',
  '[', ']', '{', '}', 'f', 'F', 'j', 'k', '1', 'Escape', 'Shift', 'Control', 'Backspace'];

test('the default keys are v0.60\'s handler, key for key', () => {
  // Every key, with and without Shift, held or not, Ctrl/Alt/Meta or not, a control focused or not, in both modes.
  // Reintroduce by dropping PageDown from DEFAULT_KEYS_PAGED.next: "paged PageDown" disagrees and this fails.
  let cases = 0;
  for (const mode of ['paged', 'vertical'] as const) {
    for (const key of KEYS) {
      for (const shiftKey of [false, true]) {
        for (const repeat of [false, true]) {
          for (const owned of [false, true]) {
            for (const mod of [{}, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
              const e: Press = { key, shiftKey, repeat, ...mod };
              assert.equal(v061(e, mode, owned), v060(e, mode, owned), `${mode} ${JSON.stringify(e)} owned=${owned}`);
              cases++;
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 1500, `only ${cases} cases`);
});

test('a key press is one binding string', () => {
  assert.equal(normalize(' '), 'Space');
  assert.equal(normalize(' ', true), 'Shift+Space');
  assert.equal(normalize('ArrowDown', true), 'Shift+ArrowDown');
  assert.equal(normalize('F', true), 'F', 'Shift on a character makes the character, which is bound as itself');
  assert.equal(normalize('j'), 'j');
});

test('Escape and Tab are never bindable, nor anything held with Ctrl, Alt or Meta', () => {
  // Reintroduce by accepting any string in bindable(): a device could bind Escape and lose its way out of the reader.
  for (const k of ['Escape', 'Tab', 'Shift+Tab', 'Control+j', 'Alt+ArrowLeft', 'Meta+f', 'Shift', 'Control', 'CapsLock', 'Shift+a', '', 'Dead']) {
    assert.equal(bindable(k), false, k);
  }
  for (const k of ['j', 'F', 'Space', 'Shift+Space', 'Shift+ArrowUp', 'PageDown', '[', 'F5', 'Backspace']) assert.equal(bindable(k), true, k);
  assert.equal(bindable(42), false);
  // Even forced into a device's bindings, they never act.
  const forced = cleanKeyOverrides({ exit: ['Escape', 'q', 'Control+w'], menu: ['Tab', 'm'], bogus: ['x'], next: 'j' });
  assert.deepEqual(forced, { exit: ['q'], menu: ['m'] }, 'storage kept a reserved or modified key, an unknown action, or a non-list');
  assert.equal(actionForKey({ key: 'Escape' }, { ...keyMapFor('paged'), menu: ['Escape'] }), null, 'a map holding Escape made it a binding');
  assert.equal(actionForKey({ key: 'Tab' }, { ...keyMapFor('paged'), next: ['Tab'] }), null);
  assert.equal(actionForKey({ key: 'j', ctrlKey: true }, { ...keyMapFor('paged'), next: ['j'] }), null, 'Ctrl+j acted');
});

test("'j' rebound to the next page turns it, in both modes, and nothing else changes", () => {
  const { overrides, from } = bindKey({}, 'paged', 'next', 'j');
  assert.equal(from, null);
  assert.deepEqual(overrides, { next: ['Space', 'ArrowDown', 'PageDown', 'j'] });
  assert.equal(actionForKey({ key: 'j' }, keyMapFor('paged', overrides)), 'next');
  assert.equal(actionForKey({ key: 'j' }, keyMapFor('vertical', overrides)), 'next');
  assert.equal(actionForKey({ key: ']' }, keyMapFor('paged', overrides)), 'nextChapter', 'another action changed');
  // Taken off again.
  assert.deepEqual(unbindKey(overrides, 'paged', 'next', 'j').next, ['Space', 'ArrowDown', 'PageDown']);
});

test('a key bound to another action moves, and says from where', () => {
  // Reintroduce by adding without taking it off the other action: Page Down would do two things at once.
  const { overrides, from } = bindKey({}, 'paged', 'nextChapter', 'PageDown');
  assert.equal(from, 'next');
  const map = keyMapFor('paged', overrides);
  assert.deepEqual(map.nextChapter, [']', 'PageDown']);
  assert.ok(!map.next.includes('PageDown'));
  assert.equal(READER_ACTIONS.filter((a) => map[a].includes('PageDown')).length, 1);
});

test('a held key repeats a page turn and nothing else; a focused control keeps its own keys', () => {
  const map = keyMapFor('paged', { menu: ['m'], exit: ['q'] });
  assert.equal(actionForKey({ key: 'ArrowDown', repeat: true }, map), 'next');
  for (const key of [']', '[', 'f', 'm', 'q']) assert.equal(actionForKey({ key, repeat: true }, map), null, `${key} repeated`);
  // A focused button keeps Space and Enter, the slider its arrows -- whatever they are bound to.
  const enter = keyMapFor('paged', { nextChapter: [']', 'Enter'] });
  assert.equal(actionForKey({ key: 'Enter' }, enter, { owned: true }), null, 'Enter on a focused button changed chapter');
  assert.equal(actionForKey({ key: 'Enter' }, enter), 'nextChapter');
  assert.equal(actionForKey({ key: ']' }, enter, { owned: true }), 'nextChapter', 'a key no control uses stopped working');
});

test('the defaults are the documented ones', () => {
  // Paged turns with Page Down; the column leaves Page Down to the browser, which scrolls it natively.
  assert.ok(DEFAULT_KEYS_PAGED.next.includes('PageDown'));
  assert.ok(!DEFAULT_KEYS_VERTICAL.next.includes('PageDown'));
  assert.deepEqual(DEFAULT_KEYS_VERTICAL.pageLeft, []);
  assert.deepEqual(DEFAULT_KEYS_PAGED.exit, [], 'Escape leaves; nothing else does by default');
});

test('the reader runs every key through the map, Escape first, and stops a bound key\'s default', () => {
  // Reintroduce the chain of `e.key === …` tests in the reader: these fail.
  const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  assert.match(src, /const keyMap = useMemo\(\(\) => keyMapFor\(prefs\.mode, device\.keys\), \[prefs\.mode, device\.keys\]\);/);
  assert.match(src, /if \(e\.key === 'Escape'\) \{ if \(!e\.repeat\) back\(\); return; \}\s*[\s\S]{0,600}const action = actionForKey\(e, keyMap, \{ owned \}\);\s*if \(!action\) return;[\s\S]{0,200}e\.preventDefault\(\);\s*performRef\.current\(action\);/);
  assert.doesNotMatch(src, /e\.key === 'ArrowRight'|e\.key === 'PageDown'|e\.key === '\['/, 'a key is tested by hand again, past the map');
});
