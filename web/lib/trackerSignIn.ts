// The browser half of signing in to a tracker: leave for its login page, and read what it sends back.
// The server half, and why each service goes the way it does, is bff/src/lib/trackerOauth.ts.

const KEY = 'uchiyomi.trackerSignIn';
/** A sign-in left unfinished this long ago is not one we are coming back from. */
const FRESH_MS = 30 * 60 * 1000;

export interface Pending { provider: string; state: string; verifier: string; redirectUri: string; at: number }

/** Where the service sends people back to. The page that receives it is app/tracker-callback. */
export const callbackUrl = (origin: string) => `${origin}/tracker-callback/`;

const random = (bytes: number) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function readPending(): Pending | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null') as Pending | null;
    return p && Date.now() - p.at < FRESH_MS ? p : null;
  } catch { return null; }
}
export const clearPending = () => { try { localStorage.removeItem(KEY); } catch { /* storage off: nothing to clear */ } };

/**
 * Leave for the service's login page. `state` and the PKCE `verifier` stay in this browser's localStorage (not
 * sessionStorage: a browser may start a tab's session storage afresh after a detour through another site's login
 * page, and AniList's has sent people back to "this sign-in was not started here"). MyAnimeList's `state` is still
 * checked on return; AniList's implicit flow has none, so there a recent, unfinished sign-in is the whole guard.
 * AniList's implicit flow has no PKCE; MyAnimeList's only supports `plain`, so its challenge IS the verifier.
 */
export function startSignIn(t: { provider: string; authorizeUrl?: string; clientId?: string }, origin: string) {
  const p: Pending = { provider: t.provider, state: random(24), verifier: random(48), redirectUri: callbackUrl(origin), at: Date.now() };
  localStorage.setItem(KEY, JSON.stringify(p));
  const u = new URL(t.authorizeUrl!);
  u.searchParams.set('client_id', t.clientId!);
  if (t.provider === 'myanimelist') {
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', p.state);
    u.searchParams.set('code_challenge', p.verifier);
    u.searchParams.set('code_challenge_method', 'plain');
    u.searchParams.set('redirect_uri', p.redirectUri);
  } else {
    u.searchParams.set('response_type', 'token');
  }
  window.location.assign(u.toString());
}

/** What came back on the callback URL: the query string (MyAnimeList's code) and the fragment (AniList's token). */
export function readReturn(search: string, hash: string) {
  const q = new URLSearchParams(search);
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  const get = (k: string) => h.get(k) || q.get(k) || '';
  return {
    token: h.get('access_token') || '', code: q.get('code') || '', state: q.get('state') || '',
    error: get('error'), errorText: get('error_description') || get('message'),
  };
}
