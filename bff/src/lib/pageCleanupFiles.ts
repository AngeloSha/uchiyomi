// Reversible local CBZ edits (#354). Page names/slots never move. A durable journal is written BEFORE
// the archive rename; either digest then selects a complete state after an interruption. No ZIP entry
// is extracted by name, and adm-zip is used only to construct a new archive from capped entry bytes.
import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, chmod, chown, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { naturalCmp } from './naming';
import { MAX_META_BYTES, MAX_PAGE_BYTES, zipEntryCapped } from './archiveCaps';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StreamZip = require('node-stream-zip');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip');

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;
const SHA = /^[a-f0-9]{64}$/;
const BLOB = SHA;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 2000;
export const CLEANUP_MANIFEST = 'uchiyomi-page-cleanup.json';
export class PageCleanupError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) { super(message); }
}
interface Removed {
  name: string; blob: string; original: string; placeholder: string; size: number; at: string; purged?: boolean;
}
interface State { digest: string; removed: Record<string, Removed> }
interface Journal { version: 1; book: string; before: State; after: State }
export interface CleanupPage { number: number; name: string; bytes: number; gif: boolean; removed: boolean; restorable: boolean }
export interface CleanupPreview { revision: string; contentVersion: string; pages: CleanupPage[]; retainedBytes: number; unusedRetainedBytes: number; unusedRetainedImages: number }
export interface CleanupTarget { bookId: string; file: string; store: string }
export interface CleanupMetadata { revision?: string; removed: Set<number>; restorable: Set<number>; stale?: boolean }
const hash = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
/** A cheap cache/download identity; full content SHA256 is still used for every physical edit. */
export const pageFileVersionOf = (st: Stats): string => hash(JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs]));
export const pageFileVersion = async (file: string): Promise<string> => pageFileVersionOf(await lstat(file));
const fail = (code: string, message: string): never => { throw new PageCleanupError(code, message); };
const safeName = (name: string): boolean => name.length > 0 && name.length < 1024 && !name.includes('\\')
  && !name.includes('\0') && !name.startsWith('/') && !/^[a-z]:/i.test(name)
  && !name.split('/').some((p) => p === '.' || p === '..');
const storeFor = (t: CleanupTarget): string => path.join(t.store, hash(t.bookId));
const revisionFor = (state: State): string => hash(JSON.stringify(state));
const neededBlobs = (state: State): Set<string> => new Set(Object.values(state.removed).filter((r) => !r.purged).map((r) => r.blob));
async function storedBlobs(dir: string): Promise<Array<{ name: string; blob: string; bytes: number }>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  const out = [];
  for (const entry of entries) {
    const m = /^([a-f0-9]{64})\.bin$/.exec(entry.name);
    if (!m) continue;
    const st = await lstat(path.join(dir, entry.name));
    if (!st.isFile()) fail('invalid_store', 'A retained page is not a regular file. Keep the page trash for diagnosis.');
    out.push({ name: entry.name, blob: m[1], bytes: st.size });
  }
  return out;
}
async function describeState(t: CleanupTarget, pages: CleanupPage[], state: State): Promise<CleanupPreview> {
  const blobs = await storedBlobs(storeFor(t)), byBlob = new Map(blobs.map((b) => [b.blob, b]));
  const needed = neededBlobs(state), unused = blobs.filter((b) => !needed.has(b.blob));
  return { revision: revisionFor(state), contentVersion: await pageFileVersion(t.file), pages: pages.map((p) => {
    const r = state.removed[String(p.number)];
    return { ...p, removed: !!r, restorable: !!r && !r.purged && byBlob.get(r.blob)?.bytes === r.size };
  }), retainedBytes: blobs.reduce((n, b) => n + b.bytes, 0),
  unusedRetainedBytes: unused.reduce((n, b) => n + b.bytes, 0), unusedRetainedImages: unused.length };
}

async function fileDigest(file: string): Promise<string> {
  const h = createHash('sha256');
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { for await (const chunk of fh.createReadStream()) h.update(chunk); return h.digest('hex'); }
  finally { await fh.close(); }
}
async function writableFile(file: string) {
  if (!/\.cbz$/i.test(file)) fail('unsupported_format', 'Physical page removal supports local CBZ files only. Use Skip for CBR, PDF, EPUB, folders and remote chapters.');
  const st = await lstat(file).catch((e) => {
    if (e.code === 'ENOENT') throw new PageCleanupError('file_missing', 'This chapter file is not on disk. Restore or refetch it before editing pages.', 404);
    throw e;
  });
  if (!st.isFile() || await realpath(file) !== path.resolve(file)) fail('unsupported_path', 'A symlink or non-regular chapter cannot be edited.');
  if (st.size > MAX_BYTES) fail('archive_too_large', 'This CBZ exceeds the 128 MiB safe editing limit. Use Skip instead.');
  try { await access(file, constants.W_OK); await access(path.dirname(file), constants.W_OK); }
  catch (e) {
    if (['EACCES', 'EPERM', 'EROFS'].includes((e as NodeJS.ErrnoException).code ?? ''))
      fail('read_only', 'The chapter or its folder is read-only for the server. Use Skip instead.');
    throw e;
  }
  return st;
}
async function durableWrite(file: string, bytes: Buffer | string, mode = 0o600): Promise<void> {
  const tmp = `${file}.cleanup-${randomBytes(8).toString('hex')}`;
  let h;
  try {
    h = await open(tmp, 'wx', mode); await h.writeFile(bytes); await h.sync(); await h.close(); h = undefined;
    await rename(tmp, file);
    // Directory fsync is not supported on every Windows filesystem. The file itself was flushed above.
    const dir = await open(path.dirname(file), 'r').catch(() => null);
    if (dir) { try { await dir.sync(); } catch {} finally { await dir.close(); } }
  } finally { await h?.close(); await unlink(tmp).catch(() => {}); }
}
async function readJournal(t: CleanupTarget): Promise<Journal | null> {
  const file = path.join(storeFor(t), 'journal.json');
  let st;
  try { st = await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  if (!st.isFile() || st.size > MAX_META_BYTES) fail('invalid_journal', 'The saved page-cleanup journal is invalid. Keep its trash for recovery.');
  const j: Journal = JSON.parse(await readFile(file, 'utf8'));
  if (j.version !== 1 || j.book !== hash(t.bookId)) fail('invalid_journal', 'This saved cleanup belongs to another chapter.');
  for (const s of [j.before, j.after]) {
    if (!s || !SHA.test(s.digest) || !s.removed || Object.keys(s.removed).length > MAX_ENTRIES) fail('invalid_journal', 'Invalid saved cleanup state.');
    for (const [n, r] of Object.entries(s.removed)) {
      if (!/^[1-9]\d*$/.test(n) || !safeName(r.name) || !BLOB.test(r.blob) || !SHA.test(r.original)
        || !SHA.test(r.placeholder) || !Number.isSafeInteger(r.size) || r.size < 0 || r.size > MAX_PAGE_BYTES
        || (r.purged !== undefined && typeof r.purged !== 'boolean'))
        fail('invalid_journal', 'Invalid saved page identity.');
    }
  }
  return j;
}
function currentState(j: Journal | null, digest: string): State {
  if (!j) return { digest, removed: {} };
  if (j.after.digest === digest) return j.after;
  if (j.before.digest === digest) return j.before;
  return fail('archive_changed', 'This chapter was replaced outside page cleanup. Its saved pages are retained, but cannot be restored onto a different archive.');
}
async function archive(t: CleanupTarget) {
  const st = await writableFile(t.file);
  const digest = await fileDigest(t.file);
  const journal = await readJournal(t);
  const state = currentState(journal, digest);
  const zip = new StreamZip.async({ file: t.file });
  try {
    const entries: Record<string, any> = await zip.entries();
    if (entries['uchiyomi-partial.json']) fail('partial_chapter', 'Finish downloading this chapter\'s missing pages before removing images. Skip remains available.');
    if (entries[CLEANUP_MANIFEST] && !journal) fail('trash_unavailable', 'This archive has removed pages from another installation. Its original page trash is required before editing it.');
    if (Object.keys(entries).length > MAX_ENTRIES || await zip.entriesCount !== Object.keys(entries).length)
      fail('unsupported_archive', 'This archive has too many or duplicate entries. Use Skip instead.');
    let total = 0;
    for (const [name, entry] of Object.entries(entries)) {
      total += Number(entry.size);
      if (!safeName(name) || !Number.isFinite(total) || total > MAX_BYTES || entry.size > MAX_PAGE_BYTES)
        fail('unsupported_archive', 'This archive exceeds safe entry limits or has unsupported entry names. Use Skip instead.');
    }
    const names = Object.keys(entries).filter((n) => !entries[n].isDirectory && IMG.test(n)).sort(naturalCmp);
    const pages: CleanupPage[] = names.map((name, i) => ({ number: i + 1, name, bytes: entries[name].size,
      gif: /\.gif$/i.test(name), removed: !!state.removed[String(i + 1)], restorable: false }));
    for (const [n, r] of Object.entries(state.removed)) {
      if (names[Number(n) - 1] !== r.name) fail('archive_changed', 'The saved page slots no longer match this chapter.');
    }
    return { zip, entries, pages, state, st };
  } catch (e) { await zip.close().catch(() => {}); throw e; }
}
export async function previewPageCleanup(t: CleanupTarget): Promise<CleanupPreview> {
  const a = await archive(t);
  try { return await describeState(t, a.pages, a.state); }
  finally { await a.zip.close(); }
}

const importedMetadata = new Map<string, { stamp: string; metadata: CleanupMetadata }>();
/** A copied archive can describe removed slots, but never authorize access to this server's page trash. */
async function embeddedMetadata(file: string): Promise<CleanupMetadata> {
  const empty = (): CleanupMetadata => ({ removed: new Set(), restorable: new Set() });
  if (!/\.cbz$/i.test(file)) return empty();
  const st = await lstat(file).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (!st?.isFile()) return empty();
  const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`, cached = importedMetadata.get(file);
  if (cached?.stamp === stamp) return cached.metadata;
  const zip = new StreamZip.async({ file });
  let result = empty();
  try {
    const entries: Record<string, any> = await zip.entries();
    if (!entries[CLEANUP_MANIFEST] || Object.keys(entries).length > MAX_ENTRIES || st.size > MAX_BYTES) return result;
    const m = JSON.parse((await zipEntryCapped(zip, CLEANUP_MANIFEST, MAX_META_BYTES)).toString());
    if (m.version !== 1 || !Array.isArray(m.removed) || m.removed.length > MAX_ENTRIES) return result;
    const names = Object.keys(entries).filter((n) => !entries[n].isDirectory && IMG.test(n)).sort(naturalCmp);
    let total = 0;
    const removed = new Set<number>();
    for (const r of m.removed) {
      if (!Number.isInteger(r.page) || r.page < 1 || names[r.page - 1] !== r.name || !SHA.test(r.placeholderSha256)
        || removed.has(r.page) || !entries[r.name] || (total += Number(entries[r.name].size)) > MAX_META_BYTES) return result;
      const bytes = await zipEntryCapped(zip, r.name, MAX_META_BYTES);
      if (hash(bytes) !== r.placeholderSha256) return result;
      // Only the tiny, flat placeholder shape can mark an imported image removed. Untrusted source
      // metadata cannot label an ordinary story image as removed merely by supplying its checksum.
      const pixels = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (pixels.info.width !== 32 || pixels.info.height !== 48 || pixels.info.channels !== 3
        || !pixels.data.every((value, i) => Math.abs(value - [38, 38, 43][i % 3]) <= 3)) return result;
      removed.add(r.page);
    }
    if (removed.size) result = { removed, restorable: new Set(), revision: await fileDigest(file) };
    return result;
  } catch { return result; }
  finally {
    await zip.close().catch(() => {});
    if (importedMetadata.size >= 512) importedMetadata.delete(importedMetadata.keys().next().value!);
    importedMetadata.set(file, { stamp, metadata: result });
  }
}

/** The journal survives rescans; a copied archive has metadata but no authority to restore local trash. */
export async function pageCleanupMetadata(t: CleanupTarget): Promise<CleanupMetadata> {
  const j = await readJournal(t);
  if (!j) return embeddedMetadata(t.file);
  try {
    const digest = await fileDigest(t.file);
    const state = currentState(j, digest);
    const blobs = new Map((await storedBlobs(storeFor(t))).map((b) => [b.blob, b.bytes]));
    return { revision: digest, removed: new Set(Object.keys(state.removed).map(Number)),
      restorable: new Set(Object.entries(state.removed).filter(([, r]) => !r.purged && blobs.get(r.blob) === r.size).map(([n]) => Number(n))) };
  } catch (e) {
    if (e instanceof PageCleanupError && e.code === 'archive_changed') return { ...await embeddedMetadata(t.file), stale: true };
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { removed: new Set(), restorable: new Set(), stale: true };
    throw e;
  }
}

/** The route owns the writer/scan claims. expectedRevision comes from the human's preview. */
export async function applyPageCleanup(t: CleanupTarget, action: 'remove' | 'restore' | 'purge' | 'purge-unused', selected: number[], expectedRevision: string,
  hooks: { beforeReplace?: () => Promise<void>; beforeUnlink?: () => Promise<void> } = {}): Promise<CleanupPreview> {
  const a = await archive(t);
  const dir = storeFor(t);
  const pages = [...new Set(selected)].sort((x, y) => x - y);
  let tmp: string | null = null;
  try {
    if (revisionFor(a.state) !== expectedRevision) fail('preview_stale', 'The chapter changed since the preview. Preview it again.');
    if ((action === 'purge-unused' ? pages.length !== 0 : !pages.length) || pages.length > 500
      || pages.some((n) => !Number.isInteger(n) || n < 1 || n > a.pages.length)) fail('bad_pages', 'Choose between 1 and 500 valid page numbers, or no pages for unused trash.');
    if (action === 'remove' && a.pages.every((p) => p.removed || pages.includes(p.number))) fail('all_pages', 'Keep at least one real page in a chapter.');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== path.resolve(dir)) fail('invalid_store', 'Page trash must be a regular server-owned directory.');
    if (action === 'purge' || action === 'purge-unused') {
      const next: State = { digest: a.state.digest, removed: { ...a.state.removed } };
      for (const n of pages) {
        const r = next.removed[String(n)];
        if (!r) fail('not_removed', `Page ${n} has not been removed.`);
        next.removed[String(n)] = { ...r, purged: true };
      }
      if (await fileDigest(t.file) !== a.state.digest) fail('preview_stale', 'The chapter changed since the preview.');
      // The irreversible decision is durable first. If unlink is interrupted, the bytes remain unused
      // and a later explicit purge-unused retries them; no active restorable reference ever loses a blob.
      await durableWrite(path.join(dir, 'journal.json'), JSON.stringify({ version: 1, book: hash(t.bookId), before: a.state, after: next } satisfies Journal));
      await hooks.beforeUnlink?.();
      const needed = neededBlobs(next);
      const selectedBlobs = new Set(pages.map((n) => next.removed[String(n)].blob));
      for (const blob of await storedBlobs(dir)) {
        if (!needed.has(blob.blob) && (action === 'purge-unused' || selectedBlobs.has(blob.blob))) await unlink(path.join(dir, blob.name));
      }
      return describeState(t, a.pages, next);
    }
    const next: State = { digest: '', removed: { ...a.state.removed } };
    const changes = new Map<string, Buffer>();
    for (const n of pages) {
      const p = a.pages[n - 1];
      const bytes = await zipEntryCapped(a.zip, p.name);
      if (action === 'remove') {
        if (p.removed) fail('already_removed', `Page ${n} was already removed. Refresh the preview.`);
        const metadata = await sharp(bytes).metadata();
        const formats: Record<string, 'jpeg' | 'png' | 'webp' | 'gif' | 'avif'> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif' };
        const format = formats[path.extname(p.name).slice(1).toLowerCase()];
        const detected = metadata.format === 'heif' ? 'avif' : metadata.format;
        if (!format || detected !== format) fail('unsupported_image', `Page ${n}'s format does not match its filename. Use Skip instead.`);
        const placeholder = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#26262b' } }).toFormat(format).toBuffer();
        const blob = hash(bytes), blobFile = path.join(dir, `${blob}.bin`);
        const existing = await lstat(blobFile).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
        if (existing) {
          if (!existing.isFile() || existing.size !== bytes.length || hash(await readFile(blobFile)) !== blob)
            fail('trash_changed', 'An existing retained image failed verification. Keep the page trash for diagnosis.');
        } else await durableWrite(blobFile, bytes);
        next.removed[String(n)] = { name: p.name, blob, original: hash(bytes), placeholder: hash(placeholder), size: bytes.length, at: new Date().toISOString() };
        changes.set(p.name, placeholder);
      } else {
        const r = a.state.removed[String(n)];
        if (r?.purged) fail('original_purged', `Page ${n}'s retained original was permanently deleted. Restore it from a separate backup or refetch the chapter.`);
        if (!r || r.name !== p.name || hash(bytes) !== r.placeholder) fail('page_changed', `Page ${n} no longer has the expected removed-page placeholder.`);
        const blobFile = path.join(dir, `${r.blob}.bin`);
        const st = await lstat(blobFile).catch(() => null);
        if (!st?.isFile() || st.size !== r.size) fail('trash_missing', `Page ${n}'s saved image is missing. Keep the chapter and its trash for recovery.`);
        const original = await readFile(blobFile);
        if (hash(original) !== r.original) fail('trash_changed', `Page ${n}'s saved image failed verification.`);
        changes.set(p.name, original); delete next.removed[String(n)];
      }
    }
    const out = new AdmZip();
    for (const [name, entry] of Object.entries(a.entries)) {
      if (name === CLEANUP_MANIFEST) continue;
      const bytes = entry.isDirectory ? Buffer.alloc(0) : changes.get(name) ?? await zipEntryCapped(a.zip, name);
      out.addFile(name, bytes, entry.comment, entry.attr);
    }
    if (Object.keys(next.removed).length) out.addFile(CLEANUP_MANIFEST, Buffer.from(JSON.stringify({ version: 1,
      removed: Object.entries(next.removed).map(([page, r]) => ({ page: Number(page), name: r.name, sha256: r.original, placeholderSha256: r.placeholder, removedAt: r.at })) })));
    const replacement: Buffer = out.toBuffer();
    next.digest = hash(replacement);
    await a.zip.close();
    tmp = `${t.file}.cleanup-${randomBytes(8).toString('hex')}`;
    await durableWrite(tmp, replacement, a.st.mode & 0o777);
    await chmod(tmp, a.st.mode & 0o777);
    if (process.getuid && (a.st.uid !== process.getuid() || a.st.gid !== process.getgid?.())) await chown(tmp, a.st.uid, a.st.gid);
    await durableWrite(path.join(dir, 'journal.json'), JSON.stringify({ version: 1, book: hash(t.bookId), before: a.state, after: next } satisfies Journal));
    await hooks.beforeReplace?.();
    const now = await lstat(t.file);
    if (!now.isFile() || now.ino !== a.st.ino || now.dev !== a.st.dev || now.size !== a.st.size || now.mtimeMs !== a.st.mtimeMs || await fileDigest(t.file) !== a.state.digest)
      fail('preview_stale', 'Another program changed this chapter. The original was left untouched; preview it again.');
    await rename(tmp, t.file); tmp = null;
    return describeState(t, a.pages.map((p) => ({ ...p, bytes: changes.get(p.name)?.length ?? p.bytes })), next);
  } finally { await a.zip.close().catch(() => {}); if (tmp) await unlink(tmp).catch(() => {}); }
}
