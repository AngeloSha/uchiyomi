// What kind of profile an account is, read from its row.
//
// Not stored as a label of its own: a label could disagree with the columns that decide who gets in. A credential is
// a password /auth/login accepts or an identity at the sign-on provider; `local_open` is opening without one from the
// local network. Nothing reads `kind` to decide anything yet -- /auth/me reports it.

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
  oidc_sub: string | null;
  auth_kind: string;
}

export function profileKind(row: ProfileRow, desktop: boolean): ProfileKind {
  if (desktop && row.auth_kind === 'desktop') return 'desktop-owner';
  const credential = row.password_login || !!row.oidc_sub;
  if (credential) return row.local_open ? 'hybrid' : 'password';
  return row.local_open ? 'open' : 'none';
}
