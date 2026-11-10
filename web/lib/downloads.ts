// Offline chapter store (IndexedDB): page blobs + chapter metadata + a progress outbox.
import { openDB, IDBPDatabase } from 'idb';
import { api, apiResponse, ApiError, getCurrentUser } from './api';
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
  /**
   * Where this reader last was in this chapter, and when.
   *
   * Written alongside every progress ping so a downloaded chapter can resume with no network. The server is
   * still the source of truth when it answers -- progress is cross-device and the outbox pushes this value up
   * -- so the reader consults it only after a live read fails.
   *
   * ADDED WITHOUT A VERSION BUMP, on purpose. IndexedDB records are schemaless: an older record simply lacks
   * the field and falls through to page 1, exactly as before. Bumping VERSION to add a number would re-enter
   * the upgrade hazard documented above, where the service worker's open connection blocked the v1 -> v2
   * upgrade and every reader hung on "Loading chapter...".
   */
  lastPage?: number;
  lastPageAt?: number;
  lastCompleted?: boolean;
  /**
   * `junk` is captured at download time so an offline chapter skips exactly what the online one does.
   * `missing` (v0.40.0) likewise: the placeholder bytes download like any page, and the caption over them
   * is drawn from this flag, so a chapter saved short still explains itself with no network.
   */
  pages: { number: number; width: number | null; height: number | null; junk?: boolean; missing?: true; removed?: true; restorable?: boolean; contentVersion?: string; join?: 'rtl' | 'ltr'; mark?: 'join' | 'split' }[];
}

/**
 * The account these records belong to. `anon` is a deliberate dead end rather than a shared bucket: if
 * nobody is signed in there is nothing legitimate to read, and writing under a shared key would recreate
 * exactly the leak this file is fixing.
 */
const actorOf = (expected?:string|null) => expected===undefined?getCurrentUser():expected;
const sameActor = (actor:string|null):actor is string => !!actor && getCurrentUser()===actor;
const chapterKey = (bookId:string,actor:string) => `${actor}:${bookId}`;
const pageKey = (bookId:string,n:number,actor:string) => `${actor}:${bookId}:${n}`;
const changedAccount = () => new ApiError(409,JSON.stringify({error:'account_changed'}));
function assertActor(actor:string|null):asserts actor is string {if(!sameActor(actor))throw changedAccount();}
export const offlineAccountChanged = (error:unknown) => error instanceof ApiError && error.status===409 && /"error"\s*:\s*"account_changed"/.test(error.body);

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

export async function isDownloaded(bookId: string,expectedOwnerId?:string|null): Promise<boolean> {
  const actor=actorOf(expectedOwnerId);if(!sameActor(actor))return false;
  try {
    const d = await db();
    const result=await d.get('chapters',chapterKey(bookId,actor));return sameActor(actor)&&!!result;
  } catch { return false; }
}

/**
 * The ids of every series with at least one chapter saved on this device.
 *
 * One index read for a whole grid, rather than `isDownloaded()` per tile -- a library page renders hundreds
 * of cards, and that would be hundreds of IndexedDB round trips to answer one boolean each.
 *
 * ⚠️ The cache lives HERE, beside the writes that invalidate it, and not in the hook that reads it. It was
 * in the hook first, with an exported invalidator that nothing ever called -- so the badge set was cached
 * for the life of the tab and went stale the moment you downloaded or deleted anything. Putting it next to
 * `downloadChapter` and `deleteDownload` is what makes forgetting to invalidate it hard: the cache and the
 * only two things that can falsify it are now in the same file, a few lines apart. (The hook cannot own
 * this and also be called from here -- it imports this module, so the dependency only goes one way.)
 */
let seriesIdCache: {actor:string;ids:Set<string>} | null = null;

export async function downloadedSeriesIds(expectedOwnerId?:string|null): Promise<Set<string>> {
  const actor=actorOf(expectedOwnerId);if(!sameActor(actor))return new Set();
  if(seriesIdCache?.actor===actor)return seriesIdCache.ids;
  const rows=await listDownloads(actor);if(!sameActor(actor))return new Set();
  seriesIdCache={actor,ids:new Set(rows.map(c=>c.seriesId))};return seriesIdCache.ids;
}

/** Called by every write below. Reintroduce by dropping a call: the badges lie until the tab is reloaded. */
export function invalidateDownloadedSeries(): void {
  seriesIdCache = null;
}

export async function listDownloads(expectedOwnerId?:string|null): Promise<OfflineChapter[]> {
  const actor=actorOf(expectedOwnerId);if(!sameActor(actor))return [];
  try {
    const d = await db();
    // From the index, not the whole store: another account's downloads must not appear even in a count.
    const all = (await d.getAllFromIndex('chapters', 'byUser', actor)) as OfflineChapter[];
    if(!sameActor(actor))return [];
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; }
}

/**
 * Remember where the reader is in a downloaded chapter.
 *
 * A no-op for a chapter that was never downloaded -- there is nothing to annotate, and inventing a record
 * would put a chapter in the Downloads list that holds no pages. Never throws: this rides along with a page
 * turn and must not be able to interrupt one.
 */
export async function noteOfflineProgress(bookId: string, page: number, completed: boolean,expectedOwnerId?:string|null): Promise<void> {
  const actor=actorOf(expectedOwnerId);if(!sameActor(actor))return;
  try {
    const d = await db();
    const key = chapterKey(bookId,actor);
    const rec = (await d.get('chapters', key)) as OfflineChapter | undefined;
    if (!rec || !sameActor(actor)) return;
    // A late write must not rewind a newer one. Progress pings are debounced and can land out of order.
    const at = Date.now();
    if (rec.lastPageAt != null && at < rec.lastPageAt) return;
    await d.put('chapters', { ...rec, lastPage: page, lastPageAt: at, lastCompleted: completed });
  } catch { /* a convenience, never a blocker */ }
}

/**
 * Carry a by-hand skip decision into the downloaded copy of a chapter.
 *
 * ⚠️ Without this the correction appears to work and then silently undoes itself. `loadChapter` consults the
 * offline record BEFORE the server, so for a downloaded chapter the stored `junk` flag is what the reader
 * actually reads -- the server would have the decision and never be asked. The page grid is the one place a
 * person states an intent about a page, so it has to reach both copies.
 *
 * No VERSION bump: `junk` is just another field on a schemaless record, exactly like `lastPage` above.
 */
export async function setOfflinePageJunk(bookId: string, pageNumber: number, junk: boolean,expectedOwnerId?:string|null): Promise<void> {
  const actor=actorOf(expectedOwnerId);if(!sameActor(actor))return;
  try {
    const d = await db();
    const key = chapterKey(bookId,actor);
    const rec = (await d.get('chapters', key)) as OfflineChapter | undefined;
    if (!rec || !sameActor(actor)) return;   // not downloaded: the server copy is the only one, and it is already updated
    await d.put('chapters', {
      ...rec,
      pages: rec.pages.map((p) => (p.number === pageNumber ? { ...p, junk } : p)),
    });
  } catch { /* the server still has the decision; this is the local mirror */ }
}

/**
 * Carry a reader's own merges and splits (v0.89.0, #262, lib/spreadMarks.ts) into the downloaded copy, for the reason
 * setOfflinePageJunk does: the reader reads a downloaded chapter's pages from here, before the server. `marks` is the
 * chapter's whole set as the server answered it, so the copy ends up holding exactly that.
 */
export async function setOfflineSpreadMarks(bookId: string, marks: ReadonlyMap<number, 'join' | 'split'>,expectedOwnerId?:string|null): Promise<void> {
  const actor=actorOf(expectedOwnerId);if(!sameActor(actor))return;
  try {
    const d = await db();
    const key = chapterKey(bookId,actor);
    const rec = (await d.get('chapters', key)) as OfflineChapter | undefined;
    if (!rec || !sameActor(actor)) return;
    await d.put('chapters', { ...rec, pages: rec.pages.map((p) => ({ ...p, mark: marks.get(p.number) })) });
  } catch { /* the server still has them; this is the local mirror */ }
}

/**
 * The chapters of one series that are actually on this device, in reading order.
 *
 * This is what lets the reader move between chapters offline. `number` is a string off the manifest, so the
 * sort is numeric -- lexicographically "10" sorts before "9" and the reader would walk them out of order.
 */
export async function listSeriesDownloads(seriesId: string,expectedOwnerId?:string|null): Promise<OfflineChapter[]> {
  const actor=actorOf(expectedOwnerId),all = await listDownloads(actor);
  if(!sameActor(actor))return [];
  return all
    .filter((c) => c.seriesId === seriesId)
    .sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0) || a.savedAt - b.savedAt);
}

export async function getOfflineChapter(bookId: string,expectedOwnerId?:string|null): Promise<OfflineChapter | undefined> {
  const actor=actorOf(expectedOwnerId);if(!sameActor(actor))return;
  try {
    const d = await db();
    const result=await d.get('chapters',chapterKey(bookId,actor));return sameActor(actor)?result:undefined;
  } catch { return undefined; }
}

export async function getPageBlob(bookId: string, n: number,expectedOwnerId?:string|null): Promise<Blob | undefined> {
  const actor=actorOf(expectedOwnerId);if(!sameActor(actor))return;
  try {
    const d = await db();
    const result=await d.get('pages',pageKey(bookId,n,actor));return sameActor(actor)?result:undefined;
  } catch { return undefined; }
}

const activeDownloads=new Map<string,Promise<OfflineChapter>>();
export async function downloadChapter(
  bookId: string,
  onProgress?: (done: number, total: number) => void,
  expectedOwnerId?:string|null,
): Promise<OfflineChapter> {
  const actor=actorOf(expectedOwnerId);assertActor(actor);
  const key=chapterKey(bookId,actor),existing=activeDownloads.get(key);if(existing)return existing;
  const pending=saveChapter(bookId,actor,onProgress).finally(()=>{if(activeDownloads.get(key)===pending)activeDownloads.delete(key);});
  activeDownloads.set(key,pending);return pending;
}
async function saveChapter(bookId:string,actor:string,onProgress?: (done:number,total:number)=>void):Promise<OfflineChapter>{
  const d=await db();assertActor(actor);
  const manifest = await api<DownloadManifest>(`/api/books/${bookId}/download-manifest`,{expectedOwnerId:actor});
  assertActor(actor);
  const dev = deviceId();
  await api('/api/downloads', {
    expectedOwnerId:actor,
    json: { bookId, seriesId: manifest.seriesId, deviceId: dev, status: 'downloading', pageCount: manifest.pageCount, bytes: manifest.totalBytes },
  }).catch(() => {});

  assertActor(actor);
  let done = 0;
  const attempt=crypto.randomUUID();
  const staged=(number:number)=>`${actor}:${bookId}:pending:${attempt}:${number}`;
  const cleanup=async()=>{for(let n=0;n<done;n++)await d.delete('pages',staged(manifest.pages[n].number)).catch(()=>{});};
  try {
    for (const p of manifest.pages) {
      assertActor(actor);
      const res = await apiResponse(p.url,{expectedOwnerId:actor});
      const blob = await res.blob();
      assertActor(actor);
      await d.put('pages', blob, staged(p.number));
      done++;
      assertActor(actor);
      onProgress?.(done, manifest.pages.length);
    }
  } catch (e) {
    // Take the half-download with us. The `chapters` record below is the ONLY index of what is stored, and it
    // is written last, so a failure at page 30 of 50 used to strand 29 full-size blobs that no UI path could
    // ever reach: deleteDownload reads the meta first and skips the pages when it is missing, and
    // clearAllDownloads iterates listDownloads(), which reads only `chapters`. Smart-offline re-runs on every
    // visibilitychange and every `online` event, so on a phone with poor signal this accumulated daily until
    // the quota filled -- at which point "free up space" moved nothing, because nothing knew they were there.
    await cleanup();
    throw e;
  }

  const meta: OfflineChapter = {
    key: chapterKey(bookId,actor),
    userId: actor,
    bookId,
    seriesId: manifest.seriesId,
    seriesTitle: manifest.seriesTitle,
    title: manifest.title,
    number: manifest.number,
    pageCount: manifest.pageCount,
    readingDirection: manifest.readingDirection,
    totalBytes: manifest.totalBytes,
    savedAt: Date.now(),
    // ⚠️ `missing` is copied beside `junk` or the offline reader loses it: this record is what the reader
    // consults BEFORE the server for a downloaded chapter, so a flag that only lives in the manifest is a
    // flag the reader never sees. Reintroduce by dropping `missing` here: a chapter saved short, downloaded,
    // shows a blank grey page offline where online it shows the caption.
    // v0.89.0 (#262): the account's own merges and splits (`mark`) ride along for the same reason.
    pages: manifest.pages.map((p) => ({ number: p.number, width: p.width, height: p.height, junk: p.junk, missing: p.missing, removed: p.removed, restorable: p.restorable, contentVersion: p.contentVersion, join: p.join, mark: p.mark })),
  };
  // Publish the complete set atomically. A failed retry or an owner switch cannot destroy an existing
  // completed copy, and no incomplete blob is ever associated with the next account's metadata.
  try{
    assertActor(actor);
    const tx=d.transaction(['pages','chapters'],'readwrite');
    try{
      for(const p of manifest.pages){
        const blob=await tx.objectStore('pages').get(staged(p.number));assertActor(actor);
        if(!blob)throw new Error('offline staged page missing');
        await tx.objectStore('pages').put(blob,pageKey(bookId,p.number,actor));
        await tx.objectStore('pages').delete(staged(p.number));
      }
      assertActor(actor);await tx.objectStore('chapters').put(meta);await tx.done;
    }catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}
  }catch(error){await cleanup();throw error;}
  invalidateDownloadedSeries();
  assertActor(actor);
  await api('/api/downloads', {
    expectedOwnerId:actor,
    json: { bookId, seriesId: manifest.seriesId, deviceId: dev, status: 'complete', pageCount: manifest.pageCount, bytes: manifest.totalBytes },
  }).catch(() => {});
  assertActor(actor);
  return meta;
}

export async function deleteDownload(bookId: string,expectedOwnerId?:string|null): Promise<void> {
  const actor=actorOf(expectedOwnerId);assertActor(actor);
  const d = await db();
  assertActor(actor);
  // One transaction: switching or closing the document halfway through must not leave completed
  // metadata pointing at already deleted pages. The same lock also excludes a concurrent save commit.
  const tx=d.transaction(['chapters','pages'],'readwrite');
  try{
    const meta=(await tx.objectStore('chapters').get(chapterKey(bookId,actor))) as OfflineChapter|undefined;
    assertActor(actor);
    if(meta)for(const p of meta.pages){await tx.objectStore('pages').delete(pageKey(bookId,p.number,actor));assertActor(actor);}
    await tx.objectStore('chapters').delete(chapterKey(bookId,actor));assertActor(actor);await tx.done;
  }catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}
  invalidateDownloadedSeries();
  api(`/api/downloads/${bookId}?deviceId=${deviceId()}`, { method: 'DELETE',expectedOwnerId:actor }).catch(() => {});
}

/** Remove every offline chapter of one series. Returns how many were deleted. */
export async function deleteSeriesDownloads(seriesId: string,expectedOwnerId?:string|null): Promise<number> {
  const actor=actorOf(expectedOwnerId);assertActor(actor);
  const all = await listDownloads(actor);assertActor(actor);
  const mine = all.filter((c) => c.seriesId === seriesId);
  for (const c of mine) await deleteDownload(c.bookId,actor);
  return mine.length;
}

/** Remove all offline chapters on this device. Returns how many were deleted. */
export async function clearAllDownloads(expectedOwnerId?:string|null): Promise<number> {
  const actor=actorOf(expectedOwnerId);assertActor(actor);
  const all = await listDownloads(actor);assertActor(actor);
  for (const c of all) await deleteDownload(c.bookId,actor);
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
  at?:number;
  /**
   * v0.61.0: read under Incognito reading (lib/incognito.ts). Kept with the event and sent with it, so a page read while
   * it was on stays out of history even when the queue flushes after it was turned off.
   */
  incognito?: boolean;
}

export async function queueProgress(ev: ProgressEvent,expectedOwnerId?:string|null): Promise<void> {
  // Refuse anonymous or stale callbacks before queuing. Neither flush guesses the owner of older
  // unattributed records; those stay quarantined instead of entering the next account's history.
  const actor=actorOf(expectedOwnerId),at=ev.at??Date.now();if(!sameActor(actor))return;
  const d = await db();
  if(!sameActor(actor))return;
  // Stamped with the owner because the flush authenticates as whoever is signed in AT THAT MOMENT, which is
  // not necessarily who read the pages. On a shared device, A's queued chapters would otherwise be filed
  // against B's reading history, streaks and leaderboard position.
  await d.add('outbox', { ...ev, userId:actor, ts:at, tries: 0 });
  if(!sameActor(actor))return;
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
  return status >= 400 && status < 500 && status !== 401 && status !== 429 && !offlineAccountChanged(e);
}

export async function flushOutbox(): Promise<number> {
  const me=getCurrentUser();if(!sameActor(me))return 0;
  let d;
  try { d = await db(); } catch { return 0; } // unavailable store: the queue waits, nothing is lost
  // One read, and the key comes off the record, which carries it (`keyPath: 'id'`). Reading `getAllKeys` and
  // `getAll` separately meant two IDB transactions: the service worker flushing between them shifted the
  // arrays out of step, after which a failure on one entry deleted a different, unrelated one.
  const all = (await d.getAll('outbox')) as Array<ProgressEvent & { id?: number; tries?: number; ts?: number; userId?: string }>;
  if(!sameActor(me))return 0;
  let sent = 0;
  for (const ev of all) {
    if (ev.id == null) continue; // written before autoIncrement keys existed; nothing safe to delete by
    if(!sameActor(me))break;
    // An unattributed legacy event is retained for review, never guessed to belong to whoever signs in next.
    if (ev.userId !== me) continue;
    try {
      await api(`/api/books/${ev.bookId}/progress`, {
        method: 'PUT',
        expectedOwnerId:me,
        json: { page: ev.page, completed: ev.completed, seriesId: ev.seriesId, deviceId: ev.deviceId, at: ev.ts, ...(ev.incognito ? { incognito: true } : {}) },
      });
      if(!sameActor(me))break;
      await d.delete('outbox', ev.id);
      sent++;
    } catch (e) {
      if(!sameActor(me) || offlineAccountChanged(e))break;
      if (permanentlyRejected(e)) await d.delete('outbox', ev.id);
      // Otherwise it stays queued. `tries` is kept for diagnostics only: it must never again decide whether
      // someone's reading survives. A failing entry does not block the others -- this loop moves on regardless.
      else await d.put('outbox', { ...ev, tries: (ev.tries ?? 0) + 1 });
    }
  }
  return sent;
}
