import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  KOMGA_BASE_URL: z.string().url().default('http://komga:25600'),
  KOMGA_API_KEY: z.string().default(''), // only needed when LIBRARY_BACKEND=komga; owned mode ignores it
  JWT_SECRET: z.string().min(16),
  // argon2 hashes contain '$' which breaks compose ${} interpolation -> carry it base64-encoded.
  INITIAL_USER_PASSWORD_HASH_B64: z.string().min(1),
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:3000'),
  CACHE_DIR: z.string().default('/cache'),
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
  const initialUserPasswordHash = Buffer.from(parsed.data.INITIAL_USER_PASSWORD_HASH_B64, 'base64').toString('utf8');
  return { ...parsed.data, initialUserPasswordHash };
})();
