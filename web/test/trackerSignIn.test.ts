// Connecting a tracker by signing in, not by pasting a token. The pieces that run in a browser are checked
// here without one: how the sign-in link is built, what the callback reads back, and that the page and the
// row are wired to them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callbackUrl, clearPending, readPending, readReturn, startSignIn } from '../lib/trackerSignIn';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function browser() {
  const store = new Map<string, string>();
  let went = '';
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  (globalThis as any).window = { location: { assign: (u: string) => { went = u; } } };
  return () => went;
}

test('the callback address is the app\'s own, with the trailing slash the static export serves', () => {
  assert.equal(callbackUrl('http://timnode:3000'), 'http://timnode:3000/tracker-callback/');
});

test('AniList: implicit grant, nothing secret, and the sign-in is remembered for the way back', () => {
  const went = browser();
  startSignIn({ provider: 'anilist', authorizeUrl: 'https://anilist.co/api/v2/oauth/authorize', clientId: '123' }, 'http://timnode:3000');
  const u = new URL(went());
  assert.equal(u.origin + u.pathname, 'https://anilist.co/api/v2/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), '123');
  assert.equal(u.searchParams.get('response_type'), 'token');
  assert.equal(readPending()?.provider, 'anilist');
  clearPending();
  assert.equal(readPending(), null);
});

test('MyAnimeList: code flow with a plain PKCE challenge equal to the verifier kept here', () => {
  const went = browser();
  startSignIn({ provider: 'myanimelist', authorizeUrl: 'https://myanimelist.net/v1/oauth2/authorize', clientId: 'abc' }, 'http://timnode:3000');
  const u = new URL(went());
  const p = readPending()!;
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'plain');
  assert.equal(u.searchParams.get('code_challenge'), p.verifier);
  assert.equal(u.searchParams.get('state'), p.state);
  assert.equal(u.searchParams.get('redirect_uri'), 'http://timnode:3000/tracker-callback/');
  assert.ok(p.verifier.length >= 43 && p.verifier.length <= 128, 'RFC 7636 length');
  assert.match(p.verifier, /^[A-Za-z0-9_-]+$/);
});

test('a sign-in left unfinished for a long time is not one we are coming back from', () => {
  browser();
  (globalThis as any).localStorage.setItem('uchiyomi.trackerSignIn', JSON.stringify({ provider: 'anilist', state: 's', verifier: 'v', redirectUri: 'r', at: Date.now() - 31 * 60 * 1000 }));
  assert.equal(readPending(), null);
});

test('the callback reads AniList\'s fragment, MyAnimeList\'s query and either service\'s refusal', () => {
  assert.equal(readReturn('', '#access_token=tok&token_type=Bearer&expires_in=31536000').token, 'tok');
  const mal = readReturn('?code=abc&state=xyz', '');
  assert.equal(mal.code, 'abc');
  assert.equal(mal.state, 'xyz');
  const no = readReturn('?error=access_denied&error_description=The+user+said+no', '');
  assert.equal(no.error, 'access_denied');
  assert.equal(no.errorText, 'The user said no');
  assert.equal(readReturn('', '#error=access_denied').error, 'access_denied');
});

test('the callback page clears the address bar and only acts on a sign-in this tab started', () => {
  const page = read('app/tracker-callback/page.tsx');
  assert.match(page, /replaceState\(null, '', window\.location\.pathname\)/, 'the token must leave the address bar');
  assert.match(page, /readPending\(\)/);
  assert.match(page, /back\.state !== pending\.state/, 'MyAnimeList\'s state is checked');
  assert.match(page, /\/api\/trackers\/myanimelist\/oauth/);
  assert.match(page, /\/api\/trackers\/anilist\/backfill/, 'a fresh AniList connection pushes what is already finished');
  assert.match(page, /\/profile\/\?tab=Connections&card=tracking/);
});

test('the tracker row signs in, and the token field is the way out rather than the way in', () => {
  const row = read('components/ProfileConnections.tsx');
  assert.match(row, /startSignIn\(t, window\.location\.origin\)/);
  assert.match(row, /\/api\/admin\/trackers\/apps\/\$\{t\.provider\}/, 'an admin registers the application here');
  assert.match(row, /tr\('Paste an access token instead'\)/);
  assert.match(row, /tr\('Sync your reading to \{name\}'/, 'scripts/shots/capture.mjs finds the card by this text');
  assert.doesNotMatch(row, /Token-paste rather than an OAuth/, 'the comment arguing for token-paste is gone');
  assert.match(row, /user\?\.role === 'admin'/, 'setup is for admins; everyone else is told to ask one');
});
