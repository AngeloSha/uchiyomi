// Per-library privacy boundary for automatic AniList enrichment (#168).
//
// Manual searches and tracker actions deliberately do not call this helper: the setting says that background
// and implicit work must not send a title or stored AniList id.  The database default preserves the historical
// `true` behaviour; an unknown series or a failed policy read is closed rather than risking a privacy leak.
import { one } from './db';

export type SeriesLocator = { id: string } | { folder: string };

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
