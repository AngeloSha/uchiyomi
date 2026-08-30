// Offline chapter store (IndexedDB): page blobs + chapter metadata + a progress outbox.
import { openDB, IDBPDatabase } from 'idb';
import { api, ApiError, getCurrentUser } from './api';
import { DownloadManifest } from './types';
import { deviceId } from './device';

const DB_NAME = 'yomi-offline';
/**
 * v2 scopes every record to the account that downloaded it.
 *
 * v1 keyed `chapters` by bookId alone and `pages` by `bookId:n`, with no account anywhere. The reader
 * consults this store BEFORE any server call (`loadChapter` in app/reader/page.tsx returns the offline copy
 * and never asks), so on a shared device the next person to sign in could open the previous person's
 * downloads by navigating to those book ids, with `visible()` never consulted and the age cap and library
 * grants both bypassed. That is the same hole the v0.11.0 sign-out purge closed for cached API responses,
 * left open on the larger and more permanent store beside it.
 *
 * The v1 records are dropped rather than migrated: nothing in them records who saved them, so there is no
 * honest owner to assign. Losing a re-downloadable cache is the right side of that trade.
 */
const VERSION = 2;

export interface OfflineChapter {
  /** `${userId}:${bookId}` — the primary key, and the whole point of v2. */
  key: string;
  /** Who downloaded it. Indexed, so listing is a lookup rather than a filter over everyone's records. */
  userId: string;
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

/**
 * The account these records belong to. `anon` is a deliberate dead end rather than a shared bucket: if
 * nobody is signed in there is nothing legitimate to read, and writing under a shared key would recreate
 * exactly the leak this file is fixing.
 */
const owner = () => getCurrentUser() || 'anon';
const chapterKey = (bookId: string) => `${owner()}:${bookId}`;
const pageKey = (bookId: string, n: number) => `${owner()}:${bookId}:${n}`;

/**
 * Opening this database must never be able to hang, and v0.11.1 proved why.
 *
 * An IndexedDB version change waits for every OTHER open connection to close first. The service worker held
 * one (it opened `yomi-offline` for the outbox flush and never closed it), so the page's v1 to v2 upgrade
 * fired `blocked` and, with no handler, the promise never settled. `loadChapter` awaits the offline lookup
 * before it does anything else, so the reader sat on "Loading chapter..." forever, for every chapter, for
 * anyone who already had the old database. A fresh browser creates v2 directly and never blocks, which is
 * exactly why the browser end-to-end pass did not catch it.
 *
 * Two defences, because either alone is thin. `blocked` gives up rather than waiting, and the deadline makes
 * "the store is unavailable" a bounded answer rather than a state the app can wait in.
 */
const DB_OPEN_TIMEOUT = 4000;

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    // `blocked` REJECTS this, it does not throw. Throwing inside the callback escapes as an uncaught
    // exception (idb dispatches it through an event target) instead of settling the open, which is a
    // different way of not answering.
    let refuse!: (e: Error) => void;
    const blocked = new Promise<never>((_, rej) => { refuse = rej; });

    const open = openDB(DB_NAME, VERSION, {
      blocked() {
        refuse(new Error('offline store upgrade blocked by another connection'));
      },
      blocking() {
        // We are holding up somebody ELSE's upgrade. Let go at once and drop the handle, so the next call
        // reopens cleanly at the new version.
        dbp = null;
        void open.then((d) => d.close()).catch(() => {});
      },
      terminated() {
        dbp = null; // the browser dropped it; reopen on next use rather than failing forever
      },
      upgrade(d, oldVersion) {
        // Unattributable v1 content goes. The outbox is deliberately NOT dropped: it holds reading that has
        // not reached the server yet, and losing it would be exactly the data loss v0.11.0 was spent closing.
        if (oldVersion < 2) {
          if (d.objectStoreNames.contains('chapters')) d.deleteObjectStore('chapters');
          if (d.objectStoreNames.contains('pages')) d.deleteObjectStore('pages');
        }
        if (!d.objectStoreNames.contains('chapters')) {
          d.createObjectStore('chapters', { keyPath: 'key' }).createIndex('byUser', 'userId');
        }
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages');
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      },
    });
    // If the open later succeeds after we already gave up, close it rather than leaking the handle, and
    // never let its rejection surface unhandled.
    void open.then((d) => { if (dbp === null) d.close(); }).catch(() => {});

    dbp = Promise.race([
      open,
      blocked,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('offline store did not open in time')), DB_OPEN_TIMEOUT)),
    ]).catch((e) => {
      dbp = null; // never cache the failure: a block clears the moment the other connection goes away
      throw e;
    });
  }
  return dbp;
}

export async function isDownloaded(bookId: string): Promise<boolean> {
  try {
    const d = await db();
    return !!(await d.get('chapters', chapterKey(bookId)));
  } catch { return false; }
}

export async function listDownloads(): Promise<OfflineChapter[]> {
  try {
    const d = await db();
    // From the index, not the whole store: another account's downloads must not appear even in a count.
    const all = (await d.getAllFromIndex('chapters', 'byUser', owner())) as OfflineChapter[];
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; }
}

export async function getOfflineChapter(bookId: string): Promise<OfflineChapter | undefined> {
  try {
    const d = await db();
    return (await d.get('chapters', chapterKey(bookId))) as OfflineChapter | undefined;
  } catch { return undefined; }
}

export async function getPageBlob(bookId: string, n: number): Promise<Blob | undefined> {
  try {
    const d = await db();
    return (await d.get('pages', pageKey(bookId, n))) as Blob | undefined;
  } catch { return undefined; }
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
      await d.put('pages', blob, pageKey(bookId, p.number));
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
      await d.delete('pages', pageKey(bookId, manifest.pages[n].number)).catch(() => {});
    }
    throw e;
  }

  const meta: OfflineChapter = {
    key: chapterKey(bookId),
    userId: owner(),
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
  const meta = (await d.get('chapters', chapterKey(bookId))) as OfflineChapter | undefined;
  if (meta) {
    for (const p of meta.pages) await d.delete('pages', pageKey(bookId, p.number));
  }
  await d.delete('chapters', chapterKey(bookId));
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
  // Stamped with the owner because the flush authenticates as whoever is signed in AT THAT MOMENT, which is
  // not necessarily who read the pages. On a shared device, A's queued chapters would otherwise be filed
  // against B's reading history, streaks and leaderboard position.
  await d.add('outbox', { ...ev, userId: owner(), ts: Date.now(), tries: 0 });
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
  let d;
  try { d = await db(); } catch { return 0; } // unavailable store: the queue waits, nothing is lost
  // One read, and the key comes off the record, which carries it (`keyPath: 'id'`). Reading `getAllKeys` and
  // `getAll` separately meant two IDB transactions: the service worker flushing between them shifted the
  // arrays out of step, after which a failure on one entry deleted a different, unrelated one.
  const all = (await d.getAll('outbox')) as Array<ProgressEvent & { id?: number; tries?: number; ts?: number; userId?: string }>;
  const me = owner();
  let sent = 0;
  for (const ev of all) {
    if (ev.id == null) continue; // written before autoIncrement keys existed; nothing safe to delete by
    // Another account's queued reading waits for them to sign back in. Events written before v2 carry no
    // owner; those still go, because the alternative is discarding reading that was genuinely recorded.
    if (ev.userId && ev.userId !== me) continue;
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
