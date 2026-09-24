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
import { relFromAbs } from './relPath';

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
  await renameRetry(tmp, file);
}

/** The waits between rename attempts on Windows. About 1.4 s in all, then the error stands. */
export const WIN_RENAME_RETRY_MS = [100, 300, 1000];
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * `rename`, retried on Windows while something else holds the file.
 *
 * ⚠️ An antivirus scanner (Defender included) opens every new file the moment it is closed, and while it
 * holds it a rename fails with EPERM, EBUSY or EACCES -- so a chapter that downloaded perfectly failed at
 * the last step, now and then, for no reason anyone could see. The hold lasts milliseconds, so a few short
 * retries clear it. Windows only: on Linux those errors are real (a read-only share, a permission problem)
 * and retrying would only delay the message. `platform`, `rename` and `waits` are parameters for the test.
 * Reintroduce by making this a bare rename: relPath.test.ts "a rename Windows refuses twice" throws (and
 * desktopSwitchHygiene.test.ts pins that writeAtomic calls this rather than `fs.rename`).
 */
export async function renameRetry(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  rename: (a: string, b: string) => Promise<void> = fs.rename,
  waits: number[] = WIN_RENAME_RETRY_MS,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? '';
      if (platform !== 'win32' || i >= waits.length || !TRANSIENT.has(code)) throw e;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
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
          // ⚠️ relFromAbs, not path.relative: on Windows that answers with `\`, and the caller matches
          // this against lib_books.file, which always holds `/` (lib/relPath.ts) -- so the row was never
          // un-marked and the chapter it just put back still read as deleted.
          restored.push(relFromAbs(root, path.join(dir, original)));
          console.warn(`[refetch] restored ${path.join(dir, original)} left behind by an interrupted refetch`);
        } catch { /* the next boot tries again */ }
      }
    }
  };
  await walk(root);
  return { reaped: n, restored };
}
