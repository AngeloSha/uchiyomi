// Run after Next completes its static export. The native app downloads this inventory; no web UI is bundled in its IPA.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const types = {
  '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const hash = data => createHash('sha256').update(data).digest('hex');
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

export async function createManifest(root, { version = packageVersion } = {}) {
  if (typeof version !== 'string' || version.length > 80 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid app version');
  const files = [];
  async function walk(relative = '') {
    for (const entry of (await readdir(resolve(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink in export: ${path}`);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile() || path === 'mobile-assets.json') continue;
      if (['api', 'auth', 'img', 'opds', 'healthz'].includes(path.split('/')[0])) throw new Error(`Server path in static export: ${path}`);
      if (path.split('/').some(p => p.startsWith('.')) || /[%\\?#\x00-\x1f]/.test(path)) throw new Error(`Unsupported asset path: ${path}`);
      const content = await readFile(resolve(root, path));
      files.push({ path: `/${path}`, size: content.length, sha256: hash(content), contentType: types[extname(path)] || 'application/octet-stream' });
    }
  }
  await walk();
  for (const path of ['/index.html', '/downloads/index.html', '/reader/index.html', '/index.txt', '/downloads/index.txt', '/reader/index.txt']) {
    if (!files.some(file => file.path === path)) throw new Error(`Missing offline route: ${path}`);
  }
  const body = { schemaVersion: 1, protocolVersion: 1, offlineSchemaVersion: 2, startupCheckVersion: 1, version, files };
  return { ...body, buildId: hash(JSON.stringify(body)) };
}

export async function writeManifest(root) {
  const manifest = await createManifest(root);
  await writeFile(resolve(root, 'mobile-assets.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${manifest.files.length} assets, ${manifest.files.reduce((n, f) => n + f.size, 0)} bytes, ${manifest.buildId}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await writeManifest(resolve(process.argv[2] || 'out'));
}
