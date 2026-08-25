// Record the product tour for the marketing hero and the README.
//
// Uses CDP Page.startScreencast rather than a screenshot loop, because the point of the recording is the
// reader's continuous scroll and a loop cannot capture that smoothly. Frames are written with their real
// timestamps and an ffmpeg concat manifest, so the encode preserves the actual pacing instead of assuming a
// constant frame interval.
//
// Reduced motion is deliberately NOT forced here (unlike the stills): the app's own transitions are the point.
//
// It runs against a live instance, so the route stops short of anything destructive — notably it hovers the
// Add button in the extension browser but never clicks it, which would really install an extension.
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const BASE = process.env.SHOT_BASE || 'http://uchiyomi:3000';
const OUT = process.env.SHOT_OUT || '/out';
const USER = process.env.SHOT_USER;
const PASS = process.env.SHOT_PASS;
const SERIES_ID = process.env.SHOT_SERIES_ID || '';
const BOOK_ID = process.env.SHOT_BOOK_ID || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(`${OUT}/frames`, { recursive: true });
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  // sign in before recording starts — nobody wants to watch a login
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('input[type=password]', { timeout: 30000 });
  const inputs = await page.$$('input');
  await inputs[0].type(USER);
  await page.type('input[type=password]', PASS);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}), page.click('button[type=submit]')]);
  await sleep(3000);
  if (await page.$('input[type=password]')) throw new Error('login failed');

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);

  const client = await page.createCDPSession();
  const frames = [];
  client.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
    frames.push({ data, t: metadata.timestamp, wall: Date.now() });
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch {}
  });
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  const t0 = Date.now();

  // Pacing is baked in PER SEGMENT rather than applied to the whole clip afterwards. A flat speed-up
  // compresses the parts worth watching exactly as hard as the waiting, which is how the first cut ended up
  // both too fast to follow AND cutting away before a search had returned anything.
  //
  // `hold` marks something worth seeing and plays near real time; `skim` marks loading and dead air and is
  // compressed hard. `rates` records when each change happened, and the durations written into the concat
  // manifest are divided accordingly, so ffmpeg encodes at 1x.
  const rates = [{ t: Date.now(), r: 4.5 }];
  const setRate = (r) => rates.push({ t: Date.now(), r });
  const hold = async (ms) => { setRate(1.15); await sleep(ms); setRate(4.5); };
  const skim = async (ms) => { setRate(4.5); await sleep(ms); };
  /** Wait for something real to appear, skimming the wait, then hold on the result. */
  const awaitThen = async (fn, holdMs, timeout = 40000) => {
    setRate(6);
    await page.waitForFunction(fn, { timeout, polling: 400 }).catch(() => {});
    await hold(holdMs);
  };
  const beat = skim;

  // ---- the route ----
  await hold(1700);                                                     // home

  // command palette
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await hold(600);
  for (const ch of 'martial') { await page.keyboard.type(ch); await sleep(85); }
  await hold(1500);
  await page.keyboard.press('Escape');
  await beat(500);

  // a series, with its art resolving on camera
  if (SERIES_ID) {
    await page.goto(`${BASE}/series/?id=${SERIES_ID}`, { waitUntil: 'networkidle2', timeout: 45000 });
    // wait for the cover art to actually resolve rather than filming a placeholder
    await awaitThen(() => [...document.images].some((i) => i.complete && i.naturalWidth > 200), 1500);
    await page.evaluate(() => window.scrollBy({ top: 420, behavior: 'smooth' }));
    await hold(1500);
  }

  // the reader — the centerpiece, and the one thing never shown moving.
  // Scroll continuously through a chapter boundary so the "Up Next" divider passes on camera.
  if (BOOK_ID) {
    await page.goto(`${BASE}/reader/?book=${BOOK_ID}`, { waitUntil: 'networkidle2', timeout: 45000 });
    await hold(1400);
    await page.evaluate(async () => {
      const el = document.querySelector('[data-lenis-prevent]');
      if (!el) return;
      // Start a fifth of the way in. Page one of a scanlated chapter is usually a credits page covered in
      // another site's branding, Patreon and Discord links -- not something to put on a homepage. The still
      // screenshots already skip it; the recording has to as well.
      el.scrollTop = Math.floor(el.scrollHeight * 0.2);
      await new Promise((r) => setTimeout(r, 600));
      const target = Math.floor(el.scrollHeight * 0.92);
      const start = performance.now(), dur = 7000, from = el.scrollTop;
      await new Promise((res) => {
        const step = (now) => {
          const p = Math.min(1, (now - start) / dur);
          el.scrollTop = from + (target - from) * p;
          p < 1 ? requestAnimationFrame(step) : res();
        };
        requestAnimationFrame(step);
      });
    });
    await hold(900);
  }

  // discover, mid-search
  await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 45000 });
  await hold(900);
  const box = await page.$('input[placeholder*="Search"]');
  if (box) {
    await box.click();
    for (const ch of 'solo leveling') { await page.keyboard.type(ch); await sleep(70); }
    await page.keyboard.press('Enter');
    // A cross-source search takes 10-20s. Wait for real result cards instead of guessing at a duration --
    // the first cut used a fixed 7s and cut away before anything had rendered.
    await awaitThen(() => document.body.innerText.includes('In library') ||
      document.querySelectorAll('img[src*="/img/sources/cover"]').length > 2, 3000, 45000);
  }

  // admin: health, then the extension browser
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2', timeout: 45000 });
  await hold(700);
  const clickTab = async (name) => {
    const h = await page.evaluateHandle((t) => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t), name);
    if (h.asElement()) await h.asElement().click();
  };
  await clickTab('Health');
  await awaitThen(() => /checks found something|All good/i.test(document.body.innerText), 2400);
  await clickTab('Providers'); await skim(900);
  const f = await page.$('input[placeholder*="Search extensions"]');
  if (f) {
    await f.click();
    for (const ch of 'manga') { await page.keyboard.type(ch); await sleep(85); }
    await awaitThen(() => document.querySelectorAll('img[src*="/img/extensions/icon/"]').length > 3, 2200);
  }
  // hover an Add button, deliberately without clicking: this is the live server.
  const add = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Add'));
  if (add.asElement()) { await add.asElement().hover(); await hold(1600); }

  await client.send('Page.stopScreencast');
  console.log(`  captured ${frames.length} frames over ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Write frames plus a concat manifest. Durations are the real inter-frame gaps divided by whatever
  // rate was in force at that moment, so the pacing is already correct and ffmpeg encodes at 1x.
  const rateAt = (w) => { let r = rates[0].r; for (const c of rates) { if (c.t <= w) r = c.r; else break; } return r; };
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const name = `f${String(i).padStart(5, '0')}.jpg`;
    await writeFile(`${OUT}/frames/${name}`, Buffer.from(frames[i].data, 'base64'));
    const wall = i + 1 < frames.length ? Math.max(0.016, Math.min(0.5, frames[i + 1].t - frames[i].t)) : 0.08;
    const rate = rateAt(frames[i].wall);
    const dur = Math.max(0.012, wall / rate);
    lines.push(`file '${name}'`, `duration ${dur.toFixed(4)}`);
  }
  lines.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  await writeFile(`${OUT}/frames/concat.txt`, lines.join('\n'));
  console.log('  manifest written');
  await browser.close();
}

main().catch((e) => { console.error('RECORD FAILED:', e.message); process.exit(1); });
