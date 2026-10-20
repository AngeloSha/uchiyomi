// Open site (v0.91.0, #314), the web's half: an extension's site in the extension engine's own browser, live in an
// admin's sheet (components/SiteBrowserSheet.tsx) -- Uchiyomi's "Open in WebView". The routes are the server's (bff
// routes/admin.ts): POST …/sources/:id/site opens the page, GET …/site/:session/stream is the page live, one JSON object a
// line, POST …/site/:session/input carries the admin's clicks, keys, wheel and paste, and DELETE …/site/:session is Done,
// which is when the engine saves the sign-in for its extensions.
import { api, apiResponse } from './api';
import { keys } from './i18n';

export interface SiteOpened { session: string; name: string; site: string }

export type SiteLine =
  | { type: 'frame'; seq: number; png: string }
  | { type: 'address'; url: string; title: string }
  | { type: 'load'; url: string; title: string; status: number; error?: string | null }
  | { type: 'closed'; reason: 'done' | 'idle' | 'replaced' | 'engine' }
  | { type: 'ping' };

export type SiteInput =
  | {
      type: 'event';
      eventType: 'mousedown' | 'mouseup' | 'mousemove' | 'wheel' | 'keydown' | 'keyup';
      clickX: number;
      clickY: number;
      button?: number;
      ctrlKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      key?: string;
      clientX?: number;
      clientY?: number;
      deltaY?: number;
    }
  | { type: 'paste'; data: string }
  | { type: 'resize'; width: number; height: number }
  | { type: 'home' };

/** What the sheet says, said alike in Admin → Sources' extension sheet and in the sheet itself. */
export const SITE_TEXT = keys(
  'Open site',
  'Some sites want you signed in, or a check passed, before an extension can read them. Open the site in the extension engine’s own browser, do that there, then press Done: the engine keeps the sign-in.',
  'Sign in or pass the site’s check, then press Done.',
);

const enc = encodeURIComponent;

export const openSite = (sourceId: string, width: number, height: number) =>
  api<SiteOpened>(`/api/admin/extensions/sources/${enc(sourceId)}/site`, { json: { width: Math.round(width), height: Math.round(height) } });

export interface SiteResult { saved: boolean; test: { ok: boolean; state?: string } | null }
export const closeSite = (session: string) => api<SiteResult>(`/api/admin/extensions/site/${enc(session)}`, { method: 'DELETE' });

/** Read the live page until it closes or `signal` aborts, each line to `onLine`. */
export async function followSite(session: string, onLine: (l: SiteLine) => void, signal: AbortSignal): Promise<void> {
  const res = await apiResponse(`/api/admin/extensions/site/${enc(session)}/stream`, { signal });
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    buf = splitLines(buf, onLine);
  }
}

/** Every whole line in `buf` to `onLine`, parsed; what is left of a line not finished yet is returned. Pure. */
export function splitLines(buf: string, onLine: (l: SiteLine) => void): string {
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try { onLine(JSON.parse(line) as SiteLine); } catch { /* a line broken in transit is skipped */ }
    }
    nl = buf.indexOf('\n');
  }
  return buf;
}

/**
 * The admin's input, sent in order and in small batches: everything within 40 ms goes in one post, and a post waits for
 * the one before it, so a click never overtakes the keys typed before it. `gone` is called once if the page is no more.
 */
export function siteSender(session: string, gone: () => void) {
  let queue: SiteInput[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<void> = Promise.resolve();
  let dead = false;
  const flush = () => {
    timer = null;
    if (dead || !queue.length) return;
    const input = queue.splice(0, 100);
    sending = sending.then(() =>
      api(`/api/admin/extensions/site/${enc(session)}/input`, { json: { input } }).then(() => undefined, () => {
        if (!dead) { dead = true; gone(); }
      }));
    if (queue.length) timer = setTimeout(flush, 0);
  };
  return {
    send(i: SiteInput) {
      if (dead) return;
      // Pointer moves only matter as the latest: one waiting is replaced, not queued behind.
      const last = queue[queue.length - 1];
      if (i.type === 'event' && i.eventType === 'mousemove' && last?.type === 'event' && last.eventType === 'mousemove') queue[queue.length - 1] = i;
      else queue.push(i);
      if (!timer) timer = setTimeout(flush, 40);
    },
    stop() { dead = true; if (timer) clearTimeout(timer); queue = []; },
  };
}

/**
 * A point on the picture of the page, in the page's own pixels. The picture is drawn `object-contain` at the top left of
 * its box, so a box resized before the next picture arrives still maps exactly. Pure; null outside the picture.
 */
export function pagePoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | null {
  if (!page.width || !page.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const x = (clientX - box.left) / scale;
  const y = (clientY - box.top) / scale;
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}
