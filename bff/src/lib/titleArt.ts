// Series title logos are persistent artwork, not thumbnails. Network discovery never holds a hero response.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { q, tx } from './db';
import { ART_DIR, ART_MAX_BYTES, FIRST_PAGE } from './seriesArt';
import { containedPath } from './fsGuard';
import { Params, SYSTEM_CTX, visible, visibleToAll, type ViewCtx } from './visibility';
import { withAniListMutation, type AniListAuthority, type ScopedQuery } from './anilistPolicy';
import { runtime } from './runtime';
import { fetchPublic } from './safeFetch';
import { lookupTitleLogo } from './titleLogoProvider';
import { coverSelectionKey, coverSelectionSql } from './coverSelection';

export const TITLE_STYLES = ['auto', 'action', 'fantasy', 'scifi', 'soft', 'noir', 'plain'] as const;
export type TitleStyle = typeof TITLE_STYLES[number];
export type TitleMode = 'automatic' | 'custom' | 'text';
export type TitleStatus = 'ready' | 'pending' | 'missing' | 'error' | 'disabled';
export interface TitleAttribution {
  source: 'Wikimedia Commons' | 'Cover lettering'; sourceUrl: string | null; artist: string | null; license: string | null; licenseUrl: string | null;
}
export interface TitleArt {
  mode: TitleMode; style: TitleStyle; status: TitleStatus; version: number; logoUrl: string | null;
  language: 'en' | 'original' | null; showReadableTitle: boolean; attribution: TitleAttribution | null;
}
interface ArtRow {
  id: string; series_id: string | null; mode: TitleMode | null; style: TitleStyle | null; version: string | number | null;
  custom_file: string | null; auto_file: string | null; auto_anilist_id: string | null;
  custom_attribution: TitleAttribution | null;
  auto_language: 'en' | 'original' | null; auto_caption: boolean | null; auto_attribution: TitleAttribution | null;
  auto_manual: boolean | null;
  lookup_status: 'ready' | 'missing' | 'error' | null; lookup_anilist_id: string | null; retry_at: Date | string | null;
  auto_cover_key: string | null; cover_selection: unknown;
  linked_anilist_id: string | null; online: boolean; library_online: boolean; first_page: boolean;
}

export class TitleArtError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string, readonly retryAfterMs?: number) { super(message); }
}
const MISS_MS = 7 * 24 * 3600_000;
const ERROR_MS = 5 * 60_000;
const PACE_MS = 2200;
const MAX_PENDING = 128;
const MAX_PIXELS = 24_000_000;
const prefix = (id: string) => `title-${createHash('sha256').update(id).digest('hex')}-`;
function assetPath(name: string): string {
  if (!/^title-[a-f0-9]{64}-[a-f0-9]{64}\.webp$/.test(name)) throw new Error('Invalid title art file');
  const path = containedPath(ART_DIR, name);
  if (!path) throw new Error('Invalid title art path');
  return path;
}
async function assetAvailable(name: string): Promise<boolean> {
  return lstat(assetPath(name)).then((s) => s.isFile() && s.size > 0 && s.size <= ART_MAX_BYTES, () => false);
}
/** No-follow open + fstat protects the actual file, not only its name. Reads stay capped even if it grows. */
async function readAsset(name: string): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = assetPath(name);
    const before = await lstat(path);
    if (!before.isFile() || before.size < 1 || before.size > ART_MAX_BYTES) return null;
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size < 1 || opened.size > ART_MAX_BYTES) return null;
    const chunks: Buffer[] = []; let count = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, ART_MAX_BYTES + 1 - count));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      count += bytesRead; if (count > ART_MAX_BYTES) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.size !== count || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) return null;
    const bytes = Buffer.concat(chunks, count);
    if (!name.endsWith(`${createHash('sha256').update(bytes).digest('hex')}.webp`)) return null;
    return bytes;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
const nversion = (v: ArtRow['version']) => Math.max(0, Number(v) || 0);
const nextVersion = (v: ArtRow['version']) => Math.max(Date.now(), nversion(v) + 1);
const validId = (s: string | null) => !!s && /^[1-9][0-9]{0,15}$/.test(s);

async function rowsFor(ids: string[]): Promise<ArtRow[]> {
  if (!ids.length) return [];
  return q<ArtRow>(`SELECT s.id, a.*, t.external_id AS linked_anilist_id,
      COALESCE(ss.automatic_title_logos, false) AS online, COALESCE(l.anilist_lookup, false) AS library_online,
      COALESCE(o.cover = $2, false) AS first_page,
      CASE WHEN a.auto_cover_key IS NOT NULL THEN ${coverSelectionSql('s')} END AS cover_selection
    FROM lib_series s LEFT JOIN series_title_art a ON a.series_id = s.id
    LEFT JOIN libraries l ON l.id = s.library_id
    LEFT JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
      AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
    LEFT JOIN series_overrides o ON o.series_id = s.id
    LEFT JOIN server_settings ss ON ss.id = 1
    WHERE s.id = ANY($1) AND ${visibleToAll('s')}`, [ids, FIRST_PAGE]);
}
function fileFor(r: ArtRow): string | null {
  if (r.mode === 'text') return null;
  if (r.mode === 'custom') return r.custom_file;
  if (r.first_page && !r.auto_manual) return null;
  if (r.auto_cover_key && r.auto_cover_key !== coverSelectionKey(r.cover_selection)) return null;
  return validId(r.linked_anilist_id) && r.auto_anilist_id === r.linked_anilist_id ? r.auto_file : null;
}

interface Job { id: string; anilistId: string; version: number; authority: AniListAuthority; generation: number }
const pending = new Map<string, Job>();
const waiting = new Set<string>();
let draining: Promise<void> | null = null;
let activeJob: Job | null = null;
let queuePaceMs = PACE_MS;
let automaticGeneration = 0;
let provider: typeof lookupTitleLogo = (...args) => lookupTitleLogo(...args);
/** A transport seam for deterministic provider/privacy/race tests; no production caller changes it. */
export function setTitleLogoLookupForTests(lookup?: typeof lookupTitleLogo): void {
  provider = lookup ?? ((...args) => lookupTitleLogo(...args));
}
export const titleLogoQueueState = () => ({ ids: [...pending.keys()], active: activeJob !== null, capacity: MAX_PENDING });
/** A test clock seam: production always uses the same conservative 2.2-second pace. */
export function setTitleLogoQueuePaceForTests(ms?: number): void { queuePaceMs = ms ?? PACE_MS; }
export function cancelAutomaticTitleLogoQueue(): void {
  automaticGeneration++;
  for (const [id, job] of pending) if (job.authority === 'automatic') { pending.delete(id); waiting.delete(id); }
}
export async function titleLogoProviderRetryAt(): Promise<number> {
  const [row] = await q<{ title_logo_retry_at: Date | null }>('SELECT title_logo_retry_at FROM server_settings WHERE id=1');
  return row?.title_logo_retry_at ? new Date(row.title_logo_retry_at).getTime() : 0;
}
/** Stop queued automatic work immediately when the setting or a series' privacy/manual choice changes. */
export async function pruneAutomaticTitleLogoQueue(): Promise<void> {
  const jobs = [...pending.values()].filter((job) => job.authority === 'automatic');
  if (!jobs.length) return;
  const rows = new Map((await rowsFor(jobs.map((job) => job.id))).map((row) => [row.id, row]));
  for (const job of jobs) {
    const row = rows.get(job.id);
    if (!row || !sameChoice(row, job) || !row.online || !row.library_online || row.first_page) {
      if (pending.get(job.id) === job) { pending.delete(job.id); waiting.delete(job.id); }
    }
  }
}
/** A paused provider leaves queued work in place; the scanner resumes it only after the persisted deadline. */
export function resumeTitleLogoQueue(): void {
  if (waiting.size && !draining && !runtime.stopping) draining = Promise.resolve().then(drain);
}

function dto(r: ArtRow): TitleArt {
  const mode = r.mode ?? 'automatic';
  const file = fileFor(r);
  const job = pending.get(r.id);
  const isPending = mode === 'automatic' && job?.version === nversion(r.version) && job.anilistId === r.linked_anilist_id;
  const allowed = mode === 'automatic' && r.online && r.library_online && !r.first_page && validId(r.linked_anilist_id);
  const currentAttempt = r.lookup_anilist_id === r.linked_anilist_id;
  const status: TitleStatus = isPending ? 'pending'
    : mode === 'custom' && file ? 'ready'
    : mode === 'text' ? 'disabled'
    : currentAttempt && r.lookup_status === 'error' ? 'error'
    : file ? 'ready' : allowed ? 'missing' : 'disabled';
  return {
    mode, style: r.style ?? 'auto', status, version: nversion(r.version),
    logoUrl: file ? `/img/series/${encodeURIComponent(r.id)}/logo?v=${nversion(r.version)}` : null,
    language: mode === 'custom' ? null : r.auto_language,
    showReadableTitle: mode === 'custom' ? true : r.auto_caption !== false,
    attribution: mode === 'custom' ? r.custom_attribution ?? null : (file ? r.auto_attribution : null),
  };
}
/** All catalog surfaces get the same cheap batch read; hero routes and the background scanner enqueue discovery. */
export async function titleArtsFor(ids: string[]): Promise<Map<string, TitleArt>> {
  return new Map((await rowsFor(ids)).map((r) => [r.id, dto(r)]));
}

/** Decode only actual raster images, cap their decoded size, preserve alpha and normalize title edges losslessly. */
export async function normalizeTitleLogo(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > ART_MAX_BYTES) throw new TitleArtError('bad_image', 400, 'Choose a readable PNG, WebP, JPEG or AVIF image up to 11 MB.');
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false });
    const info = await image.metadata();
    if (!['png', 'webp', 'jpeg', 'avif', 'heif'].includes(info.format ?? '') || (info.pages ?? 1) > 1) throw new Error('not a still raster');
    if (!info.width || !info.height || info.width * info.height > MAX_PIXELS) throw new Error('too many pixels');
    let bounded = image.rotate();
    if (info.hasAlpha) {
      const { data, info: decoded } = await image.clone().rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let left = decoded.width, top = decoded.height, right = 0, bottom = 0, transparent = false;
      for (let n = 0; n < decoded.width * decoded.height; n++) {
        const alpha = data[n * 4 + 3];
        if (alpha < 255) transparent = true;
        if (alpha > 0) {
          const x = n % decoded.width, y = Math.floor(n / decoded.width);
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
        }
      }
      if (right <= left || bottom <= top) throw new Error('empty image');
      // Heuristic trim can discard a detached title dot or a user's isolated restored pixel.
      // Transparency is authoritative: include every nonzero-alpha pixel, regardless of its RGB.
      if (transparent) bounded = sharp(data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } })
        .extract({ left, top, width: right - left, height: bottom - top });
      else bounded = bounded.trim({ background: '#00000000', threshold: 0 });
    } else bounded = bounded.trim({ background: '#00000000', threshold: 0 });
    return await bounded.resize({ width: 1600, height: 800, fit: 'inside', withoutEnlargement: true })
      .webp({ lossless: true }).toBuffer();
  } catch { throw new TitleArtError('bad_image', 400, 'That file is not a readable, still raster image.'); }
}
export async function titleLogoFromUrl(url: string): Promise<Buffer> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new TitleArtError('bad_image', 400, 'Paste a public image URL.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TitleArtError('bad_image', 400, 'Paste a public image URL.');
  const response = await fetchPublic(parsed, { timeoutMs: 15_000, maxBytes: ART_MAX_BYTES, maxHops: 4 });
  if (!response || response.status !== 200) throw new TitleArtError('bad_image', 400, 'That image could not be read.');
  return normalizeTitleLogo(response.body);
}
async function putAsset(id: string, bytes: Buffer): Promise<string> {
  const name = `${prefix(id)}${createHash('sha256').update(bytes).digest('hex')}.webp`;
  const path = assetPath(name);
  await mkdir(ART_DIR, { recursive: true });
  const part = join(ART_DIR, `.${name}.${randomUUID()}.part`);
  try { await writeFile(part, bytes, { flag: 'wx' }); await rename(part, path); }
  finally { await rm(part, { force: true }).catch(() => {}); }
  return name;
}
// Every publisher holds the series row lock while writing files, so this cannot collect another publisher's in-flight file.
async function collectAssets(id: string, keep: Array<string | null>): Promise<void> {
  const names = await readdir(ART_DIR).catch(() => [] as string[]);
  const start = prefix(id);
  for (const name of names) if (name.startsWith(start) && /^title-[a-f0-9]{64}-[a-f0-9]{64}\.webp$/.test(name) && !keep.includes(name)) {
    await rm(assetPath(name), { force: true }).catch(() => {});
  }
}
// Collect only AFTER the publisher's transaction committed. A failed COMMIT must retain the old row's file.
async function collectCurrentAssets(id: string): Promise<void> {
  await tx(async (qq) => {
    await qq('SELECT id FROM lib_series WHERE id=$1 FOR UPDATE', [id]);
    const [row] = await qq<{ custom_file: string | null; auto_file: string | null }>('SELECT custom_file,auto_file FROM series_title_art WHERE series_id=$1', [id]);
    await collectAssets(id, row ? [row.custom_file, row.auto_file] : []);
  }).catch(() => {});
}
async function ensureRow(qq: ScopedQuery, id: string): Promise<ArtRow> {
  await qq('INSERT INTO series_title_art (series_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  return (await qq<ArtRow>('SELECT *, series_id AS id FROM series_title_art WHERE series_id = $1 FOR UPDATE', [id]))[0];
}
async function lockVisible(qq: ScopedQuery, id: string, viewer: ViewCtx): Promise<void> {
  const p = new Params(); const target = p.add(id); const allowed = visible('s', viewer, p);
  const rows = await qq(`SELECT s.id FROM lib_series s WHERE s.id = ${target} AND ${allowed} FOR UPDATE OF s`, p.values);
  if (!rows.length) throw new TitleArtError('not_found', 404, 'The series is no longer available.');
}
export type TitleArtChange = { mode: 'upload' | 'url'; bytes: Buffer } | { mode: 'reset' | 'text' } | { mode: 'style'; style: TitleStyle };
export async function changeTitleArt(id: string, change: TitleArtChange, viewer: ViewCtx,
  guard?: { expectedVersion: number; assertCurrent: (qq: ScopedQuery) => Promise<void>; attribution?:TitleAttribution }): Promise<TitleArt | null> {
  await tx(async (qq) => {
    await lockVisible(qq, id, viewer);
    const row = await ensureRow(qq, id);
    if (guard) {
      if (nversion(row.version) !== guard.expectedVersion) throw new TitleArtError('stale_candidate', 409, 'The title artwork changed. Make a new preview.');
      await guard.assertCurrent(qq);
    }
    let custom = row.custom_file;
    let customAttribution = row.custom_attribution;
    let mode = row.mode ?? 'automatic'; let style = row.style ?? 'auto';
    if (change.mode === 'upload' || change.mode === 'url') { custom = await putAsset(id, change.bytes); mode = 'custom'; customAttribution=guard?.attribution??null; }
    else if (change.mode === 'style') style = change.style;
    else if (change.mode === 'text') mode = 'text';
    else { mode = 'automatic'; style = 'auto'; custom = null; customAttribution=null; }
    await qq('UPDATE series_title_art SET mode=$2, style=$3, custom_file=$4, version=$5, custom_attribution=$6, updated_at=now() WHERE series_id=$1',
      [id, mode, style, custom, nextVersion(row.version),customAttribution?JSON.stringify(customAttribution):null]);
  });
  await collectCurrentAssets(id);
  if (change.mode === 'reset') await queueTitleLogos([id]);
  return (await titleArtsFor([id])).get(id) ?? null;
}

/** Manual refresh is one explicit request, like Art Review: it may bypass online opt-outs, but never a manual title choice. */
export async function refreshTitleLogo(id: string, viewer: ViewCtx): Promise<TitleArt | null> {
  await tx(async (qq) => {
    await lockVisible(qq, id, viewer);
    const row = await ensureRow(qq, id);
    if (row.mode !== 'automatic') throw new TitleArtError('manual_choice', 409, 'Reset to automatic before finding another logo.');
  });
  const rows = await rowsFor([id]);
  if (!validId(rows[0]?.linked_anilist_id ?? null)) throw new TitleArtError('no_link', 409, 'Link this series to its AniList manga before finding a logo.');
  const row = rows[0];
  const rest = row.retry_at ? new Date(row.retry_at).getTime() - Date.now() : 0;
  if (row.lookup_status === 'error' && row.lookup_anilist_id === row.linked_anilist_id && rest > 0) {
    throw new TitleArtError('provider_busy', 429, 'The artwork provider is resting. Try again later.', rest);
  }
  const providerRest = await titleLogoProviderRetryAt() - Date.now();
  if (providerRest > 0) throw new TitleArtError('provider_busy', 429, 'The artwork provider is resting. Try again later.', providerRest);
  await queueTitleLogos([id], 'manual');
  return (await titleArtsFor([id])).get(id) ?? null;
}

export async function queueTitleLogos(ids: string[], authority: AniListAuthority = 'automatic'): Promise<void> {
  const generation = automaticGeneration;
  for (const r of await rowsFor(ids)) {
    if (runtime.stopping || (authority === 'automatic' && generation !== automaticGeneration)) break;
    if ((r.mode ?? 'automatic') !== 'automatic' || !validId(r.linked_anilist_id)) continue;
    if (r.lookup_status === 'error' && r.lookup_anilist_id === r.linked_anilist_id && r.retry_at && new Date(r.retry_at).getTime() > Date.now()) continue;
    if (authority === 'automatic') {
      if (!r.online || !r.library_online || r.first_page) continue;
      if (!r.auto_cover_key && r.auto_anilist_id === r.linked_anilist_id && r.auto_file && await assetAvailable(r.auto_file)) continue;
      if (r.lookup_anilist_id === r.linked_anilist_id && r.retry_at && new Date(r.retry_at).getTime() > Date.now()) continue;
    }
    const old = pending.get(r.id);
    if (old && (authority === 'automatic' || old === activeJob)) continue;
    if (!old && pending.size >= MAX_PENDING) {
      if (authority === 'automatic') continue;
      // Bulk discovery is recoverable from SQL. Give an explicit Find the waiting slot furthest away,
      // preserving every manual request and the active lookup; the next scan rediscovers the evicted ID.
      const evict = [...waiting].reverse().find((id) => pending.get(id)?.authority === 'automatic' && pending.get(id) !== activeJob);
      if (!evict) throw new TitleArtError('busy', 429, 'Title artwork is busy. Try again shortly.', 5000);
      waiting.delete(evict); pending.delete(evict);
    }
    pending.set(r.id, { id: r.id, anilistId: r.linked_anilist_id!, version: nversion(r.version), authority, generation });
    if (authority === 'manual') {
      const rest = [...waiting].filter((id) => id !== r.id); waiting.clear(); waiting.add(r.id);
      for (const id of rest) waiting.add(id);
    } else waiting.add(r.id);
  }
  resumeTitleLogoQueue();
}
export const titleLogoQueueSettled = (): Promise<void> => draining ?? Promise.resolve();
async function drain(): Promise<void> {
  try {
    while (waiting.size && !runtime.stopping) {
      if (await titleLogoProviderRetryAt() > Date.now()) break;
      const id = waiting.values().next().value!; waiting.delete(id);
      const job = pending.get(id); if (!job) continue;
      activeJob = job;
      try { await runJob(job); } catch { /* A DB/shutdown failure must not stop later requests from trying again. */ }
      activeJob = null;
      if (pending.get(id) === job) pending.delete(id);
      if (waiting.size && !runtime.stopping) await new Promise((resolve) => setTimeout(resolve, queuePaceMs));
    }
  } finally { draining = null; activeJob = null; if (runtime.stopping) { waiting.clear(); pending.clear(); } }
}
function sameChoice(r: ArtRow, job: Job): boolean {
  return (r.mode ?? 'automatic') === 'automatic' && nversion(r.version) === job.version && r.linked_anilist_id === job.anilistId;
}
async function runJob(job: Job): Promise<void> {
  const cancelled = () => job.authority === 'automatic' && job.generation !== automaticGeneration;
  const before = (await rowsFor([job.id]))[0];
  if (cancelled() || !before || !sameChoice(before, job) || (job.authority === 'automatic' && (!before.online || !before.library_online || before.first_page))) return;
  let found: Awaited<ReturnType<typeof lookupTitleLogo>> | null = null;
  let bytes: Buffer | null = null; let failure: unknown = null;
  try {
    found = job.authority === 'manual' ? await provider(job.anilistId, { interactive: true }) : await provider(job.anilistId);
    if (found.kind === 'found') bytes = await normalizeTitleLogo(found.candidate.bytes);
  }
  catch (error) { failure = error; }
  if (runtime.stopping) return;
  // A shared remote Retry-After survives a restart and pauses the queue, rather than making every queued
  // manga look like a failed lookup. Local decode failures have no provider retry deadline.
  const providerRest = Number((failure as any)?.retryAfterMs);
  if (failure && Number.isSafeInteger(providerRest) && providerRest >= 0 && providerRest <= 8_000_000_000_000_000 - Date.now()) {
    await q(`UPDATE server_settings SET title_logo_retry_at=GREATEST(COALESCE(title_logo_retry_at,now()),now()+($1::bigint*interval '1 millisecond')) WHERE id=1`, [providerRest]);
  }
  if (cancelled()) return;
  // Only local decoding/filesystem work happens under the authoritative lock; never HTTP.
  await withAniListMutation({ id: job.id }, job.authority, async (qq, id) => {
    if (runtime.stopping || cancelled()) return;
    if (!(await qq(`SELECT s.id FROM lib_series s WHERE s.id=$1 AND ${visibleToAll('s')}`, [id])).length) return;
    const [link] = await qq<{ external_id: string }>(`SELECT external_id FROM series_trackers WHERE series_id=$1 AND provider='anilist'
      AND (linked_by IS NOT NULL OR checked_at IS NOT NULL) FOR SHARE`, [id]);
    if (link?.external_id !== job.anilistId) return;
    if (job.authority === 'automatic') {
      const [settings] = await qq<{ automatic_title_logos: boolean }>('SELECT automatic_title_logos FROM server_settings WHERE id=1 FOR SHARE');
      const [cover] = await qq<{ cover: string | null }>('SELECT cover FROM series_overrides WHERE series_id=$1 FOR SHARE', [id]);
      if (!settings?.automatic_title_logos || cover?.cover === FIRST_PAGE) return;
    }
    const row = await ensureRow(qq, id);
    if (runtime.stopping || cancelled() || row.mode !== 'automatic' || nversion(row.version) !== job.version) return;
    if (found?.kind === 'found' && bytes) {
      const file = await putAsset(id, bytes); const c = found.candidate;
      const attribution: TitleAttribution = { source: 'Wikimedia Commons', sourceUrl: c.attribution.pageUrl,
        artist: c.attribution.author, license: c.attribution.license, licenseUrl: c.attribution.licenseUrl };
      if (runtime.stopping || cancelled()) return;
      await qq(`UPDATE series_title_art SET auto_file=$2, auto_anilist_id=$3, auto_language=$4, auto_caption=$5,
        auto_attribution=$6, lookup_anilist_id=$3, lookup_status='ready', retry_at=NULL, version=$7, auto_manual=$8, auto_cover_key=NULL, updated_at=now()
        WHERE series_id=$1`, [id, file, job.anilistId, c.language == null ? null : c.language === 'en' ? 'en' : 'original', c.showReadableTitle,
        JSON.stringify(attribution), nextVersion(row.version), job.authority === 'manual']);
    } else {
      const supplied = Number((failure as any)?.retryAfterMs);
      const retry = failure ? Math.max(ERROR_MS,
        Number.isSafeInteger(supplied) && supplied >= 0 && supplied <= 8_000_000_000_000_000 - Date.now() ? supplied : ERROR_MS) : MISS_MS;
      await qq(`UPDATE series_title_art SET lookup_anilist_id=$2, lookup_status=$3, retry_at=now()+($4::bigint*interval '1 millisecond'), updated_at=now()
        WHERE series_id=$1`, [id, job.anilistId, failure ? 'error' : 'missing', retry]);
    }
  });
  await collectCurrentAssets(job.id);
}

/** Only strict, opt-in local extraction uses this publisher; a reliable provider logo or manual choice always wins. */
export async function applyAutomaticCoverTitle(id: string, bytes: Buffer, expectedVersion: number, anilistId: string,
  coverKey: string, assertCurrent: (qq: ScopedQuery) => Promise<void>, localBatch=false): Promise<void> {
  const publish=async (qq:ScopedQuery,sid:string) => {
    await qq('SELECT series_id FROM series_trackers WHERE series_id=$1 FOR SHARE',[sid]);
    await qq('SELECT series_id FROM series_overrides WHERE series_id=$1 FOR SHARE',[sid]);
    await qq('SELECT series_id FROM series_art WHERE series_id=$1 FOR SHARE',[sid]);
    const [row] = await qq<ArtRow>(`SELECT s.id,a.*,${coverSelectionSql('s')} AS cover_selection FROM lib_series s
      LEFT JOIN series_title_art a ON a.series_id=s.id WHERE s.id=$1 AND ${visibleToAll('s')}`, [sid]);
    if (!row || runtime.stopping || (row.mode ?? 'automatic') !== 'automatic' || nversion(row.version) !== expectedVersion
      || (row.auto_file && !row.auto_cover_key && (!localBatch||await assetAvailable(row.auto_file))) || coverSelectionKey(row.cover_selection) !== coverKey) throw new TitleArtError('stale_candidate',409,'The title or cover changed.');
    await assertCurrent(qq);
    await ensureRow(qq,sid);
    const file = await putAsset(sid,bytes);
    if(runtime.stopping)throw new TitleArtError('stale_candidate',409,'The server is stopping.');
    await qq(`UPDATE series_title_art SET auto_file=$2,auto_anilist_id=$3,auto_cover_key=$4,auto_language=NULL,auto_caption=true,
      auto_manual=false,auto_attribution=$5,version=$6,updated_at=now() WHERE series_id=$1`,
      [sid,file,anilistId,coverKey,JSON.stringify({source:'Cover lettering',sourceUrl:null,artist:null,license:null,licenseUrl:null}),nextVersion(row.version)]);
  };
  // Local cover processing neither sends metadata nor inherits consent for an external AniList lookup.
  if(localBatch)await tx(async qq=>{await lockVisible(qq,id,SYSTEM_CTX);await publish(qq,id);});
  else await withAniListMutation({id},'automatic',publish);
  await collectCurrentAssets(id);
}

/** Caller first authorizes the viewer and series. A missing file is a 404, never a cover or opaque placeholder. */
export async function readTitleLogo(id: string): Promise<{ bytes: Buffer; version: number } | null> {
  // A concurrent committed replacement can collect the first selected file between the DB read and open.
  // Resolve once more rather than showing a missing logo for that harmless transition.
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = (await rowsFor([id]))[0]; if (!row) return null;
    const file = fileFor(row); if (!file) return null;
    const bytes = await readAsset(file);
    if (bytes) return { bytes, version: nversion(row.version) };
  }
  return null;
}
/** Called only after merge/hard-delete owns retirement of this series. Soft deletion leaves artwork restorable. */
export async function dropTitleArt(id: string): Promise<void> {
  await q('DELETE FROM series_title_art WHERE series_id=$1', [id]);
  await collectAssets(id, []);
}
