// A source pack's declared settings (lib/sources/preferences.ts): what the loader keeps, what a write may save,
// and what the settings sheet is told. Pure -- no database, no pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTING_TEXT_MAX, SettingError, sameSettingValue, validatePreferences, validateSettingValue, wireSetting,
} from '../src/lib/sources/preferences';

test('a declaration is kept, its title filled from its key when it has none', () => {
  const [p] = validatePreferences([{ key: 'COOKIE', type: 'text', title: '  ', secret: true }]);
  assert.equal(p.title, 'COOKIE');
  assert.equal(p.secret, true);
  assert.equal(p.default, undefined);
});

test('a bad declaration is dropped alone, never the source', () => {
  const kept = validatePreferences([
    { key: 'UA', type: 'text' },
    { key: 'UA', type: 'text' },                                  // duplicate key
    { key: 'no spaces', type: 'text' },                           // not an env-shaped key
    { key: 'BAD_TYPE', type: 'number' },
    { key: 'LIST', type: 'list' },                                // a list with no choices
    { key: 'MISMATCH', type: 'list', entries: ['A'], entryValues: ['a', 'b'] },
    { key: 'SWITCH', type: 'switch', secret: true },              // only text can be secret
    { key: 'NOPE', type: 'list', entries: ['A'], entryValues: ['a'], default: 'b' },
  ]);
  assert.deepEqual(kept.map((p) => p.key), ['UA', 'SWITCH', 'NOPE']);
  assert.equal(kept[1].secret, undefined);
  // An unusable default is dropped, not the setting: the admin can still set a valid one.
  assert.equal(kept[2].default, undefined);
});

test('the Auto Update key is reserved: a pack cannot declare or override the sweep switch', () => {
  const kept = validatePreferences([
    { key: 'autoUpdate', type: 'switch', title: 'Mine' },
    { key: 'UA', type: 'text' },
  ]);
  assert.deepEqual(kept.map((p) => p.key), ['UA']);
});

test('a choice outside the declaration is refused, and a multi-select is deduplicated', () => {
  const p = { key: 'MODE', type: 'multiselect' as const, title: 'Mode', entryValues: ['a', 'b'] };
  assert.deepEqual(validateSettingValue(p, ['b', 'a', 'b']), ['b', 'a']);
  assert.throws(() => validateSettingValue(p, ['a', 'c']), (e: unknown) => e instanceof SettingError && e.code === 'bad_value');
  assert.throws(() => validateSettingValue({ key: 'T', type: 'text', title: 'Text' }, 'x'.repeat(SETTING_TEXT_MAX + 1)),
    (e: unknown) => e instanceof SettingError && e.code === 'bad_value');
});

test('a multi-select compares as a set', () => {
  assert.equal(sameSettingValue(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameSettingValue(['a'], ['a', 'b']), false);
  assert.equal(sameSettingValue(true, true), true);
  assert.equal(sameSettingValue(null, undefined), true);
});

test('the sheet sees a default when unset, a value when set, and never a stored secret', () => {
  const text = { key: 'COOKIE', type: 'text' as const, title: 'Cookie', secret: true, default: 'mine' };
  const list = { key: 'MODE', type: 'list' as const, title: 'Mode', entryValues: ['a', 'b'], default: 'a' };
  const stored = (values: Record<string, any>, unreadable: string[] = []) => ({
    values: new Map(Object.entries(values)), unreadable: new Set(unreadable),
  });

  assert.equal(wireSetting(list, stored({})).value, 'a');
  assert.equal(wireSetting(list, stored({ MODE: 'b' })).value, 'b');
  const secret = wireSetting(text, stored({ COOKIE: 'abc' }));
  assert.equal(secret.value, null);
  assert.equal(secret.set, true);
  const unreadable = wireSetting(text, stored({}, ['COOKIE']));
  assert.equal(unreadable.set, true);
  assert.equal(unreadable.unreadable, true);
});
