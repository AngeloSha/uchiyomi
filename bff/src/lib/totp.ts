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

/** Verify a 6-digit code against the secret, allowing ±`window` 30s steps for clock drift. */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const t = (token || '').trim();
  if (!/^\d{6}$/.test(t)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) if (hotp(secret, step + w) === t) return true;
  return false;
}

export const otpauthURL = (secret: string, account: string, issuer = 'Uchiyomi'): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** One-time recovery codes (returned plaintext once; only their hashes are stored). */
export function generateRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => randomBytes(5).toString('hex').replace(/(.{4})(.{6})/, '$1-$2'));
}
