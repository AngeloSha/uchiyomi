// OpenID Connect login (Authentik, Authelia, Keycloak, Pocket ID, Google, ...).
//
// Authorization Code flow with PKCE. Notes on the choices that aren't obvious:
//
//  * The ID token's signature IS verified, against the issuer's JWKS, using node's crypto directly. The spec
//    permits skipping it when the token comes straight from the token endpoint over TLS, but "we called them
//    directly so it must be fine" is exactly the assumption that ages badly, and doing it properly costs one
//    small function and no new dependency.
//  * Login state (PKCE verifier, nonce, CSRF state) rides in a short-lived signed cookie rather than server
//    memory, so a redeploy in the middle of someone's login doesn't strand them.
//  * OIDC is an ADDITIONAL provider. Local accounts, 2FA, lockout and session revocation are untouched: the
//    callback ends by minting exactly the same session a password login does.
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, timingSafeEqual } from 'crypto';
import { env } from '../env';

export interface OidcClaims {
  sub: string;
  issuer: string;
  username: string | null;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  groups: string[];
}

export function oidcEnabled(): boolean {
  return !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID);
}

export function oidcName(): string {
  return env.OIDC_NAME || 'SSO';
}

export function redirectUri(): string {
  return `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/auth/oidc/callback`;
}

// ---- discovery + keys -------------------------------------------------------

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

let discoveryCache: { at: number; doc: Discovery } | null = null;
const DISCOVERY_TTL = 60 * 60 * 1000;

export async function discover(): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL) return discoveryCache.doc;
  const base = env.OIDC_ISSUER.replace(/\/$/, '');
  const r = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`OIDC discovery failed (${r.status}) at ${base}`);
  const doc = (await r.json()) as Discovery;
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (!doc[k]) throw new Error(`OIDC discovery document is missing ${k}`);
  }
  discoveryCache = { at: Date.now(), doc };
  return doc;
}

interface Jwk { kid?: string; kty: string; alg?: string; use?: string; [k: string]: unknown }
let jwksCache: { at: number; keys: Jwk[] } | null = null;
const JWKS_TTL = 60 * 60 * 1000;

async function jwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL) return jwksCache.keys;
  const { jwks_uri } = await discover();
  const r = await fetch(jwks_uri, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`could not fetch JWKS (${r.status})`);
  const keys = ((await r.json()) as { keys?: Jwk[] }).keys ?? [];
  jwksCache = { at: Date.now(), keys };
  return keys;
}

const ALGS: Record<string, { name: string; dsa?: { dsaEncoding: 'ieee-p1363' } }> = {
  RS256: { name: 'RSA-SHA256' },
  RS384: { name: 'RSA-SHA384' },
  RS512: { name: 'RSA-SHA512' },
  ES256: { name: 'SHA256', dsa: { dsaEncoding: 'ieee-p1363' } },
  ES384: { name: 'SHA384', dsa: { dsaEncoding: 'ieee-p1363' } },
};

const b64u = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Verify an ID token against the issuer's published keys and the claims we care about. */
export async function verifyIdToken(idToken: string, nonce: string): Promise<OidcClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed ID token');
  const header = JSON.parse(b64u(parts[0]).toString('utf8')) as { alg?: string; kid?: string };
  const payload = JSON.parse(b64u(parts[1]).toString('utf8')) as Record<string, unknown>;

  const alg = ALGS[header.alg || ''];
  if (!alg) throw new Error(`unsupported ID token algorithm: ${header.alg}`);

  // A key can be rotated between our cached copy and this login, so a miss re-fetches once before failing.
  let keys = await jwks();
  let jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && k.kty !== 'oct');
  if (!jwk) {
    keys = await jwks(true);
    jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && k.kty !== 'oct');
  }
  if (!jwk) throw new Error('no matching signing key published by the issuer');

  const pub = createPublicKey({ key: jwk as never, format: 'jwk' });
  const ok = cryptoVerify(
    alg.name,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: pub, ...(alg.dsa ?? {}) },
    b64u(parts[2]),
  );
  if (!ok) throw new Error('ID token signature does not verify');

  const { issuer } = await discover();
  if (payload.iss !== issuer) throw new Error('ID token issuer mismatch');

  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(env.OIDC_CLIENT_ID) : aud === env.OIDC_CLIENT_ID;
  if (!audOk) throw new Error('ID token was not issued for this client');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - 60) throw new Error('ID token has expired');
  if (typeof payload.iat === 'number' && payload.iat > now + 300) throw new Error('ID token is from the future');

  // Ties this token to the login we started, so a token captured elsewhere can't be replayed into our callback.
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, nonce)) throw new Error('ID token nonce mismatch');

  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('ID token has no subject');

  const groups = Array.isArray(payload.groups) ? payload.groups.filter((g): g is string => typeof g === 'string') : [];
  return {
    sub: payload.sub,
    issuer,
    username: str(payload.preferred_username) ?? str(payload.nickname),
    displayName: str(payload.name) ?? str(payload.given_name),
    email: str(payload.email),
    emailVerified: payload.email_verified === true,
    groups,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- the flow ---------------------------------------------------------------

export interface LoginStart {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

/** Build the authorization URL plus the one-time values the callback has to check it against. */
export async function beginLogin(): Promise<LoginStart> {
  const doc = await discover();
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.OIDC_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', env.OIDC_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, nonce, verifier };
}

/** Swap the authorization code for tokens, then verify the ID token. */
export async function completeLogin(code: string, verifier: string, nonce: string): Promise<OidcClaims> {
  const doc = await discover();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: env.OIDC_CLIENT_ID,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  // Confidential clients authenticate with Basic; public clients (no secret) rely on PKCE alone.
  if (env.OIDC_CLIENT_SECRET) {
    headers.authorization =
      'Basic ' + Buffer.from(`${env.OIDC_CLIENT_ID}:${env.OIDC_CLIENT_SECRET}`).toString('base64');
  }
  const r = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${text.slice(0, 200)}`);
  const tok = JSON.parse(text) as { id_token?: string };
  if (!tok.id_token) throw new Error('the issuer returned no ID token');
  return verifyIdToken(tok.id_token, nonce);
}

/** Whether the IdP says this person should be an admin here (only when an admin group is configured). */
export function isAdminByGroup(claims: OidcClaims): boolean {
  return !!env.OIDC_ADMIN_GROUP && claims.groups.includes(env.OIDC_ADMIN_GROUP);
}
