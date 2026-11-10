// Bundle the real download store for failure injection in WebKit. Test resources only.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = require('esbuild');
const directory = new URL('../build/WebViewFixtures/', import.meta.url);
await mkdir(directory, { recursive: true });
const result = await build({
  stdin: {
    contents: `import * as downloads from './lib/downloads';
      import { setCurrentUser } from './lib/api';
      window.uchiyomiDownloadFixture = { ...downloads, setCurrentUser };`,
    resolveDir: new URL('../../web/', import.meta.url).pathname,
  },
  bundle: true, write: false, platform: 'browser', format: 'iife', target: 'safari17',
});
await writeFile(new URL('downloads.js', directory), result.outputFiles[0].contents);
