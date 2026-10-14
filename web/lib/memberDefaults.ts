// The new-member defaults (#208, item 6; bff lib/memberDefaults.ts): what a member the server makes by itself starts
// with -- a sign-up, or a first sign-in through the OIDC provider with OIDC_ALLOW_SIGNUP. Admin → Members sets them with
// the same three chips a member's card has; GET /api/admin/settings answers them as `newMemberDefaults`, and PATCH takes
// them back in that shape.

export interface MemberDefaults {
  /** null: every library, including ones added later. A list: exactly these, none when empty. */
  libraries: string[] | null;
  /** null: no age limit. */
  maxAgeRating: number | null;
  /** {} allows downloads, as on an account. */
  perms: { canDownload?: false };
}

/** The defaults as a settings answer may carry them. */
export interface MemberDefaultsAnswer {
  libraries?: string[] | null;
  maxAgeRating?: number | null;
  perms?: { canDownload?: boolean } | null;
}

/**
 * The defaults in a settings answer, each one unset unless the answer says otherwise: a server older than them reads
 * as one with nothing set, which is what it does.
 */
export function memberDefaultsOf(settings: { newMemberDefaults?: MemberDefaultsAnswer | null } | null | undefined): MemberDefaults {
  const d = settings?.newMemberDefaults;
  return {
    libraries: Array.isArray(d?.libraries) ? d.libraries : null,
    maxAgeRating: typeof d?.maxAgeRating === 'number' ? d.maxAgeRating : null,
    perms: d?.perms?.canDownload === false ? { canDownload: false } : {},
  };
}

/**
 * Whether anyone can become a member on their own right now, so the defaults apply to someone: a sign-up while Open
 * registration is on (never in SSO-only mode, which has no sign-up form), or a first sign-in through the provider while
 * it makes accounts (OIDC_ALLOW_SIGNUP). `provider` is the provider's name, null with none set up.
 */
export const joinsOnTheirOwn = (o: { mode?: string; registration: boolean; provider: string | null; signup: boolean }): boolean =>
  (o.mode !== 'oidc-only' && o.registration) || (!!o.provider && o.signup);
