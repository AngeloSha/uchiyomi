// @ts-check
'use strict';
/**
 * Updates, which differ by platform because the builds are unsigned (owner's decision):
 *
 *   Windows  electron-updater against the GitHub Release of the same `v*` tag (latest.yml), downloaded in the
 *            background. Installing works unsigned. ⚠️ The install is ALWAYS preceded by the full ordered
 *            shutdown (bff -> engine -> postgres): spike S5 showed the NSIS installer kills Uchiyomi.exe but
 *            leaves the six postgres.exe it started running from the install folder, and still exits 0.
 *   macOS    Squirrel.Mac refuses an unsigned app, so there is no auto-install. The shell asks GitHub for the
 *            latest release and offers "New version -- download" (tray + the Health page, via the bridge),
 *            which opens this Mac's .dmg in the browser. The bff's own GitHub check (Health -> Version) stays.
 *
 * Both check at launch (after a minute, so they never compete with start-up) and every 6 hours. Prereleases
 * are never offered: the extension-engine packs live on an `engine-v*` PRERELEASE, and rc tags are
 * prereleases too; GitHub's /releases/latest skips all of them, and so does electron-updater.
 */
const { EventEmitter } = require('node:events');

const REPO = 'AngeloSha/uchiyomi';
const SIX_HOURS = 6 * 60 * 60 * 1000;

/** `v0.44.0` / `0.44.0` -> [0,44,0]; a prerelease (`-rc.1`) or anything else -> null. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `candidate` a newer release than `current`? Unparseable -> false (never nag about something odd). */
function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * The newest release from GitHub's API, and the download for THIS Mac (arm64 or x64 dmg), else the release page.
 * @param {{ fetch?: typeof fetch, arch?: string, repo?: string, api?: string }} [o]
 * @returns {Promise<{ version: string, url: string } | null>}
 */
async function latestRelease(o = {}) {
  const f = o.fetch || fetch;
  const api = o.api || `https://api.github.com/repos/${o.repo || REPO}/releases/latest`;
  const r = await f(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Uchiyomi-Desktop' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const j = /** @type {any} */ (await r.json());
  if (!j || j.draft || j.prerelease || !parseVersion(j.tag_name)) return null;
  const version = String(j.tag_name).replace(/^v/, '');
  const arch = o.arch || process.arch;
  const want = new RegExp(`-${arch === 'arm64' ? 'arm64' : 'x64'}\\.dmg$`);
  const asset = (Array.isArray(j.assets) ? j.assets : []).find((a) => want.test(String(a?.name || '')));
  const url = String(asset?.browser_download_url || j.html_url || `https://github.com/${o.repo || REPO}/releases/latest`);
  // Only ever hand the browser a GitHub https link.
  if (!/^https:\/\/github\.com\//.test(url)) return { version, url: `https://github.com/${o.repo || REPO}/releases/latest` };
  return { version, url };
}

/**
 * Does this Quit install a downloaded Windows update? "Restart to update" and a plain Quit (the tray's Quit, or
 * app.quit() from the app menu: before-quit; in server mode, closing the window -- which IS Quit there, nothing
 * runs locally to keep in the tray) do. ⚠️ A quit that ANOTHER installer asked for (`--quit-for-update`,
 * which build/installer.nsh runs before replacing files) must not: it would start a second installer beside the
 * one that is already running. Nor does "Try again" on the error page (a relaunch). Nor does Windows ending the
 * session ('session-end', sessionend.js): it never reaches before-quit, and an installer started while the
 * session is torn down can be killed half-way through replacing files -- the update waits for the next Quit.
 * @param {string} reason @param {{ install?: boolean }} [o]
 */
function installOnQuit(reason, o = {}) {
  if (reason === 'session-end') return false;
  return !!o.install || reason === 'tray' || reason === 'before-quit' || reason === 'window-closed';
}

class Updates extends EventEmitter {
  /**
   * @param {{
   *   version: string,
   *   platform?: string,
   *   packaged: boolean,
   *   log: { info: Function, warn: Function, error: Function },
   *   openExternal: (url: string) => void,
   *   fetch?: typeof fetch,
   * }} o
   */
  constructor(o) {
    super();
    this.o = o;
    this.platform = o.platform || process.platform;
    /** @type {{ available: boolean, version?: string, url?: string, ready?: boolean }} */
    this.s = { available: false };
    this.updater = null;
    this.timer = null;
  }

  status() {
    return { ...this.s };
  }

  set(s) {
    this.s = s;
    this.emit('status', this.status());
  }

  start() {
    if (!this.o.packaged) { this.o.log.info('updates: not a packaged build; no update checks'); return; }
    if (this.platform === 'win32') this.startWindows();
    const first = setTimeout(() => this.check(), 60_000);
    first.unref?.();
    this.timer = setInterval(() => this.check(), SIX_HOURS);
    this.timer.unref?.();
  }

  startWindows() {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      // ⚠️ Never on its own at quit: our Quit ends in app.exit() after the ordered shutdown, which skips the
      // events electron-updater installs from, and an install it started itself would not stop postgres
      // first. main.js installs explicitly, after the shutdown, when a download is ready.
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowPrerelease = false;
      autoUpdater.logger = {
        info: (m) => this.o.log.info(`updater: ${m}`),
        warn: (m) => this.o.log.warn(`updater: ${m}`),
        error: (m) => this.o.log.error(`updater: ${m}`),
        debug: () => {},
      };
      autoUpdater.on('update-available', (i) => this.set({ available: true, version: i?.version, ready: false }));
      autoUpdater.on('update-downloaded', (i) => this.set({ available: true, version: i?.version, ready: true }));
      autoUpdater.on('error', (e) => this.o.log.warn('updater: check failed', { error: String(e?.message || e) }));
      this.updater = autoUpdater;
    } catch (e) {
      this.o.log.error('updater: electron-updater did not load', { error: String(e) });
    }
  }

  async check() {
    try {
      if (this.platform === 'win32') {
        await this.updater?.checkForUpdates();
        return;
      }
      const rel = await latestRelease({ fetch: this.o.fetch });
      if (rel && isNewer(rel.version, this.o.version)) {
        if (this.s.version !== rel.version) this.o.log.info('updates: a newer release exists', rel);
        this.set({ available: true, version: rel.version, url: rel.url });
      } else if (this.s.available) {
        this.set({ available: false });
      }
    } catch (e) {
      this.o.log.warn('updates: check failed', { error: String(/** @type {any} */ (e)?.message || e) });
    }
  }

  /**
   * Windows with a downloaded update: the caller has ALREADY stopped everything. Returns true when installing.
   * Silent either way (the one-click installer has nothing to ask); `relaunch` for "Restart to update", not
   * for a plain Quit.
   * @param {boolean} relaunch
   */
  installDownloaded(relaunch) {
    if (this.platform !== 'win32' || !this.s.ready || !this.updater) return false;
    this.updater.quitAndInstall(true, relaunch);
    return true;
  }

  /** macOS (and Windows before the download is ready): open the release in the browser. */
  openDownload() {
    const url = this.s.url || `https://github.com/${REPO}/releases/latest`;
    this.o.openExternal(url);
  }
}

module.exports = { Updates, parseVersion, isNewer, latestRelease, installOnQuit, REPO };
