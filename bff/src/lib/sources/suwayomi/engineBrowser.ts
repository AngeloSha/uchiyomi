// The engine's own browser (v0.91.0, #314): a page opened in the engine's Chromium on the server -- Suwayomi's WebView,
// `/api/v1/webview` -- which is Uchiyomi's answer to Mihon's "Open in WebView". A source whose site wants a sign-in, or a
// browser check the engine's background browser cannot pass, gets its cookies this way: when the last client leaves,
// the engine copies the browser's cookies into the store its extensions send (KcefWebView.flush in Suwayomi v2.4).
//
// The protocol is the engine's page's own (server/src/main/jte/Webview.kte): JSON text frames both ways. In: `loadUrl`,
// `resize`, `event` (mouse, wheel and keys, in the page's CSS pixels) and `paste`. Out: `render` (a PNG, as a JSON array
// of bytes), `addressChange`, `load`, `statusChange` and `consoleMessage`. ⚠️ One browser, one client: a second client
// closes the first ("Other client connected"), so siteSessions.ts keeps one page at a time.
import { suwayomiBase, suwayomiImageHeaders } from './client';

/** What the page sends back, as far as Uchiyomi uses it. */
export interface BrowserEvents {
  /** A new picture of the page: PNG bytes. */
  frame?: (png: Buffer) => void;
  address?: (url: string, title: string) => void;
  load?: (e: { url: string; title: string; status: number; error?: string | null }) => void;
  closed?: (code: number, reason: string) => void;
}

/** What may be sent to the page; the routes validate a client's input against this before it gets here. */
export type BrowserInput =
  | { type: 'loadUrl'; url: string; width: number; height: number }
  | { type: 'resize'; width: number; height: number }
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
  | { type: 'paste'; data: string };

export interface EngineBrowser {
  send(msg: BrowserInput): void;
  /** Leave the page: the engine then saves its cookies. Resolves once the engine has closed the connection, or after 5 s. */
  close(): Promise<void>;
  readonly open: boolean;
}

export type BrowserOpener = (events: BrowserEvents) => Promise<EngineBrowser>;

/** The engine's browser socket: its `/api/v1/webview`, on the engine's own address. */
export function engineBrowserUrl(base: string = suwayomiBase()): string {
  const u = new URL('/api/v1/webview', base.endsWith('/') ? base : `${base}/`);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const CONNECT_MS = 10_000;
const CLOSE_MS = 5_000;

/**
 * Connect to the engine's browser. Rejects when the engine has no browser to offer -- an external engine without
 * Suwayomi v2's WebView, or one that refuses the login -- so the caller can say so instead of waiting.
 */
export const openEngineBrowser: BrowserOpener = (events) =>
  new Promise((resolve, reject) => {
    // Node's WebSocket is undici's, which takes the engine's Basic login as a header (WebSocketInit.headers).
    const ws = new WebSocket(engineBrowserUrl(), { headers: suwayomiImageHeaders() });
    let opened = false;
    let closed = false;
    let onClosed: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch { /* never opened */ }
        reject(new Error('The extension engine did not open its browser.'));
      }
    }, CONNECT_MS);

    ws.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        get open() { return !closed; },
        send(msg) { if (!closed) ws.send(JSON.stringify(msg)); },
        close() {
          if (closed) return Promise.resolve();
          return new Promise<void>((done) => {
            const t = setTimeout(done, CLOSE_MS);
            onClosed = () => { clearTimeout(t); done(); };
            try { ws.close(1000, 'done'); } catch { clearTimeout(t); done(); }
          });
        },
      });
    });
    ws.addEventListener('message', (m) => {
      if (typeof m.data !== 'string') return;
      let d: { type?: string; [k: string]: unknown };
      try { d = JSON.parse(m.data); } catch { return; }
      if (d.type === 'render' && Array.isArray(d.image)) events.frame?.(Buffer.from(d.image as number[]));
      else if (d.type === 'addressChange') events.address?.(String(d.url ?? ''), String(d.title ?? ''));
      else if (d.type === 'load') {
        events.load?.({ url: String(d.url ?? ''), title: String(d.title ?? ''), status: Number(d.status) || 0, error: (d.error as string | null) ?? null });
      }
    });
    ws.addEventListener('close', (e) => {
      closed = true;
      clearTimeout(timer);
      if (!opened) reject(new Error(`The extension engine refused its browser (${e.code}).`));
      events.closed?.(e.code, e.reason);
      onClosed?.();
    });
    ws.addEventListener('error', () => { /* `close` follows and says what happened */ });
  });
