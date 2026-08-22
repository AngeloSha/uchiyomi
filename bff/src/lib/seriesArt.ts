// Shared location for admin-uploaded series cover/banner overrides. Stored on the writable /config volume so
// they survive restarts (the BFF runs as uid 10002, which owns /config). Both the admin write route and the
// image server read route resolve paths through here.
import { join } from 'path';
import { env } from '../env';
import { q } from './db';
import { visibleToAll } from './visibility';

export const ART_DIR = join(env.CONFIG_DIR, 'series-art');
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
export const artFile = (id: string, kind: 'cover' | 'banner') => join(ART_DIR, `${safeId(id)}-${kind}.webp`);

export interface ArtOverviewRow {
  id: string;
  title: string;
  books_count: number;
  has_banner: boolean;
  has_cover: boolean;
  override_banner: boolean;
  override_cover: boolean;
  override_v: number | null;
}

/**
 * Every visible series with its art status, worst-first. Feeds the admin Art Review gallery.
 *
 * This lives here rather than inline in the route because it shipped in v0.6.0 with ORDER BY written above
 * WHERE, which Postgres rejects outright: the endpoint 500'd and the Art tab was dead in a published
 * release. Nothing in the suite ran the query, so the only thing between a typo in an admin SQL string and
 * a broken tab reaching users was somebody happening to open it. A function can be called from a test; a
 * template literal buried in a route handler cannot.
 */
export const artOverview = () =>
  q<ArtOverviewRow>(
    `SELECT s.id, s.title, s.books_count,
            (a.banner IS NOT NULL AND a.banner <> '') AS has_banner,
            (a.cover  IS NOT NULL AND a.cover  <> '') AS has_cover,
            (o.banner IS NOT NULL) AS override_banner,
            (o.cover  IS NOT NULL) AS override_cover,
            EXTRACT(EPOCH FROM o.updated_at) * 1000 AS override_v
       FROM lib_series s
       LEFT JOIN series_art a ON a.series_id = s.id
       LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE ${visibleToAll('s')}
      ORDER BY (o.banner IS NOT NULL OR o.cover IS NOT NULL), (a.banner IS NOT NULL AND a.banner <> ''),
               (a.cover IS NOT NULL AND a.cover <> ''), s.title`,
  );
