// Shared location for admin-uploaded series cover/banner overrides. Stored on the writable /config volume so
// they survive restarts (the BFF runs as uid 10002, which owns /config). Both the admin write route and the
// image server read route resolve paths through here.
import { join } from 'path';
import { env } from '../env';
import { q } from './db';
import { visibleToAll } from './visibility';

export const ART_DIR = join(env.CONFIG_DIR, 'series-art');

/**
 * series_overrides.cover when an admin chose Edit details → Cover → Use the first page (v0.55.7, #168): the series'
 * cover is its own first page for good, and its art is its own pages -- the banner too, unless an admin set one -- so
 * nothing found online (series_art) is shown for it, and nothing is looked up for it. A sentinel beside 'upload' and a
 * pasted URL, not a column: v0.55.6 reads it as a link it cannot fetch, and falls back to the very same first page.
 * Reset to automatic clears it, and the series shows its automatic art again: what series_art holds, which is never
 * changed by this choice.
 */
export const FIRST_PAGE = 'first_page';
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
export const artFile = (id: string, kind: 'cover' | 'banner') => join(ART_DIR, `${safeId(id)}-${kind}.webp`);

/**
 * The largest picture an upload takes, and the request body that carries one (v0.53.0).
 *
 * Edit details says the limit in words ("Images up to 11 MB", web components/SeriesEditor.tsx ART_MAX_MB) and turns a
 * larger file away itself. The picture travels as a base64 data URL inside JSON -- four bytes for every three -- so
 * the art route's body limit is the encoded size plus room for the rest of the body. It was a flat 12 MB, which
 * answered 413 to every picture between 9 and 11 MB that the dialog had just said it would take.
 */
export const ART_MAX_BYTES = 11 * 1024 * 1024;
export const ART_BODY_LIMIT = Math.ceil(ART_MAX_BYTES / 3) * 4 + 64 * 1024;

export interface ArtOverviewRow {
  id: string;
  title: string;
  books_count: number;
  has_banner: boolean;
  has_cover: boolean;
  override_banner: boolean;
  override_cover: boolean;
  /** The cover is the series' first page by an admin's choice (v0.55.7, FIRST_PAGE): an override, with no picture. */
  first_page: boolean;
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
            COALESCE(o.cover = $1, false) AS first_page,
            EXTRACT(EPOCH FROM o.updated_at) * 1000 AS override_v
       FROM lib_series s
       LEFT JOIN series_art a ON a.series_id = s.id
       LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE ${visibleToAll('s')}
      ORDER BY (o.banner IS NOT NULL OR o.cover IS NOT NULL), (a.banner IS NOT NULL AND a.banner <> ''),
               (a.cover IS NOT NULL AND a.cover <> ''), s.title`, [FIRST_PAGE],
  );
