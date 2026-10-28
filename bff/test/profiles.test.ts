// What kind of profile a row is (lib/profiles.ts profileKind), on every combination of the columns that decide it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileKind, type ProfileRow } from '../src/lib/profiles';

const row = (o: Partial<ProfileRow>): ProfileRow => ({ password_login: true, local_open: false, sso: false, auth_kind: 'password', ...o });

test('every account before profiles is a password profile, whether it was made by setup, sign-up or the provider', () => {
  assert.equal(profileKind(row({}), false), 'password');
  assert.equal(profileKind(row({ auth_kind: 'oidc', sso: true }), false), 'password');
  // An account the provider made has an unusable hash; with password_login false it still has one credential, the provider.
  assert.equal(profileKind(row({ auth_kind: 'oidc', sso: true, password_login: false }), false), 'password');
});

test('open at home: without a credential it is open, with one it is hybrid', () => {
  assert.equal(profileKind(row({ password_login: false, local_open: true, auth_kind: 'none' }), false), 'open');
  assert.equal(profileKind(row({ local_open: true }), false), 'hybrid');
  assert.equal(profileKind(row({ password_login: false, local_open: true, sso: true }), false), 'hybrid');
});

test('no credential and not open at home is no way in, and is said as such', () => {
  assert.equal(profileKind(row({ password_login: false }), false), 'none');
});

test('the desktop app\'s own account is the desktop owner on desktop only', () => {
  assert.equal(profileKind(row({ auth_kind: 'desktop' }), true), 'desktop-owner');
  // A server restored from a desktop backup: that account is an ordinary password account there.
  assert.equal(profileKind(row({ auth_kind: 'desktop' }), false), 'password');
  assert.equal(profileKind(row({}), true), 'password');
});
