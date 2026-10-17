import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

// One dummy hash with the same parameters used when the app creates passwords. Never hash per refusal:
// both an unknown name and an unusable account must perform a verification, without doubling normal work.
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hash(randomBytes(32).toString('base64url')));

export async function verifyLoginPassword(stored: string | null, password: string): Promise<boolean> {
  const fallback = await dummyHash();
  try {
    const ok = await verify(stored || fallback, password);
    return !!stored && ok;
  } catch {
    // A malformed/legacy unusable hash is still not a fast username oracle.
    if (stored) await verify(fallback, password);
    return false;
  }
}
