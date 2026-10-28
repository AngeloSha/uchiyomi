// Switching profile on a device: lib/auth.tsx switchProfile and the
// cross-tab guard, the switcher, Members and Profile -> Account. A switch is a change of person on a device that
// keeps its cookies, caches and other tabs, so what must not drift is the ORDER things happen in. The refresh answer
// is driven against the real client with a stubbed fetch, as desktopSession.test.ts does; the rest is source-grep.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

process.env.NEXT_PUBLIC_API_BASE = '';
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
let answer: Response = new Response('{}', { status: 404 });
globalThis.fetch = (async () => answer.clone()) as any;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let api: typeof import('../lib/api');
before(async () => { api = await import('../lib/api'); });

test('a refresh refused because the profile opens at home only says so; every other refusal is as bare as ever', async () => {
  // The sign-in screen tells "this profile opens from home only" from a sign-out by this code (LoginScreen.tsx).
  answer = json(401, { error: 'local_only' });
  assert.deepEqual(await api.refreshSession(), { kind: 'rejected', reason: 'local_only' });
  answer = json(401, { error: 'invalid_refresh' });
  assert.deepEqual(await api.refreshSession(), { kind: 'rejected' });
  answer = json(403, { error: 'disabled' });
  assert.deepEqual(await api.refreshSession(), { kind: 'rejected' });
});

test('a switch sends queued reading first, clears the caches only once the server said yes, and puts the 18+ reveal away', () => {
  const auth = code(read('lib/auth.tsx'));
  const body = auth.slice(auth.indexOf('const changeProfile = async'), auth.indexOf('const switchProfile ='));
  assert.ok(body.length > 0, 'there is no changeProfile');
  const at = (s: string) => { const i = body.indexOf(s); assert.ok(i >= 0, `changeProfile does not ${s}`); return i; };
  // Each step after the one before it. Reintroduce the purge ahead of the request: a refused switch blanks the screen.
  const order = ['await flushOutbox()', 'api(path,', 'await forgetAccountData()', 'setAdultShown(false)',
    'setAccessToken(res.accessToken)', 'adoptAuthed(res.user', "postMessage({ type: 'switched'"].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'switchProfile does its steps out of order');
  assert.match(body, /error: body\.error === 'local_only' \?/, 'a refusal from outside is not said as such');
  assert.match(body, /: body\.error === 'reauth' \?/, 'an admin remembered too long is not told to sign in again');
  // Both ways of changing person take the same steps.
  assert.match(auth, /const switchProfile = \(profileId: string\) => changeProfile\('\/auth\/switch', profileId\);/);
  assert.match(auth, /const resumeProfile = \(profileId: string\) => changeProfile\('\/auth\/resume', profileId\);/);
  assert.match(auth, /const pickProfile = \(profileId: string\) => changeProfile\('\/auth\/profile-login', profileId\);/);
  assert.match(auth, /switchProfile, resumeProfile, pickProfile, leave, backToOwner, signedOutWhy, desktop: isDesktop\(\), reconnect \}\}>/);
});

test('a profile switched in another tab starts this one over', () => {
  const auth = code(read('lib/auth.tsx'));
  // The cookie is the browser's: the next refresh in this tab answers as the new profile. Compared against what this tab
  // shows (a ref adoptAuthed keeps), never getCurrentUser(), which refreshSession has already moved on.
  assert.match(auth, /const before = shownUser\.current;\s*const r = await refreshSession\(\);/);
  assert.match(auth, /if \(r\.kind === 'authed' && before && r\.user\.id !== before\) \{\s*await forgetAccountData\(\);\s*window\.location\.reload\(\);/);
  assert.match(auth, /setCurrentUser\(u\.id\);\s*shownUser\.current = u\.id;/, 'adoptAuthed does not record who the tab shows');
  assert.match(auth, /setCurrentUser\(null\);\s*shownUser\.current = null;/);
  // And at once, not at the next refresh, when the other tab says so.
  assert.match(auth, /new BroadcastChannel\('yomi-auth'\)/);
  assert.match(auth, /e\.data\?\.type === 'switched' && e\.data\.userId !== shownUser\.current\) window\.location\.reload\(\)/);
  assert.match(auth, /channel\.current\?\.close\(\);/);
});

test('the sign-in screen says why a profile that opens at home was signed out', () => {
  const auth = code(read('lib/auth.tsx'));
  assert.equal((auth.match(/setSignedOutWhy\(r\.reason \?\? null\); await clearLocalSession\(\);/g) ?? []).length, 2, 'boot and revalidate both keep the reason');
  const login = code(read('components/LoginScreen.tsx'));
  assert.match(login, /if \(signedOutWhy === 'local_only'\) setErrMsg\(tr\('This profile opens from home only\./);
});

test('the switcher: from the profile photo, outside the popover it would close', () => {
  const menu = code(read('components/ProfileMenu.tsx'));
  assert.match(menu, /\{onSwitch && <button type="button" onClick=\{onSwitch\}/);
  assert.match(menu, /onSwitch=\{\(\) => \{ close\(false\); setSwitching\(true\); \}\}/);
  assert.match(menu, /\{switching && <ProfileSwitcher onClose=\{\(\) => setSwitching\(false\)\} \/>\}/);
  assert.match(menu, /if \(switching\) return <ProfileSwitcher onClose=\{onClose\} \/>;/, 'the phone\'s sheet has no switcher');
  const sw = code(read('components/ProfileSwitcher.tsx'));
  assert.match(sw, /api<\{ zone: 'local' \| 'remote'; content: Switchable\[\] \}>\('\/auth\/profiles'\)/);
  assert.match(sw, /const r = how === 'switch' \? await switchProfile\(id\) : await resumeProfile\(id\);/);
  assert.match(sw, /api<\{ content: Switchable\[\] \}>\('\/auth\/ring'\)/, 'the accounts this device remembers are not offered');
  assert.match(sw, /p\.id !== user\?\.id && !managed\.some\(\(m\) => m\.id === p\.id\)/);
  assert.match(sw, /\{data\?\.zone === 'remote' && <p/, 'outside, the empty list is not explained');
  assert.match(sw, /onClick=\{\(\) => \{ onClose\(\); void leave\(\); \}\}/, 'another account forgets this one even when the device remembers it');
  assert.doesNotMatch(sw, /\b(?:left|right)-\d|\bm[lr]-\d|\bp[lr]-\d|text-(?:left|right)/, 'physical-direction classes break rtl');
});

test('Members makes and converts profiles that open at home, never an admin, and shows how the server sees you', () => {
  const page = code(read('app/admin/page.tsx'));
  assert.match(page, /role: open \? 'user' : role, \.\.\.\(open \? \{ localOpen: true, managedBy: managedBy \|\| undefined \} : \{\}\)/);
  assert.match(page, /\{localOpen \? \(\s*<>\s*<select value=\{managedBy\}/, 'no choice of who manages it');
  assert.match(page, /<HomeNetwork \/>/);
  assert.match(page, /function HomeNetwork\(\) \{\s*const \{ data \} = useNetwork\(\);/);
  // The line and the settings page say it in one sentence, from one answer (components/NetworkSettings.tsx).
  const network = code(read('components/NetworkSettings.tsx'));
  assert.match(network, /queryFn: \(\) => api<NetworkState>\('\/api\/admin\/network'\)/);
  assert.match(page, /\{!u\.local_open && <button onClick=\{\(\) => patch\(u, \{ role:/, 'Make admin is offered on a profile that opens at home');
  assert.match(page, /u\.local_open && u\.password_login && !ssoOnly && <button onClick=\{\(\) => patch\(u, \{ removePassword: true \}/);
  assert.match(page, /canManageProfiles: !u\.perms\?\.canManageProfiles/);
  // The managers offered are the accounts the server accepts as one (bff routes/admin.ts mayManage).
  assert.match(page, /m\.kind === 'password' \|\| m\.kind === 'hybrid'/);
});

test('Profile -> Account lists a member\'s own profiles only when an admin let it make them', () => {
  const account = code(read('components/ProfileAccount.tsx'));
  assert.match(account, /\{\(user\?\.perms\?\.canManageProfiles \|\| \(desktop && user\?\.kind === 'desktop-owner'\)\) && <ProfilesSection \/>\}/);
  assert.match(account, /api<\{ content: ManagedProfile\[\] \}>\('\/api\/profiles'\)/);
  assert.match(account, /api\(`\/api\/profiles\/\$\{p\.id\}`, \{ method: 'DELETE' \}\)/);
  assert.match(account, /<ConfirmDialog[\s\S]*?onConfirm=\{\(\) => remove\(removing\)\}/, 'a profile is deleted without asking');
});

test('the sign-in screen remembers on request, and offers who this device remembers', () => {
  const auth = code(read('lib/auth.tsx'));
  assert.match(auth, /\.\.\.\(remember \? \{ remember: true \} : \{\}\)/, 'Remember on this device is not sent');
  assert.match(auth, /const leave = async \(\) => \{\s*try \{ await api\('\/auth\/leave', \{ method: 'POST' \}\); \} catch \{\}\s*await clearLocalSession\(\);/);
  const login = code(read('components/LoginScreen.tsx'));
  assert.match(login, /const r = await login\(username\.trim\(\) \|\| 'admin', pw, needTotp \? code\.trim\(\) : undefined, remember\);/);
  assert.match(login, /<input type="checkbox" checked=\{remember\}/);
  assert.match(login, /api<\{ content: typeof ring \}>\('\/auth\/ring'\)/);
  assert.match(login, /return list\.length > 0 && !needTotp && \(/);
  assert.match(login, /const r = how === 'ring' \? await resumeProfile\(id\) : await pickProfile\(id\);/);
  // "Who is reading?": what the server offers at home, less who the device already remembers.
  assert.match(login, /api<\{ content: typeof ring \}>\('\/auth\/pick'\)/);
  assert.match(login, /readers\.filter\(\(p\) => !ring\.some\(\(r\) => r\.id === p\.id\)\)/);
  const settings = code(read('components/AdminSettings.tsx'));
  assert.match(settings, /\{!desktop && \(\s*<SwitchRow id="local-pick"[\s\S]*?save\(\{ localPick: next \}\)/);
});

test('Uchiyomi Desktop: profiles made in Profile -> Account, and back to the owner through the shell', () => {
  const sw = code(read('components/ProfileSwitcher.tsx'));
  // No sign-in screen on desktop: from a profile, back to the owner instead of another account.
  assert.match(sw, /\{desktop \? \(\s*user\?\.kind !== 'desktop-owner' && \(/);
  assert.match(sw, /await backToOwner\(\)/);
  const auth = code(read('lib/auth.tsx'));
  const back = auth.slice(auth.indexOf('const backToOwner = async'), auth.indexOf('const leave = async'));
  const order = ['await flushOutbox()', "fetch('/auth/desktop'", 'await forgetAccountData()', 'setAdultShown(false)', 'window.location.reload()']
    .map((s) => { const i = back.indexOf(s); assert.ok(i >= 0, `backToOwner does not ${s}`); return i; });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'backToOwner does its steps out of order');
  const account = code(read('components/ProfileAccount.tsx'));
  assert.match(account, /\(user\?\.perms\?\.canManageProfiles \|\| \(desktop && user\?\.kind === 'desktop-owner'\)\) && <ProfilesSection \/>/);
});
