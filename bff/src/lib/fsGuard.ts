// Can this process actually write here, and if not, exactly how do you fix it.
//
// Modelled on runBackup()'s EACCES branch, which exists because an unattended permission error with a bare
// errno is the worst possible outcome: a failed rename is indistinguishable from "nothing happened". The
// library is the harder case, because the answer is usually "set PUID", not "chown this" -- a library belongs
// to the user, and telling them to give it away to uid 10002 is what PUID exists to avoid.
import { mkdtemp, rmdir, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';

export type Writability =
  | { ok: true }
  | { ok: false; reason: string; fix: string };

/**
 * Actually create and remove a directory rather than trusting access().
 *
 * access() reports the permission bits, which an NFS or SMB mount can satisfy while still refusing the
 * write. The only reliable answer is to try it.
 */
export async function writePreflight(dir: string): Promise<Writability> {
  const me = typeof process.getuid === 'function' ? process.getuid() : -1;
  let ownerUid = -1;
  try {
    ownerUid = (await stat(dir)).uid;
  } catch {
    return {
      ok: false,
      reason: `${dir} does not exist or cannot be read`,
      fix: `Check that the volume is mounted. In docker-compose.yml the library is mounted at ${dir}.`,
    };
  }

  try {
    const probe = await mkdtemp(join(dir, '.uchiyomi-write-'));
    await rmdir(probe);
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: `${dir} is not writable: it is owned by uid ${ownerUid} and this container runs as uid ${me}`,
      // PUID first, because it is the answer that leaves the user's files alone.
      fix:
        ownerUid >= 0
          ? `Set PUID=${ownerUid} (and PGID to its group) in your .env and restart. ` +
            `Alternatively, and only if you are sure nothing else uses these files, give them to the app: ` +
            `chown -R ${me}:${me} <your library path>`
          : `Set PUID and PGID to the owner of your library, then restart.`,
    };
  }
}

/**
 * Every distinct root a set of chapters lives under.
 *
 * A series is routinely split across the read library and the download dir -- 146 of 210 on the instance
 * this was written for -- so "is this writable" has more than one answer and every one of them has to be
 * yes before a rename may start.
 */
export async function allWritable(dirs: string[]): Promise<Writability> {
  for (const d of dirs) {
    const r = await writePreflight(d);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/**
 * Resolve `rel` under `root` and refuse anything that escapes it.
 *
 * There is no path-containment check anywhere in this codebase today, and sanitize() in the downloader
 * strips path separators but lets `..` through as a whole segment -- sanitize.test.ts records that as an
 * asserted behaviour. Every filesystem write added from here on goes through this.
 *
 * Returns the resolved absolute path, or null if it escapes. Callers treat null as a refusal, never as a
 * reason to fall back to the raw input.
 */
export function containedPath(root: string, rel: string): string | null {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return full === base || full.startsWith(base + sep) ? full : null;
}
