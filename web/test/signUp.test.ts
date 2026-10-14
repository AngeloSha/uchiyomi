// Signing up on the sign-in screen (v0.61.0), read from source.
//
// Admin → Settings → Open registration existed, and POST /auth/register answered behind it, but the sign-in screen had
// no form: turning it on did nothing anyone could see. The screen now has a `register` mode, reached only from signing
// in, only while /auth/config says `allowRegistration`, never mid-way through a second step and never on desktop; its
// form is first-run setup's own (one AccountForm), and lib/auth.tsx register() signs in as login() does and words each
// refusal by its code. The server side is bff/test/register.int.test.ts. Every guard names the edit that breaks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

const login = code(read('components/LoginScreen.tsx'));

test('the sign-in form offers Create an account only while registration is open', () => {
  // Reintroduce the form-less screen by dropping the link, or show it whatever /auth/config says (drop `canRegister &&`):
  // this fails. `!needTotp`: a person half-way through their second step is signing in, not up.
  assert.match(login, /useState<'checking' \| 'login' \| 'setup' \| 'desktop' \| 'register' \| 'sso'>\('checking'\)/, 'there is no register mode');
  assert.match(login, /^\s*setCanRegister\(c\.allowRegistration === true\);$/m, '/auth/config\'s allowRegistration is not read on a line of its own');
  // The desktop arm is untouched (web/test/desktopSurfaces.test.ts holds its exact line): a browser tab on the desktop
  // port gets the "open the app" sentence and no form at all, so no link either.
  assert.match(login, /if \(c\.desktop === true\) \{ noteServerDesktop\(true\); setMode\('desktop'\); \}/);
  const signIn = slice(login, "{mode === 'login' && (", '</form>');
  assert.match(signIn, /\{canRegister && !needTotp && \(\s*<button type="button" onClick=\{\(\) => toMode\('register'\)\}/,
    'the link is not gated on Open registration and on not being mid-way through a second step');
  assert.match(signIn, /\{tr\('Create an account'\)\}/);
  assert.equal(login.split("tr('Create an account')").length - 1, 1, 'Create an account is offered somewhere other than under the sign-in form');
  // Reached only from signing in: first-run setup always wins, and nothing else sets the mode to register.
  assert.equal(login.match(/toMode\('register'\)/g)?.length, 1);
  assert.doesNotMatch(login, /setMode\('register'\)/, 'something other than the sign-in form\'s link opens the sign-up form');
});

test('signing up is first-run setup\'s form, with its own words, and the same checks', () => {
  // Reintroduce a second copy of the form, or let setup's words drift: this fails.
  const setup = slice(login, "{mode === 'setup' && (", "{mode === 'register' && (");
  assert.match(setup, /<AccountForm onSubmit=\{submitSetup\} nameLabel=\{tr\('Admin username'\)\} namePlaceholder=\{tr\('admin'\)\}/);
  assert.match(setup, /submitLabel=\{tr\('Create admin account & open Uchiyomi'\)\}/);
  assert.match(setup, /<p className="mt-3 text-center text-xs text-fog-500">\{tr\('This first account becomes the server admin\.'\)\}<\/p>/);
  const signUp = slice(login, "{mode === 'register' && (", "{mode === 'login' && (");
  assert.match(signUp, /<AccountForm onSubmit=\{submitRegister\} nameLabel=\{tr\('Username'\)\} submitLabel=\{tr\('Create account'\)\}/);
  assert.match(signUp, /onClick=\{\(\) => toMode\('login'\)\}[^>]*>\s*\{tr\('Already have an account\? Sign in'\)\}/, 'there is no way back to signing in');
  // One form, setup's classes as they were.
  const form = login.slice(login.indexOf('function AccountForm('));
  assert.match(form, /<form onSubmit=\{onSubmit\} className="glass grad-border rounded-3xl p-5 shadow-lift">/);
  assert.match(form, /<button type="submit" disabled=\{busy\} className="btn-accent mt-4 w-full disabled:opacity-50">\s*\{busy \? tr\('Creating…'\) : submitLabel\}/);
  assert.match(form, /autoComplete="username"/);
  assert.equal(form.match(/autoComplete="new-password"/g)?.length, 2, 'a password manager is not told both fields are a new password');
  assert.equal(login.match(/<form /g)?.length, 2, 'a third form: the sign-in form and AccountForm are the only two');
  // The same checks before anything is sent.
  for (const fn of ['submitSetup', 'submitRegister']) {
    const body = slice(login, `const ${fn} = async`, '};');
    assert.match(body, /const problem = accountProblem\(\);\s*if \(problem\) \{ setErrMsg\(problem\); return; \}/, `${fn} does not run setup's checks`);
  }
});

test('a sign-up refusal is said by its code first, and a closed server sends the screen back to signing in', () => {
  // Reintroduce `body.message ||` ahead of the codes (the server's sentences are English): this fails. Registration
  // switched off while the form was open: the screen goes back to signing in and drops the link.
  const auth = code(read('lib/auth.tsx'));
  const register = slice(auth, 'const register = async', 'const logout');
  assert.match(register, /api<[^>]*>\('\/auth\/register', \{\s*json: \{ username, password, deviceId: deviceId\(\), deviceName: deviceName\(\) \},/,
    'the device does not name itself at sign-up');
  assert.match(register, /await purgeAccountCaches\(\);\s*setAccessToken\(res\.accessToken\);\s*adoptAuthed\(res\.user, res\.refreshExpiresAt\);/,
    'a sign-up does not adopt the session as a sign-in does');
  assert.match(register, /if \(body\.error === 'registration_disabled'\) \{\s*return \{ ok: false, closed: true, error: tr\('Sign-up is turned off on this server\. Ask whoever runs it for an account\.'\) \};/);
  assert.match(register, /const error = body\.error === 'username_taken' \|\| status === 409 \? tr\('That username is taken\.'\)/, 'a taken name is not said by its code first');
  assert.match(register, /: body\.error === 'weak_password' \? tr\('Password must be at least 8 characters\.'\)/);
  assert.match(register, /: body\.error === 'bad_request' \? tr\('Username: letters, numbers, \. _ - \(2–64 characters\)\.'\)/);
  assert.match(register, /: status === 429 \? tr\('Too many attempts\. Wait a few minutes and try again\.'\)/, 'the limiter\'s 429 carries no code of ours');
  assert.match(register, /: body\.message \|\| tr\('Could not create account'\);/, 'the server\'s sentence is not the last resort');
  assert.match(auth, /login, firstRunSetup, register, logout,/, 'the provider does not hand out register');
  assert.match(login, /if \(r\.closed\) \{ setCanRegister\(false\); toMode\('login'\); \}/, 'a closed server leaves the sign-up form up');
});
