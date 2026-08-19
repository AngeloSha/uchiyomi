// Symmetric encryption for third-party credentials we have to store and replay (tracker access tokens).
//
// These are not password hashes — we need the original value back to call the provider's API, so hashing is
// not an option. The key is derived from JWT_SECRET, which already lives outside the database (env or the
// /config volume), so a stolen database dump alone does not yield usable tokens.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { env } from '../env';

const ALGO = 'aes-256-gcm';
let cached: Buffer | null = null;

function key(): Buffer {
  if (!cached) cached = scryptSync(env.JWT_SECRET, 'uchiyomi.tracker.v1', 32);
  return cached;
}

/** Encrypt a secret for storage. Output is self-describing: v1:<iv>:<tag>:<ciphertext>, all base64url. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

/** Reverse of `seal`. Returns null rather than throwing — a token that can't be decrypted (rotated
 *  JWT_SECRET, corrupted row) should disconnect the tracker cleanly, not crash a reading request. */
export function open(sealed: string): string | null {
  try {
    const [v, iv, tag, ct] = sealed.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = createDecipheriv(ALGO, key(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
