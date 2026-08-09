import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env';

const ROOT = env.CACHE_DIR;

interface Meta {
  contentType: string;
  length: number;
  etag: string;
}

function keyFor(variant: string): string {
  return createHash('sha256').update(variant).digest('hex');
}

function pathsFor(key: string) {
  const dir = path.join(ROOT, key.slice(0, 2), key.slice(2, 4));
  return { dir, bin: path.join(dir, `${key}.bin`), meta: path.join(dir, `${key}.json`) };
}

async function readMeta(key: string): Promise<Meta | null> {
  try {
    const { meta, bin } = pathsFor(key);
    const raw = await fs.readFile(meta, 'utf8');
    await fs.access(bin);
    return JSON.parse(raw) as Meta;
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<Meta>>();

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.tmp.${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/** Get cached metadata for `variant`, fetching+storing via `fetcher` on a miss.
 *  Exported for cache pre-warmers (e.g. hero backdrops) that want to populate the cache without a request. */
export async function getOrFetch(
  variant: string,
  fetcher: () => Promise<{ buffer: Buffer; contentType: string }>,
): Promise<{ key: string; meta: Meta }> {
  const key = keyFor(variant);
  const existing = await readMeta(key);
  if (existing) return { key, meta: existing };

  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const { dir, bin, meta } = pathsFor(key);
      const { buffer, contentType } = await fetcher();
      const m: Meta = { contentType, length: buffer.length, etag: `"${key.slice(0, 32)}"` };
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(bin, buffer);
      await writeAtomic(meta, JSON.stringify(m));
      return m;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return { key, meta: await p };
}

function serveFromDisk(request: FastifyRequest, reply: FastifyReply, binPath: string, meta: Meta, cacheControl: string) {
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', cacheControl);
  reply.header('ETag', meta.etag);
  reply.header('Content-Type', meta.contentType);

  if (request.headers['if-none-match'] === meta.etag) {
    return reply.code(304).send();
  }

  const total = meta.length;
  const range = request.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        return reply.code(416).header('Content-Range', `bytes */${total}`).send();
      }
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
      reply.header('Content-Length', String(end - start + 1));
      return reply.send(createReadStream(binPath, { start, end }));
    }
  }
  reply.header('Content-Length', String(total));
  return reply.send(createReadStream(binPath));
}

/** High-level: serve a cached image variant, fetching via `fetcher` on miss. */
export async function serveImage(
  request: FastifyRequest,
  reply: FastifyReply,
  variant: string,
  fetcher: () => Promise<{ buffer: Buffer; contentType: string }>,
) {
  const { key, meta } = await getOrFetch(variant, fetcher);
  const { bin } = pathsFor(key);
  // Content-addressed variants never change for a given key → cache hard: page images, and remote covers
  // keyed by their full source URL (srccover:<url>). Library thumbnails/backdrops use a STABLE url whose
  // content can change (panel→real cover, AniList refresh) → keep those revalidatable.
  const immutable = /^(?:lib-)?page:/.test(variant) || variant.startsWith('srccover:');
  // hero backdrops: content changes only when the art itself changes (rare; admin overrides bust via ?av=)
  // → let browsers hold them a day so the carousel doesn't refetch on every visit.
  const cacheControl = immutable
    ? 'public, max-age=31536000, immutable'
    : variant.startsWith('artw7h')
      ? 'public, max-age=86400, stale-while-revalidate=604800'
      : 'public, max-age=300, stale-while-revalidate=604800';
  return serveFromDisk(request, reply, bin, meta, cacheControl);
}

// ---- size-capped LRU sweeper ------------------------------------------------
async function walk(dir: string): Promise<{ file: string; size: number; mtime: number }[]> {
  const out: { file: string; size: number; mtime: number }[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith('.bin')) {
      try {
        const st = await fs.stat(full);
        out.push({ file: full, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* race: file gone */
      }
    }
  }
  return out;
}

export async function cacheBytes(): Promise<number> {
  const files = await walk(ROOT);
  return files.reduce((a, f) => a + f.size, 0);
}

export async function sweepCache(maxBytes = env.CACHE_MAX_BYTES): Promise<void> {
  const files = await walk(ROOT);
  let total = files.reduce((a, f) => a + f.size, 0);
  if (total <= maxBytes) return;
  const target = maxBytes * 0.9;
  files.sort((a, b) => a.mtime - b.mtime); // oldest first
  for (const f of files) {
    if (total <= target) break;
    try {
      await fs.rm(f.file, { force: true });
      await fs.rm(f.file.replace(/\.bin$/, '.json'), { force: true });
      total -= f.size;
    } catch {
      /* ignore */
    }
  }
}

export function startSweeper(): void {
  const run = () => {
    sweepCache().catch(() => {});
  };
  run();
  const t = setInterval(run, 10 * 60 * 1000);
  t.unref();
}
