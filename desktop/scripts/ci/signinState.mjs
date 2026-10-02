// What the server-mode window shows, as product-smoke.mjs --server-mode reads it before it decides (v0.52.0). On its
// own, with no import that touches the disk, so desktop/test/smoke.signin.test.mjs holds it without a browser.
//
// ⚠️ P-server-mode failed now and then -- mac-x64 on the v0.50.0 release, win-x64 on PR #138 -- with every fact it
// printed as expected: a password form, `uchiyomiDesktop` undefined, the inert server marker, no reconnect screen.
// The verdict also took `page.waitForSelector('input[type=password]')`, and a fresh profile's first visit reloads the
// page once, the moment the PWA's service worker takes control (web/app/providers.tsx). waitForSelector finds the
// input in puppeteer's own world and then hands it to the page's (DOM.describeNode, DOM.resolveNode); a reload
// between the two fails that hand-over ("Cannot find context with specified id", "Node with given id does not
// belong to the document"), which is outside the wait's own retry, so the wait REJECTED although the form was there,
// and the check read the rejection as "no password form". Against a stand-in of that first visit (a form a moment
// after load, a worker that claims, one reload on controllerchange), 12 of 360 such waits rejected; the read below
// decided 80 of 80, each time in the document that stayed.
//
// The app was right: in server mode the server's own sign-in page IS the screen, and no bridge is ever injected
// (preload.js gives it only to a standalone window). So the check is what changed: it reads the whole state in ONE
// evaluate of one document and polls. A read a reload cuts off throws, and the next poll reads the next document. It
// decides only in the document that stays -- one the service worker served, so no reload is coming -- which is also
// where the sign-in typed next must land (it used to sleep three seconds for that).

/**
 * One read of the window, run in the page: the facts the check decides on, from one document. `served`: the PWA's
 * service worker answered this document's navigation (the first visit's one reload is behind it), or there is no
 * service worker to take over.
 */
export function readWindow() {
  const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType('navigation')[0]);
  return {
    desktop: typeof (/** @type {any} */ (window)).uchiyomiDesktop,
    shell: JSON.stringify((/** @type {any} */ (window)).uchiyomiShell ?? null),
    // DesktopReconnect's wording (web/components/DesktopReconnect.tsx) -- the only fallback screen on desktop.
    reconnect: /couldn.t open your library/i.test(document.body?.innerText || ''),
    password: !!document.querySelector('input[type=password]'),
    served: !('serviceWorker' in navigator) || (nav?.workerStart ?? 0) > 0,
    url: location.href,
  };
}

/**
 * The window's state once its document is the one that stays and shows the sign-in form or the reconnect screen --
 * whichever it shows is the check's to judge. Rejects after `timeoutMs` with the last state read, which says what was
 * there instead (or the last error, when nothing could be read).
 * @param {{ evaluate: (fn: typeof readWindow) => Promise<ReturnType<typeof readWindow>> }} page
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 */
export async function signInState(page, { timeoutMs = 90_000, intervalMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  /** @type {unknown} */
  let last = null;
  for (;;) {
    try {
      const s = await page.evaluate(readWindow);
      last = s;
      if (s.served && (s.password || s.reconnect)) return s;
    } catch (e) {
      // A document going away mid-read: the next poll reads the one that replaced it.
      last = e;
    }
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const said = last instanceof Error ? last.message : JSON.stringify(last);
  throw new Error(`timed out after ${timeoutMs} ms waiting for the sign-in page or the reconnect screen in the document that stays (last: ${String(said).slice(0, 300)})`);
}
