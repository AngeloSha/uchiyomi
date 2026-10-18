// A backup extension's source in Discover (v0.82.0): never there. The owner, 2026-10-18: Discover should show "only the
// sources/extensions he actually added manually". GET /api/sources still lists it, flagged, because the reader, the
// series page and the downloads name a chapter's source from that list; every route Discover browses, searches or adds
// through leaves it out (routes/sources.ts discoverable), and never asks it.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ADMIN = 'bkd-admin';
const MINE = 'bkd-mine', SPARE = 'bkd-spare';
const asked: string[] = [];

function fake(id: string, backup = false) {
  return {
    id, name: `Name ${id}`, lang: 'en', ...(backup ? { backup: true } : {}),
    async search(term: string) { asked.push(`${id}:search`); return [{ sourceId: `${id}-hit`, source: id, title: term }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
    async latest() { asked.push(`${id}:latest`); return [{ sourceId: `${id}-l`, source: id, title: `${id} new` }]; },
    async popular() { asked.push(`${id}:popular`); return [{ sourceId: `${id}-p`, source: id, title: `${id} hot` }]; },
  };
}

let q: any, app: any;
const H: Record<string, string> = {};
const get = (url: string) => app.inject({ method: 'GET', url, headers: H });

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter(fake(MINE) as any);
  registerAdapter(fake(SPARE, true) as any);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                          VALUES ($1,$1,'x','admin','password','{}') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}`;
});

beforeEach(() => { asked.length = 0; });

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('a backup is listed for its name, flagged, and never asked by Discover', { skip }, async () => {
  // Reintroduce by reading `surfaceable` in `discoverable`: search-all, latest, popular and find all ask the backup.
  const list = (await get('/api/sources')).json();
  const spare = list.content.find((s: any) => s.id === SPARE);
  assert.equal(spare?.backup, true, 'GET /api/sources names it, flagged');
  assert.equal(list.content.find((s: any) => s.id === MINE)?.backup, undefined, 'a source a person added is not flagged');

  const all = (await get('/api/sources/search-all?q=Moon%20Tale')).json();
  assert.ok(asked.includes(`${MINE}:search`), 'PREMISE: search-all asks the sources a person added');
  assert.ok(!asked.includes(`${SPARE}:search`), 'never the backup');
  assert.ok(!JSON.stringify(all).includes(SPARE), 'nor answers with it');

  asked.length = 0;
  await get(`/api/sources/search-all?q=Moon%20Tale&source=${SPARE}`);
  await get(`/api/sources/search?source=${SPARE}&q=Moon%20Tale`);
  assert.deepEqual(asked, [], 'naming it does not widen the list');

  assert.deepEqual((await get(`/api/sources/latest?source=${SPARE}`)).json().content, [], 'no newest listing');
  assert.deepEqual((await get(`/api/sources/popular?source=${SPARE}`)).json().content, [], 'no popular one');
  const found = (await get(`/api/sources/find?q=Moon%20Tale&sources=${MINE},${SPARE}`)).json();
  assert.deepEqual(found.content.map((f: any) => f.source), [MINE], 'the add dialog\'s find asks only the sources a person added');
  assert.ok(!asked.some((a) => a.startsWith(SPARE)), 'and the backup is never asked');
});
