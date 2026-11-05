import { openSeriesMore } from './seriesMore.mjs';

// Part of run.mjs: use its signed-in, seeded app, error collection and screenshots.
// Cover both sides of sm/lg, an unfolded screen, landscape, and nonzero safe areas.
const layouts = [
  [390, 667, 0], [430, 932, 34], [639, 800, 0], [640, 800, 0],
  [768, 1024, 34], [844, 390, 21], [1023, 768, 0], [1024, 768, 0],
];

export async function sheetNavigationWalk({ page, base, seriesHref, ok, bad, shot }) {
  console.log('\n  sheets and floating navigation');
  const viewport = page.viewport();
  const cdp = await page.createCDPSession();
  // A visible rectangle alone is insufficient: the navigation can paint over it.
  const reachable = (button) => button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const nav = document.querySelector('nav.safe-bottom');
    const n = nav?.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight
      && (!n?.height || r.bottom <= n.top)
      && [r.top + 2, (r.top + r.bottom) / 2, r.bottom - 2]
        .every((y) => el.contains(document.elementFromPoint(x, y)));
  });
  try {
    for (const [width, height, bottom] of layouts) {
      const label = `${width}x${height}-safe${bottom}`;
      await page.setViewport({ width, height });
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom } });
      await page.goto(base + seriesHref, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForSelector('button[data-series-more]');
      const kind = await openSeriesMore(page);
      kind === (width < 1024 ? 'sheet' : 'menu')
        ? ok(`More uses ${kind} at ${label}`) : bad(`unexpected More presentation: ${kind} at ${label}`);
      const last = await page.waitForSelector('[data-menu-item="remove-series"]', { visible: true });
      if (kind === 'sheet') {
        await last.evaluate((el) => {
          const body = el.closest('[data-lenis-prevent]');
          body.scrollTop = body.scrollHeight;
        });
      }
      await shot(`series-more-${label}`);
      (await reachable(last)) ? ok(`last More action reachable at ${label}`) : bad(`last More action covered at ${label}`);
      await page.keyboard.press('Escape');

      // The library's real pinned footer must stay usable even with its list scrolled.
      await page.goto(`${base}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
      const filters = await page.waitForSelector('[data-library-toolbar] button[aria-haspopup="dialog"]:not([data-library-sort])', { visible: true });
      await filters.click();
      await page.waitForSelector('[role="dialog"][aria-label="Filters"]');
      await page.evaluate(() => {
        const body = document.querySelector('[role="dialog"][aria-label="Filters"] [data-lenis-prevent]');
        body.scrollTop = body.scrollHeight;
      });
      const done = await page.waitForSelector('::-p-aria(Done[role="button"])');
      await shot(`library-filters-${label}`);
      if (await reachable(done)) {
        await done.click();
        await page.waitForSelector('[role="dialog"][aria-label="Filters"]', { hidden: true });
        ok(`pinned Done button reachable and closes filters at ${label}`);
      } else {
        bad(`pinned Done button covered at ${label}`);
        await page.keyboard.press('Escape');
      }
    }
  } finally {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await cdp.detach();
    await page.setViewport(viewport);
    await page.goto(base + seriesHref, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('button[data-series-more]');
  }
}
