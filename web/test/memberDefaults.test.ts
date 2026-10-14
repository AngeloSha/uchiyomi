// The new-member defaults in Admin → Members (#208, item 6): what a member who signs up, or who signs in through the
// provider for the first time, starts with. Read from source, like ssoOnly.test.ts, plus the pure helpers; the server
// side, that each default lands on both paths and on nobody else, is bff/test/memberDefaults.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

import { joinsOnTheirOwn, memberDefaultsOf } from '../lib/memberDefaults';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
/** The file with its comments removed, so a comment that names the old code does not fail the scan. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

test('the defaults in a settings answer are unset unless it says otherwise, and none is never every library', () => {
  const NOTHING = { libraries: null, maxAgeRating: null, perms: {} };
  assert.deepEqual(memberDefaultsOf(undefined), NOTHING);
  assert.deepEqual(memberDefaultsOf({}), NOTHING, 'a server older than the defaults reads as one with none set');
  assert.deepEqual(memberDefaultsOf({ newMemberDefaults: { libraries: ['lib_a'], maxAgeRating: 13, perms: { canDownload: false } } }),
    { libraries: ['lib_a'], maxAgeRating: 13, perms: { canDownload: false } });
  // [] is a choice -- no library -- and must not read as null, which is all of them. Reintroduce by testing the list
  // for length rather than for being one: a member set to see nothing reads as seeing everything.
  assert.deepEqual(memberDefaultsOf({ newMemberDefaults: { libraries: [] } }).libraries, []);
  assert.deepEqual(memberDefaultsOf({ newMemberDefaults: { maxAgeRating: 0 } }).maxAgeRating, 0, 'a limit of 0 is a limit');
  assert.deepEqual(memberDefaultsOf({ newMemberDefaults: { perms: { canDownload: true } } }).perms, {});
});

test('the card says when nobody can join on their own', () => {
  const local = { registration: false, provider: null, signup: false };
  assert.equal(joinsOnTheirOwn(local), false);
  assert.equal(joinsOnTheirOwn({ ...local, registration: true }), true, 'Open registration lets people sign up');
  assert.equal(joinsOnTheirOwn({ ...local, provider: 'Authentik', signup: true }), true, 'the provider makes accounts');
  assert.equal(joinsOnTheirOwn({ ...local, provider: 'Authentik' }), false, 'a provider that makes no accounts lets nobody join');
  assert.equal(joinsOnTheirOwn({ ...local, signup: true }), false, 'OIDC_ALLOW_SIGNUP with no provider set up makes nothing');
  // SSO-only mode has no sign-up form, whatever the stored switch says.
  assert.equal(joinsOnTheirOwn({ ...local, mode: 'oidc-only', registration: true }), false);
});

test('Members sets them with a member card\'s own chips: in a card of its own, or under SSO-only mode\'s', () => {
  const admin = code(read('app/admin/page.tsx'));
  // Local mode: a card of its own beside New account -- never inside the form, which is an admin choosing and is left
  // alone by them. Reintroduce by moving it into the form: an admin reads it as what their own New account gets.
  assert.match(admin, /\{!ssoOnly && data && <NewMemberDefaults provider=\{provider\} signup=\{!!data\.auth\?\.signup\} \/>\}/);
  assert.doesNotMatch(slice(admin, '<form onSubmit={create}', '</form>'), /NewMemberDefaults/);
  // SSO-only mode: inside the card that says where accounts come from.
  assert.match(slice(admin, 'data-sso-accounts>', ') : ('), /<NewMemberDefaults sso provider=\{provider\} signup=\{!!data\?\.auth\?\.signup\} \/>/);

  const card = slice(admin, 'function NewMemberDefaults(', '\nfunction ArtReview(');
  // Saved to the server's settings, in the shape a member's own PATCH takes, under Admin → Settings' own query.
  assert.match(card, /api\('\/api\/admin\/settings', \{ method: 'PATCH', json: \{ newMemberDefaults: patch \} \}\)/);
  assert.match(card, /queryKey: \['admin-settings'\]/);
  // The member card's two components, given the defaults' value and how to save it -- not a copy of either.
  assert.match(card, /<LibraryAccess granted=\{d\.libraries\} save=\{\(libraries\) => save\(\{ libraries \}\)\}/);
  assert.match(card, /<AgeCap cap=\{d\.maxAgeRating\} save=\{\(maxAgeRating\) => save\(\{ maxAgeRating \}\)\}/);
  assert.match(card, /save\(\{ perms: canDl \? \{ canDownload: false \} : \{\} \}\)/, 'downloads allowed is not saved as an account keeps it');
  assert.equal((admin.match(/^function (LibraryAccess|AgeCap)\(/gm) ?? []).length, 2, 'a second copy of a member card\'s chip');
  // Found by the walk: All libraries unticked before the list had loaded saved every library as none. Reintroduce by
  // dropping `|| !data`: a quick admin gives every new member nothing.
  assert.match(slice(admin, 'function LibraryAccess(', '\nfunction '), /<input type="checkbox" checked=\{!granted\} disabled=\{busy \|\| !data\}/);
  // Busy until the refetch has landed (found in review): two quick ticks both worked from the old list, and the second
  // undid the first. Reintroduce by not awaiting it: these fail.
  for (const fn of ['function LibraryAccess(', 'function AgeCap(']) {
    assert.match(slice(admin, fn, '\nfunction '), /await store\(next\);[\s\S]*?await onSaved\(\);[\s\S]*?setBusy\(false\);/, `${fn} lets a click save from the old value`);
  }
  assert.match(card, /await save\(\{ perms: [^}]+\} : \{\} \}\); toast\(tr\('Permission updated'\), 'success'\); await saved\(\);/);
  // The downloads chip is a member's, like library access and the age limit: an admin downloads whatever it says.
  assert.match(admin, /\{u\.role !== 'admin' && <button onClick=\{\(\) => patch\(u, \{ perms: \{ \.\.\.u\.perms, canDownload: !canDl \} \}/);
  // And a member's card still saves to the account.
  assert.match(admin, /<LibraryAccess granted=\{u\.libraries \?\? null\} onSaved=\{inval\}\s*save=\{\(libraries\) => api\(`\/api\/admin\/users\/\$\{u\.id\}`, \{ method: 'PATCH', json: \{ libraries \} \}\)\} \/>/);
  assert.match(admin, /<AgeCap cap=\{u\.max_age_rating \?\? null\} onSaved=\{inval\}\s*save=\{\(maxAgeRating\) => api\(`\/api\/admin\/users\/\$\{u\.id\}`, \{ method: 'PATCH', json: \{ maxAgeRating \} \}\)\} \/>/);
});
