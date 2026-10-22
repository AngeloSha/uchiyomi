import { readdir } from 'fs/promises';
import { join } from 'path';

/** The spelling the disk uses for `folder` when it differs only in case from the stored one, else null. */
export async function caseVariantOnDisk(roots: string[], folder: string): Promise<string | null> {
  const parts = folder.split('/');
  for (const root of roots) {
    let dir = root; const real: string[] = [];
    for (const part of parts) {
      const names = await readdir(dir).catch(() => [] as string[]);
      const hit = names.includes(part) ? part : names.find((n) => n.toLowerCase() === part.toLowerCase());
      if (!hit) { real.length = 0; break; }
      real.push(hit); dir = join(dir, hit);
    }
    if (real.length === parts.length && real.join('/') !== folder) return real.join('/');
  }
  return null;
}
