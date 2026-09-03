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

export async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.tmp.${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/**
 * Remove abandoned half-writes under `root`. A `.tmp.<hex>` that is still here is one whose rename never
 * happened: ENOSPC, or a kill between write and rename. The random suffix means no later write reuses the
 * name, so these only ever accumulate. Returns how many were removed; never throws.
 */
export async function reapStaleTemp(root: string): Promise<number> {
  let n = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (TMP_RE.test(e.name)) { try { await fs.unlink(full); n++; } catch { /* already gone */ } }
    }
  };
  await walk(root);
  return n;
}
