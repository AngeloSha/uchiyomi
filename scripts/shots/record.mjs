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

const BASE = process.env.SHOT_BASE || 'http://yomi-web';
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
    frames.push({ data, t: metadata.timestamp });
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch {}
  });
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  const t0 = Date.now();
  const beat = async (ms) => sleep(ms);

  // ---- the route ----
  await beat(1800);                                                     // home, settling

  // command palette
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await beat(700);
  for (const ch of 'martial') { await page.keyboard.type(ch); await beat(90); }
  await beat(1400);
  await page.keyboard.press('Escape');
  await beat(500);

  // a series, with its art resolving on camera
  if (SERIES_ID) {
    await page.goto(`${BASE}/series/?id=${SERIES_ID}`, { waitUntil: 'networkidle2', timeout: 45000 });
    await beat(2600);
    await page.evaluate(() => window.scrollBy({ top: 420, behavior: 'smooth' }));
    await beat(1600);
  }

  // the reader — the centerpiece, and the one thing never shown moving.
  // Scroll continuously through a chapter boundary so the "Up Next" divider passes on camera.
  if (BOOK_ID) {
    await page.goto(`${BASE}/reader/?book=${BOOK_ID}`, { waitUntil: 'networkidle2', timeout: 45000 });
    await beat(2200);
    await page.evaluate(async () => {
      const el = document.querySelector('[data-lenis-prevent]');
      if (!el) return;
      const target = el.scrollHeight - el.clientHeight;
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
    await beat(1200);
  }

  // discover, mid-search
  await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 45000 });
  await beat(1500);
  const box = await page.$('input[placeholder*="Search"]');
  if (box) { await box.click(); for (const ch of 'solo leveling') { await page.keyboard.type(ch); await beat(70); } await page.keyboard.press('Enter'); await beat(7000); }

  // admin: health, then the extension browser
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2', timeout: 45000 });
  await beat(1200);
  const clickTab = async (name) => {
    const h = await page.evaluateHandle((t) => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t), name);
    if (h.asElement()) await h.asElement().click();
  };
  await clickTab('Health'); await beat(2400);
  await clickTab('Providers'); await beat(1600);
  const f = await page.$('input[placeholder*="Search extensions"]');
  if (f) { await f.click(); for (const ch of 'manga') { await page.keyboard.type(ch); await beat(90); } await beat(2600); }
  // hover an Add button, deliberately without clicking: this is the live server.
  const add = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Add'));
  if (add.asElement()) { await add.asElement().hover(); await beat(1800); }

  await client.send('Page.stopScreencast');
  console.log(`  captured ${frames.length} frames over ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Write frames plus a concat manifest carrying the real inter-frame gaps, so pacing survives the encode.
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const name = `f${String(i).padStart(5, '0')}.jpg`;
    await writeFile(`${OUT}/frames/${name}`, Buffer.from(frames[i].data, 'base64'));
    const dur = i + 1 < frames.length ? Math.max(0.016, Math.min(0.5, frames[i + 1].t - frames[i].t)) : 0.08;
    lines.push(`file '${name}'`, `duration ${dur.toFixed(4)}`);
  }
  lines.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  await writeFile(`${OUT}/frames/concat.txt`, lines.join('\n'));
  console.log('  manifest written');
  await browser.close();
}

main().catch((e) => { console.error('RECORD FAILED:', e.message); process.exit(1); });
