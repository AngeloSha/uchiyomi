// SSO-only mode in the web app (v0.63.0, #208): the sign-in screen is the provider's button alone, Members makes no
// account but a profile with no password and sets no password, and the profile manages neither a password nor a second
// step -- the server has none of those routes in that mode (bff ssoOnly.int.test.ts). Read from source, like seriesPage.test.ts, plus the pure helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

import { linkResultText, providerOnly, ssoOnly } from '../lib/authConfig';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
/** The file with its comments removed, so a comment that names the old code does not fail the scan. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the sign-in screen is the provider\'s button alone only in SSO-only mode, and with no rescue open', () => {
  const oidc = { enabled: true, name: 'Authentik' };
  assert.equal(providerOnly({ mode: 'oidc-only', oidc }), true);
  // The rescue reopens the password form for one admin: the screen shows it again. Reintroduce by ignoring `rescue`:
  // the admin it exists for has nowhere to type.
  assert.equal(providerOnly({ mode: 'oidc-only', oidc, rescue: true }), false);
  assert.equal(providerOnly({ mode: 'local', oidc }), false);
  assert.equal(providerOnly({ oidc }), false, 'a server older than v0.63.0 says no mode: local');
  assert.equal(providerOnly({ mode: 'oidc-only', oidc: { enabled: false, name: '' } }), false, 'no provider, no button to be alone');
  assert.equal(ssoOnly({ mode: 'oidc-only' }), true);
  assert.equal(ssoOnly(undefined), false);
});

test('an SSO-only server\'s screen is its provider\'s button alone, decided once both answers are in', () => {
  const login = code(read('components/LoginScreen.tsx'));
  // Set only after /auth/config has answered: a password form shown in between would be a sign-in nobody can use.
  assert.match(login, /else if \(first\) setMode\(first === 'login' && providerOnly\(c\) \? 'sso' : first\);/);
  const card = login.slice(login.indexOf("{mode === 'sso' && ("), login.indexOf("{mode === 'login' && ("));
  assert.ok(card.length > 0, 'there is no SSO-only screen');
  assert.match(card, /href="\/auth\/oidc\/start"/);
  assert.doesNotMatch(card, /type="password"/, 'the SSO-only screen asks for a password');
  // The rescue's form says why it is there.
  assert.match(login, /\{config\?\.rescue && !needTotp && \(/);
});

test('Members offers no New account and no password in SSO-only mode, and marks linked accounts', () => {
  const members = code(read('app/admin/page.tsx'));
  assert.match(members, /const ssoOnly = data\?\.auth\?\.mode === 'oidc-only';/);
  // Reintroduce the form for SSO-only mode: the server refuses every account it makes (403 sso_only).
  assert.match(members, /\{ssoOnly \? \(\s*<div className="card grad-border p-4" data-sso-accounts>/);
  assert.match(members, /\{!ssoOnly && <button onClick=\{\(\) => setResetting\(u\)\} className="btn-key">\{tr\('Reset'\)\}<\/button>\}/);
  assert.match(members, /u\.sso && provider \? provider : null/);
});

test('in SSO-only mode Members makes a profile without a password, and nothing else', () => {
  const members = code(read('app/admin/page.tsx'));
  // The server makes that one account in this mode (bff passwordlessProfile.int.test.ts) and refuses any other: drop
  // `|| ssoOnly` and the form sends a member with no password, which it refuses.
  assert.match(members, /const open = localOpen \|\| ssoOnly;/);
  assert.match(members, /password: ssoOnly \? undefined : password \|\| undefined/);
  assert.match(members, /\.\.\.\(open \? \{ localOpen: true, managedBy: managedBy \|\| undefined \} : \{\}\)/);
  const form = members.slice(members.indexOf('{ssoOnly && data && ('), members.indexOf('{!ssoOnly && data && <NewMemberDefaults'));
  assert.ok(form.includes('data-sso-profile'), 'there is no New profile in SSO-only mode');
  assert.doesNotMatch(form, /type="password"/, 'New profile in SSO-only mode asks for a password');
  assert.doesNotMatch(form, /setRole/, 'New profile in SSO-only mode offers a role');
  assert.match(form, /<HomeNetwork \/>/);
});

test('the profile manages no password and no 2FA in SSO-only mode, and links an account to the provider', () => {
  const profile = code(read('components/ProfileAccount.tsx'));
  assert.match(profile, /\{!ssoOnly\(config\) && <TwoFactorSection \/>\}/);
  assert.match(profile, /\{!ssoOnly\(config\) && <Row stacked label=\{tr\('Change password'\)\}/);
  // A link, never a request: the server takes the account from this browser's session (bff /auth/oidc/link).
  assert.match(profile, /\{!user\?\.sso && <a href="\/auth\/oidc\/link" className="btn-key" data-sso-link>/);
  const settings = code(read('components/AdminSettings.tsx'));
  assert.match(settings, /\{!desktop && !ssoOnly\(authConfig\) && \(\s*<SwitchRow id="registration" label=\{tr\('Open registration'\)\}/,
    'Open registration is offered where there is no sign-up');
});

test('the link\'s result, in words', () => {
  assert.deepEqual(linkResultText('ok', 'Authentik'), { text: 'Linked to Authentik. You can sign in with it now.', ok: true });
  assert.deepEqual(linkResultText('taken', 'Authentik'), { text: 'That Authentik account is already linked to another account here.', ok: false });
  assert.equal(linkResultText('failed', 'Authentik').ok, false);
});
