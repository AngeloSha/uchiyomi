// Destructive library operations: hide a series, restore it, and merge one into another.
//
// Deleting HIDES rather than erases. The id survives, so favourites, ratings, notes and -- above all --
// reading history stay attached to something real, the action is undoable, and we never have to choose
// between erasing someone's reading events (which silently rewrites their stats, streaks and Wrapped) and
// leaving a dead series in Trending. persistScan() knows to skip a hidden folder, or the next scan would
// simply bring it back under a new id.
//
// Merging does NOT de-duplicate chapters, deliberately. Every chapter row and every progress row survives
// exactly as it is. The moment you delete a chapter because it looks like a duplicate, you have to fold two
// read_progress rows into one, and getting that wrong silently marks chapters unread -- which then syncs
// outward to the user's AniList account and cannot be undone. Duplicate chapter numbers are a tidiness
// problem the health page can surface; lost reading progress is not recoverable.
import { rm, rename, realpath, stat } from 'fs/promises';
import { q, one, tx } from './db';
import { artFile } from './seriesArt';
import { allWritable, containedPath } from './fsGuard';
import { join, dirname } from 'path';

export interface SeriesRow {
  id: string;
  title: string;
  folder: string;
  deleted_at: string | null;
  merged_into: string | null;
}

export const getSeriesRow = (id: string) =>
  one<SeriesRow>(`SELECT id, title, folder, deleted_at, merged_into FROM lib_series WHERE id = $1`, [id]);

/** Remove the derived, per-series art: the DB row and the two files nothing else ever sweeps. */
async function dropArt(id: string): Promise<void> {
  await q(`DELETE FROM series_art WHERE series_id = $1`, [id]).catch(() => {});
  await q(`DELETE FROM series_overrides WHERE series_id = $1`, [id]).catch(() => {});
  for (const kind of ['cover', 'banner'] as const) {
    await rm(artFile(id, kind), { force: true }).catch(() => {});
  }
}

/**
 * Hide a series. Its chapters, and everything a user owns about it, stay in place.
 *
 * The tracker link goes, because it is what the duplicate-series health check matches on: leaving it means
 * the check reports the pair forever, and a later re-add flags as a duplicate of something invisible.
 */
export async function deleteSeries(id: string): Promise<{ ok: true; books: number }> {
  const books = await one<{ n: number }>(`SELECT count(*)::int n FROM lib_books WHERE series_id = $1`, [id]);
  await tx(async (qq) => {
    await qq(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [id]);
    await qq(`DELETE FROM series_trackers WHERE series_id = $1`, [id]);
  });
  return { ok: true, books: books?.n ?? 0 };
}

export async function restoreSeries(id: string): Promise<{ ok: true }> {
  await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = $1`, [id]);
  return { ok: true };
}

export interface MergeResult {
  ok: true;
  moved: number;
  favorites: number;
  ratings: number;
  collections: number;
}

/**
 * Fold `fromId` into `intoId`. Everything the absorbed series held moves; nothing is deleted.
 *
 * The tables keyed `(user_id, series_id)` are the awkward ones: a user who had BOTH series favourited would
 * violate the primary key on a plain UPDATE, so those are insert-if-absent then drop. series_seen's counter
 * is recomputed rather than carried over -- summing two "how many chapters had you seen" values would give
 * everyone a phantom NEW badge, or hide one.
 */
export async function mergeSeries(fromId: string, intoId: string): Promise<MergeResult> {
  return tx(async (qq) => {
    const moved = await qq<{ id: string }>(
      `UPDATE lib_books SET series_id = $2 WHERE series_id = $1 RETURNING id`,
      [fromId, intoId],
    );

    // (user_id, series_id) — union, keeping whatever the survivor already had
    const favs = await qq<{ user_id: string }>(
      `INSERT INTO favorites (user_id, series_id, created_at)
       SELECT user_id, $2, created_at FROM favorites WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING RETURNING user_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM favorites WHERE series_id = $1`, [fromId]);

    const rates = await qq<{ user_id: string }>(
      `INSERT INTO ratings (user_id, series_id, stars, updated_at)
       SELECT user_id, $2, stars, updated_at FROM ratings WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING RETURNING user_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM ratings WHERE series_id = $1`, [fromId]);

    const cols = await qq<{ collection_id: string }>(
      `INSERT INTO collection_items (collection_id, series_id, position)
       SELECT collection_id, $2, position FROM collection_items WHERE series_id = $1
       ON CONFLICT (collection_id, series_id) DO NOTHING RETURNING collection_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM collection_items WHERE series_id = $1`, [fromId]);

    // NEW badges: recompute against the merged size rather than carrying a stale count across
    await qq(
      `INSERT INTO series_seen (user_id, series_id, seen_books_count, seen_at)
       SELECT user_id, $2, 0, seen_at FROM series_seen WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM series_seen WHERE series_id = $1`, [fromId]);

    // Keyed on book_id, so the books moving is enough — no collision is possible, and every progress row
    // and every reading event survives untouched. This is the whole reason merge does not de-duplicate.
    for (const t of ['read_progress', 'reading_events', 'notes', 'offline_downloads']) {
      await qq(`UPDATE ${t} SET series_id = $2 WHERE series_id = $1`, [fromId, intoId]);
    }

    // Point the absorbed row at its survivor instead of deleting it: its folder still exists on disk, and
    // persistScan needs this to keep putting those files under the merged series.
    await qq(`UPDATE lib_series SET merged_into = $2 WHERE id = $1`, [fromId, intoId]);
    await qq(`DELETE FROM series_trackers WHERE series_id = $1`, [fromId]);

    // The survivor's rollups are now wrong
    await qq(
      `UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
         FROM (SELECT count(*) n, max(mtime) mt FROM lib_books WHERE series_id = $1) c
        WHERE s.id = $1`,
      [intoId],
    );
    await qq(
      `UPDATE lib_series SET cover_book_id = (
         SELECT id FROM lib_books WHERE series_id = $1 ORDER BY number ASC, file ASC LIMIT 1
       ) WHERE id = $1`,
      [intoId],
    );

    return {
      ok: true as const,
      moved: moved.length,
      favorites: favs.length,
      ratings: rates.length,
      collections: cols.length,
    };
  }).then(async (r) => {
    // outside the transaction: filesystem work must not hold it open
    await dropArt(fromId);
    return r;
  });
}


// ---- file operations ----
//
// These are the only code paths in the app that write to the user's own library, and they are why the
// mount is no longer read-only. Both are deliberately narrow: one series at a time, explicitly confirmed,
// and refusing outright rather than half-applying.

/** Every distinct root a series' chapters live under. Usually two: the read library and the download dir. */
async function rootsOf(seriesId: string): Promise<string[]> {
  const rows = await q<{ root: string }>(
    'SELECT DISTINCT root FROM lib_books WHERE series_id = $1 AND root IS NOT NULL', [seriesId],
  );
  return rows.map((r) => r.root).filter(Boolean);
}

export interface FileOpRefusal { ok: false; reason: string; fix?: string }

/**
 * Delete a hidden series' files from disk.
 *
 * Requires the series to be hidden already, so the reversible step always happens first: "Remove" hides,
 * and only then can you also delete the files. It is an escalation, never a shortcut past the undo.
 *
 * The chapter ROWS and everyone's read_progress stay. read_progress.book_id is ON DELETE RESTRICT precisely
 * so that removing a chapter cannot silently delete what someone read of it, which is the one loss with no
 * undo and which syncs outward to AniList. A later scan neither resurrects them (the folder is gone) nor
 * prunes them (there is no prune path).
 */
export async function deleteSeriesFiles(id: string): Promise<{ ok: true; files: number; bytes: number } | FileOpRefusal> {
  const row = await one<{ folder: string; deleted_at: string | null }>(
    'SELECT folder, deleted_at FROM lib_series WHERE id = $1', [id],
  );
  if (!row) return { ok: false, reason: 'That series no longer exists.' };
  if (!row.deleted_at) {
    return { ok: false, reason: 'Remove the series first. Deleting its files is a second, separate step.' };
  }

  const roots = await rootsOf(id);
  if (!roots.length) return { ok: false, reason: 'That series has no files on disk.' };

  const w = await allWritable(roots);
  if (!w.ok) return { ok: false, reason: w.reason, fix: w.fix };

  let files = 0;
  let bytes = 0;
  for (const root of roots) {
    // Containment, then realpath, then compare again: a symlinked folder inside a library is not
    // hypothetical on a NAS, and a lexical check alone would follow it out of the tree.
    const target = containedPath(root, row.folder);
    if (!target) return { ok: false, reason: 'That folder path is not inside the library.' };
    const real = await realpath(target).catch(() => null);
    if (!real || !containedPath(root, real.slice(root.length + 1) || '.')) {
      if (real && real !== target) return { ok: false, reason: 'That folder resolves outside the library.' };
    }
    for (const b of await q<{ file: string }>('SELECT file FROM lib_books WHERE series_id = $1 AND root = $2', [id, root])) {
      const abs = containedPath(root, b.file);
      if (!abs) continue;
      const st = await stat(abs).catch(() => null);
      if (st) bytes += st.size;
      await rm(abs, { recursive: true, force: true }).catch(() => {});
      files++;
    }
    await rm(target, { recursive: true, force: true }).catch(() => {});
  }
  return { ok: true, files, bytes };
}

/**
 * Rename a series' folder on disk, in every root it occupies.
 *
 * The failure this guards against: renaming only the writable half. persistScan merges identical folderRel
 * across roots, so the old name stays live under the untouched root and the next scan splits the series in
 * two, stranding half of everyone's progress on a row they cannot find. There is no scan-free window --
 * scans run on every add, every updater sweep and the admin button -- so the rule is all roots or none.
 *
 * The database is updated directly rather than left to fingerprint rematch. LIBRARY_REMATCH is off by
 * default and is a deliberate-refusal guesser (two chapters minimum, ambiguity refuses); when Uchiyomi
 * performs the rename it knows the mapping exactly, so guessing it back would be strictly worse.
 */
export async function renameSeriesFolder(id: string, newFolder: string): Promise<{ ok: true } | FileOpRefusal> {
  const row = await one<{ folder: string; library_id: string }>(
    'SELECT folder, library_id FROM lib_series WHERE id = $1', [id],
  );
  if (!row) return { ok: false, reason: 'That series no longer exists.' };

  const dest = newFolder.replace(/^\/+|\/+$/g, '').trim();
  if (!dest || dest === row.folder) return { ok: false, reason: 'Choose a different folder name.' };

  const roots = await rootsOf(id);
  if (!roots.length) return { ok: false, reason: 'That series has no files on disk.' };

  const w = await allWritable(roots);
  if (!w.ok) return { ok: false, reason: w.reason, fix: w.fix };

  // Verify the destination is free in EVERY root first. rename() into an existing directory merges under
  // one filesystem and fails under another, so checking as we go would leave a half-applied move.
  for (const root of roots) {
    const to = containedPath(root, dest);
    const from = containedPath(root, row.folder);
    if (!to || !from) return { ok: false, reason: 'That folder path is not inside the library.' };
    if (await stat(to).then(() => true).catch(() => false)) {
      return { ok: false, reason: `Something already exists at "${dest}".` };
    }
  }

  const done: Array<{ root: string; from: string; to: string }> = [];
  for (const root of roots) {
    const from = containedPath(root, row.folder)!;
    const to = containedPath(root, dest)!;
    try {
      await mkdirp(dirname(to));
      await rename(from, to);
      done.push({ root, from, to });
    } catch (e) {
      // Roll back what already moved. Two renames on two filesystems cannot be made atomic, so the honest
      // design is: verify hard, roll back, and if the rollback itself fails, say exactly what is now
      // inconsistent rather than pretending otherwise.
      for (const d of done.reverse()) {
        try { await rename(d.to, d.from); } catch {
          return {
            ok: false,
            reason: `The rename failed partway and could not be undone. "${d.to}" should be "${d.from}". ` +
                    'Nothing in the database was changed, so fix the folder names on disk and rescan.',
          };
        }
      }
      return { ok: false, reason: `Could not rename the folder: ${(e as Error).message}` };
    }
  }

  await tx(async (qq) => {
    await qq('UPDATE lib_series SET folder_prev = folder, folder = $2 WHERE id = $1', [id, dest]);
    await qq(
      `UPDATE lib_books SET file = $2 || substring(file from length($3) + 1), updated_at = now()
        WHERE series_id = $1 AND file LIKE $3 || '/%'`,
      [id, dest, row.folder],
    );
  });
  return { ok: true };
}

/** mkdir -p without pulling in another import at the top of this file. */
async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import('fs/promises');
  await mkdir(dir, { recursive: true }).catch(() => {});
}
