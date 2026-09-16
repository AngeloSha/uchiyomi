// Authentication for the Komga-compatibility layer (bff/src/routes/komgaCompat.ts).
//
// The Mihon Komga extension sends either:
//   X-API-Key: <credential>
// or
//   Authorization: Basic base64(username:credential)
//
// In both cases the credential is an Uchiyomi personal API token (uy_...).
// username:password is also accepted so users who prefer not to generate a token can just
// paste their Uchiyomi login. API token is strongly preferred: it is revocable, scopeable,
// never tied to the account password, and visible in Profile → Account → Tokens.
//
// No rate-limiting or failed-attempt counting here. The token path is a SHA-256 lookup (fast);
// the password path is an argon2 verify (slow by design, inherently rate-limited).
import { verify } from '@node-rs/argon2';
import type { FastifyRequest } from 'fastify';
import { one } from './db';
import { resolveApiToken } from './auth';
import { viewCtxFor, type ViewCtx } from './visibility';

export interface KomgaCompatUser {
  userId: string;
  role: string;
  /** The visibility context for this user. Passed to every DB query that gates series/book access. */
  ctx: ViewCtx;
}

/**
 * Resolve the Komga-compat user from whichever auth mechanism the extension sent.
 * Returns null when the credential is absent, invalid or the account is locked.
 *
 * `hideAdult: false` is deliberate: the adult-library toggle is an Uchiyomi UI preference, not a
 * permission. Mihon has its own content filtering, and the age CAP on the user's account is still
 * enforced by `visible()` inside every query, regardless of this flag.
 */
export async function resolveKomgaUser(req: FastifyRequest): Promise<KomgaCompatUser | null> {
  // ── X-API-Key header ────────────────────────────────────────────────────────
  const rawKey = (req.headers as Record<string, string | undefined>)['x-api-key'];
  if (rawKey?.trim()) {
    const tok = await resolveApiToken(rawKey.trim()).catch(() => null);
    if (tok) return build(tok.userId, tok.role);
  }

  // ── Authorization: Basic ────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (authHeader && /^basic /i.test(authHeader)) {
    let decoded = '';
    try { decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8'); } catch { return null; }
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);

    // The Komga extension lets users enter either "API key" or "Username + Password".
    // When an API key is set, it is sent as X-API-Key (handled above). When the user
    // used Basic auth, the password field may still carry an API token if they pasted one.
    if (password.startsWith('uy_')) {
      const tok = await resolveApiToken(password.trim()).catch(() => null);
      if (tok) return build(tok.userId, tok.role);
    }

    // Real username + password.
    if (username && password) return byPassword(username, password);
  }

  return null;
}

// ---- private helpers -------------------------------------------------------

async function build(userId: string, role: string): Promise<KomgaCompatUser> {
  const ctx = await viewCtxFor(userId, role, { hideAdult: false });
  return { userId, role, ctx };
}

async function byPassword(username: string, password: string): Promise<KomgaCompatUser | null> {
  // `password_hash IS NOT NULL` skips OIDC-only accounts that have no local credential.
  const row = await one<{ id: string; password_hash: string; role: string; disabled: boolean }>(
    `SELECT id, password_hash, role, disabled
       FROM users
      WHERE username = $1 AND password_hash IS NOT NULL
        AND (locked_until IS NULL OR locked_until < now())`,
    [username],
  ).catch(() => null);
  if (!row || row.disabled) return null;
  const ok = await verify(row.password_hash, password).catch(() => false);
  if (!ok) return null;
  return build(row.id, row.role);
}
