/**
 * The one person on a desktop install.
 *
 * Uchiyomi Desktop never shows a sign-in screen: the shell signs its own window in through `POST /auth/desktop`
 * (routes/auth.ts), and that exchange needs an account to sign in AS. This makes sure there is one -- a local
 * admin created on first boot, the same shape as the account the first-run web setup creates on a server,
 * except that it has no password anyone could type.
 *
 * Only ever called when the desktop switch is on (server.ts, right after `migrate()`); a server never reaches it.
 */
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'crypto';
import { one, q } from './db';
import { logAudit } from './audit';
import { desktopUserName } from './desktop';

/**
 * Who the desktop window signs in as: the OLDEST enabled admin, not "the user called local".
 *
 * A database restored from a server backup has its own admin (and no `local`), and a person who renamed
 * themselves must stay signed in -- oldest-enabled-admin is right in all three cases, and it is the same
 * account the server's own migrate step promotes when it finds a single pre-existing user.
 */
export async function desktopUserId(): Promise<string | null> {
  const r = await one<{ id: string }>(
    "SELECT id FROM users WHERE role = 'admin' AND NOT disabled ORDER BY created_at, id LIMIT 1",
  );
  return r?.id ?? null;
}

/**
 * Make sure the desktop has someone to sign in as, and return their id. Idempotent: a second call (every boot
 * after the first) finds the account and changes nothing.
 *
 * The password is 32 random bytes that are hashed and then forgotten -- the same unusable-password idea as an
 * account created through SSO -- so the row is a valid user everywhere a password hash is expected, while
 * password sign-in (hidden on desktop anyway) can never open it.
 */
export async function ensureDesktopUser(): Promise<string> {
  const existing = await desktopUserId();
  if (existing) return existing;
  const placeholder = await hash(randomBytes(32).toString('base64url'));
  // `local` may already name a disabled or demoted account in a restored database; the username is unique, so
  // take the next free one rather than failing the boot.
  let username = 'local';
  for (let i = 2; await one('SELECT 1 FROM users WHERE username = $1', [username]); i++) username = `local${i}`;
  const row = await one<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ($1, $2, 'admin', $3, 'desktop') RETURNING id`,
    [desktopUserName().slice(0, 64), username, placeholder],
  );
  if (!row) throw new Error('could not create the local account');
  await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [row.id]);
  await logAudit('setup.desktop', { userId: row.id, username });
  return row.id;
}
