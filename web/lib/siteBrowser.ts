// Open site (v0.91.0, #314), the web's half: an extension's site in the extension engine's own browser, live in an
// admin's sheet (components/SiteBrowserSheet.tsx) -- Uchiyomi's "Open in WebView". The routes are the server's (bff
// routes/admin.ts): POST …/sources/:id/site opens the page, GET …/site/:session/stream is the page live, one JSON object a
// line, POST …/site/:session/input carries the admin's clicks, keys, wheel and paste, and DELETE …/site/:session is Done,
// which is when the engine saves the sign-in for its extensions.
import { api, apiResponse } from './api';
import { keys } from './i18n';

export interface SiteOpened { session: string; name: string; site: string }

export type SiteLine =
  | { type: 'frame'; seq: number; jpeg: string }
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
  | { type: 'home' }
  /** The stream's picture `seq` arrived: the server sends the next only then (v0.91.1). */
  | { type: 'seen'; seq: number };

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
 * The admin's input, sent in order: one post at a time, and everything that came while it was on its way goes in the
 * next, so a click never overtakes the keys typed before it and a slow connection gets fewer, fuller posts rather than a
 * queue of them. (v0.91.0 started a post every 40 ms, each waiting for the one before: over a home server's connection
 * the keys ended up twenty seconds behind the mouse moves queued ahead of them.) `gone` is called once if the page is no
 * more.
 */
export function siteSender(session: string, gone: () => void) {
  let queue: SiteInput[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let posting = false;
  let dead = false;
  const flush = () => {
    timer = null;
    if (dead || posting || !queue.length) return;
    const input = queue.splice(0, 100);
    posting = true;
    api(`/api/admin/extensions/site/${enc(session)}/input`, { json: { input } }).then(() => {
      posting = false;
      if (queue.length && !timer) timer = setTimeout(flush, 0);
    }, () => {
      if (!dead) { dead = true; gone(); }
    });
  };
  return {
    send(i: SiteInput) {
      if (dead) return;
      // Pointer moves only matter as the latest: one waiting is replaced, not queued behind. So does which picture the
      // sheet has.
      const last = queue[queue.length - 1];
      if (i.type === 'event' && i.eventType === 'mousemove' && last?.type === 'event' && last.eventType === 'mousemove') queue[queue.length - 1] = i;
      else if (i.type === 'seen') queue = [...queue.filter((q) => q.type !== 'seen'), i];
      else queue.push(i);
      if (!timer && !posting) timer = setTimeout(flush, 40);
    },
    stop() { dead = true; if (timer) clearTimeout(timer); queue = []; },
  };
}

/**
 * What the sheet's typing field starts with: something for a phone's Backspace to take. An empty field gives a phone's
 * Backspace nothing to delete, so the page would never hear it.
 */
export const TYPER_FILL = '_'.repeat(32);

/**
 * What a phone's keyboard did to the typing field, as the Backspaces and then the text that make the same change on the
 * page. A phone types through the field rather than with keys (v0.91.1), and its keyboard may change a word it typed
 * already -- a correction, a word finished -- which arrives here as Backspaces and the new letters. Counted in
 * characters, not UTF-16 units. Pure.
 */
export function typedDiff(before: string, after: string): { back: number; text: string } {
  const a = Array.from(before);
  const b = Array.from(after);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { back: a.length - i, text: b.slice(i).join('') };
}

/** Typed text as the page takes it: a line break is Enter, a tab is Tab, the rest is text. Pure. */
export function typedInput(back: number, text: string): SiteInput[] {
  const out: SiteInput[] = [];
  const key = (k: string) => out.push(
    { type: 'event', eventType: 'keydown', clickX: 0, clickY: 0, key: k },
    { type: 'event', eventType: 'keyup', clickX: 0, clickY: 0, key: k },
  );
  for (let i = 0; i < back; i++) key('Backspace');
  for (const part of text.split(/(\r?\n|\t)/)) {
    if (part === '\n' || part === '\r\n') key('Enter');
    else if (part === '\t') key('Tab');
    else if (part) out.push({ type: 'paste', data: part });
  }
  return out;
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
