// Updates: what counts as newer, and which download a Mac is sent to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseVersion, isNewer, latestRelease, Updates, installOnQuit } = require('../src/updates.js');

const quiet = { info() {}, warn() {}, error() {} };
const gh = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
const release = (tag, extra = {}) => ({
  tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/AngeloSha/uchiyomi/releases/tag/${tag}`,
  assets: [
    { name: `Uchiyomi-${tag.slice(1)}-arm64.dmg`, browser_download_url: `https://github.com/AngeloSha/uchiyomi/releases/download/${tag}/Uchiyomi-${tag.slice(1)}-arm64.dmg` },
    { name: `Uchiyomi-${tag.slice(1)}-x64.dmg`, browser_download_url: `https://github.com/AngeloSha/uchiyomi/releases/download/${tag}/Uchiyomi-${tag.slice(1)}-x64.dmg` },
    { name: `Uchiyomi-Setup-${tag.slice(1)}.exe`, browser_download_url: 'https://github.com/x.exe' },
  ],
  ...extra,
});

test('versions: plain semver only; prereleases and engine tags are never "newer"', () => {
  // Reintroduce by dropping the `$` anchor in parseVersion: v0.45.0-rc.1 counts as newer.
  assert.deepEqual(parseVersion('v0.44.0'), [0, 44, 0]);
  assert.equal(parseVersion('v0.45.0-rc.1'), null);
  assert.equal(parseVersion('engine-v2.3.2243'), null);
  assert.equal(isNewer('0.44.1', '0.44.0'), true);
  assert.equal(isNewer('0.44.0', '0.44.0'), false);
  assert.equal(isNewer('0.43.9', '0.44.0'), false);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('v0.45.0-rc.1', '0.44.0'), false);
});

test("a Mac gets its own architecture's dmg; drafts and prereleases are ignored; only github.com links", async () => {
  // Reintroduce by dropping the github.com check in latestRelease: the browser is sent to evil.test.
  assert.deepEqual(await latestRelease({ fetch: gh(release('v0.45.0')), arch: 'arm64' }), { version: '0.45.0', url: 'https://github.com/AngeloSha/uchiyomi/releases/download/v0.45.0/Uchiyomi-0.45.0-arm64.dmg' });
  assert.match((await latestRelease({ fetch: gh(release('v0.45.0')), arch: 'x64' })).url, /-x64\.dmg$/);
  assert.equal(await latestRelease({ fetch: gh(release('v0.45.0', { prerelease: true })) }), null);
  assert.equal(await latestRelease({ fetch: gh(release('engine-v2.3.2243')) }), null);
  const odd = await latestRelease({ fetch: gh(release('v0.45.0', { assets: [{ name: 'Uchiyomi-0.45.0-arm64.dmg', browser_download_url: 'https://evil.test/x.dmg' }] })), arch: 'arm64' });
  assert.equal(odd.url, 'https://github.com/AngeloSha/uchiyomi/releases/latest');
  await assert.rejects(() => latestRelease({ fetch: gh({}, 403) }), /403/);
});

test('macOS: the check reports the newer release and its URL; nothing is ever installed', async () => {
  // Reintroduce by reporting any release as available (no isNewer): the up-to-date app nags.
  const opened = [];
  const u = new Updates({ version: '0.44.0', platform: 'darwin', packaged: true, log: quiet, openExternal: (x) => opened.push(x), fetch: gh(release('v0.45.0')) });
  const seen = [];
  u.on('status', (s) => seen.push(s));
  await u.check();
  assert.equal(u.status().available, true);
  assert.equal(u.status().version, '0.45.0');
  assert.match(u.status().url, /^https:\/\/github\.com\/.+\.dmg$/);
  assert.equal(seen.length, 1);
  assert.equal(u.installDownloaded(true), false);
  u.openDownload();
  assert.deepEqual(opened, [u.status().url]);
  const same = new Updates({ version: '0.45.0', platform: 'darwin', packaged: true, log: quiet, openExternal: () => {}, fetch: gh(release('v0.45.0')) });
  await same.check();
  assert.deepEqual(same.status(), { available: false });
});

test('a downloaded update installs on Quit and on "Restart to update" -- never when another installer asked us to stop', () => {
  // Reintroduce by installing on every quit reason: build/installer.nsh's --quit-for-update would start a second
  // installer beside the one already running.
  assert.equal(installOnQuit('tray'), true);
  assert.equal(installOnQuit('before-quit'), true);
  assert.equal(installOnQuit('update', { install: true }), true);
  assert.equal(installOnQuit('quit-for-update'), false);
  assert.equal(installOnQuit('relaunch'), false);
});

