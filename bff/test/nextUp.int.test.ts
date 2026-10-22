// "Only tell me about my next chapter" (account setting `notifyOnlyNext`, lib/nextUp.ts), through the real database: the
// setting is validated by PUT /api/settings, web push (notifyNewChapter) and a person-aimed target's digest (sendDigest) both
// leave out a series whose new chapter is not the one that account would read next, and an account without the setting is told
// as always. Skipped automatically unless TEST_DATABASE_URL is set.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = mkdtempSync(join(tmpdir(), 'uy-nextup-'));
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = join(TMP, 'config'); // VAPID keys are generated here, so web push is on
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = require('web-push');
const realSend = webpush.sendNotification;
let sent: string[] = [];
const KEYS = { p256dh: 'BOtgYHT5o5gH3bVJx0bY8Ul0O3YQe1lEw7xT7X5Ch6S8vT2H1x0l1Ywq4bU0pQ3j8y0ZbVQwvV2K9Jq4Y8p6Q0E', auth: 'c2VjcmV0LWF1dGgtMTIzNA' };

const LIB = 'lib_nu', SID = 's_nu_a';
let q: any, app: any, push: typeof import('../src/lib/push');
const U: Record<'picky' | 'plain' | 'admin', { id: string; h: { authorization: string } }> = {} as any;
const hooks: Array<{ server: Server; hits: string[]; base: string }> = [];

async function hook() {
  const h = { hits: [] as string[] } as { server: Server; hits: string[]; base: string };
  h.server = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { h.hits.push(b); res.writeHead(200); res.end('{}'); }); });
  await new Promise<void>((r) => h.server.listen(0, '127.0.0.1', r));
  h.base = `http://127.0.0.1:${(h.server.address() as { port: number }).port}`;
  hooks.push(h);
  return h;
}

before(async () => {
  if (!DSN) return;
  ({ q } = (await import('../src/lib/db')) as any);
  await (await import('../src/lib/migrate')).migrate();
  push = await import('../src/lib/push');
  webpush.sendNotification = async (sub: { endpoint: string }) => { sent.push(sub.endpoint); };
  await q(`DELETE FROM users WHERE username LIKE 'nu-%'`);
  await q(`DELETE FROM lib_series WHERE id = $1`, [SID]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'NU', '/nu') ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1, 'T!nu', 'Next Up Title', 'T!nu/a', 3, $2)`, [SID, LIB]);
  for (let n = 1; n <= 3; n++) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1, $2, 'T!nu', $3, $4, $5, '/library')`, [`b_nu_${n}`, SID, `T!nu/a/ch${n}.cbz`, n, `Chapter ${n}`]);
  }
  for (const [k, role] of [['picky', 'user'], ['plain', 'user'], ['admin', 'admin']] as const) {
    const id = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, 'x', $2, 'password') RETURNING id`, [`nu-${k}`, role]))[0].id;
    U[k] = { id, h: { authorization: '' } };
  }
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/personal')).default);
  await app.register((await import('../src/routes/notify')).default);
  await app.ready();
  for (const k of ['picky', 'plain', 'admin'] as const) U[k].h.authorization = `Bearer ${app.jwt.sign({ sub: U[k].id, role: k === 'admin' ? 'admin' : 'user' })}`;
  for (const k of ['picky', 'plain']) {
    await q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)`, [U[k as 'picky'].id, `https://93.184.216.34/wpush/${k}`, KEYS.p256dh, KEYS.auth]);
    await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1, $2)`, [U[k as 'picky'].id, SID]);
  }
});

after(async () => {
  webpush.sendNotification = realSend;
  for (const h of hooks) await new Promise<void>((r) => { h.server.closeAllConnections?.(); h.server.close(() => r()); });
  if (DSN) {
    await app?.close();
    await q(`DELETE FROM notify_targets WHERE name LIKE 'nu-%'`).catch(() => {});
    await q(`DELETE FROM users WHERE username LIKE 'nu-%'`).catch(() => {});
    await q(`DELETE FROM lib_series WHERE id = $1`, [SID]).catch(() => {});
    await q(`DELETE FROM libraries WHERE id = $1`, [LIB]).catch(() => {});
  }
  rmSync(TMP, { recursive: true, force: true });
});

const finish = (u: 'picky' | 'plain', n: number) => q(
  `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, $2, '${SID}', 0, true) ON CONFLICT (user_id, book_id) DO UPDATE SET completed = true`, [U[u].id, `b_nu_${n}`]);
const unfinish = (u: 'picky' | 'plain') => q('DELETE FROM read_progress WHERE user_id = $1', [U[u].id]);
const put = (u: 'picky' | 'plain', payload: unknown) => app.inject({ method: 'PUT', url: '/api/settings', headers: U[u].h, payload });

test('the setting must be a real boolean, and is kept per account', { skip }, async () => {
  // Reintroduce by accepting anything: "yes" is saved with 200.
  for (const bad of ['yes', 1, null, 'true']) assert.equal((await put('picky', { notifyOnlyNext: bad })).statusCode, 400, JSON.stringify(bad));
  assert.equal((await put('picky', { notifyOnlyNext: true })).statusCode, 200);
  const nu = await import('../src/lib/nextUp');
  assert.equal(await nu.notifyOnlyNextOn(U.picky.id), true);
  assert.equal(await nu.notifyOnlyNextOn(U.plain.id), false, 'another account is not affected');
  const mine = (await app.inject({ method: 'GET', url: '/api/settings', headers: U.picky.h })).json();
  assert.equal(mine.notifyOnlyNext, true);
});

test('web push: an account that wants only its next chapter is told only when the new chapter is it', { skip }, async () => {
  await unfinish('picky'); await unfinish('plain');
  // Both read chapter 1; chapter 2 is unread and chapter 3 just landed: for them 2 is next.
  await finish('picky', 1); await finish('plain', 1);
  sent = [];
  await push.notifyNewChapter(SID, 'Next Up Title', 1, [3]);
  assert.deepEqual(sent.sort(), ['https://93.184.216.34/wpush/plain'], 'the picky account was told about a chapter behind its next one');
  // Caught up through chapter 2: the new chapter 3 is next.
  await finish('picky', 2);
  sent = [];
  await push.notifyNewChapter(SID, 'Next Up Title', 1, [3]);
  assert.ok(sent.includes('https://93.184.216.34/wpush/picky'), 'the picky account was not told about its next chapter');
  assert.ok(sent.includes('https://93.184.216.34/wpush/plain'));
  // Behind again, but an announcement naming no chapter is always sent.
  await unfinish('picky'); await finish('picky', 1);
  sent = [];
  await push.notifyNewChapter(SID, 'Next Up Title', 1);
  assert.ok(sent.includes('https://93.184.216.34/wpush/picky'), 'an announcement with no chapter numbers was filtered');
});

test('web push: a half-read chapter is the one to continue, so the new one is not told', { skip }, async () => {
  await unfinish('picky');
  await finish('picky', 1); await finish('picky', 2);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, 'b_nu_3', '${SID}', 4, false) ON CONFLICT (user_id, book_id) DO UPDATE SET page = 4, completed = false`, [U.picky.id]);
  sent = [];
  await push.notifyNewChapter(SID, 'Next Up Title', 1, [3]);
  assert.ok(!sent.includes('https://93.184.216.34/wpush/picky'));
});

test('a notification target aimed at an account hears only about its next chapter; a server-wide target hears everything', { skip }, async () => {
  await unfinish('picky'); await unfinish('plain');
  await finish('picky', 1); await finish('plain', 1);
  const L = { picky: await hook(), plain: await hook(), server: await hook() };
  const post = async (name: string, url: string, userId?: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: U.admin.h, payload: { kind: 'webhook', name, url, events: ['new_chapters'], ...(userId ? { userId } : {}) } });
    assert.equal(r.statusCode, 201, r.body);
  };
  await post('nu-picky', `${L.picky.base}/p`, U.picky.id);
  await post('nu-plain', `${L.plain.base}/p`, U.plain.id);
  await post('nu-server', `${L.server.base}/p`);
  const { sendDigest } = await import('../src/lib/notify');
  const landed = [{ id: SID, title: 'Next Up Title', added: 1, numbers: [3] }];
  await sendDigest(landed);
  assert.equal(L.picky.hits.length, 0, 'the picky account\'s target was told about a chapter behind its next one');
  assert.equal(L.plain.hits.length, 1);
  assert.equal(L.server.hits.length, 1, 'a server-wide target is not filtered');
  // Caught up through 2: now it is next.
  await finish('picky', 2);
  await sendDigest(landed);
  assert.equal(L.picky.hits.length, 1);
  // A digest entry that names no chapters is always sent.
  await unfinish('picky'); await finish('picky', 1);
  await sendDigest([{ id: SID, title: 'Next Up Title', added: 1 }]);
  assert.equal(L.picky.hits.length, 2);
});
