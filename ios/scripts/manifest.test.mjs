import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createManifest } from './manifest.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uchiyomi-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['index.html', 'downloads/index.html', 'reader/index.html', 'index.txt', 'downloads/index.txt', 'reader/index.txt', '_next/static/reader.js']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path);
  }
  return root;
}
test('inventory is reproducible, includes unvisited routes, and changes with asset contents', async t => {
  const root = await fixture(t);
  const first = await createManifest(root);
  await writeFile(join(root, 'mobile-assets.json'), JSON.stringify(first));
  assert.deepEqual(await createManifest(root), first);
  assert(first.files.some(f => f.path === '/_next/static/reader.js'));
  await writeFile(join(root, '_next/static/reader.js'), 'new version');
  assert.notEqual((await createManifest(root)).buildId, first.buildId);
});
test('incomplete routes cannot produce an offline-ready inventory', async t => {
  const root = await fixture(t);
  await rm(join(root, 'reader/index.txt'));
  await assert.rejects(createManifest(root), /Missing offline route/);
});
test('symlinks cannot include files outside the export', async t => {
  const root = await fixture(t);
  await symlink('/etc/hosts', join(root, 'external'));
  await assert.rejects(createManifest(root), /Symlink/);
});
test('private and server paths cannot enter the static inventory', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.env'), 'test-only secret');
  await assert.rejects(createManifest(root), /Unsupported asset path/);
  await rm(join(root, '.env'));
  await mkdir(join(root, 'auth'));
  await writeFile(join(root, 'auth/session'), 'test-only session');
  await assert.rejects(createManifest(root), /Server path/);
});

test('host version is readable, validated and part of the build identity', async t => {
  const root = await fixture(t);
  const first = await createManifest(root, { version: '0.101.0' });
  const second = await createManifest(root, { version: '0.101.1-beta.1' });
  assert.equal(first.version, '0.101.0');
  assert.equal(second.version, '0.101.1-beta.1');
  assert.notEqual(first.buildId, second.buildId);
  assert.deepEqual(first.files, second.files);
  for (const version of ['', 'latest', '../version', '1.0.0-' + 'a'.repeat(80), 12]) {
    await assert.rejects(createManifest(root, { version }), /Invalid app version/);
  }
});
