// Local cover/banner files belong to the library owner. The scanner reads originals only;
// image routes serve validated, content-addressed copies on /config, including read-only libraries.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import sharp from 'sharp';
import { q } from './db';
import { ART_DIR, ART_MAX_BYTES } from './seriesArt';
import { realContainedPath } from './fsGuard';

export type LocalArtKind = 'cover' | 'banner';
const EXTENSIONS = ['webp', 'png', 'jpg', 'jpeg', 'avif'];
const MAX_PIXELS = 24_000_000;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const prefix = (id: string) => `local-${sha(id)}-`;
const validCacheName = (id: string, name: string) => name.startsWith(prefix(id)) && /^local-[a-f0-9]{64}-[a-f0-9]{64}\.webp$/.test(name);

/** The actual open is bounded and checked, including a growing file and a raced final symlink. */
async function readBounded(root: string, rel: string): Promise<{ bytes: Buffer; stamp: string } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const file = await realContainedPath(root, rel);
    if (!file) return null;
    const before = await lstat(file);
    if (!before.isFile() || before.size < 1 || before.size > ART_MAX_BYTES) return null;
    const realRoot = await realpath(root);
    // Open the canonical, contained parent. O_NOFOLLOW refuses a final symlink replaced since lstat.
    const parent = await realpath(dirname(file));
    if (parent !== realRoot && !parent.startsWith(realRoot + sep)) return null;
    handle = await open(join(parent, relative(dirname(file), file)), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const at = await handle.stat();
    if (!at.isFile() || at.dev !== before.dev || at.ino !== before.ino || at.size < 1 || at.size > ART_MAX_BYTES) return null;
    // On Linux the opened descriptor is the authority even if a parent directory is raced.
    if (process.platform === 'linux') {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (openedPath !== realRoot && !openedPath.startsWith(realRoot + sep)) return null;
    }
    const chunks: Buffer[] = []; let count = 0;
    while (count <= ART_MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, ART_MAX_BYTES + 1 - count));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      count += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (count > ART_MAX_BYTES || after.size !== count || at.size !== after.size || at.mtimeMs !== after.mtimeMs) return null;
    const bytes = Buffer.concat(chunks, count);
    return { bytes, stamp: `${rel}:${at.dev}:${at.ino}:${at.size}:${at.mtimeMs}:${sha(bytes)}` };
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

/** A dedicated artwork folder must never become a loose-image chapter itself. */
export const localArtFilename = (name: string) => /^(?:cover|banner)\.(?:webp|png|jpe?g|avif|gif)$/i.test(name);

async function candidate(id: string, root: string, folder: string, kind: LocalArtKind, previous?: { file: string | null; stamp: string | null }): Promise<{ file: string; stamp: string } | null> {
  for (const sub of ['artwork', '']) for (const extension of EXTENSIONS) {
    const rel = join(folder, sub, `${kind}.${extension}`);
    const input = await readBounded(root, rel);
    if (!input) continue;
    if (previous?.file && previous.stamp === input.stamp && validCacheName(id, previous.file)) {
      const cached = await readBounded(ART_DIR, previous.file);
      if (cached && sha(cached.bytes) === previous.file.slice(-69, -5)) return { file: previous.file, stamp: input.stamp };
    }
    try {
      const image = sharp(input.bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false });
      const meta = await image.metadata();
      if (!meta.width || !meta.height || (meta.pages ?? 1) !== 1 || !['jpeg', 'png', 'webp', 'avif', 'heif'].includes(meta.format ?? '')) continue;
      const bytes = await image.rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
      const file = `${prefix(id)}${sha(bytes)}.webp`;
      await mkdir(ART_DIR, { recursive: true });
      const target = join(ART_DIR, file); const temporary = `${target}.${randomUUID()}.part`;
      try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      return { file, stamp: input.stamp };
    } catch { /* Invalid images fall through to another supported local file, then ordinary artwork. */ }
  }
  return null;
}

/** Called once a scanned folder committed; never changes source artwork or a person's overrides. */
export async function refreshLocalSeriesArt(id: string, root: string, folder: string, priority: number): Promise<void> {
  const [old] = await q<{ cover_file: string | null; cover_stamp: string | null; banner_file: string | null; banner_stamp: string | null }>(
    'SELECT cover_file,cover_stamp,banner_file,banner_stamp FROM series_local_art WHERE series_id=$1 AND root=$2 AND folder=$3', [id, root, folder]);
  const cover = await candidate(id, root, folder, 'cover', old && { file: old.cover_file, stamp: old.cover_stamp });
  const banner = await candidate(id, root, folder, 'banner', old && { file: old.banner_file, stamp: old.banner_stamp });
  await q(`INSERT INTO series_local_art (series_id,root,folder,priority,cover_file,cover_stamp,banner_file,banner_stamp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (series_id,root,folder) DO UPDATE SET priority=EXCLUDED.priority,
      cover_file=EXCLUDED.cover_file,cover_stamp=EXCLUDED.cover_stamp,
      banner_file=EXCLUDED.banner_file,banner_stamp=EXCLUDED.banner_stamp,updated_at=now()`,
    [id, root, folder, priority, cover?.file ?? null, cover?.stamp ?? null, banner?.file ?? null, banner?.stamp ?? null]);
  // A folder rematched/renamed by the scanner no longer owns any book path. Its old
  // cached candidate must not outrank the new folder; merged folders that still hold books remain.
  await q(`DELETE FROM series_local_art la WHERE la.series_id=$1 AND la.root=$2 AND la.folder<>$3
    AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id=la.series_id AND b.root=la.root
      AND left(b.file,length(la.folder)+1)=la.folder||'/')`, [id, root, folder]);
  await collectLocalArt(id);
}

/** Current local input and its content identity, or null. No original library files are opened on a page view. */
export async function readLocalSeriesArt(id: string, kind: LocalArtKind): Promise<{ bytes: Buffer; version: string } | null> {
  const rows = await q<{ file: string }>(`SELECT ${kind}_file AS file FROM series_local_art
    WHERE series_id=$1 AND ${kind}_file IS NOT NULL ORDER BY priority,root,folder`, [id]);
  for (const row of rows) {
    if (!validCacheName(id, row.file)) continue;
    const input = await readBounded(ART_DIR, row.file);
    if (!input || sha(input.bytes) !== row.file.slice(-69, -5)) continue;
    return { bytes: input.bytes, version: sha(input.bytes) };
  }
  return null;
}

/** Only this series' generated cache files, never original cover/banner images. */
async function collectLocalArt(id: string): Promise<void> {
  const rows = await q<{ cover_file: string | null; banner_file: string | null }>('SELECT cover_file,banner_file FROM series_local_art WHERE series_id=$1', [id]);
  const keep = new Set(rows.flatMap(r => [r.cover_file, r.banner_file]).filter(Boolean));
  for (const name of await readdir(ART_DIR).catch(() => [] as string[])) {
    if (validCacheName(id, name) && !keep.has(name)) await rm(join(ART_DIR, name), { force: true }).catch(() => {});
  }
}
export async function dropLocalSeriesArt(id: string): Promise<void> {
  await q('DELETE FROM series_local_art WHERE series_id=$1', [id]);
  await collectLocalArt(id);
}
