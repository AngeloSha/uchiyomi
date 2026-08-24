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

// z.coerce.boolean() is a trap for env vars: it is just Boolean(value), so the STRING "false" comes out true
// and a flag can only ever be turned off by leaving it unset. Read the actual word instead.
const envFlag = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : /^(1|true|yes|on)$/i.test(v.trim())));

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
  // Optional OIDC / SSO. Everything stays off unless an issuer and client id are set, so an install that
  // doesn't want it is unaffected. There is no refresh handling on purpose: we mint our own session at the
  // end of the flow and the IdP is only consulted at login.
  OIDC_ISSUER: z.string().default(''),
  OIDC_CLIENT_ID: z.string().default(''),
  OIDC_CLIENT_SECRET: z.string().default(''),
  OIDC_NAME: z.string().default('SSO'),
  OIDC_SCOPES: z.string().default('openid profile email'),
  // Create an account the first time an unknown person signs in through the IdP.
  OIDC_ALLOW_SIGNUP: envFlag(false),
  // Adopt an existing local account whose username matches the one the IdP reports. Off by default: turning
  // it on means trusting your IdP to be authoritative over usernames, which is true when you run it yourself.
  OIDC_LINK_BY_USERNAME: envFlag(false),
  // Users in this IdP group become admins here (leave empty to keep roles managed locally).
  OIDC_ADMIN_GROUP: z.string().default(''),
  // Optional Suwayomi server used purely as an extension engine: it runs Mihon/Tachiyomi's Kotlin extensions
  // on the JVM and exposes them over GraphQL. Empty issuer = feature off, exactly like OIDC. Uchiyomi keeps
  // owning the library, reader, downloads and updates; Suwayomi only answers search/chapters/pages.
  SUWAYOMI_URL: z.string().default(''),
  SUWAYOMI_USERNAME: z.string().default(''),
  SUWAYOMI_PASSWORD: z.string().default(''),
  // Suwayomi can expose hundreds of sources; cross-source search fans out to every REGISTERED source, so
  // registration is opt-in per source and additionally capped here.
  SUWAYOMI_MAX_SOURCES: z.coerce.number().int().min(1).max(500).default(25),
  // How long one source gets to answer "what is new" on Discover. This handler was the only one of its
  // siblings with no bound of its own and inherited the adapter's -- 30s for Suwayomi, 95s for a
  // FlareSolverr-backed site -- so a single slow source stalled the whole wall for over a minute. Settable
  // because an operator on a slow link may want more, and because a test cannot afford to wait 8 seconds.
  SOURCE_LATEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(8000),
  // Recognising a series whose folder was renamed or moved, by matching its chapters' content fingerprints.
  //   off    - a moved folder becomes a new series, as it always has
  //   report - work out what it WOULD match and write it to the audit log, change nothing
  //   apply  - actually move the series to its new folder, keeping progress, favourites and covers
  // Defaults to off: a wrong match moves someone's reading progress onto the wrong series, so this is opt-in
  // and 'report' exists so an operator can read the proposed matches before ever trusting it.
  LIBRARY_REMATCH: z.enum(['off', 'report', 'apply']).default('off'),
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:admin@uchiyomi.com'),
  CACHE_MAX_BYTES: z.coerce.number().default(16 * 1024 * 1024 * 1024),
  BACKUP_DIR: z.string().default('/backups'),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14), // nightly dumps to retain
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
