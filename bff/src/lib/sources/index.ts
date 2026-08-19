// Source registry entry point. The reader core ships with NO bundled sources — providers are loaded at boot
// from SOURCES_DIR by the loader (server.ts calls loadSources()). With nothing mounted the registry is empty,
// which is the legal, scraper-free default. Consumers import getSource/listSources from here.
export { getSource, listSources, sourceIds, loadSources, reloadSources, registerAdapter } from './loader';
export { loadCustomSites } from './customSites';
export { loadBuiltins } from './builtins';
export { reloadAll } from './reload';
export { loadSuwayomiSources, enabledSourceIds } from './suwayomi/register';
export { listRemoteSources, swAdapterId, isSwAdapterId } from './suwayomi/sources';
export { suwayomiConfigured, aboutServer as suwayomiAbout } from './suwayomi/client';
export { detectEngine } from './detect';
export * from './types';
