// Compatibility entry point for prototype setup commands. Normal web builds generate this automatically.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeManifest } from '../../web/scripts/mobile-assets.mjs';
export { createManifest } from '../../web/scripts/mobile-assets.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await writeManifest(resolve(process.argv[2] || 'web/out'));
}
