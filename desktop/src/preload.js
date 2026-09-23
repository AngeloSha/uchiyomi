// @ts-check
'use strict';
/**
 * The bridge the web app will read in Phase 1 (`window.uchiyomiDesktop`): a marker that it runs inside the
 * desktop shell, which is what gates Web Push, "Save offline" and the sign-in screen there. Sandboxed preload,
 * so only `electron`'s renderer-safe modules are available.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('uchiyomiDesktop', Object.freeze({
  shell: 'electron',
  platform: process.platform,
}));
