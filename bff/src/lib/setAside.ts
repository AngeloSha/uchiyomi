// Chapter files that stay on disk but are no longer the library's (v0.57.0, lib/extraCopies.ts).
//
// A merge -- and the one-time clean-up of the merges made before v0.57.0 -- keeps one copy of a chapter both series had
// and removes the other. Its file is deleted when it is in the download folder; anywhere else (a library folder the
// server may not write to, such as a read-only mount of an older library) it cannot be, and the file stays where it is.
// Its row is gone either way, so the next scan would simply index the file again and the chapter would be listed twice
// once more. These rows are what the scan skips (lib/library.ts persistScan), and what the downloads census does not
// count as "on disk but not in the library" (lib/downloadCensus.ts).
//
// A row names one file AS IT WAS: its mtime and size when it was set aside. A different file at that path -- a chapter
// downloaded there later, a file copied over it by hand -- is not the one set aside, and is indexed like any other
// (the row goes). Deleting a row puts its file back into the library at the next scan.
import { q } from './db';

export interface SetAsideFile { mtime: number | null; size: number | null }

/** Every set-aside file, by root then by file (relative to the root, as lib_books.file is). */
export async function setAsideByRoot(): Promise<Map<string, Map<string, SetAsideFile>>> {
  const rows = await q<{ root: string; file: string; mtime: string | null; size: string | null }>(
    'SELECT root, file, mtime, size FROM set_aside_files',
  ).catch(() => [] as Array<{ root: string; file: string; mtime: string | null; size: string | null }>);
  const out = new Map<string, Map<string, SetAsideFile>>();
  for (const r of rows) {
    let m = out.get(r.root);
    if (!m) out.set(r.root, (m = new Map()));
    m.set(r.file, { mtime: r.mtime == null ? null : Number(r.mtime), size: r.size == null ? null : Number(r.size) });
  }
  return out;
}

/**
 * Is the file found at `root`/`file` (with this stat) the one that was set aside? A file whose mtime or size differs is
 * another file: the row is dropped, and the caller indexes the file.
 */
export async function stillSetAside(
  root: string, file: string, was: SetAsideFile, st: { mtimeMs: number; size: number } | null,
): Promise<boolean> {
  if (!st) return true;
  const same = (was.mtime == null || Math.floor(st.mtimeMs) === was.mtime) && (was.size == null || st.size === was.size);
  if (!same) await q('DELETE FROM set_aside_files WHERE root = $1 AND file = $2', [root, file]).catch(() => {});
  return same;
}
