// @ts-check
'use strict';
/**
 * The main-process half of the preload bridge (preload.js): one ipcMain handler per call, and a check on
 * EVERY call that it came from the page allowed to make it.
 *
 *   desktop:*   only from the app window, showing the app's own origin (http://127.0.0.1:<ui port>)
 *   firstrun:*  only from the app window, showing the shell's firstrun.html
 *   shell:*     only from the app window, showing one of the shell's own file:// pages
 *
 * The window never shows anything else (main.js blocks navigation away from those), but a check that holds
 * whatever the page is costs nothing, and it is what keeps a solver window -- which loads arbitrary manga
 * sites, in other partitions, without this preload -- from ever reaching these handlers.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

/**
 * Is this IPC message from the app window's top frame, currently at `origin`?
 * @param {any} e Electron's IpcMainEvent / IpcMainInvokeEvent
 * @param {any} win
 * @param {string} origin
 */
function fromOrigin(e, win, origin) {
  if (!win || win.isDestroyed?.() || e.sender !== win.webContents) return false;
  const url = e.senderFrame?.url;
  if (!url || e.senderFrame.parent) return false; // top frame only (an iframe has a parent)
  try { return new URL(url).origin === origin; } catch { return false; }
}

/** The shell's own local pages, beside this file (inside app.asar when packaged). */
const SHELL_PAGES = ['loading.html', 'firstrun.html'];

/**
 * Is this IPC message from the app window showing one of the shell's OWN local pages -- `page`, or either when
 * omitted? Compared as file paths, not by name: a file called firstrun.html anywhere else on disk is not ours.
 * @param {any} e @param {any} win @param {string} [page] @param {string} [dir]
 */
function fromShellPage(e, win, page, dir = __dirname) {
  if (!win || win.isDestroyed?.() || e.sender !== win.webContents) return false;
  const url = e.senderFrame?.url;
  if (!url || e.senderFrame.parent || !url.startsWith('file:')) return false;
  return isShellPage(url, page, dir);
}

/** @param {string} url @param {string} [page] @param {string} [dir] */
function isShellPage(url, page, dir = __dirname) {
  let file;
  try { file = path.resolve(fileURLToPath(url.replace(/[?#].*$/, ''))); } catch { return false; }
  const fold = (p) => (process.platform === 'linux' ? p : p.toLowerCase());
  return (page ? [page] : SHELL_PAGES).some((n) => fold(file) === fold(path.join(dir, n)));
}

/** Free space on the drive a (maybe not yet existing) folder would live on, in whole GB; null when unknown. */
function freeGB(dir) {
  let d = dir;
  for (let i = 0; i < 64; i++) {
    try {
      const s = fs.statfsSync(d);
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1e9);
    } catch {
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
  return null;
}

/**
 * @param {{
 *   ipcMain: Electron.IpcMain,
 *   win: () => any,
 *   appOrigin: () => string,
 *   log: { info: Function, warn: Function, error: Function },
 *   engine: () => any,
 *   updates: any,
 *   installUpdate: () => void,
 *   revealLibrary: () => void,
 *   revealBackups: () => void,
 *   restoreBackup: () => Promise<void>,
 *   strings: () => Record<string, string>,
 *   relaunch: () => void,
 *   openLogs: () => void,
 *   firstRun: { defaults: () => any, choose: () => Promise<any>, confirm: (dir: string, anyway: boolean) => any },
 * }} o
 */
function installBridge(o) {
  const { ipcMain } = o;
  const deny = (channel) => {
    o.log.warn(`bridge: refused ${channel} from a page that may not call it`);
    return Promise.reject(new Error('not allowed'));
  };
  const app = (e) => fromOrigin(e, o.win(), o.appOrigin());

  ipcMain.handle('desktop:engine-status', (e) => (app(e) ? o.engine().status() : deny('desktop:engine-status')));
  ipcMain.handle('desktop:engine-install', async (e) => {
    if (!app(e)) return deny('desktop:engine-install');
    await o.engine().install();
  });
  ipcMain.on('desktop:reveal-library', (e) => { if (app(e)) o.revealLibrary(); else void deny('desktop:reveal-library').catch(() => {}); });
  ipcMain.on('desktop:reveal-backups', (e) => { if (app(e)) o.revealBackups(); else void deny('desktop:reveal-backups').catch(() => {}); });
  ipcMain.handle('desktop:restore-backup', async (e) => {
    if (!app(e)) return deny('desktop:restore-backup');
    await o.restoreBackup();
  });
  ipcMain.handle('desktop:update-status', (e) => (app(e) ? o.updates.status() : deny('desktop:update-status')));
  ipcMain.on('desktop:update-install', (e) => { if (app(e)) o.installUpdate(); else void deny('desktop:update-install').catch(() => {}); });

  ipcMain.handle('shell:strings', (e) => (fromShellPage(e, o.win()) ? o.strings() : deny('shell:strings')));
  ipcMain.on('shell:relaunch', (e) => { if (fromShellPage(e, o.win(), 'loading.html')) o.relaunch(); });
  ipcMain.on('shell:open-logs', (e) => { if (fromShellPage(e, o.win(), 'loading.html')) o.openLogs(); });

  ipcMain.handle('firstrun:defaults', (e) => (fromShellPage(e, o.win(), 'firstrun.html') ? o.firstRun.defaults() : deny('firstrun:defaults')));
  ipcMain.handle('firstrun:choose', (e) => (fromShellPage(e, o.win(), 'firstrun.html') ? o.firstRun.choose() : deny('firstrun:choose')));
  ipcMain.handle('firstrun:confirm', (e, dir, anyway) => (fromShellPage(e, o.win(), 'firstrun.html') ? o.firstRun.confirm(String(dir || ''), !!anyway) : deny('firstrun:confirm')));
}

module.exports = { installBridge, fromOrigin, fromShellPage, isShellPage, freeGB, SHELL_PAGES };
