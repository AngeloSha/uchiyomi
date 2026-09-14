// Write a file so that it is either entirely there or not there at all.
//
// A plain writeFile onto the final name leaves a truncated file behind if the process dies mid-write, and
// everything that checks "is this chapter already on disk" does so with a bare stat(). So a container
// restarted during a download -- five times in two days, on this install -- could leave a half-chapter
// that was then skipped forever. The image cache had solved this for files that matter less; the library
// itself did not have it.
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';

/** The half-write suffix. Sweepers key on it; nothing else may create names like this. */
export const TMP_RE = /\.tmp\.[0-9a-f]{12}$/;

/**
 * The suffix the refetch route (routes/admin.ts) sets a chapter's old copy aside under while the new one
 * downloads. Not a chapter to the scanner (lib/library.ts listChapters keys on the archive extension, and
 * this is not one), so the row it belongs to reads as a tombstone until the download settles it.
 */
export const REFETCH_BAK = '.refetch-bak';

export async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.tmp.${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/**
 * Remove abandoned half-writes under `root`. A `.tmp.<hex>` that is still here is one whose rename never
 * happened: ENOSPC, or a kill between write and rename. The random suffix means no later write reuses the
 * name, so these only ever accumulate. Returns how many were removed; never throws.
 *
 * Also puts back an orphaned refetch copy: a `<file>.refetch-bak` whose `<file>` is missing is a refetch
 * the process died in the middle of (the download never landed, and the hook that would have restored it
 * died with the process). Renamed back, so the chapter that was there is there again. A bak whose original
 * EXISTS is left alone: the new copy landed and only the delete of the bak was lost, and the settled file
 * wins.
 *
 * `restored` names every file put back, relative to `root` the way lib_books.file is, so the caller can
 * clear the row's tombstone mark at once (unpruneRestored in lib/chapterCleanup.ts). ⚠️ "The next scan
 * clears it" was the first version's answer, and there is no boot scan: the sweep scans only after it
 * ADDED something and the cleanup never looks at a tombstone, so on a quiet series the chapter sat on disk
 * for days reading "deleted" -- refused by the reader, hidden from OPDS and the offline plan.
 */
export async function reapStaleTemp(root: string): Promise<{ reaped: number; restored: string[] }> {
  let n = 0;
  const restored: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (TMP_RE.test(e.name)) { try { await fs.unlink(full); n++; } catch { /* already gone */ } }
      else if (e.name.endsWith(REFETCH_BAK)) {
        const original = e.name.slice(0, -REFETCH_BAK.length);
        if (names.has(original)) continue;
        try {
          await fs.rename(full, path.join(dir, original));
          restored.push(path.relative(root, path.join(dir, original)));
          console.warn(`[refetch] restored ${path.join(dir, original)} left behind by an interrupted refetch`);
        } catch { /* the next boot tries again */ }
      }
    }
  };
  await walk(root);
  return { reaped: n, restored };
}
