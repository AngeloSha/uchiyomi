// Offline chapter store (IndexedDB): page blobs + chapter metadata + a progress outbox.
import { openDB, IDBPDatabase } from 'idb';
import { api, ApiError } from './api';
import { DownloadManifest } from './types';
import { deviceId } from './device';

const DB_NAME = 'yomi-offline';
const VERSION = 1;

export interface OfflineChapter {
  bookId: string;
  seriesId: string;
  seriesTitle: string;
  title: string;
  number: string;
  pageCount: number;
  readingDirection?: string;
  totalBytes: number;
  savedAt: number;
  pages: { number: number; width: number | null; height: number | null }[];
}

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB(DB_NAME, VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('chapters')) d.createObjectStore('chapters', { keyPath: 'bookId' });
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages');
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      },
    });
  }
  return dbp;
}

export async function isDownloaded(bookId: string): Promise<boolean> {
  const d = await db();
  return !!(await d.get('chapters', bookId));
}

export async function listDownloads(): Promise<OfflineChapter[]> {
  const d = await db();
  const all = (await d.getAll('chapters')) as OfflineChapter[];
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function getOfflineChapter(bookId: string): Promise<OfflineChapter | undefined> {
  const d = await db();
  return (await d.get('chapters', bookId)) as OfflineChapter | undefined;
}

export async function getPageBlob(bookId: string, n: number): Promise<Blob | undefined> {
  const d = await db();
  return (await d.get('pages', `${bookId}:${n}`)) as Blob | undefined;
}

export async function downloadChapter(
  bookId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<OfflineChapter> {
  const manifest = await api<DownloadManifest>(`/api/books/${bookId}/download-manifest`);
  const dev = deviceId();
  await api('/api/downloads', {
    json: { bookId, seriesId: manifest.seriesId, deviceId: dev, status: 'downloading', pageCount: manifest.pageCount, bytes: manifest.totalBytes },
  }).catch(() => {});

  const d = await db();
  let done = 0;
  try {
    for (const p of manifest.pages) {
      const res = await fetch(p.url, { credentials: 'include' });
      if (!res.ok) throw new Error(`page ${p.number}: HTTP ${res.status}`);
      const blob = await res.blob();
      await d.put('pages', blob, `${bookId}:${p.number}`);
      done++;
      onProgress?.(done, manifest.pages.length);
    }
  } catch (e) {
    // Take the half-download with us. The `chapters` record below is the ONLY index of what is stored, and it
    // is written last, so a failure at page 30 of 50 used to strand 29 full-size blobs that no UI path could
    // ever reach: deleteDownload reads the meta first and skips the pages when it is missing, and
    // clearAllDownloads iterates listDownloads(), which reads only `chapters`. Smart-offline re-runs on every
    // visibilitychange and every `online` event, so on a phone with poor signal this accumulated daily until
    // the quota filled -- at which point "free up space" moved nothing, because nothing knew they were there.
    for (let n = 0; n < done; n++) {
      await d.delete('pages', `${bookId}:${manifest.pages[n].number}`).catch(() => {});
    }
    throw e;
  }

  const meta: OfflineChapter = {
    bookId,
    seriesId: manifest.seriesId,
    seriesTitle: manifest.seriesTitle,
    title: manifest.title,
    number: manifest.number,
    pageCount: manifest.pageCount,
    readingDirection: manifest.readingDirection,
    totalBytes: manifest.totalBytes,
    savedAt: Date.now(),
    pages: manifest.pages.map((p) => ({ number: p.number, width: p.width, height: p.height })),
  };
  await d.put('chapters', meta);
  await api('/api/downloads', {
    json: { bookId, seriesId: manifest.seriesId, deviceId: dev, status: 'complete', pageCount: manifest.pageCount, bytes: manifest.totalBytes },
  }).catch(() => {});
  return meta;
}

export async function deleteDownload(bookId: string): Promise<void> {
  const d = await db();
  const meta = (await d.get('chapters', bookId)) as OfflineChapter | undefined;
  if (meta) {
    for (const p of meta.pages) await d.delete('pages', `${bookId}:${p.number}`);
  }
  await d.delete('chapters', bookId);
  api(`/api/downloads/${bookId}?deviceId=${deviceId()}`, { method: 'DELETE' }).catch(() => {});
}

/** Remove every offline chapter of one series. Returns how many were deleted. */
export async function deleteSeriesDownloads(seriesId: string): Promise<number> {
  const all = await listDownloads();
  const mine = all.filter((c) => c.seriesId === seriesId);
  for (const c of mine) await deleteDownload(c.bookId);
  return mine.length;
}

/** Remove all offline chapters on this device. Returns how many were deleted. */
export async function clearAllDownloads(): Promise<number> {
  const all = await listDownloads();
  for (const c of all) await deleteDownload(c.bookId);
  return all.length;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  }
  return { usage: 0, quota: 0 };
}

export async function requestPersist(): Promise<boolean> {
  try {
    return navigator.storage?.persist ? await navigator.storage.persist() : false;
  } catch {
    return false;
  }
}

// ---- progress outbox (queued while offline, flushed on reconnect) ----
export interface ProgressEvent {
  bookId: string;
  seriesId?: string;
  page: number;
  completed: boolean;
  deviceId?: string;
}

export async function queueProgress(ev: ProgressEvent): Promise<void> {
  const d = await db();
  await d.add('outbox', { ...ev, ts: Date.now(), tries: 0 });
  // background sync: the SW flushes the outbox when connectivity returns, even if the app is closed
  try {
    // Bounded: `serviceWorker.ready` never resolves when no worker becomes active, and this is awaited on
    // every page turn. The event is already in the outbox by this point, so the worst a timeout costs is the
    // background-sync hint, which the foreground flush covers anyway.
    const reg = await Promise.race([
      navigator.serviceWorker?.ready,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
    ]);
    await (reg as any)?.sync?.register('yomi-progress');
  } catch { /* no background-sync support — the foreground online/timer flush still runs */ }
}

/**
 * A queued event may only be discarded when the server has PERMANENTLY rejected it.
 *
 * `api()` throws the same way for a dead network, a 401 mid-refresh, a 429 and a 500 as it does for a bad
 * payload, so counting attempts and dropping at five treated "the server is down" as "this entry is
 * poisoned". Read twenty chapters on a plane, land, let the phone flap between cellular and a captive portal,
 * and the queue was deleted with no message: progress, streaks and Continue Reading all rewound.
 *
 * The service worker's copy of this same queue (public/sw.js) has always drawn the line here instead, and
 * the two disagreeing is what showed this one up. A genuinely poisoned entry still leaves immediately, as a
 * 4xx; nothing else is a reason to throw away something somebody read.
 */
function permanentlyRejected(e: unknown): boolean {
  const status = e instanceof ApiError ? e.status : 0;
  return status >= 400 && status < 500 && status !== 401 && status !== 429;
}

export async function flushOutbox(): Promise<number> {
  const d = await db();
  // One read, and the key comes off the record, which carries it (`keyPath: 'id'`). Reading `getAllKeys` and
  // `getAll` separately meant two IDB transactions: the service worker flushing between them shifted the
  // arrays out of step, after which a failure on one entry deleted a different, unrelated one.
  const all = (await d.getAll('outbox')) as Array<ProgressEvent & { id?: number; tries?: number; ts?: number }>;
  let sent = 0;
  for (const ev of all) {
    if (ev.id == null) continue; // written before autoIncrement keys existed; nothing safe to delete by
    try {
      await api(`/api/books/${ev.bookId}/progress`, {
        method: 'PUT',
        json: { page: ev.page, completed: ev.completed, seriesId: ev.seriesId, deviceId: ev.deviceId, at: ev.ts },
      });
      await d.delete('outbox', ev.id);
      sent++;
    } catch (e) {
      if (permanentlyRejected(e)) await d.delete('outbox', ev.id);
      // Otherwise it stays queued. `tries` is kept for diagnostics only: it must never again decide whether
      // someone's reading survives. A failing entry does not block the others -- this loop moves on regardless.
      else await d.put('outbox', { ...ev, tries: (ev.tries ?? 0) + 1 });
    }
  }
  return sent;
}
