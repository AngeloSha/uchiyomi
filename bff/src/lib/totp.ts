// Minimal RFC-6238 TOTP (SHA1, 6 digits, 30s) + recovery codes — no external dependency for the algorithm.
import { createHmac, randomBytes, createHash } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = (): string => base32Encode(randomBytes(20));

function hotp(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = ((h[offset] & 0x7f) << 24) | ((h[offset + 1] & 0xff) << 16) | ((h[offset + 2] & 0xff) << 8) | (h[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

/**
 * The 30 s step a 6-digit code was made for, within ±`window` steps of `now` for clock drift; null when it is none of
 * them. The latest matching step, so a code that happens to match two steps is spent for both.
 *
 * A step, not a yes or no (v0.77.1): a code is good once, and the caller records the step it took in the same statement
 * that checks it is later than the last one (lib/auth.ts spendTotpStep, RFC 6238 section 5.2). There is no
 * boolean check beside this on purpose, so no route can accept a code without spending it.
 */
export function totpStep(secret: string, token: string, window = 1, now = Date.now()): number | null {
  const t = (token || '').trim();
  if (!/^\d{6}$/.test(t)) return null;
  const step = Math.floor(now / 1000 / 30);
  for (let w = window; w >= -window; w--) if (hotp(secret, step + w) === t) return step + w;
  return null;
}

export const otpauthURL = (secret: string, account: string, issuer = 'Uchiyomi'): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * One-time recovery codes (returned plaintext once; only their hashes are stored).
 *
 * 10 bytes, not 5. These are stored as UNSALTED SHA-256 (routes/auth.ts, alongside the other high-entropy
 * bearer tokens) and each one bypasses 2FA on its own, so their entropy is the whole defence if the users
 * table ever leaks. At the old 5 bytes that was 40 bits -- a few GPU-hours offline. 80 bits is not.
 */
export function generateRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => randomBytes(10).toString('hex').replace(/(.{5})(.{5})(.{5})(.{5})/, '$1-$2-$3-$4'));
}

/**
 * A typed recovery code in the form its hash was taken of, or null when it cannot be one. Case, spaces and dashes
 * are forgiven, so a code read aloud or pasted without its dashes still works. Two shapes: today's 20 hex digits
 * (xxxxx-xxxxx-xxxxx-xxxxx, generateRecoveryCodes) and the 10 of codes made before the move to 10 bytes (xxxx-xxxxxx),
 * which accounts may still hold. Sign-in tested only the old shape, so no code made since v0.21.0 was ever accepted.
 */
export function recoveryCodeForm(typed: string): string | null {
  const hex = (typed || '').toLowerCase().replace(/[\s-]/g, '');
  if (/^[0-9a-f]{20}$/.test(hex)) return hex.replace(/(.{5})(.{5})(.{5})(.{5})/, '$1-$2-$3-$4');
  if (/^[0-9a-f]{10}$/.test(hex)) return hex.replace(/(.{4})(.{6})/, '$1-$2');
  return null;
}
