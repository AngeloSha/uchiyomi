// One page in the engine's browser at a time (v0.91.0, #314), for two callers:
//
//  - an admin's Open site (Admin → Sources → an extension → Open site): the page is shown to them live and they sign in,
//    or pass a check, with their own clicks and keys; Done leaves the page, and leaving is what makes the engine save
//    the cookies (engineBrowser.ts);
//  - passSiteCheck, the quiet visit: an extension that answers "Open in WebView…" -- its own background browser could not
//    pass the site's check -- gets the site's home page opened for a few seconds and the call tried once more.
//
// ⚠️ The engine has ONE browser and a second client closes the first, so both go through `current`: a quiet visit never
// starts while an admin has the page, and an admin's page is never closed by one.
import { randomBytes } from 'crypto';
import { openEngineBrowser, type BrowserInput, type BrowserOpener, type EngineBrowser } from './engineBrowser';

/** A line of the live stream a page's sheet reads (routes/admin.ts). */
export type SiteLine =
  | { type: 'frame'; seq: number; png: string }
  | { type: 'address'; url: string; title: string }
  | { type: 'load'; url: string; title: string; status: number; error?: string | null }
  | { type: 'closed'; reason: 'done' | 'idle' | 'replaced' | 'engine' }
  | { type: 'ping' };

/** What an admin's sheet may send: the page's own input, a new size, or back to the source's home page. */
export type SiteInput =
  | Extract<BrowserInput, { type: 'event' } | { type: 'paste' } | { type: 'resize' }>
  | { type: 'home' };

interface Session {
  id: string;
  /** The admin's id, or '' for a quiet visit. */
  uid: string;
  sourceId: string;
  home: string;
  size: { width: number; height: number };
  browser: EngineBrowser | null;
  lastInput: number;
  frame: { seq: number; png: string } | null;
  address: { url: string; title: string } | null;
  listeners: Set<(l: SiteLine) => void>;
  pending: Buffer | null;
  lastEmit: number;
  frameTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
  onActivity: (() => void) | null;
}

/** No input for ten minutes: the page is left, so the engine saves what it has and frees its browser. */
export const SITE_IDLE_MS = 10 * 60_000;
/** Thirty minutes at most, whatever happens on it. */
export const SITE_MAX_MS = 30 * 60_000;
/** At most five pictures a second reach the sheet; a newer one replaces one not sent yet. */
export const FRAME_GAP_MS = 200;
/** Another admin's page counts as in use while it had input in the last minute. */
const BUSY_MS = 60_000;

let opener: BrowserOpener = openEngineBrowser;
/** Test seam: a fake engine browser. Called with nothing, back to the real one. */
export function setBrowserOpener(o?: BrowserOpener): void { opener = o ?? openEngineBrowser; }

let current: Session | null = null;

/** Whether the engine's browser is in use, by an admin or by a quiet visit. */
export const siteSessionActive = (): boolean => !!current;

export class SiteBusyError extends Error {
  constructor() { super('Another admin has a site open in the extension engine. Try again in a minute.'); }
}

function emit(s: Session, line: SiteLine): void {
  for (const l of s.listeners) {
    try { l(line); } catch { /* a listener that went away */ }
  }
}

function flushFrame(s: Session): void {
  s.frameTimer = null;
  if (!s.pending) return;
  s.frame = { seq: (s.frame?.seq ?? 0) + 1, png: s.pending.toString('base64') };
  s.pending = null;
  s.lastEmit = Date.now();
  emit(s, { type: 'frame', ...s.frame });
}

function queueFrame(s: Session, png: Buffer): void {
  s.pending = png;
  if (s.frameTimer) return;
  s.frameTimer = setTimeout(() => flushFrame(s), Math.max(0, s.lastEmit + FRAME_GAP_MS - Date.now()));
}

function armIdle(s: Session): void {
  if (!s.uid) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => void endSession(s, 'idle'), SITE_IDLE_MS);
}

async function endSession(s: Session, reason: 'done' | 'idle' | 'replaced' | 'engine'): Promise<void> {
  if (current === s) current = null;
  for (const t of [s.frameTimer, s.idleTimer, s.maxTimer]) if (t) clearTimeout(t);
  s.frameTimer = s.idleTimer = s.maxTimer = null;
  emit(s, { type: 'closed', reason });
  s.listeners.clear();
  const b = s.browser;
  s.browser = null;
  if (b) await b.close().catch(() => {});
}

async function open(s: Session): Promise<void> {
  current = s;
  try {
    s.browser = await opener({
      frame: (png) => { queueFrame(s, png); s.onActivity?.(); },
      address: (url, title) => { s.address = { url, title }; emit(s, { type: 'address', url, title }); s.onActivity?.(); },
      load: (e) => { if (e.url) s.address = { url: e.url, title: e.title }; emit(s, { type: 'load', ...e }); s.onActivity?.(); },
      closed: () => { if (current === s) void endSession(s, 'engine'); },
    });
  } catch (e) {
    if (current === s) current = null;
    throw e;
  }
  s.browser.send({ type: 'loadUrl', url: s.home, ...s.size });
}

const blank = (uid: string, sourceId: string, home: string, size: { width: number; height: number }): Session => ({
  id: randomBytes(18).toString('base64url'), uid, sourceId, home, size, browser: null, lastInput: Date.now(), frame: null,
  address: null, listeners: new Set(), pending: null, lastEmit: 0, frameTimer: null, idleTimer: null, maxTimer: null,
  onActivity: null,
});

const clampSize = (w: number, h: number) => ({
  width: Math.round(Math.min(1600, Math.max(320, w))),
  height: Math.round(Math.min(1600, Math.max(320, h))),
});

/**
 * An admin's page on a source's site, opened at its home page at the size their sheet has. Another admin's page in use
 * refuses (SiteBusyError); their own earlier page, or one gone quiet, is left for this one. Rejects when the engine has
 * no browser (engineBrowser.ts).
 */
export async function startSite(o: { uid: string; sourceId: string; home: string; width: number; height: number }): Promise<{ id: string }> {
  const c = current;
  if (c) {
    if (!c.uid || (c.uid !== o.uid && Date.now() - c.lastInput < BUSY_MS)) throw new SiteBusyError();
    await endSession(c, 'replaced');
  }
  const s = blank(o.uid, o.sourceId, o.home, clampSize(o.width, o.height));
  await open(s);
  armIdle(s);
  s.maxTimer = setTimeout(() => void endSession(s, 'idle'), SITE_MAX_MS);
  return { id: s.id };
}

/** The admin's own page, or nothing: an id names a page only to the admin who opened it. */
function own(id: string, uid: string): Session | null {
  return current && current.uid && current.id === id && current.uid === uid ? current : null;
}

/** Follow a page: what it shows now at once, then every change, until it closes. Null when it is not theirs or gone. */
export function subscribe(id: string, uid: string, listener: (l: SiteLine) => void): (() => void) | null {
  const s = own(id, uid);
  if (!s) return null;
  s.listeners.add(listener);
  if (s.address) listener({ type: 'address', ...s.address });
  if (s.frame) listener({ type: 'frame', ...s.frame });
  return () => { s.listeners.delete(listener); };
}

/** The admin's clicks, keys, wheel, paste or a new size, for the page; `home` opens the source's home page again. */
export function sendInput(id: string, uid: string, input: SiteInput[]): boolean {
  const s = own(id, uid);
  if (!s?.browser) return false;
  for (const m of input) {
    if (m.type === 'home') s.browser.send({ type: 'loadUrl', url: s.home, ...s.size });
    else if (m.type === 'resize') {
      s.size = clampSize(m.width, m.height);
      s.browser.send({ type: 'resize', ...s.size });
    } else s.browser.send(m);
  }
  s.lastInput = Date.now();
  armIdle(s);
  return true;
}

/** Whether a page is open and the admin's: the stream route asks before it starts streaming. */
export const siteOpen = (id: string, uid: string): boolean => !!own(id, uid);

/**
 * Done: leave the page, which is when the engine saves its cookies. The source the page was for, so the caller can try
 * it; null when the page was not theirs, or is gone already.
 */
export async function stopSite(id: string, uid: string): Promise<string | null> {
  const s = own(id, uid);
  if (!s) return null;
  await endSession(s, 'done');
  return s.sourceId;
}

/**
 * Whether an extension's error is its "Open in WebView…": the line keiyoushi's extensions throw when their own browser
 * could not pass the site's check (BatCave's DleGuardResolver: "Open in WebView to bypass site protection").
 */
export const needsBrowserCheck = (e: unknown): boolean =>
  /\bweb ?view\b/i.test(String((e as { message?: unknown } | null)?.message ?? e ?? ''));

/**
 * The sources whose site an admin has opened (suwayomi_sources.site_opened_at): their sites wanted a sign-in or a check, so
 * ANY failure of theirs earns a quiet visit, not only an "Open in WebView…" -- BatCave's guard, run out after a day, answers
 * a plain 404. Loaded at registration (register.ts) and added to by Done (routes/admin.ts).
 */
const opened = new Set<string>();
export function setSitesOpened(ids: Iterable<string>): void { opened.clear(); for (const id of ids) opened.add(String(id)); }
export function noteSiteOpened(id: string): void { opened.add(String(id)); }
export const siteWasOpened = (id: string): boolean => opened.has(String(id));

/**
 * A quiet visit waits for the page to settle: 3 s without news, after at least 4 s, and never more than 20 s. One visit
 * per source in half an hour: a site that still refuses after one is not refused for want of a visit. Mutable for the
 * tests alone (siteSessions.test.ts), which cannot wait seconds.
 */
export const visitTiming = { settleMs: 3_000, minMs: 4_000, maxMs: 20_000, gapMs: 30 * 60_000, tickMs: 250 };
const lastVisit = new Map<string, number>();
const visiting = new Map<string, Promise<boolean>>();

/** Forget when each source was last visited: a test, and nothing else. */
export function resetSiteChecks(): void { lastVisit.clear(); visiting.clear(); }

/**
 * Open a source's home page in the engine's browser for a few seconds, for a check its own background browser could
 * not pass, then leave it so the engine saves the cookies. True when the visit happened -- the caller then tries once
 * more; false when the browser was busy, the source was visited lately, or the engine has no browser. Callers at the
 * same moment share one visit.
 */
export function passSiteCheck(sourceId: string, home: string): Promise<boolean> {
  const inflight = visiting.get(sourceId);
  if (inflight) return inflight;
  if (current || !home || Date.now() - (lastVisit.get(sourceId) ?? 0) < visitTiming.gapMs) return Promise.resolve(false);
  lastVisit.set(sourceId, Date.now());
  const run = (async () => {
    const s = blank('', sourceId, home, { width: 1280, height: 800 });
    const started = Date.now();
    let last = started;
    s.onActivity = () => { last = Date.now(); };
    try {
      await open(s);
    } catch {
      return false;
    }
    await new Promise<void>((done) => {
      const tick = setInterval(() => {
        const now = Date.now();
        if (!s.browser || now - started >= visitTiming.maxMs || (now - started >= visitTiming.minMs && now - last >= visitTiming.settleMs)) {
          clearInterval(tick);
          done();
        }
      }, visitTiming.tickMs);
    });
    await endSession(s, 'done');
    return true;
  })().finally(() => visiting.delete(sourceId));
  visiting.set(sourceId, run);
  return run;
}
