// The one place a filesystem path becomes the relative path the database stores, and back.
//
// ⚠️ THE DATABASE ALWAYS STORES `/`. The SQL depends on it: `folder || '/%'` in routes/admin.ts and
// lib/libraryAdmin.ts, `s.folder || '/Chapter '` in lib/repair.ts, and libraryIdFor in lib/library.ts all
// build prefixes with a forward slash. On Windows `path.join` and `path.relative` answer with `\`, so a
// chapter written there was stored as `Src\T\Chapter 1.cbz` and never matched any of them again: the nightly
// repair, the Health "Fix" chip and "Fetch again" all silently skipped it.
//
// ⚠️ On POSIX a backslash is an ordinary filename character, not a separator, so it is left exactly as it
// is. Converting it there would rename a real (if odd) folder under everyone running the server, which is
// the one build that must not change at all. `impl` defaults to the platform's own path module and is a
// parameter only so the Windows rules can be tested on Linux with `path.win32`.
import path from 'path';

type PathImpl = Pick<typeof path, 'sep' | 'relative'>;

/** A relative path as the database stores it: `/`-separated on every platform. */
export function toStoredRel(p: string, impl: PathImpl = path): string {
  return impl.sep === '\\' ? p.replace(/\\/g, '/') : p;
}

/** Join stored path segments. posix on purpose, so Windows writes the same string Linux does. */
export const joinRel = (...parts: string[]): string => path.posix.join(...parts);

/** `abs` relative to `root`, in the stored form. */
export function relFromAbs(root: string, abs: string, impl: PathImpl = path): string {
  return toStoredRel(impl.relative(root, abs), impl);
}

/** The folder part of a stored path. posix, because the stored path is. */
export const dirnameRel = (p: string): string => path.posix.dirname(p);
