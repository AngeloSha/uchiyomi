import { z } from 'zod';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

// One-click install: if JWT_SECRET isn't provided, generate one once and persist it under CONFIG_DIR so sessions
// survive restarts. Lets the app boot with zero secrets configured (a set JWT_SECRET always wins).
function ensureJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const dir = process.env.CONFIG_DIR || '/config';
  const file = `${dir}/jwt.secret`;
  try {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    mkdirSync(dir, { recursive: true });
    const secret = randomBytes(48).toString('base64url');
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[env] could not persist a JWT secret; using an ephemeral one (set JWT_SECRET or mount /config)');
    return randomBytes(48).toString('base64url');
  }
}
process.env.JWT_SECRET = ensureJwtSecret();

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  KOMGA_BASE_URL: z.string().url().default('http://komga:25600'),
  KOMGA_API_KEY: z.string().default(''), // only needed when LIBRARY_BACKEND=komga; owned mode ignores it
  JWT_SECRET: z.string().min(16),
  // Optional: legacy pre-seed of the admin (base64 argon2 hash). If unset, the first-run web setup creates the
  // admin instead. argon2 hashes contain '$' which breaks compose ${} interpolation -> carried base64-encoded.
  INITIAL_USER_PASSWORD_HASH_B64: z.string().optional(),
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:3000'),
  CACHE_DIR: z.string().default('/cache'),
  CONFIG_DIR: z.string().default('/config'),
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:admin@koryomi.app'),
  CACHE_MAX_BYTES: z.coerce.number().default(16 * 1024 * 1024 * 1024),
  ACCESS_TTL_SECONDS: z.coerce.number().default(60 * 15),
  REFRESH_TTL_DAYS: z.coerce.number().default(60),
});

type RawEnv = z.infer<typeof schema>;
export type Env = RawEnv & { initialUserPasswordHash: string };

export const env: Env = (() => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const initialUserPasswordHash = parsed.data.INITIAL_USER_PASSWORD_HASH_B64
    ? Buffer.from(parsed.data.INITIAL_USER_PASSWORD_HASH_B64, 'base64').toString('utf8')
    : '';
  return { ...parsed.data, initialUserPasswordHash };
})();
