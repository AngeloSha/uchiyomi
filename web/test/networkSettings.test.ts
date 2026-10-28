// Admin -> Settings -> Server -> Home network (components/NetworkSettings.tsx; bff GET/PATCH /api/admin/network): the
// home network and the trusted proxies, set like Sonarr's local addresses, with the environment outranking the page.
// Read from source, like profileSwitch.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
/** The file with its comments removed, so a comment that names the old code does not fail the scan. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('a value the environment sets is shown, not edited', () => {
  // The server refuses the save anyway (409 set_by_env); a field there would read as a setting that does nothing.
  // Reintroduce by drawing the editable row whatever the source: these fail.
  const page = code(read('components/NetworkSettings.tsx'));
  assert.match(page, /\{home\.source === 'env' \? \(\s*<Row id="local-networks" label=\{tr\('Home network'\)\} help=\{fromEnv\('LOCAL_NETWORKS'\)\}>/);
  assert.match(page, /\{proxies\.source === 'env' \? \(\s*<Row id="trusted-proxies" label=\{tr\('Trusted proxies'\)\} help=\{fromEnv\('TRUST_PROXY'\)\}>/);
});

test('the home is the private networks, these networks, or none; an emptied field is the default', () => {
  const page = code(read('components/NetworkSettings.tsx'));
  assert.match(page, /\{ value: 'private', label: tr\('Private networks'\) \}/);
  assert.match(page, /await save\(\{ localNetworks: v === 'none' \? 'none' : null \}\);/, 'Private networks saves the default (null)');
  assert.match(page, /onSave=\{\(v\) => save\(\{ localNetworks: v\.trim\(\) \|\| null \}\)\}/);
  assert.match(page, /onSave=\{\(v\) => save\(\{ trustedProxies: v\.trim\(\) \|\| null \}\)\}/);
  // Use my network: the admin's own /24, which the server offers only for a private address.
  assert.match(page, /save\(\{ localNetworks: data\.suggestion \}\)/);
});

test('a save is the page\'s new state, and Members\' line reads the same answer', () => {
  const page = code(read('components/NetworkSettings.tsx'));
  assert.match(page, /qc\.setQueryData\(\['admin-network'\], await api<NetworkState>\('\/api\/admin\/network', \{ method: 'PATCH', json: body \}\)\);/);
  assert.match(page, /queryKey: \['admin-network'\]/);
  const members = code(read('app/admin/page.tsx'));
  assert.match(members, /<a href="\/admin\/\?tab=server&section=local-networks"/);
});

test('what can make everyone look at home is said: the warnings and every signed-in device\'s address', () => {
  const page = code(read('components/NetworkSettings.tsx'));
  assert.match(page, /w\.code === 'trust_all'/);
  assert.match(page, /tr\('The proxy \{ip\} is inside the home network/);
  // A proxy trusted only by the default names: nobody behind it is at home, and the page offers to trust it alone.
  assert.match(page, /w\.code === 'proxy_unnamed'/);
  assert.match(page, /w\.code === 'via_cloudflare'/);
  assert.match(page, /w\.code === 'home_default_proxy'/);
  assert.match(page, /save\(\{ trustedProxies: w\.ip \}\)/);
  assert.match(page, /data\.recent\.map\(\(r\) =>/);
  assert.match(page, /r\.zone === 'local' \? tr\('at home'\) : tr\('outside'\)/);
});

test('not on the desktop app, where the server is reached from its own computer only', () => {
  const settings = code(read('components/AdminSettings.tsx'));
  assert.match(settings, /\{!desktop && <NetworkSettings \/>\}/);
});
