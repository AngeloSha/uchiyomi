// Local-only sessions use a separate cryptographic domain so an older release cannot turn them into remote sessions.
// A `loc` claim alone is insufficient: releases before profiles ignore it. Normal credential sessions keep their
// existing JWT key and SHA-256 refresh hash, and keep working when the app is downgraded.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../env';

export const LOCAL_REFRESH_PREFIX = 'ylrt_';

function domainKey(domain: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`uchiyomi/local-profile/${domain}/v1`).digest('hex');
}

/** An opaque refresh value; only sessions entered without a credential use the new format. */
export function newRefreshValue(local: boolean): string {
  return (local ? LOCAL_REFRESH_PREFIX : '') + randomBytes(48).toString('hex');
}

/**
 * The keyed hash is essential: merely SHA-256 hashing a public prefix plus the token lets a caller present that
 * combined string to an old release. Old code's plain SHA-256 lookup cannot resolve a keyed local-session hash.
 */
export function refreshTokenHash(token: string): string {
  return token.startsWith(LOCAL_REFRESH_PREFIX)
    ? createHmac('sha256', domainKey('refresh')).update(token).digest('hex')
    : createHash('sha256').update(token).digest('hex');
}

/** Access and image tokens from local-only sessions cannot verify under an older server's ordinary JWT key. */
export function signSessionJwt(app: FastifyInstance, payload: object, expiresIn: number, local = false): string {
  return app.jwt.sign({ ...payload, ...(local ? { loc: true } : {}) }, {
    expiresIn, ...(local ? { key: domainKey('jwt') } : {}),
  });
}

/** Fallback only after the ordinary verifier refused. A local key can never mint an unrestricted session. */
export function verifyLocalSessionJwt<T extends { loc?: unknown }>(app: FastifyInstance, token: string): T {
  const payload = app.jwt.verify<T>(token, { key: domainKey('jwt') });
  if (payload.loc !== true) throw new Error('local session claim required');
  return payload;
}
