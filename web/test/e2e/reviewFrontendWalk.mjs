import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Part of the normal seeded-app walk, with the same signed-in account and error/screenshot reporting.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const api = async (base, token, path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? null : response.json();
};

export async function collectionMembershipWalk({ page, base, token, seriesHref, ok, bad, shot }) {
  const seriesId = new URL(seriesHref, base).searchParams.get('id');
  let list;
  try {
    list = await api(base, token, '/api/collections', 'POST', { name: `Membership test ${Date.now()}` });
    const selector = `[data-list-membership="${list.id}"]`;
    const open = async () => {
      await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.title === 'Add to list')?.click());
      await page.waitForSelector(selector, { visible: true });
      await page.waitForFunction(sel => !document.querySelector(sel)?.disabled, {}, selector);
    };
    await open();
    (await page.$eval(selector, el => el.getAttribute('aria-checked'))) === 'false' ? ok('list membership begins unchecked') : bad('an empty list is checked');
    await page.click(selector);
    await page.waitForFunction(sel => document.querySelector(sel)?.getAttribute('aria-checked') === 'true' && !document.querySelector(sel)?.disabled, {}, selector);
    const added = await api(base, token, `/api/collections?seriesId=${encodeURIComponent(seriesId)}`);
    added.content.find(x => x.id === list.id)?.contains === true ? ok('checking the list adds the series on the server') : bad('list add was not stored');
    await page.keyboard.press('Escape'); await sleep(200); await open();
    await page.waitForFunction(sel => document.querySelector(sel)?.getAttribute('aria-checked') === 'true', {}, selector);
    ok('reopened sheet reports existing membership');
    await page.click(selector);
    await page.waitForFunction(sel => document.querySelector(sel)?.getAttribute('aria-checked') === 'false' && !document.querySelector(sel)?.disabled, {}, selector);
    const removed = await api(base, token, `/api/collections?seriesId=${encodeURIComponent(seriesId)}`);
    removed.content.find(x => x.id === list.id)?.contains === false ? ok('unchecking removes the series on the server') : bad('list removal was not stored');
    await shot('list-membership-toggles');
    await page.keyboard.press('Escape');
  } catch (error) { bad(`list membership walk: ${error.message}`); }
  finally {
    if (list) await api(base, token, `/api/collections/${list.id}`, 'DELETE').catch(error => bad(`membership cleanup: ${error.message}`));
    await page.goto(base + seriesHref, { waitUntil: 'networkidle2', timeout: 60000 });
  }
}

export async function pagedFitWalk({ page, base, token, seriesHref, bookId, ok, bad, shot }) {
  if (!bookId) { bad('paged fit walk needs the reader book'); return; }
  const seriesId = new URL(seriesHref, base).searchParams.get('id');
  const previous = await api(base, token, '/api/settings');
  const viewport = page.viewport();
  const local = await page.evaluate(id => Object.fromEntries(['yomi_reader_prefs', `yomi_rs_${id}`].map(k => [k, localStorage.getItem(k)])), seriesId);
  const configure = async (rtl, spread = false) => {
    const reader = { ...(previous.reader || {}), mode: 'paged', spread, pagedFitWidth: true, pagedDirection: rtl ? 'rtl' : 'ltr',
      widePages: 'whole', cropBorders: false, joinSplit: false, autoMode: false };
    const look = { mode: 'paged', spread, spreadShift: spread, pagedDirection: rtl ? 'rtl' : 'ltr', directionChosen: true, zoom: 1 };
    await api(base, token, '/api/settings', 'PUT', { reader, readerSeries: { ...(previous.readerSeries || {}), [seriesId]: look } });
    await page.evaluate(({ reader, look, id }) => {
      localStorage.setItem('yomi_reader_prefs', JSON.stringify(reader)); localStorage.setItem(`yomi_rs_${id}`, JSON.stringify(look));
    }, { reader, look, id: seriesId });
    await page.goto(`${base}/reader/?book=${encodeURIComponent(bookId)}&page=1`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-paged-scroll="0"] img')].some(img => img.complete && img.naturalWidth));
    await page.waitForFunction(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[data-paged-scroll="0"]'));
  };
  try {
    await page.setViewport({ width: 1280, height: 800 });
    for (const rtl of [false, true]) {
      await configure(rtl);
      const geometry = await page.evaluate(() => {
        const pane = document.querySelector('[data-paged-scroll="0"]'); const image = pane.querySelector('img');
        return { width: image.getBoundingClientRect().width, available: pane.clientWidth, height: pane.scrollHeight, viewport: pane.clientHeight };
      });
      Math.abs(geometry.width - geometry.available) <= 4 && geometry.height > geometry.viewport + 10
        ? ok(`paged Fit width fills the slide and permits vertical reading (${rtl ? 'RTL' : 'LTR'})`)
        : bad(`paged Fit width has wrong geometry (${rtl ? 'RTL' : 'LTR'}): ${JSON.stringify(geometry)}`);
      const position = () => page.$eval('[data-paged-scroll="0"]', pane => ({
        x: pane.scrollLeft, y: pane.scrollTop, width: pane.scrollWidth, height: pane.scrollHeight,
        viewportWidth: pane.clientWidth, viewportHeight: pane.clientHeight,
        slide: Math.round(Math.abs(pane.parentElement.scrollLeft) / pane.parentElement.clientWidth),
      }));
      const waitSlide = slide => page.waitForFunction(expected => {
        const track = document.querySelector('[data-paged-scroll="0"]')?.parentElement;
        return track && Math.round(Math.abs(track.scrollLeft) / track.clientWidth) === expected;
      }, {}, slide);
      await page.keyboard.press('PageDown'); await sleep(250);
      const keyDown = await position();
      keyDown.y > 0 && keyDown.slide === 0 ? ok('PageDown reads lower content before turning the slide') : bad(`PageDown skipped content: ${JSON.stringify(keyDown)}`);
      await page.keyboard.press('PageUp');
      await page.waitForFunction(() => {
        const pane = document.querySelector('[data-paged-scroll="0"]');
        return pane && pane.scrollTop <= 2 && Math.round(Math.abs(pane.parentElement.scrollLeft) / pane.parentElement.clientWidth) === 0;
      });
      const keyUp = await position();
      keyUp.y <= 2 && keyUp.slide === 0 ? ok('PageUp reads back within the same slide') : bad(`PageUp skipped content: ${JSON.stringify(keyUp)}`);
      await page.$eval('[data-paged-scroll="0"]', pane => { pane.scrollTop = pane.scrollHeight - pane.clientHeight; });
      await page.keyboard.press('PageDown'); await waitSlide(1); await sleep(200);
      ok('PageDown turns the slide after reaching the bottom');
      await page.keyboard.press('PageUp'); await waitSlide(0); await sleep(200);
      await page.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight'); await waitSlide(1); await sleep(200);
      ok(`physical arrow still turns immediately (${rtl ? 'RTL' : 'LTR'})`);
      await page.keyboard.press(rtl ? 'ArrowRight' : 'ArrowLeft'); await waitSlide(0); await sleep(200);
      const moved = await page.evaluate(() => {
        const pane = document.querySelector('[data-paged-scroll="0"]'); const track = pane.parentElement;
        const before = track.scrollLeft; pane.scrollTop = 100; return { top: pane.scrollTop, before, after: track.scrollLeft };
      });
      moved.top > 0 && moved.before === moved.after ? ok(`scrolling the page retains the current slide (${rtl ? 'RTL' : 'LTR'})`) : bad('vertical page scroll changed slides or could not scroll');
      // Exercise the real mouse zoom path, then its drag path: the width-fitted image must remain reachable.
      // Page turns can start the next chapter's metadata prefetch. The retained pane's DOM is behind its loading
      // overlay until that finishes; send input only when the picture itself can receive it.
      await page.waitForFunction(() => document.elementFromPoint(640, 400)?.closest('[data-paged-scroll="0"]'));
      await page.mouse.click(640, 400, { count: 2, delay: 80 }); await sleep(400);
      const zoomed = await page.$eval('[data-paged-scroll="0"]', pane => pane.scrollWidth > pane.clientWidth * 1.5);
      zoomed ? ok(`width-fitted page zooms without switching slides (${rtl ? 'RTL' : 'LTR'})`) : bad('width-fitted page did not zoom');
      await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(550, 300, { steps: 6 }); await page.mouse.up();
      const pan = await page.$eval('[data-paged-scroll="0"]', pane => ({ x: pane.scrollLeft, y: pane.scrollTop }));
      pan.x > 0 && pan.y > 0 ? ok(`zoomed width-fitted page can be panned (${rtl ? 'RTL' : 'LTR'})`) : bad(`width-fitted pan failed: ${JSON.stringify(pan)}`);
      // Native pinch events exercise the actual zoom setter and browser layout clamping, including zoom-out.
      const cdp = await page.createCDPSession();
      try {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const pinch = async factor => {
          const points = half => [{ x: 640 - half, y: 400, id: 1, radiusX: 4, radiusY: 4, force: 1 },
            { x: 640 + half, y: 400, id: 2, radiusX: 4, radiusY: 4, force: 1 }];
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(100) });
          for (let i = 1; i <= 12; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(100 * (1 + (factor - 1) * i / 12)) });
            await sleep(20);
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250);
        };
        const anchor = (before, after) => {
          const expectedX = Math.max(0, Math.min(after.width - after.viewportWidth,
            (before.x + before.viewportWidth / 2) * after.width / before.width - after.viewportWidth / 2));
          const expectedY = Math.max(0, Math.min(after.height - after.viewportHeight,
            (before.y + before.viewportHeight / 2) * after.width / before.width - after.viewportHeight / 2));
          return Math.abs(after.x - expectedX) <= 5 && Math.abs(after.y - expectedY) <= 5 && after.slide === 0;
        };
        const beforeIn = await position(); await pinch(1.5); const afterIn = await position();
        afterIn.width > beforeIn.width * 1.2 && anchor(beforeIn, afterIn)
          ? ok('pinch zoom preserves both anchors after an off-centre pan') : bad(`pinch zoom moved the reading anchor: ${JSON.stringify({ beforeIn, afterIn })}`);
        await page.$eval('[data-paged-scroll="0"]', pane => {
          pane.scrollLeft = pane.scrollWidth - pane.clientWidth - 8; pane.scrollTop = pane.scrollHeight - pane.clientHeight - 8;
        });
        const beforeOut = await position(); await pinch(2 / 3); const afterOut = await position();
        afterOut.width < beforeOut.width * 0.8 && anchor(beforeOut, afterOut)
          ? ok('pinch zoom-out preserves clamped anchors at the lower right edge') : bad(`zoom-out lost its pre-resize anchor: ${JSON.stringify({ beforeOut, afterOut })}`);
      } finally {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach();
      }
      await shot(`paged-fit-width-${rtl ? 'rtl' : 'ltr'}`);
    }
    for (const rtl of [false, true]) {
      await configure(rtl, true);
      await page.waitForFunction(() => document.querySelectorAll('[data-paged-scroll="0"] img').length === 2);
      await page.keyboard.press('z');
      await page.waitForFunction(() => document.querySelectorAll('[data-paged-scroll="0"] img').length === 1);
      const focusedPage = await page.$eval('[data-paged-scroll="0"] img', el => el.alt);
      await page.keyboard.press('PageDown'); await sleep(250);
      const reading = await page.$eval('[data-paged-scroll="0"]', pane => ({ top: pane.scrollTop,
        slide: Math.round(Math.abs(pane.parentElement.scrollLeft) / pane.parentElement.clientWidth),
        label: pane.querySelector('img')?.alt }));
      reading.top > 0 && reading.slide === 0 && reading.label === focusedPage
        ? ok(`a tall focused page scrolls before its spread partner (${rtl ? 'RTL' : 'LTR'})`) : bad(`focused page skipped content: ${JSON.stringify(reading)}`);
      await page.$eval('[data-paged-scroll="0"]', pane => { pane.scrollTop = pane.scrollHeight - pane.clientHeight; });
      await page.keyboard.press('PageDown');
      await page.waitForFunction(before => document.querySelector('[data-paged-scroll="0"] img')?.alt !== before, {}, focusedPage);
      await sleep(200);
      const partner = await page.$eval('[data-paged-scroll="0"]', pane => ({ top: pane.scrollTop,
        slide: Math.round(Math.abs(pane.parentElement.scrollLeft) / pane.parentElement.clientWidth),
        label: pane.querySelector('img')?.alt }));
      partner.top <= 2 && partner.slide === 0 && partner.label && partner.label !== focusedPage
        ? ok(`the focused spread partner opens at its top (${rtl ? 'RTL' : 'LTR'})`) : bad(`focused partner inherited the previous scroll: ${JSON.stringify(partner)}`);
    }
    // The mode's own control switches back to the old whole-page layout.
    if (!(await page.$('[data-reader-settings]'))) {
      await page.waitForFunction(() => document.elementFromPoint(640, 400)?.closest('[data-paged-scroll]'));
      await page.mouse.click(640, 400);
    }
    // The control can be inside its exit animation when this long walk reaches it. Open the same settings
    // action synchronously, as the original walk did, rather than click a stale animated element handle.
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-reader-settings]');
      if (!button) return false;
      button.click(); return true;
    });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Whole page'));
    await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Whole page')?.click());
    await page.waitForSelector('[data-paged-scroll]', { hidden: true });
    ok('Whole page restores the previous contained layout');
    await page.goto(`${base}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1700); // allow the fixture's debounced setting write to settle before restoring it
  } catch (error) { bad(`paged fit walk: ${error.message}`); }
  finally {
    await api(base, token, '/api/settings', 'PUT', { reader: previous.reader || {}, readerSeries: previous.readerSeries || {}, readerSource: previous.readerSource || {} });
    await page.evaluate(values => { for (const [k, v] of Object.entries(values)) v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }, local);
    await page.setViewport(viewport);
    await page.goto(`${base}/reader/?book=${encodeURIComponent(bookId)}&page=1`, { waitUntil: 'networkidle2', timeout: 60000 });
  }
}


export async function manualUploadWalk({ page, base, token, ok, bad, shot }) {
  const seed = process.env.LIB && join(process.env.LIB, 'Test Source', 'Mixed Formats', 'Chapter 001.cbz');
  if (!seed) { bad('manual upload walk requires the normal seeded library path'); return; }
  const title = `Upload walk ${Date.now()}`;
  let temp; let seriesId;
  try {
    temp = await mkdtemp(join(tmpdir(), 'uchiyomi-upload-walk-'));
    const extra = join(temp, 'Chapter 002.cbz'); await copyFile(seed, extra);
    await page.goto(`${base}/upload/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('[data-upload-series] input:not([type="file"])');
    await page.type('[data-upload-series] input:not([type="file"])', title);
    await (await page.$('[data-upload-series] input[type="file"]')).uploadFile(seed);
    await page.waitForFunction(() => !document.querySelector('[data-upload-start]')?.disabled);
    await page.click('[data-upload-start]');
    const open = await page.waitForSelector('[data-upload-series] a[href*="/series/"]');
    seriesId = new URL(await open.evaluate(el => el.href)).searchParams.get('id');
    seriesId ? ok('a real CBZ uploaded through the file picker creates a series') : bad('upload UI returned no series link');
    await page.goto(`${base}/upload/?seriesId=${encodeURIComponent(seriesId)}`, { waitUntil: 'networkidle2', timeout: 60000 });
    const picker = await page.waitForSelector('[data-upload-series] input[type="file"]');
    await picker.uploadFile(extra); await picker.uploadFile(extra);
    (await page.$$('[data-upload-files] li')).length === 1 ? ok('selecting the same upload twice does not duplicate the queue') : bad('duplicate file picker selection entered the upload queue');
    await page.click('[data-upload-start]');
    await page.waitForSelector('[data-upload-series] a[href*="/series/"]');
    const books = await api(base, token, `/api/series/${encodeURIComponent(seriesId)}/books?size=20`);
    books.content.some(b => b.number === 1) && books.content.some(b => b.number === 2)
      ? ok('uploading another real file adds the missing chapter to the existing series') : bad('existing-series upload did not preserve both chapters');
    const repeated = await fetch(`${base}/api/library/upload?seriesId=${encodeURIComponent(seriesId)}&name=Chapter%20002.cbz`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: await readFile(extra) });
    const refusal = await repeated.json();
    repeated.status === 409 && refusal.error === 'exists' ? ok('re-uploading a stored filename is refused without overwrite') : bad(`duplicate upload was not refused: ${repeated.status}`);
    await shot('manual-upload-existing-series');
  } catch (error) { bad(`manual upload walk: ${error.message}`); }
  finally {
    if (seriesId) {
      try {
        const owned = await api(base, token, `/api/series/${encodeURIComponent(seriesId)}`);
        if (owned.id !== seriesId || owned.name !== title || !title.startsWith('Upload walk ')) throw new Error('created upload identity changed; refusing cleanup');
        // These are separate deliberate actions in the product: remove, then delete files, then forget.
        await api(base, token, `/api/admin/series/${seriesId}`, 'DELETE');
        await api(base, token, `/api/admin/series/${seriesId}/delete-files`, 'POST', { confirm: title });
        await api(base, token, `/api/admin/series/${seriesId}/forget`, 'POST', { confirm: title });
        ok('only the upload walk’s own series, files and history were cleaned up');
      } catch (error) { bad(`upload cleanup: ${error.message}`); }
    }
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
