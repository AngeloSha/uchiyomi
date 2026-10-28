// Profiles on Uchiyomi Desktop: the PC's owner switches to a profile that
// opens at home, and goes back through the shell's own handshake, which takes up the session the profile was opened
// from rather than leaving a new owner session behind each time. The keyring and "who is reading?" do not exist here:
// on desktop the shell is the only way in. Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const DATA = mkdtempSync(join(tmpdir(), 'uchi-desk-prof-'));
const PORT = 43126;
const SECRET = '7d'.repeat(32);
const HOST = `127.0.0.1:${PORT}`;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.UCHIYOMI_DESKTOP = '1';
  process.env.UCHIYOMI_DATA_DIR = DATA;
  process.env.PORT = String(PORT);
  process.env.DL_ROOT = join(DATA, 'dl');
  process.env.UCHIYOMI_DESKTOP_SECRET = SECRET;
  process.env.UCHIYOMI_DESKTOP_USER = 'Owner';
  delete process.env.CONFIG_DIR;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('profiles on the desktop app', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { ensureDesktopUser } = await import('../src/lib/desktopUser');
  const { installDesktopGuards } = await import('../src/lib/desktopGuard');
  await migrate();
  await q("DELETE FROM users WHERE auth_kind = 'desktop' OR username = 'dp-kid'");
  const setAside = (await q<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND NOT disabled")).map((r) => r.id);
  if (setAside.length) await q('UPDATE users SET disabled = true WHERE id = ANY($1::uuid[])', [setAside]);
  const owner = await ensureDesktopUser();
  const kid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, password_login, local_open, managed_by)
     VALUES ('dp-kid', 'dp-kid', 'x', 'user', 'none', false, true, $1) RETURNING id`, [owner]))[0].id;

  const app = (await import('fastify')).default();
  installDesktopGuards(app);
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();
  const rtOf = (res: any) => res.cookies.find((c: any) => c.name === 'yomi_rt')?.value as string;
  const handshake = (rt?: string) => app.inject({
    method: 'POST', url: '/auth/desktop', headers: { host: HOST, 'x-uchiyomi-desktop': SECRET }, ...(rt ? { cookies: { yomi_rt: rt } } : {}),
  });
  const ownerSessions = async () => (await q(
    `SELECT DISTINCT session_id FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [owner])).length;

  try {
    await t.test('back to the owner takes up the session the profile came from', async () => {
      const first = await handshake();
      assert.equal(first.statusCode, 200, first.body);
      const ownerRt = rtOf(first);
      const ownerSession = (await one<{ s: string }>('SELECT session_id AS s FROM refresh_tokens WHERE token_hash = $1', [sha(ownerRt)]))!.s;
      const list = await app.inject({ method: 'GET', url: '/auth/profiles', headers: { host: HOST, authorization: `Bearer ${first.json().accessToken}` } });
      assert.deepEqual(list.json().content.map((p: any) => p.id), [kid], 'the desktop is home: its owner lists the profile');
      const sw = await app.inject({
        method: 'POST', url: '/auth/switch', headers: { host: HOST, authorization: `Bearer ${first.json().accessToken}` },
        cookies: { yomi_rt: ownerRt }, payload: { profileId: kid },
      });
      assert.equal(sw.statusCode, 200, sw.body);
      const kidRt = rtOf(sw);
      const back = await handshake(kidRt);
      assert.equal(back.statusCode, 200, back.body);
      assert.equal(back.json().user.id, owner);
      const backSession = (await one<{ s: string }>('SELECT session_id AS s FROM refresh_tokens WHERE token_hash = $1', [sha(rtOf(back))]))!.s;
      assert.equal(backSession, ownerSession, 'a new owner session was made');
      assert.equal(await ownerSessions(), 1, 'an owner session was left live with no cookie anywhere');
      assert.equal((await one<{ r: boolean }>('SELECT revoked_at IS NOT NULL AS r FROM refresh_tokens WHERE token_hash = $1', [sha(kidRt)]))!.r, true,
        "the profile's session was left live");
    });

    await t.test('a plain handshake is what it always was', async () => {
      const before = await ownerSessions();
      assert.equal((await handshake()).statusCode, 200);
      assert.equal(await ownerSessions(), before + 1);
    });

    await t.test('the keyring and "who is reading?" are not ways in here', async () => {
      for (const [method, url] of [['GET', '/auth/ring'], ['POST', '/auth/resume'], ['POST', '/auth/leave'], ['GET', '/auth/pick'], ['POST', '/auth/profile-login']] as const) {
        const r = await app.inject({ method, url, headers: { host: HOST }, payload: method === 'POST' ? {} : undefined });
        assert.equal(r.statusCode, 404, `${method} ${url}`);
      }
    });
  } finally {
    await q("DELETE FROM users WHERE auth_kind = 'desktop' OR username = 'dp-kid'").catch(() => {});
    if (setAside.length) await q('UPDATE users SET disabled = false WHERE id = ANY($1::uuid[])', [setAside]).catch(() => {});
    await app.close();
  }
});
