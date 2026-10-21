// Shared location for admin-uploaded series cover/banner overrides, and for the first page the read-chapter cleanup keeps
// (keepCoverPage below). Stored on the writable /config volume so they survive restarts (the BFF runs as uid 10002, which
// owns /config). The admin write route, the cleanup and the image server read route resolve paths through here.
import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { env } from '../env';
import { q } from './db';
import { containedPath } from './fsGuard';
import { visibleToAll } from './visibility';
import { noticeBook, noticeShown } from './noticeChapters';

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
/** An admin's uploaded cover or banner (WebP), or the series' kept first page: as the page was, so its name claims no format. */
export const artFile = (id: string, kind: 'cover' | 'banner' | 'page') => {
  const file = containedPath(ART_DIR, kind === 'page' ? `${safeId(id)}-page` : `${safeId(id)}-${kind}.webp`);
  // safeId permits only a single filename component, so this is unreachable unless that contract changes.
  // Keep the containment check here anyway: every reader, writer and remover then shares the same boundary.
  if (!file) throw new Error('Invalid series art path');
  return file;
};

/**
 * The chapter series `s` (a lib_series alias) takes its first page from, as SQL: its cover chapter, unless that is a notice
 * the series hides, which has no pages to give anyone -- then its lowest shown chapter, live first, as the scan picks the
 * cover (lib/library.ts). The cover route reads its page (routes/images.ts firstPageInput), and the read-chapter cleanup
 * keeps that page before the chapter goes (coverPageBooks).
 */
export const firstPageBookOf = (s: string): string => `CASE WHEN ${noticeBook(`${s}.cover_book_id`)} THEN (
              SELECT fb.id FROM lib_books fb LEFT JOIN book_overrides fov ON fov.book_id = fb.id
               WHERE fb.series_id = ${s}.id AND ${noticeShown(s, 'fb', 'fov')}
               ORDER BY (fb.pruned_at IS NOT NULL), fb.number ASC, fb.file ASC LIMIT 1)
            ELSE ${s}.cover_book_id END`;

/**
 * Of the chapters `ids`, each one a series' cover is drawn from right now, with its series: the chapter its first page
 * comes from, on a series with no cover picture of its own -- no admin's upload or link, no source's or AniList's cover
 * (series_art), the order the cover route reads them in -- or whose admin chose Use the first page. Those are the
 * chapters whose page the read-chapter cleanup keeps before it deletes them (#332).
 */
export async function coverPageBooks(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await q<{ id: string; series_id: string }>(
    `SELECT b.id, b.series_id
       FROM lib_books b
       JOIN lib_series s ON s.id = b.series_id
       LEFT JOIN series_overrides o ON o.series_id = s.id
       LEFT JOIN series_art a ON a.series_id = s.id
      WHERE b.id = ANY($1)
        AND b.id = ${firstPageBookOf('s')}
        AND (o.cover = $2 OR (COALESCE(o.cover, '') = '' AND COALESCE(a.cover, '') = ''))`,
    [ids, FIRST_PAGE],
  );
  return new Map(rows.map((r) => [r.id, r.series_id]));
}

/**
 * Keep series `id`'s first page (v0.97.0, #332) before the read-chapter cleanup deletes the chapter it is in, as the page
 * was: the cover route reads it ahead of any chapter (routes/images.ts firstPageInput), so the cover stays when its
 * chapter goes. `page` reads it, or null for a chapter with no page to give.
 *
 * A page kept already is the cover people see, and stays: the chapter going now is only the one the cover would have
 * fallen back to. Written beside and renamed into place, so a half-written page is never read as a cover. Throws when
 * the page cannot be written, and the cleanup leaves the chapter for its next run.
 */
export async function keepCoverPage(id: string, page: () => Promise<Buffer | null>): Promise<'kept' | 'had' | 'none'> {
  const file = artFile(id, 'page');
  if (await stat(file).then(() => true, () => false)) return 'had';
  const bytes = await page();
  if (!bytes) return 'none';
  await mkdir(ART_DIR, { recursive: true });
  const part = `${file}.part`;
  try {
    await writeFile(part, bytes);
    await rename(part, file);
  } catch (e) {
    await rm(part, { force: true }).catch(() => {});
    throw e;
  }
  return 'kept';
}

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
