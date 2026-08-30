// Source registry entry point. The reader core ships with NO bundled sources — providers are loaded at boot
// from SOURCES_DIR by the loader (server.ts calls loadSources()). With nothing mounted the registry is empty,
// which is the legal, scraper-free default. Consumers import getSource/listSources from here.
export { getSource, listSources, sourceIds, loadSources, reloadSources, registerAdapter } from './loader';
export { loadCustomSites } from './customSites';
export { loadBuiltins } from './builtins';
export { reloadAll } from './reload';
export { loadSuwayomiSources, enabledSourceIds, scheduleSuwayomiRetry } from './suwayomi/register';
export { listRemoteSources, swAdapterId, isSwAdapterId, SW_PREFIX } from './suwayomi/sources';
export { suwayomiConfigured, aboutServer as suwayomiAbout } from './suwayomi/client';
export { detectEngine } from './detect';
export * from './types';

/**
 * Give up after `ms`, and be honest about who gave up.
 *
 * The error is TAGGED, not merely worded. A string saying "timeout" went through `classify`, came out as
 * `down`, and earned the source the same escalating cooldown as a site refusing us -- which then stopped it
 * being asked at all. That is how Aqua Manga, answering correctly in about 11.5 seconds against an 8 second
 * budget, vanished from Discover entirely while every check reported it healthy. Being slower than our own
 * patience is not a fault of the source, and the caller now has a way to tell the difference.
 */
export const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(Object.assign(new Error(`timeout after ${ms}ms`), { selfTimeout: true, ms })), ms)),
  ]);
