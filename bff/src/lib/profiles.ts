// What kind of profile an account is, read from its row, and what making one takes.
//
// The kind is not stored as a label of its own: a label could disagree with the columns that decide who gets in. A
// credential is a password /auth/login accepts or a link to the sign-on provider (`sso`); `local_open` is opening
// without one from the local network (lib/clientAddr.ts).
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'crypto';
import type { Query } from './memberDefaults';
import { isDesktop } from './desktop';

export type ProfileKind =
  /** Every account before profiles: a password, or the sign-on provider, from anywhere. */
  | 'password'
  /** No credential: opens from the local network only, through someone else's session or the desktop app. */
  | 'open'
  /** Opens without a password from the local network, and with its credential from anywhere else. */
  | 'hybrid'
  /** The desktop app's one account, signed in by the app itself (lib/desktopUser.ts). */
  | 'desktop-owner'
  /** No credential and not open at home: no way in. The management routes never make one; an old row might be one. */
  | 'none';

export interface ProfileRow {
  password_login: boolean;
  local_open: boolean;
  /** Linked to an identity at the sign-on provider (`oidc_sub IS NOT NULL`). */
  sso: boolean;
  auth_kind: string;
}

/** `desktop`: whether this server is the desktop app's; asked of the switch unless a test says. */
export function profileKind(row: ProfileRow, desktop: boolean = isDesktop()): ProfileKind {
  if (desktop && row.auth_kind === 'desktop') return 'desktop-owner';
  const credential = row.password_login || row.sso;
  if (credential) return row.local_open ? 'hybrid' : 'password';
  return row.local_open ? 'open' : 'none';
}

/**
 * Why an account cannot be this, or null when it can (POST/PATCH /api/admin/users, POST/PATCH /api/profiles): a profile
 * that opens at home is never an admin -- anyone on the local network could run the server (the check
 * users_local_open_not_admin says the same in SQL) -- and every account keeps a way in.
 */
export function profileRefusal(o: { role: string; localOpen: boolean; credential: boolean }): { error: string; message: string } | null {
  if (o.localOpen && o.role === 'admin') {
    return { error: 'local_open_admin', message: 'A profile that opens at home without a password cannot be an admin.' };
  }
  if (!o.localOpen && !o.credential) return { error: 'no_way_in', message: 'Give it a password, or let it open at home.' };
  return null;
}

/** How many profiles one member may manage (POST /api/profiles). An admin makes as many as it likes in Members. */
export const MAX_MANAGED_PROFILES = 6;

/**
 * A password hash nobody can type: 32 random bytes, hashed and forgotten -- the row is a valid user everywhere a hash
 * is expected and password sign-in can never open it (lib/desktopUser.ts, the sign-on provider's accounts).
 */
export const placeholderPasswordHash = (): Promise<string> => hash(randomBytes(32).toString('base64url'));

/**
 * A username for a profile made from its display name: letters, digits and . _ - only, free in any case (POST
 * /auth/register's rule, so `Bob` beside `bob` is taken), with a number after it when the name is taken.
 */
export async function freeUsername(qq: Query, displayName: string): Promise<string> {
  const base = displayName.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 56) || 'profile';
  let name = base.length >= 2 ? base : `${base}-profile`;
  for (let i = 2; (await qq('SELECT 1 FROM users WHERE lower(username) = lower($1)', [name])).length; i++) name = `${base}${i}`;
  return name;
}

/**
 * A profile a member makes sees no more than the member does: their libraries (the "nothing" marker included), their
 * age limit, and their say on downloads. Never their permission to make profiles. Without this a member restricted to
 * one library could make a profile that sees them all. An admin's own grants are none, so its profiles start open;
 * Members narrows them.
 */
export async function inheritRestrictions(qq: Query, from: string, to: string): Promise<void> {
  await qq('INSERT INTO user_libraries (user_id, library_id) SELECT $2, library_id FROM user_libraries WHERE user_id = $1 ON CONFLICT DO NOTHING',
    [from, to]);
  await qq(
    `UPDATE users c SET max_age_rating = g.max_age_rating,
            perms = CASE WHEN g.perms->>'canDownload' = 'false' THEN '{"canDownload": false}'::jsonb ELSE '{}'::jsonb END
       FROM users g WHERE g.id = $1 AND c.id = $2`,
    [from, to]);
}
