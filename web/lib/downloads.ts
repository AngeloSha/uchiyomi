// Offline chapter store (IndexedDB): page blobs + chapter metadata + a progress outbox.
import { openDB, IDBPDatabase } from 'idb';
import { api } from './api';
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
  for (const p of manifest.pages) {
    const res = await fetch(p.url, { credentials: 'include' });
    if (!res.ok) throw new Error(`page ${p.number}: HTTP ${res.status}`);
    const blob = await res.blob();
    await d.put('pages', blob, `${bookId}:${p.number}`);
    done++;
    onProgress?.(done, manifest.pages.length);
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
    const reg = await navigator.serviceWorker?.ready;
    await (reg as any)?.sync?.register('yomi-progress');
  } catch { /* no background-sync support — the foreground online/timer flush still runs */ }
}

export async function flushOutbox(): Promise<number> {
  const d = await db();
  const keys = await d.getAllKeys('outbox');
  const all = (await d.getAll('outbox')) as Array<ProgressEvent & { tries?: number }>;
  let sent = 0;
  for (let i = 0; i < all.length; i++) {
    const ev = all[i];
    try {
      await api(`/api/books/${ev.bookId}/progress`, {
        method: 'PUT',
        json: { page: ev.page, completed: ev.completed, seriesId: ev.seriesId, deviceId: ev.deviceId },
      });
      await d.delete('outbox', keys[i]);
      sent++;
    } catch {
      // don't let one poisoned entry (deleted book, bad payload) block the whole queue forever:
      // count the failure and drop the entry after 5 attempts; keep trying the rest this pass
      const tries = (ev.tries ?? 0) + 1;
      if (tries >= 5) await d.delete('outbox', keys[i]);
      else await d.put('outbox', { ...ev, tries }); // outbox has keyPath 'id' — the record carries its own key
    }
  }
  return sent;
}
