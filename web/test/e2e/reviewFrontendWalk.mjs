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
  const configure = async (rtl) => {
    const reader = { ...(previous.reader || {}), mode: 'paged', spread: false, pagedFitWidth: true, pagedDirection: rtl ? 'rtl' : 'ltr',
      widePages: 'whole', cropBorders: false, joinSplit: false, autoMode: false };
    const look = { mode: 'paged', spread: false, pagedDirection: rtl ? 'rtl' : 'ltr', directionChosen: true, zoom: 1 };
    await api(base, token, '/api/settings', 'PUT', { reader, readerSeries: { ...(previous.readerSeries || {}), [seriesId]: look } });
    await page.evaluate(({ reader, look, id }) => {
      localStorage.setItem('yomi_reader_prefs', JSON.stringify(reader)); localStorage.setItem(`yomi_rs_${id}`, JSON.stringify(look));
    }, { reader, look, id: seriesId });
    await page.goto(`${base}/reader/?book=${encodeURIComponent(bookId)}&page=1`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-paged-scroll="0"] img')].some(img => img.complete && img.naturalWidth));
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
      const moved = await page.evaluate(() => {
        const pane = document.querySelector('[data-paged-scroll="0"]'); const track = pane.parentElement;
        const before = track.scrollLeft; pane.scrollTop = 100; return { top: pane.scrollTop, before, after: track.scrollLeft };
      });
      moved.top > 0 && moved.before === moved.after ? ok(`scrolling the page retains the current slide (${rtl ? 'RTL' : 'LTR'})`) : bad('vertical page scroll changed slides or could not scroll');
      // Exercise the real mouse zoom path, then its drag path: the width-fitted image must remain reachable.
      await page.mouse.click(640, 400, { count: 2, delay: 80 }); await sleep(400);
      const zoomed = await page.$eval('[data-paged-scroll="0"]', pane => pane.scrollWidth > pane.clientWidth * 1.5);
      zoomed ? ok(`width-fitted page zooms without switching slides (${rtl ? 'RTL' : 'LTR'})`) : bad('width-fitted page did not zoom');
      await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(550, 300, { steps: 6 }); await page.mouse.up();
      const pan = await page.$eval('[data-paged-scroll="0"]', pane => ({ x: pane.scrollLeft, y: pane.scrollTop }));
      pan.x > 0 && pan.y > 0 ? ok(`zoomed width-fitted page can be panned (${rtl ? 'RTL' : 'LTR'})`) : bad(`width-fitted pan failed: ${JSON.stringify(pan)}`);
      await shot(`paged-fit-width-${rtl ? 'rtl' : 'ltr'}`);
    }
    // The mode's own control switches back to the old whole-page layout.
    await page.evaluate(() => document.querySelector('[data-reader-settings]')?.click());
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
