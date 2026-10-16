// Turning two-factor on asks for the password (v0.77.1), and the profile's password checks say their refusals in the
// reader's words. Read from source, like settingsConsole.test.ts.
//
// The server (bff routes/auth.ts /auth/totp/enable) now refuses an enable without the account's password, so the
// setup form carries a Current password field and sends it with the code. The three password checks behind a session
// (change password, 2FA on, 2FA off) also count toward the account lock and carry sign-in's address limit, so a 423 or
// a 429 can answer them: said by code, with sentences every language already has, never the server's English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- comments here quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const src = code(read('components/ProfileAccount.tsx'));
const section = src.slice(src.indexOf('function TwoFactorSection('), src.indexOf('/* ============================== Active sessions'));

test('the 2FA setup form asks for the password and sends it with the code', () => {
  assert.ok(section.length > 0, 'no TwoFactorSection');
  // Reintroduce by sending `{ code: code.trim() }` alone: the server answers 400, and 2FA can never be turned on.
  assert.match(section, /api<\{ recoveryCodes: string\[\] \}>\('\/auth\/totp\/enable', \{ json: \{ code: code\.trim\(\), password: enPw \} \}\)/,
    'the enable request does not carry the password');
  const form = section.slice(section.indexOf('{setup && !totpOn && ('), section.indexOf('{disabling && totpOn && ('));
  assert.match(form, /<input id=\{enPwId\} type="password" autoComplete="current-password" value=\{enPw\}/, 'no password field in the setup form');
  assert.match(form, /<label htmlFor=\{enPwId\} className="sr-only">\{tr\('Current password'\)\}<\/label>/, 'the password field has no label');
  assert.match(form, /disabled=\{code\.trim\(\)\.length < 6 \|\| !enPw\}/, 'the form submits without a password');
  assert.match(form, /if \(code\.trim\(\)\.length >= 6 && enPw\) void enableTotp\(\);/, 'Enter submits without a password');
  // The password goes once the form is done with, and when it is cancelled.
  assert.match(section, /setTotpEnabled\(true\); setEnPw\(''\);/, 'the password stays in state after enabling');
  assert.match(section, /const cancel = \(\) => \{[^}]*setEnPw\(''\)/, 'Cancel keeps the password');
});

test('a refused password check is said by its code, in words every language has', () => {
  const said = src.slice(src.indexOf('function refusalText('), src.indexOf('function explain('));
  assert.match(said, /body\.error === 'wrong_password' \? tr\('Wrong password'\)/);
  // Reintroduce by showing the server's own sentence for a lock: Arabic, Japanese... readers get English.
  assert.match(said, /body\.error === 'locked' \|\| status === 423 \? tr\('Account locked — too many attempts\. Try again later\.'\)/);
  assert.match(said, /status === 429 \? tr\('Too many attempts\. Wait a few minutes and try again\.'\)/);
  // All three places that check the password say it this way.
  assert.match(src, /function explain\(e: unknown, fallback: string\): never \{\s*const said = refusalText\(e\);/, 'Change password does not');
  assert.match(section, /toast\(refusalText\(e\) \|\| msgOf\(e, tr\('Incorrect code'\)\), 'error'\)/, 'turning 2FA on does not');
  assert.match(section, /toast\(refusalText\(e\) \|\| msgOf\(e, tr\('Wrong password'\)\), 'error'\)/, 'turning 2FA off does not');
  // And every sentence is one each language already has.
  const keys = ['Current password', 'Wrong password', 'Account locked — too many attempts. Try again later.',
    'Too many attempts. Wait a few minutes and try again.', 'Incorrect code'];
  for (const f of readdirSync(join(ROOT, 'public/locales')).filter((n) => n.endsWith('.json'))) {
    const d = JSON.parse(read(`public/locales/${f}`));
    for (const k of keys) assert.ok(String(d[k] ?? '').trim(), `${f} has no "${k}"`);
  }
});
