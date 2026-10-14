'use client';
// What the server says about signing in (GET /auth/config), and the sentences SSO-only mode needs (v0.63.0, #208).
//
// In SSO-only mode (bff lib/authMode.ts) the provider is the only way in: the sign-in screen offers its button alone,
// Members makes no account and sets no password, and the profile has no password and no two-factor to manage -- the
// routes behind them are not there. `rescue`: password sign-in reopened for one admin (AUTH_RESCUE_ADMIN), so the
// sign-in screen shows its form again, saying why.
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { t as tr } from './i18n';

export interface AuthConfig {
  serverName?: string;
  allowRegistration?: boolean;
  oidc?: { enabled: boolean; name: string };
  /** Absent from a server older than v0.63.0, which signs in the local way. */
  mode?: 'local' | 'oidc-only';
  rescue?: boolean;
  desktop?: boolean;
}

/** The server signs in through its provider only. */
export const ssoOnly = (c: AuthConfig | null | undefined): boolean => c?.mode === 'oidc-only';

/** The sign-in screen offers the provider's button and nothing else: SSO-only, with no rescue open. */
export const providerOnly = (c: AuthConfig | null | undefined): boolean => ssoOnly(c) && !c?.rescue && !!c?.oidc?.enabled;

/** /auth/config for screens past sign-in (Members, the profile): read once a session, it changes only with a restart. */
export function useAuthConfig() {
  return useQuery({ queryKey: ['auth-config'], queryFn: () => api<AuthConfig>('/auth/config'), staleTime: Infinity, retry: false });
}

/** What Profile → Account says after Link to … came back with `sso_link=<result>` (bff routes/auth.ts). */
export function linkResultText(result: string, name: string): { text: string; ok: boolean } {
  switch (result) {
    case 'ok': return { text: tr('Linked to {name}. You can sign in with it now.', { name }), ok: true };
    case 'taken': return { text: tr('That {name} account is already linked to another account here.', { name }), ok: false };
    default: return { text: tr('Could not link your account to {name}.', { name }), ok: false };
  }
}
