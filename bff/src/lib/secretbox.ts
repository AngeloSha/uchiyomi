// Symmetric encryption for third-party credentials we have to store and replay (tracker access tokens, and
// since v0.43.0 the notification targets' addresses and tokens).
//
// These are not password hashes — we need the original value back to call the provider's API, so hashing is
// not an option. The key is derived from JWT_SECRET, which already lives outside the database (env or the
// /config volume), so a stolen database dump alone does not yield usable tokens.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { env } from '../env';

const ALGO = 'aes-256-gcm';

/**
 * One key per PURPOSE, each derived from JWT_SECRET under its own salt.
 *
 * `tracker` is the original and its salt is frozen: every stored tracker token was sealed under it, so
 * changing the string would make each of them undecryptable at once. `notify` (v0.43.0, #70) holds the
 * notification targets' addresses and tokens -- a Home Assistant long-lived token, a Discord webhook URL --
 * under a key of its own, so the two kinds of secret never share one and the tracker salt stays true to
 * its name.
 *
 * A named purpose rather than a free salt string: `tokens.map(open)` would otherwise pass the array index
 * as the salt and fail every decrypt quietly. The type refuses that.
 */
const SALTS = { tracker: 'uchiyomi.tracker.v1', notify: 'uchiyomi.notify.v1' } as const;
export type SecretPurpose = keyof typeof SALTS;
const cached = new Map<SecretPurpose, Buffer>();

function key(purpose: SecretPurpose): Buffer {
  let k = cached.get(purpose);
  if (!k) { k = scryptSync(env.JWT_SECRET, SALTS[purpose], 32); cached.set(purpose, k); }
  return k;
}

/** Encrypt a secret for storage. Output is self-describing: v1:<iv>:<tag>:<ciphertext>, all base64url. */
export function seal(plain: string, purpose: SecretPurpose = 'tracker'): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key(purpose), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

/** Reverse of `seal`. Returns null rather than throwing — a token that can't be decrypted (rotated
 *  JWT_SECRET, corrupted row) should disconnect the tracker cleanly, not crash a reading request. */
export function open(sealed: string, purpose: SecretPurpose = 'tracker'): string | null {
  try {
    const [v, iv, tag, ct] = sealed.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = createDecipheriv(ALGO, key(purpose), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
