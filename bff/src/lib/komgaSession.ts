// The session cookie behind the Komga-compatible API (routes/komgaCompat.ts).
//
// Mihon's Komga TRACKER sends no credential at all -- its only header is `User-Agent` (upstream
// mihon/app/src/main/java/eu/kanade/tachiyomi/data/track/komga/KomgaApi.kt L27-31 @424bbc53) -- and relies on
// the cookie jar the Komga EXTENSION filled while it was browsing with `X-API-Key` (AndroidCookieJar.kt L12-30:
// every OkHttp client built from the app's network helper shares one WebView CookieManager). So the compat
// hook mints a cookie on every credentialed request and honours it on the credential-less ones.
//
// ⚠️ NOT an app JWT. `app.jwt.sign({...})` would have produced a value that `authenticate()` accepts as a
// Bearer token for the whole /api/* surface and that `authorizeImageRequest` accepts as `yomi_img`: a read-only
// token holder could have turned the seven-day cookie into a full write session that survived revoking the
// token, and the WebView jar replays it to EVERY port on the host. This value is a keyed MAC under a key
// derived from JWT_SECRET with its own label, so nothing else on the server can ever verify it, and the only
// verifier (the compat hook) re-reads the api_tokens row on every use -- revoking the token kills the cookie.
//
// Value: `v1.<tokenId>.<exp seconds>.<mac>`. It names the api_tokens row, never the user or the scopes: the
// row is re-read, so a scope change, an expiry, a revocation or a disabled account all bite on the next request.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

/**
 * Not `KOMGA-SESSION`. The WebView jar is keyed by host and cookie name and ignores the port, so a real Komga
 * on the same host as this server (the migration case, and why the extension ships three factory instances)
 * would overwrite our cookie with its own session id and we would overwrite theirs -- both trackers broken,
 * silently. A name of our own lets the two coexist on one phone; the jar and both clients are name-agnostic.
 */
export const SESSION_COOKIE = 'UCHIYOMI-SESSION';

/** Komga's own inactivity window (`server.servlet.session.timeout: 7d`, komga application.yml). */
export const SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;

const VERSION = 'v1';

/**
 * Domain separation: the app JWT and this cookie must never verify under the same key. The label is part of
 * the key material, so a MAC computed here cannot be replayed to anything that uses JWT_SECRET directly, and
 * vice versa. Derived once per process; JWT_SECRET is parsed once at boot too.
 */
const key = (): string => `${env.JWT_SECRET} komga-session`;

const mac = (tokenId: string, exp: number): string =>
  createHmac('sha256', key()).update(`${VERSION}.${tokenId}.${exp}`).digest('base64url');

/** Constant-time string comparison; precedent lib/oidc.ts safeEqual. Length mismatch is an honest "no". */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Mint a cookie value for this token.
 *
 * `maxAge` is min(7 days, token expiry - now), in whole seconds, never below 1: a cookie that outlived its token
 * would be harmless only because the verifier re-reads the row, and "harmless only because" is not a property
 * to lean on. `exp` inside the value is the same instant, so an expired cookie fails before the database is
 * asked. A token with no expiry gets the full seven days, like Komga's own session.
 */
export function mintSession(tokenId: string, expiresAt: Date | null): { value: string; maxAge: number } {
  const now = Math.floor(Date.now() / 1000);
  let maxAge = SESSION_MAX_SECONDS;
  if (expiresAt) {
    const left = Math.floor(expiresAt.getTime() / 1000) - now;
    maxAge = Math.max(1, Math.min(maxAge, left));
  }
  const exp = now + maxAge;
  return { value: `${VERSION}.${tokenId}.${exp}.${mac(tokenId, exp)}`, maxAge };
}

/**
 * Verify a cookie value. Returns the token id it names, or null for anything else: a foreign cookie (a real
 * Komga's base64 session id, say), a tampered one, an expired one, or a value signed under another secret.
 *
 * ⚠️ Null means "no cookie", never "refuse". The hook falls through to X-API-Key/Basic and re-mints; a 401 on
 * a garbage cookie alone would lock a phone out the moment another server on the host wrote to the jar.
 */
export function verifySession(value: string): { tokenId: string; exp: number } | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, tokenId, expStr, given] = parts;
  // The token id is a uuid and the exp a plain integer; anything else is not ours, whatever its MAC says.
  if (!/^[0-9a-f-]{36}$/i.test(tokenId) || !/^\d{1,12}$/.test(expStr)) return null;
  const exp = Number(expStr);
  // The MAC is computed over the NUMBER, so every string that parses to the same number ("0<exp>",
  // "00<exp>"…) shared one MAC and verified: a malleable cookie, and a verifier that accepts more than one
  // encoding of a value is the kind of thing a later check (a denylist of seen values, say) trips over.
  // Exactly one encoding is ours: the canonical decimal the minter wrote.
  // Reintroduce by dropping this line: "a cookie whose expiry is spelled with a leading zero is refused" in
  // komgaCompat.int.test.ts sees 200.
  if (String(exp) !== expStr) return null;
  if (!safeEqual(given, mac(tokenId, exp))) return null;
  if (exp <= Math.floor(Date.now() / 1000)) return null;
  return { tokenId, exp };
}

/**
 * Should a credentialed request re-mint the cookie it was sent with?
 *
 * Yes when the presented cookie is for another token (the extension's key was changed to another account's
 * token: the jar still holds the OLD user's cookie, and the tracker's credential-less PUT would land on the
 * old account -- a cross-account write), or when it is past half its life (so a phone that keeps browsing
 * never watches its tracker go dark at day seven). `cookie` is what verifySession returned, or null.
 */
export function shouldRemint(cookie: { tokenId: string; exp: number } | null, tokenId: string, maxAge: number): boolean {
  if (!cookie) return true;
  if (cookie.tokenId !== tokenId) return true;
  const left = cookie.exp - Math.floor(Date.now() / 1000);
  return left < maxAge / 2;
}
