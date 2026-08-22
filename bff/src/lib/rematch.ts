// Recognising a series whose folder was renamed or moved.
//
// Without this, moving a folder creates a second copy of the series and leaves the reader's progress,
// favourites, ratings, notes and chosen cover attached to the invisible original. With it, the series moves
// and keeps all of that.
//
// It is deliberately hard to trigger. A wrong match is worse than no match — it moves someone's reading
// progress onto the wrong series — so every rule here is about refusing when the evidence is thin:
//
//   * the folder must contain at least MIN_BOOKS fingerprinted chapters. One chapter is not evidence: a
//     single file is legitimately copied between series.
//   * the candidate must share at least MIN_OVERLAP of the smaller side's chapters.
//   * exactly one candidate may qualify. Two plausible answers means we do not know, so we do nothing.
//   * the candidate series must be FULLY fingerprinted. A series with only some of its chapters done
//     reports a small total, so a handful of shared files would look like complete overlap.
//
// Failing any of those falls through to today's behaviour, which is a new series. That is the floor: this
// can decline to help, it must never do harm.
import { q } from './db';
import { logAudit } from './audit';
import { visibleToAll } from './visibility';

export const MIN_BOOKS = 2;
export const MIN_OVERLAP = 0.5;

export interface RematchCandidate {
  seriesId: string;
  oldFolder: string;
  title: string;
  /** How many of this folder's fingerprints the candidate series already holds. */
  shared: number;
  /** shared / the smaller of the two chapter counts. */
  overlap: number;
}

/**
 * Find the one existing series these chapter fingerprints belong to, or null.
 *
 * `excludeFolders` are folders seen on disk during this scan: a series still sitting at its own path has not
 * moved, so it must never be considered a candidate for a different folder.
 */
export async function findRematch(
  fingerprints: string[],
  excludeFolders: string[],
): Promise<{ match: RematchCandidate | null; reason: string; candidates: RematchCandidate[] }> {
  const fps = fingerprints.filter(Boolean);
  if (fps.length < MIN_BOOKS) {
    return { match: null, reason: `only ${fps.length} fingerprinted chapter(s), need ${MIN_BOOKS}`, candidates: [] };
  }

  const rows = await q<{ series_id: string; folder: string; title: string; shared: string; total: string }>(
    `SELECT b.series_id, s.folder, s.title,
            count(DISTINCT b.fingerprint)::text AS shared,
            (SELECT count(*)::text FROM lib_books x WHERE x.series_id = b.series_id AND x.fingerprint IS NOT NULL) AS total
       FROM lib_books b
       JOIN lib_series s ON s.id = b.series_id
      WHERE b.fingerprint = ANY($1)
        AND NOT (s.folder = ANY($2))
        -- a deleted or merged-away series must never be re-adopted into a folder
        AND ${visibleToAll('s')}
        -- a partially fingerprinted series would understate its own size and so overstate the overlap
        AND NOT EXISTS (SELECT 1 FROM lib_books u WHERE u.series_id = b.series_id AND u.fp_at IS NULL)
      GROUP BY b.series_id, s.folder, s.title`,
    [fps, excludeFolders],
  );

  const candidates: RematchCandidate[] = rows.map((r) => {
    const shared = Number(r.shared);
    const smaller = Math.min(fps.length, Math.max(1, Number(r.total)));
    return { seriesId: r.series_id, oldFolder: r.folder, title: r.title, shared, overlap: shared / smaller };
  });

  const strong = candidates.filter((c) => c.overlap >= MIN_OVERLAP);
  if (!strong.length) {
    return { match: null, reason: candidates.length ? 'no candidate shared enough chapters' : 'no candidate', candidates };
  }
  if (strong.length > 1) {
    // Ambiguity is the dangerous case, so it is an explicit refusal rather than a best guess.
    return { match: null, reason: `${strong.length} candidates were equally plausible`, candidates };
  }
  return { match: strong[0], reason: 'ok', candidates };
}

/**
 * Move a series to its new folder and repoint the chapter rows that moved with it, matched by fingerprint.
 *
 * Repointing the books matters as much as moving the series: without it the old rows keep their stale paths,
 * the scanner inserts fresh rows for the files at the new paths, and the series ends up holding both.
 */
export async function applyRematch(
  qq: <R = any>(text: string, params?: any[]) => Promise<R[]>,
  seriesId: string,
  oldFolder: string,
  newFolder: string,
  files: { rel: string; root: string; fingerprint: string | null }[],
): Promise<{ moved: number }> {
  await qq(`UPDATE lib_series SET folder = $2, folder_prev = $3 WHERE id = $1`, [seriesId, newFolder, oldFolder]);

  let moved = 0;
  for (const f of files) {
    if (!f.fingerprint) continue;
    // Only repoint a row whose fingerprint is unique within this series, and only if nothing already sits at
    // the destination path — otherwise the (root, file) unique index would reject it anyway.
    const hit = await qq<{ id: string }>(
      `SELECT id FROM lib_books
        WHERE series_id = $1 AND fingerprint = $2
          AND NOT (root = $3 AND file = $4)
        LIMIT 2`,
      [seriesId, f.fingerprint, f.root, f.rel],
    );
    if (hit.length !== 1) continue;
    const taken = await qq<{ id: string }>(`SELECT id FROM lib_books WHERE root = $1 AND file = $2`, [f.root, f.rel]);
    if (taken.length) continue;
    await qq(`UPDATE lib_books SET file = $2, root = $3, updated_at = now() WHERE id = $1`, [hit[0].id, f.rel, f.root]);
    moved++;
  }
  return { moved };
}

export async function logRematch(
  mode: 'report' | 'apply',
  detail: Record<string, unknown>,
): Promise<void> {
  await logAudit(mode === 'apply' ? 'library.rematch' : 'library.rematch.report', { detail });
  console.log(
    `[rematch] ${mode}: ${JSON.stringify(detail)}`,
  );
}
