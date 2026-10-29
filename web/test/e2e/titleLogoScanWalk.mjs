// The real scan/status API and settings panel on up.sh's throwaway PostgreSQL instance.
// Online lookups are disabled for every fixture library before the switch is enabled. One completed miss is
// seeded behind that privacy boundary, so Retry no matches is exercised without asking an external provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const target = new URL(BASE);
const NET = process.env.E2E_NET || 'uchiyomi-e2e';
const OUT = process.env.OUT || 'test/e2e/shots-title-logo-scan';
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.protocol === 'http:', 'use a disposable localhost fixture');
assert.match(NET, /^uchi[a-z0-9-]*(?:e2e|codex|test)[a-z0-9-]*$/, 'use an up.sh test stack');
const [app] = JSON.parse(execFileSync('docker', ['inspect', NET], { encoding: 'utf8' }));
assert.equal(app.HostConfig.NetworkMode, NET, 'the test app belongs to the named fixture network');
assert.ok(app.NetworkSettings.Ports['3000/tcp']?.some((p) => p.HostIp === '127.0.0.1' && p.HostPort === target.port), 'BASE must point at the named test container');
const sql = (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await sleep(150); }
  throw new Error(`Timed out: ${label}`);
};
mkdirSync(OUT, { recursive: true });
const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.E2E_USER || 'e2e', password: process.env.E2E_PASS || 'e2e-passw0rd-123' }) });
assert.equal(login.status, 200);
const { accessToken } = await login.json();
const api = async (path, options = {}) => {
  const response = await fetch(BASE + path, { ...options, headers: { authorization: `Bearer ${accessToken}`,
    ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
const settings = await api('/api/admin/settings');
assert.equal(settings.automatic_title_logos, false, 'the throwaway fixture starts with automatic provider calls disabled');
const featured = await api('/api/featured');
const id = featured.content[0]?.id;
assert.ok(id, 'the main walk seeded a manga');
const saved = JSON.parse(sql(`SELECT json_build_object(
  'libraries',(SELECT json_agg(json_build_object('id',id,'online',anilist_lookup)) FROM libraries),
  'tracker',(SELECT row_to_json(t) FROM series_trackers t WHERE series_id=${lit(id)} AND provider='anilist'),
  'art',(SELECT row_to_json(a) FROM series_title_art a WHERE series_id=${lit(id)}))`));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const browserGets = [];
const posts = [];
try {
  sql(`BEGIN;
    UPDATE libraries SET anilist_lookup=false;
    INSERT INTO series_trackers(series_id,provider,external_id,checked_at) VALUES(${lit(id)},'anilist','999999990',now())
      ON CONFLICT(series_id,provider) DO UPDATE SET external_id=EXCLUDED.external_id,checked_at=EXCLUDED.checked_at;
    INSERT INTO series_title_art(series_id,lookup_status,lookup_anilist_id,retry_at)
      VALUES(${lit(id)},'missing','999999990',now()+interval '8 days')
      ON CONFLICT(series_id) DO UPDATE SET mode='automatic',custom_file=NULL,auto_file=NULL,auto_anilist_id=NULL,
        lookup_status='missing',lookup_anilist_id='999999990',retry_at=now()+interval '8 days';
    COMMIT;`);
  const read = () => api('/api/admin/title-logos/status');
  const initial = await read();
  assert.equal(initial.enabled, false);
  assert.equal(initial.counts.eligible, 0, 'none of the fixture titles is allowed to contact a title-art provider');
  assert.equal(initial.counts.pending, 0);
  assert.ok(initial.counts.missing > 0 && initial.counts.unchecked > 0, 'confirmed misses and unsearched titles are both represented');
  for (const cookie of login.headers.getSetCookie()) {
    const pair = cookie.split(';')[0], at = pair.indexOf('=');
    await browser.defaultBrowserContext().setCookie({ name: pair.slice(0, at), value: pair.slice(at + 1), url: BASE });
  }
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/admin/title-logos/status' && request.method() === 'GET') browserGets.push(Date.now());
    if (path === '/api/admin/title-logos/scan' && request.method() === 'POST') posts.push(JSON.parse(request.postData() || '{}'));
  });
  await page.setBypassServiceWorker(true);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(BASE + '/admin/?tab=series&section=automatic-title-logos', { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-title-logo-count="missing"]', { visible: true });
  const compareCounts = async (expected) => {
    for (const key of ['checked', 'ready', 'missing', 'error', 'unchecked', 'needsLink']) {
      const n = Number(await page.$eval(`[data-title-logo-count="${key}"] dd`, (element) => element.textContent));
      assert.equal(n, key === 'checked' ? expected.checked : expected.counts[key], key);
    }
  };
  await compareCounts(initial);
  assert.equal(await page.$eval('[data-title-logo-action="scan"]', (element) => element.disabled), true);
  const idleReads = browserGets.length;
  await sleep(3200);
  assert.equal(browserGets.length, idleReads, 'the disabled, idle panel does not keep polling');
  console.log('PASS real status counts distinguish completed no-match from unchecked titles, and the off panel does not poll');

  await page.click('#automatic-title-logos button[role="switch"]');
  await wait(async () => (await read()).enabled, 'automatic title logos enabled on fixture');
  await page.waitForFunction(() => !document.querySelector('[data-title-logo-action="scan"]')?.disabled);
  const clickScan = async (retryMissing) => {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/title-logos/scan' && r.request().method() === 'POST');
    await page.click(`[data-title-logo-action="${retryMissing ? 'retry' : 'scan'}"]`);
    const answer = await response;
    assert.ok([200, 202].includes(answer.status()), `scan response: ${answer.status()}`);
    assert.deepEqual(posts.at(-1), { retryMissing });
    const result = (await answer.json()).status;
    assert.equal(result.counts.eligible, 0);
    assert.equal(result.counts.pending, 0, 'the explicit scan preserves the library privacy boundary');
    await page.waitForFunction(() => !document.querySelector('[data-title-logo-action="scan"]')?.disabled);
    const current = await read();
    assert.equal(current.counts.missing, initial.counts.missing, 'retry does not clear a privacy-blocked result');
    await compareCounts(current);
  };
  await clickScan(false);
  await clickScan(true);
  const settledReads = browserGets.length;
  await sleep(3200);
  assert.equal(browserGets.length, settledReads, 'an enabled panel stops polling as soon as the scan is idle');
  console.log('PASS Scan library and Retry no matches send their real requests, and neither bypasses online-lookup choices');
  await page.$eval('#automatic-title-logos', (element) => element.scrollIntoView({ block: 'center' }));
  await (await page.$('#automatic-title-logos')).screenshot({ path: `${OUT}/scan-desktop.png` });
  await page.setViewport({ width: 390, height: 844 });
  await page.$eval('#automatic-title-logos', (element) => element.scrollIntoView({ block: 'start' }));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'phone panel has no sideways overflow');
  for (const action of ['scan', 'retry']) {
    assert.ok(await page.$eval(`[data-title-logo-action="${action}"]`, (element) => {
      const rect = element.getBoundingClientRect();
      return !element.disabled && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
    }), `${action} remains reachable on a phone`);
  }
  await (await page.$('#automatic-title-logos')).screenshot({ path: `${OUT}/scan-phone.png` });
  console.log('PASS actual desktop and 390px phone panels fit, with accessible scan controls');
  await page.click('#automatic-title-logos button[role="switch"]');
  await wait(async () => !(await read()).enabled, 'automatic title logos disabled again');
  await page.waitForFunction(() => document.querySelector('[data-title-logo-action="scan"]')?.disabled === true);
  const refused = await fetch(BASE + '/api/admin/title-logos/scan', { method: 'POST', headers: {
    authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ retryMissing: true }) });
  assert.equal(refused.status, 409, 'server also refuses a scan while automatic title logos are off');
  assert.deepEqual(errors, [], 'no runtime exceptions or server failures');
  console.log('PASS both the UI and real API gate scans while switched off');
} finally {
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ automaticTitleLogos: false }) });
    sql(`BEGIN;
      DELETE FROM series_title_art WHERE series_id=${lit(id)};
      DELETE FROM series_trackers WHERE series_id=${lit(id)} AND provider='anilist';
      ${saved.art ? `INSERT INTO series_title_art SELECT * FROM json_populate_record(NULL::series_title_art,${lit(JSON.stringify(saved.art))}::json);` : ''}
      ${saved.tracker ? `INSERT INTO series_trackers SELECT * FROM json_populate_record(NULL::series_trackers,${lit(JSON.stringify(saved.tracker))}::json);` : ''}
      UPDATE libraries l SET anilist_lookup=b.online FROM json_to_recordset(${lit(JSON.stringify(saved.libraries || []))}::json) AS b(id text,online boolean) WHERE l.id=b.id;
      COMMIT;`);
  } finally { await browser.close(); }
}
