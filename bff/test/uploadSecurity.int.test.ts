// Exercise the actual HTTP stream: inject() alone cannot establish socket/error/abort behavior.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { type ClientRequest } from 'node:http';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const skip = !DSN;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = 'upload-security-isolated-test-key';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
  process.env.MIN_FREE_GB = '0';
  process.env.UPLOAD_MAX_MB = '0.02';
}

let root = '', app: any, db: any, address = '', authorization = '', archive: Buffer;
const sockets = new Set<ClientRequest>();
const nativeFetch = globalThis.fetch;
const names = ['security-oversize', 'security-abort', 'security-cap-a', 'security-cap-b', 'security-cap-c'];

async function until(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(message);
}

function open(title: string) {
  let resolve!: (value: { status: number; body: string }) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<{ status: number; body: string }>((yes, no) => { resolve = yes; reject = no; });
  // The client deliberately omits Content-Length, as a streamed upload may do.
  const req = http.request(`${address}/api/library/upload?fresh=1&title=${title}&name=Chapter%201.cbz`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
  }, res => {
    const body: Buffer[] = [];
    res.on('data', chunk => body.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(body).toString() }));
    res.on('error', reject);
  });
  req.on('error', reject);
  req.on('close', () => sockets.delete(req));
  sockets.add(req);
  // Attach a rejection handler immediately, including requests intentionally aborted below.
  void response.catch(() => {});
  req.flushHeaders();
  req.write(archive.subarray(0, 4));
  return { req, response };
}

async function files(title: string): Promise<string[]> {
  return readdir(join(root, 'dl', 'Uploads', title)).catch(() => []);
}

async function reservationGone(title: string): Promise<boolean> {
  return stat(join(root, 'dl', 'Uploads', title)).then(() => false, error => {
    if (error.code === 'ENOENT') return true;
    throw error;
  });
}

before(async () => {
  if (!DSN) return;
  root = await mkdtemp(join(tmpdir(), 'uchiyomi-upload-security-'));
  process.env.DL_ROOT = join(root, 'dl');
  process.env.LIBRARY_ROOT = join(root, 'lib');
  process.env.CONFIG_DIR = join(root, 'config');
  globalThis.fetch = (async () => { throw new Error('No external requests in upload stream tests'); }) as typeof fetch;
  db = await import('../src/lib/db');
  await (await import('../src/lib/migrate')).migrate();
  const id = (await db.q(`INSERT INTO users(username,display_name,password_hash,role,auth_kind)
    VALUES('upload-security-admin','Upload security','x','admin','password') RETURNING id`))[0].id;
  app = (await import('fastify')).default();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/upload')).uploadSeriesRoutes);
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  authorization = `Bearer ${app.jwt.sign({ sub: id, role: 'admin' })}`;
  const zip = new ((await import('adm-zip')).default)();
  const sharp = (await import('sharp')).default;
  zip.addFile('001.png', await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer());
  archive = zip.toBuffer();
});

after(async () => {
  if (!DSN) return;
  for (const req of sockets) req.destroy();
  await app?.close();
  if (db) {
    await db.q('DELETE FROM lib_series WHERE folder = ANY($1::text[])', [names.map(n => `Uploads/${n}`)]);
    await db.q("DELETE FROM users WHERE username='upload-security-admin'");
    await db.pool.end();
  }
  globalThis.fetch = nativeFetch;
  if (root) await rm(root, { recursive: true, force: true });
});

test('an unknown-length oversized upload gets an HTTP refusal, removes its partial file and releases its reservation', { skip, timeout: 15000 }, async () => {
  const pending = open(names[0]);
  // Leave the source open: the server must refuse at the cap, rather than waiting for a sender to finish.
  pending.req.write(Buffer.alloc(25000));
  const refused = await pending.response;
  pending.req.end();
  assert.equal(refused.status, 413, refused.body);
  await until(() => reservationGone(names[0]), 'Oversized upload retained its partial file or folder reservation');
  const retry = open(names[0]);
  retry.req.end(archive.subarray(4));
  const accepted = await retry.response;
  assert.equal(accepted.status, 200, accepted.body);
  assert.equal(JSON.parse(accepted.body).indexed, true);
});

test('a client abort removes its partial file and releases the folder writer for a complete retry', { skip, timeout: 15000 }, async () => {
  const pending = open(names[1]);
  await until(async () => (await files(names[1])).some(name => name.includes('.tmp.')), 'Streaming upload did not create its private temporary file');
  pending.req.destroy();
  await pending.response.catch(() => {});
  await until(() => reservationGone(names[1]), 'Aborted upload retained its partial file or folder reservation');
  const retry = open(names[1]);
  retry.req.end(archive.subarray(4));
  const accepted = await retry.response;
  assert.equal(accepted.status, 200, accepted.body);
});

test('three requests admitted together through asynchronous title lookups never consume more than two upload slots', { skip, timeout: 20000 }, async () => {
  const { Client } = await import('pg');
  const lock = new Client({ connectionString: DSN! });
  await lock.connect();
  const pending: ReturnType<typeof open>[] = [];
  let committed = false;
  try {
    await lock.query('BEGIN');
    // Queue all three after the first active-count observation but before any body is received.
    await lock.query('LOCK TABLE lib_series IN ACCESS EXCLUSIVE MODE');
    for (const title of names.slice(2)) pending.push(open(title));
    await until(async () => {
      // PostgreSQL caches the statistics snapshot within our lock transaction.
      await lock.query('SELECT pg_stat_clear_snapshot()');
      return Number((await lock.query(`SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE 'SELECT 1 FROM lib_series s WHERE%'`)).rows[0].n) === 3;
    },
    'The three route title lookups did not reach the deterministic database barrier');
    await lock.query('COMMIT'); committed = true;
    const raced = await Promise.race([
      ...pending.map((p, index) => p.response.then(response => ({ index, response }))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No third-upload refusal: all three streams were admitted')), 3000)),
    ]);
    assert.equal(raced.response.status, 429, raced.response.body);
    for (const [index, p] of pending.entries()) if (index !== raced.index) p.req.end(archive.subarray(4));
    const results = await Promise.all(pending.map(p => p.response));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 429]);
  } finally {
    if (!committed) await lock.query('ROLLBACK');
    await lock.end();
    for (const p of pending) if (!p.req.destroyed) p.req.destroy();
  }
});
