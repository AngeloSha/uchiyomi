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
 * On the shell's own local pages (file://: the loading screen, the first-launch choice / server address /
 * certificate page, and the first-run folder picker), `window.uchiyomiShell` instead: their strings and calls.
 *
 * ⚠️ Which of the two depends on the MODE main.js started the window in (`--uchiyomi-mode`), not on the address
 * alone: in server mode the window shows the person's OWN server, and a server on this same PC is
 * http://127.0.0.1:8080 -- with the bridge, its web app would take itself for the desktop app, wait for a
 * desktop sign-in that never comes, and never show its sign-in page. So the bridge exists only in a window
 * started in standalone mode (anything else, a missing argument included, gets none), and a server-mode page
 * gets only an inert marker, `window.uchiyomiShell = { mode: 'server', version }` -- no functions -- so a v0.45+
 * server's web app can hide what makes no sense inside the app ("Install app"); older servers ignore it.
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

const mode = arg('mode');
const onApp = mode === 'standalone' && location.protocol === 'http:' && location.hostname === '127.0.0.1';
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
      back: () => ipcRenderer.invoke('firstrun:back'),
    },
    welcome: {
      info: () => ipcRenderer.invoke('welcome:info'),
      /** @param {string} address */
      connect: (address) => ipcRenderer.invoke('welcome:connect', String(address || '')),
      /** @param {string} host @param {string} fingerprint @param {boolean} replace */
      trust: (host, fingerprint, replace) => ipcRenderer.invoke('welcome:trust', String(host || ''), String(fingerprint || ''), !!replace),
      use: () => ipcRenderer.invoke('welcome:use'),
      local: () => ipcRenderer.invoke('welcome:local'),
      cancel: () => ipcRenderer.invoke('welcome:cancel'),
      retry: () => ipcRenderer.invoke('welcome:retry'),
    },
  });
} else if (mode === 'server') {
  // Inert on purpose: data, no functions, nothing that reaches the main process.
  contextBridge.exposeInMainWorld('uchiyomiShell', { mode: 'server', version: arg('version') });
}
