// Sign-in modes (v0.63.0, #208).
//
// `local` is how every install signed in before: accounts with passwords, first-run setup in the browser, and the OIDC
// provider beside them when one is configured. `oidc-only` makes the provider the only way in, for a server on the
// internet behind Authentik, Authelia or Keycloak. The password routes are not registered at all -- setup, sign-in,
// sign-up, password change, two-factor (routes/auth.ts) -- so there is nothing there to guess at, rate-limit or watch.
// The first admin comes from the provider, and no account gets or changes a password (routes/admin.ts).
//
// Read when asked rather than once at load, as lib/sources/flaresolverr.ts reads its solvers: production sets them
// before the server starts, and a test can build an app in each mode.
import { env } from '../env';
import { q } from './db';
import { oidcEnabled, oidcName } from './oidc';
import { isDesktop } from './desktop';

export type AuthMode = 'local' | 'oidc-only';

const raw = (): string => (process.env.AUTH_MODE ?? '').trim().toLowerCase();

/** The sign-in mode in force. Uchiyomi Desktop signs its one person in through the app, whatever is set: local. */
export function authMode(): AuthMode {
  return !isDesktop() && raw() === 'oidc-only' ? 'oidc-only' : 'local';
}

/** SSO-only mode is on. */
export const ssoOnly = (): boolean => authMode() === 'oidc-only';

/**
 * The one admin account whose password sign-in SSO-only mode reopens while AUTH_RESCUE_ADMIN names it: the way back in
 * when the provider is down or misconfigured. Null in local mode, where every account signs in with its password.
 */
export function rescueAdmin(): string | null {
  const name = (process.env.AUTH_RESCUE_ADMIN ?? '').trim();
  return ssoOnly() && name ? name : null;
}

/** The provider subject (`sub`) whose first sign-in makes a new SSO-only server's first admin. */
export const bootstrapSub = (): string => (process.env.OIDC_BOOTSTRAP_ADMIN_SUB ?? '').trim();

export interface AuthFacts {
  /** AUTH_MODE as written. */
  mode: string;
  desktop: boolean;
  oidc: boolean;
  linkByUsername: boolean;
  bootstrapSub: string;
  adminGroup: string;
  /** Any account exists: a server past its first admin needs no way to make one. */
  hasUsers: boolean;
}

/**
 * Why the server cannot start in the sign-in mode it was given, one sentence each; empty when it can. Each is a
 * configuration that cannot work, and SSO-only is a security setting: a server that started anyway would leave the
 * password routes open while its operator thinks them closed (a typo in the mode), or have no way for anyone to sign
 * in. Uchiyomi Desktop ignores the mode (authMode), so nothing here stops it.
 */
export function authModeProblems(f: AuthFacts): string[] {
  const mode = f.mode.trim().toLowerCase();
  if (mode !== '' && mode !== 'local' && mode !== 'oidc-only') return [`AUTH_MODE is "${f.mode}": use local or oidc-only.`];
  if (mode !== 'oidc-only' || f.desktop) return [];
  const out: string[] = [];
  if (!f.oidc) out.push('AUTH_MODE=oidc-only needs single sign-on: set OIDC_ISSUER and OIDC_CLIENT_ID.');
  if (f.linkByUsername) {
    out.push('AUTH_MODE=oidc-only knows an account by its identity at the provider alone: unset OIDC_LINK_BY_USERNAME.');
  }
  if (!f.hasUsers && !f.bootstrapSub && !f.adminGroup) {
    out.push('A new server with AUTH_MODE=oidc-only needs a way to make its first admin: set OIDC_BOOTSTRAP_ADMIN_SUB to '
      + 'that person\'s subject at your provider, or OIDC_ADMIN_GROUP.');
  }
  return out;
}

/** This process's facts, for authModeProblems: boot passes whether any account exists. */
export const authFacts = (hasUsers: boolean): AuthFacts => ({
  mode: process.env.AUTH_MODE ?? '',
  desktop: isDesktop(),
  oidc: oidcEnabled(),
  linkByUsername: env.OIDC_LINK_BY_USERNAME,
  bootstrapSub: bootstrapSub(),
  adminGroup: env.OIDC_ADMIN_GROUP,
  hasUsers,
});

/**
 * Whether a new SSO-only server's first sign-in may make this person its admin: the subject OIDC_BOOTSTRAP_ADMIN_SUB
 * names when it is set, else anyone in OIDC_ADMIN_GROUP. Never both ways at once: a named subject is the explicit
 * choice, and the group would be a second, wider door the operator did not ask for.
 */
export function mayBootstrap(claims: { sub: string; groups: string[] }, o: { bootstrapSub: string; adminGroup: string }): boolean {
  if (o.bootstrapSub) return claims.sub === o.bootstrapSub;
  return !!o.adminGroup && claims.groups.includes(o.adminGroup);
}

/** How many unlinked accounts the start-up warning names before it says how many more. */
const NAMED = 10;

/**
 * What the sign-in mode tells the operator at every start (server.ts), one line each: in SSO-only mode the accounts
 * that can no longer sign in, the rescue door while it is open and the setting it ignores; outside it, the settings
 * that only mean something in it.
 */
export async function authModeWarnings(): Promise<string[]> {
  const out: string[] = [];
  if (isDesktop()) {
    if (raw() && raw() !== 'local') out.push('Uchiyomi Desktop signs in through the app: AUTH_MODE is ignored.');
    return out;
  }
  if (!ssoOnly()) {
    if ((process.env.AUTH_RESCUE_ADMIN ?? '').trim()) out.push('AUTH_RESCUE_ADMIN does nothing outside AUTH_MODE=oidc-only: every account signs in with its password.');
    return out;
  }
  // A profile without a password is no account the provider should know: it opens at home through a guardian the
  // provider signed in, so it is not one that "cannot sign in".
  const unlinked = await q<{ username: string | null }>(
    'SELECT username FROM users WHERE oidc_sub IS NULL AND NOT disabled AND NOT (local_open AND NOT password_login) ORDER BY created_at');
  if (unlinked.length) {
    const names = unlinked.slice(0, NAMED).map((u) => u.username ?? '?').join(', ');
    const more = unlinked.length > NAMED ? ` and ${unlinked.length - NAMED} more` : '';
    out.push(`SSO-only mode: ${unlinked.length === 1 ? '1 account has' : `${unlinked.length} accounts have`} no ${oidcName()} link `
      + `and cannot sign in: ${names}${more}. Link one from its Profile -> Account in local mode, or sign in through `
      + `${oidcName()} for a new account.`);
  }
  const rescue = rescueAdmin();
  if (rescue) {
    const admin = await q('SELECT 1 FROM users WHERE username = $1 AND role = \'admin\' AND NOT disabled', [rescue]);
    out.push(admin.length
      ? `SSO-only mode: password sign-in is OPEN for the admin "${rescue}" (AUTH_RESCUE_ADMIN). Remove it once ${oidcName()} works again.`
      : `SSO-only mode: AUTH_RESCUE_ADMIN names "${rescue}", which is no admin account here: nobody can use it.`);
  }
  if (env.initialUserPasswordHash) out.push('SSO-only mode ignores INITIAL_USER_PASSWORD_HASH_B64: the first admin comes from the provider.');
  return out;
}
