// The solver's real backend: hidden Electron BrowserWindows (design-shell.md §3.3-§3.5).
//
// One page load per request, in a window drawn from a small pool. Cookies live in in-memory partitions:
//   fs-s:<name>    a named session (Suwayomi sends its fixed "suwayomi"), recreated after session_ttl_minutes
//   fs-o:<origin>  everyone else (the bff), one jar per target origin, cleared after 30 minutes
// so a cf_clearance earned on the first request to an origin is still in the jar for the next one. That is
// the deliberate difference from FlareSolverr, which starts a fresh Chrome for every session-less call.
//
// Detection is FlareSolverr's (detect.ts). The response body is `document.documentElement.outerHTML`, which is
// what Selenium's page_source returns -- so a JSON endpoint comes back wrapped in the browser's <pre> exactly
// as manganato.ts:104-105 expects.
import { app, BrowserWindow, session as Sessions, powerMonitor, Notification, type Session, type Cookie } from 'electron';
import { SolveError, type SolverBackend, type SolveRequest, type SolveResult, type SolverCookie } from './protocol';
import { PROBE_SOURCE, TURNSTILE_RECT_SOURCE, challengeReason, isAccessDenied, isChallenge, type Probe } from './detect';
import { chPlatform, greaseBrands, secChUa, type Brand } from './userAgent';

export interface BrowserBackendOptions {
  /** Windows alive at once, busy or idle: 4 for the bff + 1 for Suwayomi. */
  poolSize?: number;
  /** An idle window is destroyed after this long. */
  idleCloseMs?: number;
  /** A session-less origin's cookie jar is wiped after this long. */
  originTtlMs?: number;
  /** Still challenged after this long: the first trusted "verify" input on the Turnstile checkbox. */
  clickAfterMs?: number;
  /** Then again every this often while still challenged (0 = only once, the design's first guess). */
  clickEveryMs?: number;
  /**
   * How to press the checkbox. 'keyboard' = focus + Tab + Space, which is what FlareSolverr does
   * (flaresolverr_service.py click_verify); 'mouse' = a pointer move + click on the box; 'both' alternates.
   */
  verifyInput?: 'keyboard' | 'mouse' | 'both';
  /** 'cdp' = DevTools Input domain (reaches cross-origin iframes); 'sendInputEvent' = the design's first guess. */
  inputVia?: 'cdp' | 'sendInputEvent';
  /** Still challenged after this long: ask the human (§3.5 step 2). */
  showAfterMs?: number;
  /** 'show' = the product behaviour; 'log' = the spike: only report that the window would have been shown. */
  humanCheck?: 'show' | 'log';
  /**
   * 'hidden' = show:false (the design). 'offscreen' = a visible window parked off-screen (S4's named fallback).
   * 'visible' = an ordinary on-screen window (diagnostics only: is a failure about being hidden?).
   */
  windowMode?: 'hidden' | 'offscreen' | 'visible';
  /** Refuse every request from a solver window to a loopback address (default). */
  blockAllLoopback?: boolean;
  /** Loopback ports refused even when blockAllLoopback is off (the solver's own, the UI's, Postgres's…). */
  protectedPorts?: number[];
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Per-solve timings for the spike harness and the shell's diagnostics. */
  onSolveDetail?: (d: SolveDetail) => void;
  /** Tray badge when the user is away and Cloudflare wants a click (product only). */
  onNeedsHuman?: (host: string) => void;
  /**
   * Add the Sec-CH-UA trio Chrome sends on HTTPS (Electron sends none; see userAgent.ts). Default on.
   */
  chromeHeaders?: boolean;
  /** Diagnostics: a PNG of the hidden page at the click and at the "ask the human" moment. */
  onCapture?: (what: 'before-click' | 'after-click' | 'human-check', host: string, png: Buffer) => void;
}

export interface SolveDetail {
  id: number;
  url: string;
  partition: string;
  reusedWindow: boolean;
  acquireMs: number;
  firstLoadMs: number;
  challenged: boolean;
  challengeReason: string;
  solveMs: number;
  totalMs: number;
  clicked: boolean;
  verifyAttempts: Array<{ atMs: number; kind: string }>;
  wouldShow: boolean;
  shown: boolean;
  statuses: number[];
  finalUrl: string;
  error?: string;
}

interface Part {
  name: string;
  kind: 'session' | 'origin';
  label: string;
  ses: Session;
  createdAt: number;
  ttlMs: number;
  lastUsed: number;
}

interface Slot {
  win: BrowserWindow;
  part: Part;
  busy: boolean;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
  statuses: number[];
  blockMedia: boolean;
  gone?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LOOPBACK = /^(localhost|.*\.localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|\[?::\]?)$/i;
const MEDIA = new Set(['image', 'media', 'font', 'stylesheet']);

/** Electron's cookie → FlareSolverr's (CDP) shape. Suwayomi requires `domain`; a leading dot means "domain cookie". */
export function toSolverCookie(c: Cookie): SolverCookie {
  const sameSite = c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'strict' ? 'Strict' : 'Lax';
  const session = !!c.session || c.expirationDate === undefined;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '/',
    expires: session ? -1 : Number(c.expirationDate),
    size: c.name.length + c.value.length,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    session,
    sameSite,
    ...(session ? {} : { expiry: Math.floor(Number(c.expirationDate)) }),
  };
}

export class ElectronSolverBackend implements SolverBackend {
  private readonly o: Required<Omit<BrowserBackendOptions, 'log' | 'onSolveDetail' | 'onNeedsHuman' | 'onCapture'>> & BrowserBackendOptions;
  private parts = new Map<string, Part>();
  private slots: Slot[] = [];
  private prompted = new Map<string, number>();
  private configured = new WeakSet<Session>();
  /** The brand list the pages' own navigator.userAgentData reports; computed until a page tells us. */
  private brands: Brand[] = greaseBrands(Number(process.versions.chrome?.split('.')[0] || 0));

  constructor(opts: BrowserBackendOptions = {}) {
    this.o = {
      poolSize: 5,
      idleCloseMs: 60_000,
      originTtlMs: 30 * 60_000,
      // Measured (spike S4): the widget takes ~3-5 s to become clickable; a press at 2 s was ignored, one at
      // 5 s solved in ~10 s. The design's single click at 15 s could never meet a 15 s median.
      clickAfterMs: 5_000,
      clickEveryMs: 8_000,
      chromeHeaders: true,
      verifyInput: 'both',
      inputVia: 'cdp',
      showAfterMs: 25_000,
      humanCheck: 'show',
      windowMode: 'hidden',
      blockAllLoopback: true,
      protectedPorts: [],
      ...opts,
    };
  }

  userAgent(): string {
    return app.userAgentFallback;
  }

  // ---- sessions ------------------------------------------------------------------------------------------

  private partition(kind: 'session' | 'origin', label: string, ttlMs: number): Part {
    const name = `${kind === 'session' ? 'fs-s' : 'fs-o'}:${label}`;
    let p = this.parts.get(name);
    if (!p) {
      const ses = Sessions.fromPartition(name, { cache: true });
      this.configure(ses);
      p = { name, kind, label, ses, createdAt: Date.now(), ttlMs, lastUsed: Date.now() };
      this.parts.set(name, p);
    }
    return p;
  }

  /** Everything a solver page must not be able to do, set once per partition. */
  private configure(ses: Session): void {
    if (this.configured.has(ses)) return;
    this.configured.add(ses);
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e, item) => { e.preventDefault(); try { item.cancel(); } catch { /* already gone */ } });
    ses.setSpellCheckerEnabled(false);
    if (this.o.chromeHeaders) {
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        const h = details.requestHeaders;
        if (/^https:/i.test(details.url)) {
          const has = (k: string) => Object.keys(h).some((x) => x.toLowerCase() === k);
          if (!has('sec-ch-ua')) {
            h['sec-ch-ua'] = secChUa(this.brands);
            h['sec-ch-ua-mobile'] = '?0';
            h['sec-ch-ua-platform'] = `"${chPlatform()}"`;
          }
        }
        cb({ requestHeaders: h });
      });
    }
    ses.webRequest.onBeforeRequest((details, cb) => {
      let cancel = this.blockedUrl(details.url);
      if (!cancel && details.webContentsId !== undefined && MEDIA.has(details.resourceType)) {
        const slot = this.slots.find((s) => !s.win.isDestroyed() && s.win.webContents.id === details.webContentsId);
        cancel = !!slot?.blockMedia;
      }
      cb({ cancel });
    });
  }

  /** Loopback is never a manga site. Refusing it stops a hostile page from reaching our own ports (§3.3). */
  blockedUrl(raw: string): boolean {
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    if (!/^(https?|wss?):$/.test(u.protocol)) return false;
    if (!LOOPBACK.test(u.hostname)) return false;
    if (this.o.blockAllLoopback) return true;
    const port = Number(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80));
    return this.o.protectedPorts.includes(port);
  }

  /** Wipe a partition in place. In-memory partitions cannot be freed in Electron, only emptied. */
  private async wipe(p: Part): Promise<void> {
    for (const s of this.slots.filter((x) => x.part === p && !x.busy)) this.destroySlot(s);
    await p.ses.clearStorageData().catch(() => {});
    await p.ses.clearCache().catch(() => {});
    p.createdAt = Date.now();
  }

  async sessionsCreate(name: string): Promise<boolean> {
    const existed = this.parts.has(`fs-s:${name}`);
    this.partition('session', name, 0);
    return !existed;
  }

  sessionsList(): string[] {
    return [...this.parts.values()].filter((p) => p.kind === 'session').map((p) => p.label);
  }

  async sessionsDestroy(name: string): Promise<boolean> {
    const p = this.parts.get(`fs-s:${name}`);
    if (!p) return false;
    this.parts.delete(p.name);
    for (const s of this.slots.filter((x) => x.part === p)) this.destroySlot(s);
    await p.ses.clearStorageData().catch(() => {});
    await p.ses.clearCache().catch(() => {});
    return true;
  }

  // ---- windows -------------------------------------------------------------------------------------------

  private createSlot(p: Part): Slot {
    const offscreen = this.o.windowMode === 'offscreen';
    const win = new BrowserWindow({
      show: offscreen || this.o.windowMode === 'visible',
      x: offscreen ? -4000 : undefined,
      y: offscreen ? -4000 : undefined,
      width: 1280,
      height: 800,
      skipTaskbar: true,
      title: 'Uchiyomi',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: p.name,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const onlyWeb = (e: { preventDefault(): void }, url: string) => {
      if (!/^(https?:|about:blank)/i.test(url) || this.blockedUrl(url)) e.preventDefault();
    };
    wc.on('will-navigate', onlyWeb);
    wc.on('will-redirect', onlyWeb);
    const slot: Slot = { win, part: p, busy: false, lastUsed: Date.now(), statuses: [], blockMedia: false };
    // The main frame's real HTTP status, per navigation (a challenge is a 403/503 followed by the page's 200).
    wc.on('did-navigate', (_e, url, code) => { if (/^https?:/i.test(url) && code > 0) slot.statuses.push(code); });
    wc.on('render-process-gone', (_e, d) => { slot.gone = d.reason; });
    win.on('closed', () => { this.slots = this.slots.filter((s) => s !== slot); });
    this.slots.push(slot);
    return slot;
  }

  private destroySlot(s: Slot): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.slots = this.slots.filter((x) => x !== s);
    if (!s.win.isDestroyed()) s.win.destroy();
  }

  private acquire(p: Part): { slot: Slot; reused: boolean } {
    const idle = this.slots.find((s) => s.part === p && !s.busy && !s.gone && !s.win.isDestroyed());
    if (idle) {
      if (idle.idleTimer) clearTimeout(idle.idleTimer);
      idle.busy = true;
      return { slot: idle, reused: true };
    }
    // The server's gates keep busy windows at or under the pool size, so when full there is an idle one to evict.
    while (this.slots.length >= this.o.poolSize) {
      const lru = this.slots.filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!lru) break;
      this.destroySlot(lru);
    }
    const slot = this.createSlot(p);
    slot.busy = true;
    return { slot, reused: false };
  }

  private release(s: Slot): void {
    s.busy = false;
    s.lastUsed = Date.now();
    s.blockMedia = false;
    if (s.gone || s.win.isDestroyed()) { this.destroySlot(s); return; }
    // Park it on a blank page so the last site's scripts stop running in the background.
    s.win.webContents.loadURL('about:blank').catch(() => {});
    s.idleTimer = setTimeout(() => this.destroySlot(s), this.o.idleCloseMs);
  }

  private async probe(s: Slot): Promise<Probe | null> {
    if (s.win.isDestroyed()) return null;
    const run = s.win.webContents.executeJavaScriptInIsolatedWorld(1000, [{ code: PROBE_SOURCE }]) as Promise<Probe>;
    const p = await Promise.race([run.catch(() => null), sleep(2000).then(() => null)]);
    if (p?.brands?.length && secChUa(p.brands) !== secChUa(this.brands)) {
      this.o.log?.('client-hints', { was: secChUa(this.brands), now: secChUa(p.brands) });
      this.brands = p.brands;
    }
    return p;
  }

  private async capture(s: Slot, what: 'before-click' | 'after-click' | 'human-check', host: string): Promise<void> {
    if (!this.o.onCapture || s.win.isDestroyed()) return;
    // Bounded: capturePage() can wait ~30 s for a frame when the page navigates underneath it (measured).
    const img = await Promise.race([s.win.webContents.capturePage().catch(() => null), sleep(1500).then(() => null)]);
    if (img) { try { this.o.onCapture(what, host, img.toPNG()); } catch { /* diagnostics only */ } }
  }

  /**
   * §3.5 step 1: trusted input on the Turnstile checkbox.
   *
   * Through the DevTools protocol (webContents.debugger, Input.dispatch*), not webContents.sendInputEvent.
   * Measured in the spike: sendInputEvent hands the event to the MAIN frame's widget, so it never reaches a
   * cross-origin iframe, which is exactly where the Turnstile checkbox lives (challenges.cloudflare.com is an
   * out-of-process iframe). A same-origin test box took the click; the real checkbox never reacted -- not to
   * the click, and not to Space after Tab had visibly focused it. The DevTools Input domain is routed by the
   * browser's hit-testing (the same path as a real mouse), which is how chromedriver clicks it for
   * FlareSolverr. Attaching the debugger does not set navigator.webdriver.
   *
   * Keyboard = focus, Tab, Space (FlareSolverr's click_verify); mouse = glide onto the box and click.
   */
  private async pressVerify(s: Slot, kind: 'keyboard' | 'mouse'): Promise<boolean> {
    const wc = s.win.webContents;
    const dbg = wc.debugger;
    const viaCdp = this.o.inputVia === 'cdp';
    if (viaCdp && !dbg.isAttached()) dbg.attach('1.3');
    const cdp = (m: string, p: Record<string, unknown>) => dbg.sendCommand(m, p);
    try {
      if (kind === 'keyboard') {
        wc.focus();
        if (viaCdp) {
          await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
          await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
          await sleep(1000);
          await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', unmodifiedText: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
          await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        } else {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
          await sleep(1000);
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
          wc.sendInputEvent({ type: 'char', keyCode: ' ' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        }
        this.o.log?.('verify-input', { kind, via: this.o.inputVia });
        return true;
      }
      // Where the box is: the Turnstile iframe's own box, found by DevTools (which pierces the CLOSED shadow
      // root the challenge page hides it in); else the page-script guess next to cf-turnstile-response.
      const r = (viaCdp ? await this.turnstileBox(dbg).catch(() => null) : null) ?? await Promise.race([
        (wc.executeJavaScriptInIsolatedWorld(1000, [{ code: TURNSTILE_RECT_SOURCE }]) as Promise<any>).catch(() => null),
        sleep(2000).then(() => null),
      ]);
      if (!r) { this.o.log?.('verify-input', { kind, via: this.o.inputVia, target: 'none found' }); return false; }
      const x = Math.round(r.x + Math.min(30, r.w / 2));
      const y = Math.round(r.y + r.h / 2);
      // Arrive from somewhere else in a few steps, like a hand would, rather than teleporting onto the box.
      const from = { x: x + 180, y: y + 120 };
      for (let i = 1; i <= 8; i++) {
        const mx = Math.round(from.x + ((x - from.x) * i) / 8), my = Math.round(from.y + ((y - from.y) * i) / 8);
        if (viaCdp) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my });
        else wc.sendInputEvent({ type: 'mouseMove', x: mx, y: my });
        await sleep(25 + Math.round(Math.random() * 25));
      }
      await sleep(120);
      if (viaCdp) await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      else wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await sleep(70 + Math.round(Math.random() * 60));
      if (viaCdp) await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      else wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      this.o.log?.('verify-input', { kind, via: this.o.inputVia, x, y, target: `${r.tag}#${r.id}` });
      return true;
    } finally {
      if (viaCdp && dbg.isAttached()) { try { dbg.detach(); } catch { /* already gone */ } }
    }
  }

  /** The challenges.cloudflare.com iframe's border box in page coordinates, via DOM.getDocument(pierce). */
  private async turnstileBox(dbg: Electron.Debugger): Promise<{ x: number; y: number; w: number; h: number; tag: string; id: string } | null> {
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: any };
    let hit: any = null;
    const walk = (n: any) => {
      if (hit || !n) return;
      if (n.nodeName === 'IFRAME') {
        const a: string[] = n.attributes || [];
        const src = a[a.indexOf('src') + 1] || '';
        if (a.includes('src') && /challenges\.cloudflare\.com/.test(src)) { hit = n; return; }
      }
      for (const c of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c);
    };
    walk(root);
    if (!hit) return null;
    const { model } = await dbg.sendCommand('DOM.getBoxModel', { backendNodeId: hit.backendNodeId }) as { model: { border: number[]; width: number; height: number } };
    const [x1, y1] = model.border;
    if (!model.width || !model.height) return null;
    return { x: x1, y: y1, w: model.width, h: model.height, tag: 'IFRAME', id: 'challenges.cloudflare.com' };
  }

  /** §3.5 step 2. Returns true when the window was actually shown. */
  private humanCheck(s: Slot, host: string): { would: boolean; shown: boolean } {
    const last = this.prompted.get(host) || 0;
    if (Date.now() - last < 30 * 60_000) return { would: false, shown: false };
    if (this.o.humanCheck === 'log') {
      this.prompted.set(host, Date.now());
      this.o.log?.('would-show-window', { host });
      return { would: true, shown: false };
    }
    // Only interrupt someone who is at the machine; otherwise a tray badge waits for them.
    if (powerMonitor.getSystemIdleTime() > 60) { this.o.onNeedsHuman?.(host); return { would: true, shown: false }; }
    this.prompted.set(host, Date.now());
    s.win.setTitle(`Uchiyomi needs you to verify ${host}`);
    s.win.setBounds({ width: 1000, height: 760 });
    s.win.center();
    s.win.setSkipTaskbar(false);
    s.win.show();
    s.win.focus();
    app.dock?.bounce('informational');
    s.win.flashFrame(true);
    if (Notification.isSupported()) new Notification({ title: 'Uchiyomi', body: `Uchiyomi needs you to verify ${host}` }).show();
    return { would: true, shown: true };
  }

  /** A shown verification window stays up to 10 minutes after the request gave up, so the retry finds the cookie. */
  private keepForHuman(s: Slot): void {
    this.slots = this.slots.filter((x) => x !== s); // out of the pool
    const until = Date.now() + 10 * 60_000;
    const tick = async () => {
      if (s.win.isDestroyed()) return;
      const p = await this.probe(s);
      if (Date.now() > until || (p && !isChallenge(p) && p.readyState === 'complete')) { s.win.destroy(); return; }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2000);
  }

  // ---- the solve -----------------------------------------------------------------------------------------

  async solve(req: SolveRequest): Promise<SolveResult> {
    const t0 = Date.now();
    const target = new URL(req.url);
    const part = req.session
      ? this.partition('session', req.session, (req.sessionTtlMinutes ?? 0) * 60_000)
      : this.partition('origin', target.origin, this.o.originTtlMs);
    if (req.session && req.sessionTtlMinutes) part.ttlMs = req.sessionTtlMinutes * 60_000;
    // FlareSolverr's TTL rule (sessions.py:74-79): an expired session is recreated on use.
    if (part.ttlMs > 0 && Date.now() - part.createdAt > part.ttlMs) await this.wipe(part);
    part.lastUsed = Date.now();

    const { slot, reused } = this.acquire(part);
    const wc = slot.win.webContents;
    slot.statuses = [];
    slot.blockMedia = req.disableMedia;
    const d: SolveDetail = {
      id: req.id, url: req.url, partition: part.name, reusedWindow: reused, acquireMs: Date.now() - t0, firstLoadMs: 0,
      challenged: false, challengeReason: '', solveMs: 0, totalMs: 0, clicked: false, verifyAttempts: [], wouldShow: false, shown: false,
      statuses: slot.statuses, finalUrl: '',
    };
    let keep = false;
    const stopped = () => {
      if (slot.gone) throw new SolveError('crashed', `The solver window's renderer exited (${slot.gone}).`);
      if (req.signal.aborted) throw new SolveError(d.shown ? 'human' : 'timeout', '');
    };
    try {
      for (const c of req.cookies) {
        await part.ses.cookies.set({ url: req.url, name: c.name, value: c.value, path: '/' }).catch(() => {});
      }
      const tl = Date.now();
      const load = req.method === 'POST'
        ? wc.loadURL(req.url, {
          postData: [{ type: 'rawData', bytes: Buffer.from(req.postData ?? '', 'utf8') }],
          extraHeaders: 'Content-Type: application/x-www-form-urlencoded\n',
        })
        : wc.loadURL(req.url);
      const aborted = new Promise<'aborted'>((r) => req.signal.addEventListener('abort', () => r('aborted'), { once: true }));
      try {
        await Promise.race([load, aborted]);
      } catch (e) {
        const err = e as { code?: string; errno?: number };
        // ERR_ABORTED (-3): the page navigated again before it finished (a challenge redirecting). The loop
        // below follows the new navigation. Anything else is a real network failure.
        if (err.errno !== -3 && err.code !== 'ERR_ABORTED') throw new SolveError('navigation', `net::${err.code || 'ERR_FAILED'}`);
      }
      load.catch(() => {});
      stopped();
      d.firstLoadMs = Date.now() - tl;

      let first: Probe | null = null;
      for (let i = 0; !first; i++) {
        stopped();
        first = await this.probe(slot);
        if (!first) await sleep(250);
      }
      if (isAccessDenied(first)) throw new SolveError('blocked', '');
      d.challenged = isChallenge(first);
      d.challengeReason = challengeReason(first);
      const ts = Date.now();
      if (d.challenged) {
        this.o.log?.('challenge', { id: req.id, host: target.host, reason: d.challengeReason });
        let clean = 0;
        for (;;) {
          await sleep(500);
          stopped();
          const p = await this.probe(slot);
          // Improvement on FlareSolverr, which only looks for a block page before the challenge: a failed
          // managed challenge that turns into "Access denied" is final, so do not wait out the clock on it.
          if (p && isAccessDenied(p)) throw new SolveError('blocked', '');
          if (p && !isChallenge(p) && !wc.isLoading() && p.readyState === 'complete') {
            if (++clean >= 2) break; // clean on two looks 500 ms apart: the redirect after the challenge has landed
          } else clean = 0;
          const el = Date.now() - ts;
          const due = this.o.clickEveryMs > 0
            ? el >= this.o.clickAfterMs + d.verifyAttempts.length * this.o.clickEveryMs
            : !d.clicked && el >= this.o.clickAfterMs;
          if (due) {
            const kind = this.o.verifyInput === 'both' ? (d.verifyAttempts.length % 2 ? 'keyboard' : 'mouse') : this.o.verifyInput;
            d.clicked = true;
            d.verifyAttempts.push({ atMs: el, kind });
            if (d.verifyAttempts.length === 1) await this.capture(slot, 'before-click', target.host);
            await this.pressVerify(slot, kind).catch(() => false);
            if (this.o.onCapture && d.verifyAttempts.length <= 2) {
              await sleep(400); await this.capture(slot, 'after-click', target.host);
              await sleep(2600); await this.capture(slot, 'after-click', target.host);
            }
          }
          if (!d.wouldShow && el >= this.o.showAfterMs) {
            await this.capture(slot, 'human-check', target.host);
            const h = this.humanCheck(slot, target.host);
            d.wouldShow = h.would;
            d.shown = h.shown;
          }
        }
      }
      d.solveMs = Date.now() - ts;
      if (req.waitInSeconds > 0) { await sleep(req.waitInSeconds * 1000); stopped(); }

      const finalUrl = wc.getURL();
      d.finalUrl = finalUrl;
      const response = req.returnOnlyCookies ? undefined
        : String(await wc.executeJavaScriptInIsolatedWorld(1000, [{ code: 'document.documentElement.outerHTML' }]));
      const screenshot = req.returnScreenshot ? (await wc.capturePage()).toPNG().toString('base64') : undefined;
      // After every wait, like FlareSolverr (cookies set by the page's own JS are included).
      const cookies = (await part.ses.cookies.get({ url: finalUrl })).map(toSolverCookie);
      return {
        url: finalUrl,
        originStatus: slot.statuses[slot.statuses.length - 1] ?? 0,
        response,
        cookies,
        userAgent: wc.getUserAgent(),
        challenged: d.challenged,
        screenshot,
      };
    } catch (e) {
      d.error = e instanceof SolveError ? `${e.kind}${e.reason ? `: ${e.reason}` : ''}` : String((e as Error)?.message || e);
      if (d.shown) keep = true;
      throw e;
    } finally {
      d.totalMs = Date.now() - t0;
      d.statuses = [...slot.statuses];
      d.finalUrl ||= slot.win.isDestroyed() ? '' : wc.getURL();
      this.o.onSolveDetail?.(d);
      if (keep) this.keepForHuman(slot);
      else this.release(slot);
    }
  }

  /** Close every window (quit, or the tests' teardown). */
  async shutdown(): Promise<void> {
    for (const s of [...this.slots]) this.destroySlot(s);
  }

  /** How many windows exist and how many are busy (diagnostics). */
  stats(): { windows: number; busy: number; partitions: number } {
    return { windows: this.slots.length, busy: this.slots.filter((s) => s.busy).length, partitions: this.parts.size };
  }
}
