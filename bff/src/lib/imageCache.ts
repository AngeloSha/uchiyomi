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
      noteCacheWrite(buffer.length);
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
      // A day, not five minutes. The url is stable while its content can change (panel art -> real
      // cover, an AniList refresh, an admin override), but every one of those already busts the url
      // via `?av=<artVersion>`, so the short max-age bought nothing. Measured live: 2,139 of 2,695
      // cover requests were 304s -- round trips that bought the user a byte-identical image.
      : 'public, max-age=86400, stale-while-revalidate=604800';
  return serveFromDisk(request, reply, bin, meta, cacheControl);
}

// ---- size-capped LRU sweeper ------------------------------------------------
const TMP_RE = /\.bin\.tmp\.[0-9a-f]+$/;
/** Long enough that a legitimately in-flight write is never removed from under itself. */
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
async function walk(dir: string): Promise<{ file: string; size: number; atime: number }[]> {
  const out: { file: string; size: number; atime: number }[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    // An abandoned half-write from `writeAtomic`. It renames into place on success, so a `.bin.tmp.<hex>`
    // still here is one that never got there: ENOSPC, or the container killed between write and rename.
    // Nothing in this file ever deleted one, and `walk` only collected `.bin`, so cacheBytes() and the
    // sweeper were both blind to them -- the cache reported itself under its cap while the directory sat
    // well over it, which is precisely how a disk fills again after being cleared. The random suffix means
    // no later write ever reuses the name either.
    else if (TMP_RE.test(e.name)) {
      try {
        const st = await fs.stat(full);
        if (Date.now() - st.mtimeMs > TMP_MAX_AGE_MS) await fs.rm(full, { force: true });
        else out.push({ file: full, size: st.size, atime: Math.max(st.atimeMs, st.mtimeMs) });
      } catch { /* race: file gone */ }
    }
    else if (e.name.endsWith('.bin')) {
      try {
        const st = await fs.stat(full);
        // atime, not mtime. mtime is when the entry was written and reading never changes it, so an
        // "LRU" keyed on mtime evicts the covers opened every day and keeps last night's one-off page
        // images. The cache volume is mounted relatime, so atime advances at most once per 24h -- coarse,
        // but "touched today or not" is exactly the question here. Falls back to mtime when atime is
        // somehow older (a fresh file that has never been read).
        out.push({ file: full, size: st.size, atime: Math.max(st.atimeMs, st.mtimeMs) });
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

/**
 * Running size of the cache, so the sweeper does not walk 30,000 files to learn it has nothing to do. Seeded
 * by the first real sweep; a full walk still happens whenever we are near the cap, so drift cannot leave the
 * cache oversized.
 */
let bytesKnown: number | null = null;
let skipped = 0;
const SKIP_LIMIT = 6;
export function noteCacheWrite(bytes: number): void {
  if (bytesKnown !== null) bytesKnown += bytes;
}

export async function sweepCache(maxBytes = env.CACHE_MAX_BYTES): Promise<void> {
  // The walk cost 2.2s of a four-slot threadpool every ten minutes, 144 times a day, essentially always to
  // conclude "under the cap, return". Only pay for it when the running total says we might be over.
  //
  // The total is only ever an estimate: it counts what this process wrote and swept, and misses anything
  // deleted underneath us. So it is allowed to skip the walk at most SKIP_LIMIT times in a row before
  // paying for a real one -- roughly hourly at the current interval -- which bounds how far it can drift.
  if (bytesKnown !== null && bytesKnown < maxBytes * 0.95 && skipped < SKIP_LIMIT) {
    skipped++;
    return;
  }
  skipped = 0;
  const files = await walk(ROOT);
  let total = files.reduce((a, f) => a + f.size, 0);
  bytesKnown = total;
  if (total <= maxBytes) return;
  const target = maxBytes * 0.9;
  files.sort((a, b) => a.atime - b.atime); // least recently USED first
  for (const f of files) {
    if (total <= target) break;
    try {
      await fs.rm(f.file, { force: true });
      await fs.rm(f.file.replace(/\.bin$/, '.json'), { force: true });
      total -= f.size;
      bytesKnown = total;
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
