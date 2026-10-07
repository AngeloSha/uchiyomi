// Per-library privacy boundary for automatic AniList enrichment (#168).
//
// Manual searches and tracker actions deliberately do not call this helper: the setting says that background
// and implicit work must not send a title or stored AniList id.  The database default preserves the historical
// `true` behaviour; an unknown series or a failed policy read is closed rather than risking a privacy leak.
import { one, tx } from './db';

export type SeriesLocator = { id: string } | { folder: string };
export type ScopedQuery = <T = any>(text: string, params?: any[]) => Promise<T[]>;
export type AniListAuthority = 'automatic' | 'manual';

export type AniListMutationResult<T> =
  | { applied: false; seriesId: string | null }
  | { applied: true; seriesId: string; value: T };

interface MutationHooks {
  /** After the caller has its network answer, immediately before the authoritative transaction starts. */
  beforeLock?: (where: SeriesLocator) => Promise<void>;
  /** With both policy rows locked. A concurrent move/toggle must wait until this hook and the write finish. */
  afterPolicyLock?: (seriesId: string, allowed: boolean) => Promise<void>;
}

let mutationHooks: MutationHooks = {};

/** Test seam for the two policy/write race boundaries. Pass nothing to restore production behaviour. */
export function setAniListMutationHooks(hooks?: MutationHooks): void {
  mutationHooks = hooks ?? {};
}

export async function automaticAniListAllowed(where: SeriesLocator): Promise<boolean> {
  const byId = 'id' in where;
  const row = await one<{ allowed: boolean }>(
    `SELECT COALESCE(l.anilist_lookup, true) AS allowed
       FROM lib_series s JOIN libraries l ON l.id = s.library_id
      WHERE ${byId ? 's.id' : 's.folder'} = $1
      LIMIT 1`,
    [byId ? where.id : where.folder],
  ).catch(() => null);
  return row?.allowed === true;
}

/**
 * Apply an AniList-derived database result under the series' CURRENT library policy.
 *
 * A pre-network `automaticAniListAllowed()` is only permission to start the request: the series may move, or its
 * library may opt out, while the service is answering.  This is the write authority.  Lock the series first so its
 * `library_id` cannot move, then take a shared lock on that exact library so its policy cannot change until every DML
 * in `write` commits.  This order matches library moves (series first); a policy-only update locks no series row and
 * therefore cannot form the opposite half of a deadlock.
 *
 * Manual Admin Art/Relink and the explicit “Check online matches” action use `manual`: they still serialize against a
 * concurrent series move, but deliberately do not consult or lock the privacy switch.
 */
export async function withAniListMutation<T>(
  where: SeriesLocator,
  authority: AniListAuthority,
  write: (qq: ScopedQuery, seriesId: string) => Promise<T>,
): Promise<AniListMutationResult<T>> {
  await mutationHooks.beforeLock?.(where);
  const byId = 'id' in where;
  return tx(async (qq) => {
    const [series] = await qq<{ id: string; library_id: string }>(
      `SELECT id, library_id FROM lib_series
        WHERE ${byId ? 'id' : 'folder'} = $1
        FOR UPDATE`,
      [byId ? where.id : where.folder],
    );
    if (!series) return { applied: false, seriesId: null };

    if (authority === 'automatic') {
      // FOR SHARE permits unrelated automatic writes in this library together, while conflicting with the
      // UPDATE/DELETE that can change or remove its policy row.
      const [library] = await qq<{ anilist_lookup: boolean }>(
        'SELECT anilist_lookup FROM libraries WHERE id = $1 FOR SHARE',
        [series.library_id],
      );
      const allowed = library?.anilist_lookup === true;
      await mutationHooks.afterPolicyLock?.(series.id, allowed);
      if (!allowed) return { applied: false, seriesId: series.id };
    }

    return { applied: true, seriesId: series.id, value: await write(qq, series.id) };
  });
}
