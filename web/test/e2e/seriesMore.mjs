// The series page's More (v0.60.0), for the browser walks.
//
// Edit details, New banner, Rename folder, Remove from library, Archive slowly, Find missing chapters and the notes
// door used to be a stack of buttons under the cover; they are More's now -- a menu from lg up (components/ContextMenu.tsx,
// `role="menu"`) and a sheet below (components/SeriesKeys.tsx, `[data-series-more-sheet]`). A walk that pressed one of
// them by its words opens More first; one that wants an item whatever the language finds it by its hook,
// `[data-menu-item="<hook>"]` (lib/seriesActions.ts: archive-slowly, new-banner, edit-details, remove-series, notes).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In the page: the More key on screen -- the first one; the phone's bar carries a second once the reading button is gone. */
const SCAN = 'button[data-series-more]';
/** In the page: what More has open, if anything. */
const OPEN = '[data-series-more-sheet], [role="menu"]';

/**
 * Press the series page's More key and wait for what it opens: 'menu' (lg up), 'sheet' (below), or null when the page
 * has no key or nothing opened in `timeout` ms.
 *
 * ⚠️ A menu closes on any scroll (components/ContextMenu.tsx), and the scroll event of a scrollIntoView lands after the
 * click that opened it: the key is brought into view FIRST and given a moment, and nothing here scrolls once it is up.
 */
export async function openSeriesMore(page, { timeout = 8000 } = {}) {
  const inView = await page.evaluate((sel) => {
    const key = [...document.querySelectorAll(sel)].find((b) => b.getClientRects().length);
    if (!key) return null;
    const r = key.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  }, SCAN);
  if (inView === null) return null;
  if (!inView) {
    await page.evaluate((sel) => [...document.querySelectorAll(sel)].find((b) => b.getClientRects().length)?.scrollIntoView({ block: 'center' }), SCAN);
    await sleep(700);
  }
  await page.evaluate((sel) => [...document.querySelectorAll(sel)].find((b) => b.getClientRects().length)?.click(), SCAN);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const open = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? (el.matches('[role="menu"]') ? 'menu' : 'sheet') : null;
    }, OPEN);
    if (open) {
      await sleep(250); // the menu places itself after measuring; the sheet's rows are live at once
      return open;
    }
    await sleep(150);
  }
  return null;
}

/** In the page: More's item whose hook is `h`, in the menu or the sheet. */
const ITEM = (h) => `[role="menu"] [data-menu-item="${h}"], [data-series-more-sheet] [data-menu-item="${h}"]`;

/** Open More and press the item whose hook is `hook` (a DOM click: nothing scrolls under a menu); whether there was one. */
export async function pressSeriesMoreItem(page, hook) {
  if (!(await openSeriesMore(page))) return false;
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el?.click();
    return !!el;
  }, ITEM(hook));
}

/** Whether More offers the item whose hook is `hook`: opened, looked at, closed again (Escape closes either form). */
export async function seriesMoreOffers(page, hook) {
  if (!(await openSeriesMore(page))) return false;
  const has = await page.evaluate((sel) => !!document.querySelector(sel), ITEM(hook));
  await page.keyboard.press('Escape');
  await sleep(300);
  return has;
}
