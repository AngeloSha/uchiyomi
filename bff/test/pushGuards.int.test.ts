// Web push, the two halves the audit found open (v0.69.1):
//   - a member's push endpoint is a URL the server POSTs to, and it was stored and dialled with no host check, so any
//     member could aim the server at loopback, the LAN or a metadata address;
//   - a new-chapter push went to everyone who had favourited the series, naming it to members who may not open it.
//
// Deliveries are captured by replacing web-push's sendNotification (lib/push.ts holds the same module). Skipped
// automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = mkdtempSync(join(tmpdir(), 'uy-push-'));
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = join(TMP, 'config'); // VAPID keys are generated here at boot, so push is on
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = require('web-push');
const realSend = webpush.sendNotification;
let sent: Array<{ endpoint: string; body: string }> = [];
let q: any, app: any, push: typeof import('../src/lib/push');
let fenced = '', open = '';
const KEYS = { p256dh: 'BOtgYHT5o5gH3bVJx0bY8Ul0O3YQe1lEw7xT7X5Ch6S8vT2H1x0l1Ywq4bU0pQ3j8y0ZbVQwvV2K9Jq4Y8p6Q0E', auth: 'c2VjcmV0LWF1dGgtMTIzNA' };

before(async () => {
  if (!DSN) return;
  ({ q } = (await import('../src/lib/db')) as any);
  await (await import('../src/lib/migrate')).migrate();
  push = await import('../src/lib/push');
  webpush.sendNotification = async (sub: { endpoint: string }, body: string) => { sent.push({ endpoint: sub.endpoint, body }); };
  await q(`DELETE FROM users WHERE username LIKE 'pg-%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_pg_%'`);
  for (const id of ['lib_pg_a', 'lib_pg_b']) await q(`INSERT INTO libraries (id, name, path) VALUES ($1,$1,$2) ON CONFLICT (id) DO NOTHING`, [id, `/${id}`]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ('s_pg_b','T!pg','Hidden Title B','T!pg/b',1,'lib_pg_b')`);
  const mk = async (name: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;
  fenced = await mk('pg-fenced');
  open = await mk('pg-open');
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1,'lib_pg_a')`, [fenced]);
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
});

after(async () => {
  webpush.sendNotification = realSend;
  if (DSN) {
    await app?.close();
    await q(`DELETE FROM users WHERE username LIKE 'pg-%'`).catch(() => {});
    await q(`DELETE FROM lib_series WHERE id LIKE 's_pg_%'`).catch(() => {});
  }
  rmSync(TMP, { recursive: true, force: true });
});

const as = (uid: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` });
const subscribe = (uid: string, endpoint: string) =>
  app.inject({ method: 'POST', url: '/api/push/subscribe', headers: as(uid), payload: { endpoint, keys: KEYS } });

test('a push endpoint must be a public https URL', { skip }, async () => {
  // Reintroduce by removing assertPushEndpoint from saveSubscription: every one of these is stored with 200.
  for (const bad of ['https://127.0.0.1:8443/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/x',
    'https://[::1]:8443/x', 'https://localhost/x', 'https://db:5432/', 'http://93.184.216.34/x', 'https://2130706433/x']) {
    const r = await subscribe(open, bad);
    assert.equal(r.statusCode, 400, `${bad} answered ${r.statusCode}`);
  }
  const rows = await q(`SELECT endpoint FROM push_subscriptions WHERE user_id = $1`, [open]);
  assert.deepEqual(rows, [], 'nothing was stored');
  const ok = await subscribe(open, 'https://93.184.216.34/wpush/v2/open');
  assert.equal(ok.statusCode, 200, ok.body);
});

test('a stored internal endpoint is skipped at send time, not dialled and not deleted', { skip }, async () => {
  await q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,'https://127.0.0.1:9/old',$2,$3)`, [open, KEYS.p256dh, KEYS.auth]);
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,'s_pg_b') ON CONFLICT DO NOTHING`, [open]);
  sent = [];
  await push.notifyNewChapter('s_pg_b', 'Hidden Title B', 1);
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://93.184.216.34/wpush/v2/open']);
  assert.equal((await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = 'https://127.0.0.1:9/old'`)).length, 1, 'left in place');
});

test('a new-chapter push reaches only members who may open the series', { skip }, async () => {
  // Reintroduce by sending to every favourite: the fenced member's device receives "Hidden Title B".
  await q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,'https://93.184.216.34/wpush/v2/fenced',$2,$3)`, [fenced, KEYS.p256dh, KEYS.auth]);
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,'s_pg_b') ON CONFLICT DO NOTHING`, [fenced]);
  sent = [];
  await push.notifyNewChapter('s_pg_b', 'Hidden Title B', 2);
  const to = sent.map((s) => s.endpoint).sort();
  assert.ok(!to.includes('https://93.184.216.34/wpush/v2/fenced'), 'the member granted only library A was told about a series in B');
  assert.ok(to.includes('https://93.184.216.34/wpush/v2/open'), 'the unrestricted member still is');
});
