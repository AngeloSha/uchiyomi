// Actual SQL/queue/scheduler checks with synthetic lookup outcomes: no library data leaves the process.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `yomi-title-scan-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN; process.env.CONFIG_DIR = ROOT; process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.LIBRARY_ROOT = join(ROOT, 'library'); process.env.DL_ROOT = join(ROOT, 'downloads');
  process.env.JWT_SECRET = 'title-scan-test-secret-at-least-16'; process.env.LIBRARY_BACKEND = 'owned'; process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const LIB = 'title-scan-lib', QUIET = 'title-scan-private';
let q: any, pool: any, app: any, admin: string, member: string;
let art: typeof import('../src/lib/titleArt'), scan: typeof import('../src/lib/titleLogoScan');
let runtime: typeof import('../src/lib/runtime').runtime;
let stop: (() => void) | undefined;
let calls: string[] = [];
const realFetch = globalThis.fetch;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const id = (n: number) => `s_title_scan_${String(n).padStart(4, '0')}`;
async function seed(n: number) {
  await q(`INSERT INTO lib_series(id,source,title,folder,books_count,library_id)
    SELECT 's_title_scan_'||lpad(i::text,4,'0'),'T!scan','Fixture '||i,'scan-'||i,0,$1 FROM generate_series(1,$2::int)i`, [LIB, n]);
  await q(`INSERT INTO series_trackers(series_id,provider,external_id,checked_at)
    SELECT id,'anilist',substring(id from '[0-9]+$')::int+10000,now() FROM lib_series WHERE library_id=$1`, [LIB]);
}
async function eventually(check: () => Promise<boolean> | boolean) {
  const until = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < until, 'condition did not settle'); await new Promise((r) => setTimeout(r, 5)); }
}
function timers() {
  const pending = new Map<object, { fn: () => void; ms: number }>();
  let cleared = 0;
  return { pending, get cleared() { return cleared; },
    options: { setTimer(fn: () => void, ms: number) { const handle = { unref() {} }; pending.set(handle, { fn, ms }); return handle as ReturnType<typeof setTimeout>; },
      clearTimer(handle: ReturnType<typeof setTimeout>) { if (pending.delete(handle)) cleared++; } },
    fire() { const [handle, item] = [...pending][0]; pending.delete(handle); item.fn(); return item.ms; },
  };
}
before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { Media: null, Page: { media: [] } } }), { status: 200 })) as typeof fetch;
  ({ q, pool } = await import('../src/lib/db')); await (await import('../src/lib/migrate')).migrate();
  art = await import('../src/lib/titleArt'); scan = await import('../src/lib/titleLogoScan'); ({ runtime } = await import('../src/lib/runtime'));
  await q(`INSERT INTO libraries(id,name,path,anilist_lookup) VALUES($1,'Scan fixture',$1,true),($2,'Private fixture',$2,false)
    ON CONFLICT(id) DO UPDATE SET anilist_lookup=EXCLUDED.anilist_lookup`, [LIB, QUIET]);
  const Fastify = (await import('fastify')).default; app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await q("DELETE FROM users WHERE username LIKE 'title-scan-%'");
  for (const role of ['admin', 'user']) {
    const [u] = await q(`INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'x',$2) RETURNING id`, [`title-scan-${role}`, role]);
    const token = app.jwt.sign({ sub: u.id, role }); if (role === 'admin') admin = token; else member = token;
  }
  await app.register((await import('../src/routes/admin')).default); await app.ready();
});
beforeEach(async () => {
  if (!DSN) return;
  stop?.(); stop = undefined; runtime.stopping = false;
  art.cancelAutomaticTitleLogoQueue(); await art.titleLogoQueueSettled(); art.setTitleLogoQueuePaceForTests(0);
  await q('DELETE FROM lib_series WHERE library_id=ANY($1)', [[LIB, QUIET]]);
  await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1', [LIB]);
  await q('UPDATE server_settings SET automatic_title_logos=true,title_logo_retry_at=NULL WHERE id=1');
  calls = []; art.setTitleLogoLookupForTests(async (anilistId, opts) => { assert.equal(opts, undefined); calls.push(anilistId); return { kind: 'missing' }; });
});
after(async () => {
  if (!DSN) return;
  stop?.(); runtime.stopping = false; art.cancelAutomaticTitleLogoQueue(); await art.titleLogoQueueSettled();
  art.setTitleLogoLookupForTests(); art.setTitleLogoQueuePaceForTests(); await app.close();
  await q('DELETE FROM lib_series WHERE library_id=ANY($1)', [[LIB, QUIET]]); await q('DELETE FROM libraries WHERE id=ANY($1)', [[LIB, QUIET]]);
  await q("DELETE FROM users WHERE username LIKE 'title-scan-%'");
  await q('UPDATE server_settings SET automatic_title_logos=false,title_logo_retry_at=NULL WHERE id=1');
  await pool.end(); globalThis.fetch = realFetch; await rm(ROOT, { recursive: true, force: true });
});

test('a bounded batch continues beyond 128 titles after scheduler restart without page views or duplicate lookups', { skip }, async () => {
  await seed(140);
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  art.setTitleLogoLookupForTests(async (anilistId) => { calls.push(anilistId); if (calls.length === 1) await gate; return { kind: 'missing' }; });
  assert.equal(await scan.scanTitleLogos(), 128); await eventually(() => calls.length === 1);
  assert.equal(art.titleLogoQueueState().ids.length, 128); release(); await art.titleLogoQueueSettled();
  let status = await scan.titleLogoScanStatus(); assert.equal(status.checked, 128); assert.equal(status.counts.unchecked, 12); assert.equal(status.counts.missing, 128); assert.equal(status.running, true);
  const clock = timers(); stop = scan.startTitleLogoScan(undefined, clock.options);
  assert.equal(clock.fire(), 15_000); await eventually(() => calls.length === 140); await art.titleLogoQueueSettled();
  status = await scan.titleLogoScanStatus(); assert.equal(status.checked, 140); assert.equal(status.counts.missing, 140); assert.equal(status.counts.unchecked, 0);
  assert.equal(new Set(calls).size, 140); await eventually(() => clock.pending.size === 1);
  assert.equal(clock.fire(), 30_000); await eventually(() => clock.pending.size === 1); assert.equal(calls.length, 140);
});

test('never-checked defaults, actual misses and due errors are distinct; explicit retry refreshes old misses only', { skip }, async () => {
  await seed(5);
  await q(`INSERT INTO series_title_art(series_id,lookup_status,lookup_anilist_id,retry_at) VALUES
    ($1,'missing',NULL,NULL),($2,'missing','10002',now()+interval '7 days'),
    ($3,'error','10003',now()+interval '1 hour'),($4,'error','10004',now()-interval '1 minute'),
    ($5,'missing','99999',now()+interval '7 days')`, [id(1), id(2), id(3), id(4), id(5)]);
  let status = await scan.titleLogoScanStatus(); assert.equal(status.counts.unchecked, 2); assert.equal(status.counts.missing, 1); assert.equal(status.counts.error, 2); assert.equal(status.checked, 3);
  assert.equal(await scan.scanTitleLogos(), 3); await art.titleLogoQueueSettled(); assert.deepEqual(new Set(calls), new Set(['10001', '10004', '10005']));
  assert.equal(await scan.scanTitleLogos(), 0); assert.equal(await scan.scanTitleLogos({ retryMissing: true }), 4); await art.titleLogoQueueSettled();
  assert.equal(calls.filter((v) => v === '10002').length, 1, 'the old negative result is retried by explicit bulk refresh');
  assert.equal(calls.includes('10003'), false, 'future provider errors retain their backoff');
  await q('UPDATE series_title_art SET retry_at=now()-interval \'1 second\' WHERE series_id=$1', [id(3)]);
  await scan.scanTitleLogos(); await art.titleLogoQueueSettled(); assert.equal(calls.includes('10003'), true);
  status = await scan.titleLogoScanStatus(); assert.equal(status.checked, 5); assert.equal(status.counts.error, 0);
});

test('global opt-out, missing or unconfirmed links, private library, first-page, custom and text choices are excluded', { skip }, async () => {
  await seed(8);
  await q('DELETE FROM series_trackers WHERE series_id=$1', [id(1)]);
  await q('UPDATE series_trackers SET checked_at=NULL WHERE series_id=$1', [id(2)]);
  await q('UPDATE lib_series SET library_id=$2 WHERE id=$1', [id(3), QUIET]);
  await q("INSERT INTO series_overrides(series_id,cover) VALUES($1,'first_page')", [id(4)]);
  await q("INSERT INTO series_title_art(series_id,mode) VALUES($1,'custom'),($2,'text')", [id(5), id(6)]);
  await q('UPDATE lib_series SET deleted_at=now() WHERE id=$1', [id(7)]);
  let status = await scan.titleLogoScanStatus(); assert.equal(status.counts.total, 7); assert.equal(status.counts.eligible, 1);
  assert.equal(status.counts.needsLink, 2); assert.equal(status.counts.libraryOptOut, 1); assert.equal(status.counts.firstPage, 1); assert.equal(status.counts.custom, 1); assert.equal(status.counts.text, 1);
  await q('UPDATE server_settings SET automatic_title_logos=false WHERE id=1'); assert.equal(await scan.scanTitleLogos(), 0); assert.deepEqual(calls, []);
  await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1'); assert.equal(await scan.scanTitleLogos(), 1); await art.titleLogoQueueSettled(); assert.deepEqual(calls, ['10008']);
});

test('a shared provider Retry-After pauses other identities and persists longer than one day', { skip }, async () => {
  await seed(3);
  art.setTitleLogoLookupForTests(async (anilistId) => { calls.push(anilistId); throw Object.assign(new Error('rate limited'), { retryAfterMs: 49 * 3600_000 }); });
  await scan.scanTitleLogos(); await art.titleLogoQueueSettled(); assert.equal(calls.length, 1);
  let status = await scan.titleLogoScanStatus(); assert.equal(status.counts.error, 1); assert.equal(status.counts.unchecked, 2); assert.equal(status.counts.pending, 2); assert.equal(status.running, true);
  assert.ok(Date.parse(status.providerRetryAt!) > Date.now() + 48 * 3600_000); assert.equal(status.nextRetryAt, status.providerRetryAt);
  const deadline = (await q('SELECT title_logo_retry_at FROM server_settings WHERE id=1'))[0].title_logo_retry_at;
  assert.equal(await scan.scanTitleLogos({ retryMissing: true }), 0); await art.titleLogoQueueSettled(); assert.equal(calls.length, 1);
  assert.equal(new Date((await q('SELECT title_logo_retry_at FROM server_settings WHERE id=1'))[0].title_logo_retry_at).getTime(), new Date(deadline).getTime());
  await q("UPDATE server_settings SET title_logo_retry_at=now()-interval '1 second' WHERE id=1");
  art.setTitleLogoLookupForTests(async (anilistId) => { calls.push(anilistId); return { kind: 'missing' }; });
  await scan.scanTitleLogos(); await art.titleLogoQueueSettled(); assert.equal(calls.length, 3); status = await scan.titleLogoScanStatus(); assert.equal(status.counts.error, 1); assert.equal(status.counts.missing, 2);
});

test('queued work rechecks manual choices and identity changes, and turning off the setting cancels it immediately', { skip }, async () => {
  await seed(3); let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  art.setTitleLogoLookupForTests(async (anilistId) => { calls.push(anilistId); await gate; return { kind: 'missing' }; });
  await scan.scanTitleLogos(); await eventually(() => calls.length === 1);
  await q("INSERT INTO series_title_art(series_id,mode) VALUES($1,'text')", [id(2)]);
  await q("UPDATE series_trackers SET external_id='20003' WHERE series_id=$1", [id(3)]);
  release(); await art.titleLogoQueueSettled(); assert.equal(calls.length, 1); assert.equal((await scan.titleLogoScanStatus()).checked, 1);
  await q("UPDATE server_settings SET title_logo_retry_at=now()+interval '1 hour' WHERE id=1");
  await scan.scanTitleLogos(); await art.titleLogoQueueSettled(); assert.equal(art.titleLogoQueueState().ids.length, 1);
  const response = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth(admin), payload: { automaticTitleLogos: false } });
  assert.equal(response.statusCode, 200); assert.equal(art.titleLogoQueueState().ids.length, 0); assert.equal(calls.length, 1);
});

test('scheduler shutdown clears its timer, discards in-flight automatic results and prevents rearming', { skip }, async () => {
  await seed(1); let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  art.setTitleLogoLookupForTests(async (anilistId) => { calls.push(anilistId); await gate; return { kind: 'missing' }; });
  const clock = timers(); stop = scan.startTitleLogoScan(undefined, clock.options); clock.fire(); await eventually(() => calls.length === 1);
  stop(); release(); await art.titleLogoQueueSettled(); await eventually(() => clock.pending.size === 0);
  assert.equal((await scan.titleLogoScanStatus()).checked, 0); assert.equal(art.titleLogoQueueState().ids.length, 0);
  stop = scan.startTitleLogoScan(undefined, clock.options); assert.equal(clock.pending.size, 1); stop(); assert.equal(clock.pending.size, 0); assert.ok(clock.cleared > 0);
  runtime.stopping = true; stop = scan.startTitleLogoScan(undefined, clock.options); assert.equal(clock.pending.size, 0);
});

test('status is admin-only and read-only; explicit scan rejects disabled mode and responds before provider completion', { skip }, async () => {
  await seed(1); await q('UPDATE server_settings SET automatic_title_logos=false WHERE id=1');
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/title-logos/status' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/title-logos/status', headers: auth(member) })).statusCode, 403);
  const get = await app.inject({ method: 'GET', url: '/api/admin/title-logos/status', headers: auth(admin) });
  assert.equal(get.statusCode, 200); assert.equal(get.json().counts.unchecked, 1); assert.equal(get.json().checked, 0); assert.equal(calls.length, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/title-logos/scan', headers: auth(admin), payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/title-logos/scan', headers: auth(member), payload: {} })).statusCode, 403);
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  art.setTitleLogoLookupForTests(async (anilistId) => { calls.push(anilistId); await gate; return { kind: 'missing' }; });
  await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');
  const post = await app.inject({ method: 'POST', url: '/api/admin/title-logos/scan', headers: auth(admin), payload: { retryMissing: false } });
  assert.equal(post.statusCode, 200); assert.equal(post.json().ok, true); assert.equal(post.json().status.running, true);
  release(); await art.titleLogoQueueSettled(); assert.equal((await scan.titleLogoScanStatus()).checked, 1);
});
