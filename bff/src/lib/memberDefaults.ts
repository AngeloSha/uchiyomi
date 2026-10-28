// What an account the server makes by itself starts with (#208, item 6): Admin → Members → When someone signs up.
//
// Two paths make an account with no admin choosing what it may open: a sign-up (POST /auth/register, while Open
// registration is on) and a first sign-in through the OIDC provider with OIDC_ALLOW_SIGNUP. Until this, both got every
// library, no age limit and downloads -- the absence of each restriction -- so an admin who relies on either had to fix
// every new account by hand in Admin → Members, after its first session had already seen everything.
//
// The defaults are the three things a member's card sets, in the shapes and with the meanings of PATCH
// /api/admin/users/:id: `libraries` null for every library (including ones added later), a list for exactly these, []
// for none; `maxAgeRating` null for no limit; `perms.canDownload` false to deny downloads. They live on server_settings
// (new_member_*), unset by default, so a server that never sets them makes accounts exactly as before: no grant rows, a
// NULL limit, perms {}.
//
// Applied inside the transaction that makes the account, so it never exists without them, not even for its first
// request, and whatever its role: an admin is unrestricted whatever it carries, but one the provider makes an admin
// (OIDC_ADMIN_GROUP) becomes a member the first time it signs in outside the group, and is then what the defaults say
// rather than a member nobody chose for. Never applied where an admin is the one choosing: the first admin (first-run
// setup, SSO-only mode's firstAdmin), the desktop's one account, and an account made in Admin → Members, which its card
// sets up.
import { z } from 'zod';
import { q } from './db';
import { NO_LIBRARIES } from './visibility';

/** A query as `tx` hands one to its callback; `q` is one too. */
export type Query = <R = any>(text: string, params?: any[]) => Promise<R[]>;

// The permissions that are actually enforced: canDownload (sources.ts, adding a series) and canManageProfiles (POST
// /api/profiles: making profiles that open at home). A flag that is toggleable and checked nowhere is worse than no
// flag, so there are no others. What a new member starts with is the download one only: who may make profiles is an
// admin's choice, member by member.
const downloadPerm = z.object({ canDownload: z.boolean().optional() });
export const permsShape = downloadPerm.extend({ canManageProfiles: z.boolean().optional() });

/**
 * The new-member defaults on PATCH /api/admin/settings: a member's own fields on PATCH /api/admin/users/:id, each optional,
 * absent leaving that one as it is.
 */
export const memberDefaultsShape = z.object({
  libraries: z.array(z.string().max(100)).max(1000).nullable().optional(),
  maxAgeRating: z.number().int().min(0).max(18).nullable().optional(),
  perms: downloadPerm.optional(),
});

export interface MemberDefaults {
  /** null: every library, including ones added later. A list: exactly these, none when empty. */
  libraries: string[] | null;
  /** null: no age limit. */
  maxAgeRating: number | null;
  /** {} allows downloads, as on an account. */
  perms: { canDownload?: false };
}

/**
 * Stop a member's grant list from collapsing into "everything".
 *
 * Removing their last row leaves zero rows, and zero rows means EVERY library. So every path that can take
 * away the last one has to backstop it, or "remove their access" reads as "give them all of it".
 */
export async function keepRestricted(qq: Query, userId: string): Promise<void> {
  const n = await qq<{ c: number }>('SELECT count(*)::int AS c FROM user_libraries WHERE user_id = $1', [userId]);
  if (!n[0]?.c) {
    await qq('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [userId, NO_LIBRARIES]);
  }
}

/**
 * The defaults as they stand. A library removed since it was chosen has left the list, and the list stays a list: a
 * choice of one library that is gone is the choice of none, never every library -- the rule a member's grants follow
 * when their library goes (DELETE /api/admin/libraries/:id).
 */
export async function memberDefaults(qq: Query = q): Promise<MemberDefaults> {
  const [row] = await qq<{ libraries: string[] | null; max_age_rating: number | null; perms: { canDownload?: boolean } | null }>(
    `SELECT CASE WHEN s.new_member_libraries IS NULL THEN NULL
                 ELSE ARRAY(SELECT x FROM unnest(s.new_member_libraries) AS x WHERE EXISTS (SELECT 1 FROM libraries l WHERE l.id = x))
            END AS libraries,
            s.new_member_max_age_rating AS max_age_rating, s.new_member_perms AS perms
       FROM server_settings s WHERE s.id = 1`,
  );
  return {
    libraries: row?.libraries ?? null,
    maxAgeRating: row?.max_age_rating ?? null,
    perms: row?.perms?.canDownload === false ? { canDownload: false } : {},
  };
}

/**
 * Save what the admin changed. Each field on its own, as a member's are; the libraries are kept as the ones that exist
 * (a list of none that do is the choice of none), and downloads allowed is stored as an account stores it, `{}`.
 */
export async function saveMemberDefaults(b: z.infer<typeof memberDefaultsShape>, qq: Query = q): Promise<void> {
  if (b.libraries !== undefined) {
    await qq(
      `UPDATE server_settings
          SET new_member_libraries = CASE WHEN $1::text[] IS NULL THEN NULL
                                          ELSE ARRAY(SELECT x FROM unnest($1::text[]) AS x WHERE EXISTS (SELECT 1 FROM libraries l WHERE l.id = x)) END,
              updated_at = now()
        WHERE id = 1`,
      [b.libraries === null ? null : [...new Set(b.libraries)]],
    );
  }
  if (b.maxAgeRating !== undefined) {
    await qq('UPDATE server_settings SET new_member_max_age_rating = $1, updated_at = now() WHERE id = 1', [b.maxAgeRating]);
  }
  if (b.perms !== undefined) {
    await qq('UPDATE server_settings SET new_member_perms = $1::jsonb, updated_at = now() WHERE id = 1',
      [JSON.stringify(b.perms.canDownload === false ? { canDownload: false } : {})]);
  }
}

/**
 * Give an account the server just made the new-member defaults, inside the transaction that made it, whatever its role:
 * an admin is unrestricted whatever rows it has (visibility.ts viewCtxFor, and every download check lets an admin
 * through), and one the provider made an admin keeps them for the day the group sync makes it a member. With nothing set
 * it writes nothing, so the account is exactly what the INSERT made.
 *
 * Not caught, on purpose: every restriction is a non-null value, so a fallback here would be a fallback to
 * "unrestricted" -- the account that reads no defaults is not made, and the sign-up or sign-in fails instead.
 */
export async function applyMemberDefaults(qq: Query, userId: string): Promise<void> {
  const d = await memberDefaults(qq);
  if (d.maxAgeRating !== null || d.perms.canDownload === false) {
    await qq('UPDATE users SET max_age_rating = $2, perms = $3::jsonb WHERE id = $1', [userId, d.maxAgeRating, JSON.stringify(d.perms)]);
  }
  if (d.libraries !== null) {
    await qq(
      `INSERT INTO user_libraries (user_id, library_id)
       SELECT $1, l.id FROM libraries l WHERE l.id = ANY($2::text[]) ON CONFLICT DO NOTHING`,
      [userId, d.libraries],
    );
    // An empty choice -- or one whose every library has gone -- is none, which rows cannot say by being absent.
    await keepRestricted(qq, userId);
  }
}
