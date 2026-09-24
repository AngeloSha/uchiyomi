// The desktop app's own pages, photographed from the REAL Electron app (not a browser, not a mock-up).
//
//   xvfb-run -a node scripts/shots/desktop.mjs                       # every shot
//   xvfb-run -a node scripts/shots/desktop.mjs --only desktop-welcome,desktop-server
//   SITE_DIR=/path/to/site/assets/shots xvfb-run -a node scripts/shots/desktop.mjs
//
// Linux with Xvfb, node 22+, `npm ci` in desktop/ with the Electron binary installed
// (`node desktop/node_modules/electron/install.js` if npm skipped it) and `npm run build` there, and openssl.
// SHOT_SERVER is a throwaway Uchiyomi to connect to (web/test/e2e/up.sh with KEEP=1, default
// http://127.0.0.1:18140) -- its server name is what the pages show, so set it first (Admin -> Settings). The
// engine card needs the standalone app's payload staged (`node desktop/scripts/stage.mjs`); without it that one
// shot is skipped and says so. Writes docs/shots/desktop-*.webp (and SITE_DIR copies), with bff's sharp.
//
// What the shots show, and the one input that is not this machine's (docs/SCREENSHOTS.md lists it):
//   desktop-welcome              the first launch, on a fresh profile
//   desktop-server               the address step, `https://manga.home.arpa:8443` typed
//   desktop-certificate          the ask-once prompt for a self-signed certificate made here (CN manga.home.arpa)
//   desktop-certificate-changed  the same host re-keyed: the loud warning
//   desktop-server-error         a saved server that does not answer
//   desktop-library-folder       the folder page from the chooser. FIXTURE: its path is set through the page's
//                                own show() to what a Windows PC computes, not this Linux host's home folder
//   desktop-engine               Admin -> Extensions before the engine download (standalone)
// manga.home.arpa (RFC 8375's home-network name) is mapped to 127.0.0.1 with Chromium's --host-resolver-rules,
// so no real host and no /etc/hosts edit is involved; an https front with each certificate proxies to SHOT_SERVER.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESK = process.env.DESKTOP_DIR || path.join(REPO, 'desktop');
const puppeteer = createRequire(path.join(DESK, 'package.json'))('puppeteer-core');
const sharp = createRequire(path.join(REPO, 'bff', 'package.json'))('sharp');
const ELECTRON = path.join(DESK, 'node_modules', 'electron', 'dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const SERVER = new URL(process.env.SHOT_SERVER || 'http://127.0.0.1:18140');
const DOCS = path.join(REPO, 'docs', 'shots');
const SITE = process.env.SITE_DIR || '';
const ONLY = (process.argv.find((a, i) => process.argv[i - 1] === '--only') || '').split(',').filter(Boolean);
const want = (n) => !ONLY.length || ONLY.includes(n);
const HOST = 'manga.home.arpa';
const PORT = Number(process.env.SHOT_HTTPS_PORT || 8443);
const VIEW = { width: 1040, height: 700, deviceScaleFactor: 2 };
// The site's phone plates: the same page laid out at phone width, at native scale -- a 1250px desktop plate
// shown in a 390px column puts the page's 15px text at about 8px.
const PHONE = { width: 400, height: 860, deviceScaleFactor: 3 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uchiyomi-desktop-shots-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Everything started here, so that a failure ends the run instead of leaving an app and a server holding it open.
const children = new Set();
const servers = new Set();

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what} (${String(last).slice(0, 200)})`);
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const readState = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')); } catch { return {}; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A self-signed certificate for the made-up host, and its fingerprint the way openssl prints it. */
function certificate(name) {
  const key = path.join(TMP, `${name}.key`), pem = path.join(TMP, `${name}.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', pem,
    '-days', '825', '-subj', `/CN=${HOST}/O=Home server`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  const fp = execFileSync('openssl', ['x509', '-in', pem, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' }).split('=')[1].trim();
  return { key, pem, fp };
}

/** An https front on PORT with one certificate, proxying to the throwaway server. */
function front(cert) {
  const srv = https.createServer({ cert: fs.readFileSync(cert.pem), key: fs.readFileSync(cert.key) }, (req, res) => {
    const p = http.request({ host: SERVER.hostname, port: SERVER.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: SERVER.host, 'x-forwarded-proto': 'https' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(p);
  });
  servers.add(srv);
  return new Promise((res) => srv.listen(PORT, '127.0.0.1', () => res(srv)));
}

async function launch(root, extra = []) {
  const dbg = await freePort();
  const log = fs.openSync(path.join(TMP, `${path.basename(root)}.log`), 'a');
  const child = spawn(ELECTRON, [DESK, '--no-sandbox', '--lang=en-US', `--data-dir=${root}`, `--remote-debugging-port=${dbg}`,
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, ...extra], { env: { ...process.env, HOME }, stdio: ['ignore', log, log], detached: true });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const browserURL = `http://127.0.0.1:${dbg}`;
  await waitFor(async () => (await fetch(`${browserURL}/json/version`, { signal: AbortSignal.timeout(2000) })).ok, 60_000, 'the debug port');
  return { child, browser: await puppeteer.connect({ browserURL, defaultViewport: null, protocolTimeout: 120_000 }) };
}
// By TARGET url: puppeteer's Page.url() can stay '' for a page whose first navigation was replaced (builder M).
const pageAt = (browser, pred, what, ms = 60_000) => waitFor(async () => {
  const t = browser.targets().find((x) => x.type() === 'page' && pred(x.url()));
  return t ? t.page() : null;
}, ms, what);
const visible = (p, id) => p.evaluate((x) => { const el = document.getElementById(x); return !!el && !el.hidden && el.getClientRects().length > 0; }, id);
async function quit(root) {
  const pid = readState(root).mainPid;
  await new Promise((r) => spawn(ELECTRON, [DESK, '--no-sandbox', '--quit-for-update', `--data-dir=${root}`], { env: { ...process.env, HOME }, stdio: 'ignore' }).on('exit', r));
  if (pid) await waitFor(() => !alive(pid), 30_000, 'the app to quit');
}

const shots = [];
/** The shell pages sit centred on a black window: keep the page, trim the empty black around it. */
async function shot(p, name, { clip = null, trim = true } = {}) {
  if (!want(name)) return;
  await p.setViewport(VIEW);
  await sleep(900);
  const png = await p.screenshot(clip ? { clip } : {});
  const img = trim ? await sharp(png).trim({ background: '#000000', threshold: 6 })
    .extend({ top: 56, bottom: 56, left: 64, right: 64, background: '#000000' }).toBuffer() : png;
  await sharp(img).webp({ quality: 86 }).toFile(path.join(DOCS, `${name}.webp`));
  if (SITE) await sharp(img).resize({ width: 1800, withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(SITE, `${name}.webp`));
  shots.push(name);
  console.log(`  ✓ ${name}`);
  if (SITE && trim) {
    await p.setViewport(PHONE);
    await sleep(900);
    const small = await sharp(await p.screenshot()).trim({ background: '#000000', threshold: 6 })
      .extend({ top: 48, bottom: 48, left: 36, right: 36, background: '#000000' }).toBuffer();
    await sharp(small).webp({ quality: 80 }).toFile(path.join(SITE, `phone-${name}.webp`));
    await p.setViewport(VIEW);
    console.log(`  ✓ phone-${name} (site only)`);
  }
}

async function serverShots() {
  const A = certificate('a'), B = certificate('b');
  const root = path.join(TMP, 'server');
  let srv = await front(A);
  let { browser } = await launch(root);
  let p = await pageAt(browser, (u) => u.includes('welcome.html'), 'the first-launch page');
  await waitFor(() => visible(p, 'pickServer'), 20_000, 'the two cards');
  await shot(p, 'desktop-welcome');
  await p.click('#pickServer');
  await waitFor(() => visible(p, 'addr'), 10_000, 'the address step');
  await p.type('#addr', `https://${HOST}:${PORT}`);
  await shot(p, 'desktop-server');
  await p.click('#connect');
  await waitFor(() => visible(p, 'trust'), 30_000, 'the certificate prompt');
  const shown = await p.evaluate(() => document.getElementById('cFp').textContent);
  // The page's fingerprint must be openssl's, or the docs' advice to compare them is wrong.
  if (shown.trim() !== A.fp) throw new Error(`the prompt shows ${shown}, openssl says ${A.fp}`);
  await shot(p, 'desktop-certificate');
  await p.click('#trust');
  await pageAt(browser, (u) => u.startsWith(`https://${HOST}:${PORT}`), 'the server window');
  browser.disconnect();
  await quit(root);

  await new Promise((r) => srv.close(r));
  srv = await front(B);
  ({ browser } = await launch(root));
  p = await pageAt(browser, (u) => u.includes('welcome.html'), 'the changed-certificate warning');
  await waitFor(() => visible(p, 'replace'), 30_000, 'Trust the new certificate…');
  await shot(p, 'desktop-certificate-changed');
  browser.disconnect();
  await quit(root);
  await new Promise((r) => srv.close(r));

  // Saved server, nothing answering, nothing cached for it: the error page.
  const down = path.join(TMP, 'down');
  fs.mkdirSync(down);
  fs.writeFileSync(path.join(down, 'state.json'), JSON.stringify({ mode: 'server', serverOrigin: `https://${HOST}:${PORT}`, serverName: 'Home library' }));
  ({ browser } = await launch(down));
  p = await pageAt(browser, (u) => u.includes('welcome.html'), 'the error page');
  await waitFor(() => visible(p, 'errRetry'), 30_000, 'Try again');
  await shot(p, 'desktop-server-error');
  browser.disconnect();
  await quit(down);
}

async function folderShot() {
  const root = path.join(TMP, 'local');
  const { browser } = await launch(root);
  const p = await pageAt(browser, (u) => u.includes('welcome.html'), 'the first-launch page');
  await waitFor(() => visible(p, 'pickLocal'), 20_000, 'the two cards');
  await p.click('#pickLocal');
  const f = await pageAt(browser, (u) => u.includes('firstrun.html'), 'the folder page');
  await waitFor(() => f.evaluate(() => !!document.getElementById('dir')?.textContent), 20_000, 'the default folder');
  if (await f.evaluate(() => document.getElementById('back').hidden)) throw new Error('the folder page from the chooser has no Back');
  // FIXTURE: a Windows PC's default (os.homedir() + "Uchiyomi Library") instead of this build host's home folder.
  await f.evaluate(() => show({ dir: 'C:\\Users\\you\\Uchiyomi Library', freeGB: 412 }));
  await shot(f, 'desktop-library-folder');
  browser.disconnect();
  await quit(root);
}

async function engineShot() {
  if (!fs.existsSync(path.join(DESK, 'resources', 'bff'))) { console.log('  · skipped desktop-engine: stage the payload first (node desktop/scripts/stage.mjs)'); return; }
  const root = path.join(TMP, 'engine'), lib = path.join(TMP, 'library');
  fs.mkdirSync(lib);
  const { browser } = await launch(root, [`--library-dir=${lib}`]);
  const app = await pageAt(browser, (u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u), 'the local app', 240_000);
  await app.setViewport(VIEW);
  await sleep(5000);
  await app.goto(`${new URL(app.url()).origin}/admin/?tab=Extensions`, { waitUntil: 'domcontentloaded' });
  const box = await waitFor(() => app.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Download the extension engine'));
    const card = b?.closest('.card');
    if (!card) return null;
    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = card.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  }), 60_000, 'the engine download card');
  await sleep(800);
  await shot(app, 'desktop-engine', { clip: box, trim: false });
  browser.disconnect();
  await quit(root);
}

try {
  if (['desktop-welcome', 'desktop-server', 'desktop-certificate', 'desktop-certificate-changed', 'desktop-server-error'].some(want)) await serverShots();
  if (want('desktop-library-folder')) await folderShot();
  if (want('desktop-engine')) await engineShot();
  console.log(`done: ${shots.length} shot(s). Look at every one before committing it.`);
} catch (e) {
  console.error('DESKTOP SHOTS FAILED:', e.message);
  process.exitCode = 1;
} finally {
  // ⚠️ A failure mid-run leaves an app (with its own Postgres, for the engine shot) and an https front
  // running, and either keeps this process alive for ever. Take the process groups down, then leave.
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (const srv of servers) srv.close();
  await sleep(children.size ? 3000 : 0);
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
