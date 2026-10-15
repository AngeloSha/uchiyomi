// Sign-in for the trackers, in place of pasting a token.
//
// An admin registers one OAuth application per service (AniList, MyAnimeList) and puts its client id here, in
// the app, once; after that everyone connects with a button and a redirect back to Uchiyomi. Kitsu has no
// application to register, and signs in as before: a token pasted under Profile → Connections.
//
//   AniList      implicit grant. The browser goes to the authorize URL; AniList sends it back to the
//                registered redirect URL with `#access_token=` in the fragment, which only the browser sees.
//                The callback page hands the token to POST /api/trackers/anilist/connect. No secret anywhere.
//   MyAnimeList  authorization code with PKCE (plain). The callback page posts the code and its verifier to
//                POST /api/trackers/myanimelist/oauth; the server swaps them for a token.
import { q, one } from './db';
import { seal, open as unseal } from './secretbox';
import type { Provider } from './trackerProviders';

/** `token` is a service with nothing to register: its row takes a pasted token, as every row did before. */
export type ConnectMethod = 'oauth-implicit' | 'oauth-code' | 'token';
export const METHOD: Partial<Record<Provider, ConnectMethod>> = { anilist: 'oauth-implicit', myanimelist: 'oauth-code' };

const AUTHORIZE: Partial<Record<Provider, string>> = {
  anilist: 'https://anilist.co/api/v2/oauth/authorize',
  myanimelist: 'https://myanimelist.net/v1/oauth2/authorize',
};
const MAL_TOKEN = () => process.env.MYANIMELIST_OAUTH_URL || 'https://myanimelist.net/v1/oauth2/token';
const ENV_ID: Partial<Record<Provider, string>> = { anilist: 'ANILIST_CLIENT_ID', myanimelist: 'MYANIMELIST_CLIENT_ID' };
const ENV_SECRET: Partial<Record<Provider, string>> = { myanimelist: 'MYANIMELIST_CLIENT_SECRET' };

export interface OauthApp { clientId: string; clientSecret: string | null; source: 'settings' | 'env' }

/** The registered application: the admin's saved one first, then the environment's. */
export async function getApp(provider: Provider): Promise<OauthApp | null> {
  if (!AUTHORIZE[provider]) return null;
  const r = await one<{ client_id: string; client_secret: string | null }>(
    'SELECT client_id, client_secret FROM tracker_oauth_apps WHERE provider = $1', [provider]);
  if (r) return { clientId: r.client_id, clientSecret: r.client_secret ? unseal(r.client_secret) : null, source: 'settings' };
  const id = ENV_ID[provider] && process.env[ENV_ID[provider]!];
  if (id) return { clientId: id.trim(), clientSecret: (ENV_SECRET[provider] && process.env[ENV_SECRET[provider]!]) || null, source: 'env' };
  return null;
}

export async function saveApp(provider: Provider, clientId: string, clientSecret: string | null): Promise<void> {
  await q(
    `INSERT INTO tracker_oauth_apps (provider, client_id, client_secret) VALUES ($1,$2,$3)
     ON CONFLICT (provider) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret, updated_at = now()`,
    [provider, clientId, clientSecret ? seal(clientSecret) : null]);
}

export async function clearApp(provider: Provider): Promise<void> {
  await q('DELETE FROM tracker_oauth_apps WHERE provider = $1', [provider]);
}

/** What a person's browser needs to start a sign-in. The client id is public by design. */
export interface ConnectInfo {
  method: ConnectMethod;
  /** false until an admin registers the app (always true for a service with none to register). */
  configured: boolean;
  authorizeUrl?: string;
  clientId?: string;
}

export async function connectInfo(provider: Provider): Promise<ConnectInfo> {
  const method = METHOD[provider] ?? 'token';
  if (method === 'token') return { method, configured: true };
  const app = await getApp(provider);
  return app ? { method, configured: true, authorizeUrl: AUTHORIZE[provider], clientId: app.clientId } : { method, configured: false };
}

export interface TokenGrant { token: string; expiresInSec: number | null }

async function tokenCall(url: string, init: RequestInit, label: string): Promise<TokenGrant> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) {
    const why = j?.error_description || j?.hint || j?.message || j?.error;
    throw Object.assign(new Error(why ? `${label}: ${why}` : `${label} did not give a token (${r.status})`), { rejected: r.status === 400 || r.status === 401 });
  }
  return { token: String(j.access_token), expiresInSec: Number.isFinite(Number(j.expires_in)) ? Number(j.expires_in) : null };
}

export async function exchangeMalCode(code: string, verifier: string, redirectUri: string): Promise<TokenGrant> {
  const app = await getApp('myanimelist');
  if (!app) throw Object.assign(new Error('MyAnimeList sign-in is not set up'), { rejected: true });
  const body = new URLSearchParams({ client_id: app.clientId, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
  if (app.clientSecret) body.set('client_secret', app.clientSecret);
  return tokenCall(MAL_TOKEN(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, 'MyAnimeList');
}
