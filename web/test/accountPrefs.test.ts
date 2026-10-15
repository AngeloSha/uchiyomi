// Show-not-yet-on-server chapters and also-follow are ACCOUNT settings now, mirrored to the
// localStorage keys the device-only versions used. The rules, as Reduce effects has them: the device's copy until
// the account's value has loaded, the account's value over the device's after, nothing lost on the way up.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_PREFS, adoptAccountPrefs, clearAccountPrefs, localOnlyPrefs, readAccountPref, writeAccountPref } from '../lib/accountPrefs';

const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
beforeEach(() => mem.clear());

test('the defaults are what the device-only switches had: ghosts on, also-follow off', () => {
  assert.deepEqual(ACCOUNT_PREFS, ['showGhosts', 'alsoFollow']);
  assert.equal(readAccountPref('showGhosts'), true);
  assert.equal(readAccountPref('alsoFollow'), false);
});

test('what an older build already stored is still read, under the same keys and values', () => {
  mem.set('uchiyomi.showGhosts', 'off');
  mem.set('uchiyomi.alsoFollow', '1');
  assert.equal(readAccountPref('showGhosts'), false);
  assert.equal(readAccountPref('alsoFollow'), true);
});

test('writing mirrors the device, and stores the default the way the old code did', () => {
  writeAccountPref('showGhosts', false);
  assert.equal(mem.get('uchiyomi.showGhosts'), 'off');
  writeAccountPref('alsoFollow', false);
  assert.equal(mem.get('uchiyomi.alsoFollow'), '0');
});

test('the account value overwrites the device, in both directions; a key it does not hold is left alone', () => {
  mem.set('uchiyomi.alsoFollow', '1');
  adoptAccountPrefs({ showGhosts: false });
  assert.equal(readAccountPref('showGhosts'), false, 'the account says hide ghosts');
  assert.equal(readAccountPref('alsoFollow'), true, 'no account value: the device keeps its own');
  adoptAccountPrefs({ showGhosts: true, alsoFollow: false });
  assert.equal(readAccountPref('showGhosts'), true);
  assert.equal(readAccountPref('alsoFollow'), false);
  // A non-boolean is ignored rather than trusted.
  adoptAccountPrefs({ alsoFollow: 'true' as any });
  assert.equal(readAccountPref('alsoFollow'), false);
  adoptAccountPrefs(undefined);
});

test('a choice made before the upgrade is carried up once: only what differs from the default and the account lacks', () => {
  mem.set('uchiyomi.showGhosts', 'on'); // the default, spelled out: nothing to carry
  mem.set('uchiyomi.alsoFollow', '1');
  assert.deepEqual(localOnlyPrefs({}), { alsoFollow: true });
  assert.deepEqual(localOnlyPrefs({ alsoFollow: false }), {}, 'the account already has a value');
  mem.clear();
  assert.deepEqual(localOnlyPrefs({}), {}, 'nothing on the device, nothing to carry');
  mem.set('uchiyomi.showGhosts', 'off');
  assert.deepEqual(localOnlyPrefs(undefined), { showGhosts: false });
});

test('sign-out forgets the device copies, so the next account starts from its own settings', () => {
  mem.set('uchiyomi.showGhosts', 'off');
  mem.set('uchiyomi.alsoFollow', '1');
  clearAccountPrefs();
  assert.equal(mem.size, 0);
});

test('a storage that throws reads as the defaults', () => {
  const saved = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(readAccountPref('showGhosts'), true);
  assert.doesNotThrow(() => writeAccountPref('alsoFollow', true));
  assert.deepEqual(localOnlyPrefs({}), {});
  (globalThis as any).localStorage = saved;
});

test('auth adopts them on every sign-in, clears them on sign-out, and the two consumers use the account store', () => {
  const root = join(__dirname, '..');
  const auth = readFileSync(join(root, 'lib/auth.tsx'), 'utf8');
  assert.match(auth, /adoptAccountPrefs\(u\.settings\);/, 'the account value never reaches the device');
  assert.match(auth, /clearAccountPrefs\(\);/, 'the next account on a shared device inherits these');
  assert.match(readFileSync(join(root, 'app/series/page.tsx'), 'utf8'), /useAccountPref\('showGhosts'\)/);
  assert.match(readFileSync(join(root, 'components/AddSeriesDialog.tsx'), 'utf8'), /useAccountPref\('alsoFollow'\)/);
});
