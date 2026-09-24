// @ts-check
'use strict';
/**
 * The window's preload (sandboxed: only Electron's renderer-safe modules). Two surfaces, never both:
 *
 * On the app itself (http://127.0.0.1:<port>/), `window.uchiyomiDesktop` -- contract 3 of the desktop build,
 * exactly this shape, because the web app (web/lib/desktop.ts) reads it:
 *   version, platform,
 *   engine.status() / engine.install() / engine.onStatus(cb) -> unsubscribe,
 *   revealLibrary(), revealBackups(), restoreBackup(),
 *   update.status() / update.installNow().
 * Its presence is also THE marker the web app uses to hide what a one-person PC app has no use for (sign-in,
 * Web Push, "Save offline"...). The web app must keep working when it is absent -- that is the server build.
 *
 * On the shell's own local pages (file://: the loading screen and the first-run folder picker),
 * `window.uchiyomiShell` instead: their strings and the three first-run calls.
 *
 * Nothing secret crosses this bridge: the sign-in secret is added to one request in the main process
 * (signin.js) and never reaches any page. Every call is re-checked in the main process against the page that
 * sent it (bridge.js), so a page cannot reach a surface it was not given here.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** `--uchiyomi-<name>=<value>` from webPreferences.additionalArguments. */
const arg = (name) => {
  const p = `--uchiyomi-${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : '';
};

const onApp = location.protocol === 'http:' && location.hostname === '127.0.0.1';
const onShellPage = location.protocol === 'file:';

if (onApp) {
  contextBridge.exposeInMainWorld('uchiyomiDesktop', {
    version: arg('version'),
    platform: process.platform,
    engine: {
      status: () => ipcRenderer.invoke('desktop:engine-status'),
      install: () => ipcRenderer.invoke('desktop:engine-install').then(() => undefined),
      /** @param {(s: any) => void} cb */
      onStatus: (cb) => {
        // The IPC event object stays on this side: only the status crosses into the page.
        const h = (/** @type {any} */ _e, /** @type {any} */ s) => { try { cb(s); } catch { /* the page's problem */ } };
        ipcRenderer.on('desktop:engine-status-changed', h);
        return () => { ipcRenderer.removeListener('desktop:engine-status-changed', h); };
      },
    },
    revealLibrary: () => { ipcRenderer.send('desktop:reveal-library'); },
    revealBackups: () => { ipcRenderer.send('desktop:reveal-backups'); },
    restoreBackup: () => ipcRenderer.invoke('desktop:restore-backup').then(() => undefined),
    update: {
      status: () => ipcRenderer.invoke('desktop:update-status'),
      installNow: () => { ipcRenderer.send('desktop:update-install'); },
    },
  });
} else if (onShellPage) {
  contextBridge.exposeInMainWorld('uchiyomiShell', {
    lang: arg('lang') || 'en',
    strings: () => ipcRenderer.invoke('shell:strings'),
    relaunch: () => { ipcRenderer.send('shell:relaunch'); },
    openLogs: () => { ipcRenderer.send('shell:open-logs'); },
    firstRun: {
      defaults: () => ipcRenderer.invoke('firstrun:defaults'),
      choose: () => ipcRenderer.invoke('firstrun:choose'),
      /** @param {string} dir @param {boolean} anyway */
      confirm: (dir, anyway) => ipcRenderer.invoke('firstrun:confirm', String(dir || ''), !!anyway),
    },
  });
}
