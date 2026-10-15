// Restarting the server must never change anyone's role once it has an admin.
//
// migrate() ends with a step written for a pre-multi-user install: make its one account the admin. It ran on every
// boot with no condition, so after an admin demoted the oldest account (Admin -> Members, or OIDC_ADMIN_GROUP at the
// next sign-in) the next restart made it admin again, and deleting the oldest account promoted the next-oldest
// member. The audit reproduced both against the real migrate(). The step now runs only while no admin exists.
//
// Owns the whole users table (CI gives every file a fresh database; every foreign key on users cascades or nulls).
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

test('a restart keeps demotions and deletions, and still adopts a lone legacy account', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, pool } = await import('../src/lib/db');
  await migrate();
  await q('DELETE FROM users');
  const mk = async (username: string | null, role: string, created: string) =>
    (await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
      [username, username ?? 'legacy', role, created],
    ))[0].id;
  const role = async (id: string) => (await q<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]))[0]?.role;

  try {
    const founder = await mk('founder', 'admin', '2001-01-01');
    const kid = await mk('kid', 'user', '2002-01-01');
    await mk('second', 'admin', '2003-01-01');

    // an admin demotes the oldest account; a restart must not undo it
    await q(`UPDATE users SET role = 'user' WHERE id = $1`, [founder]);
    await migrate();
    assert.equal(await role(founder), 'user', 'the restart re-promoted a demoted founder');

    // the founder is deleted; the next-oldest member must stay a member
    await q('DELETE FROM users WHERE id = $1', [founder]);
    await migrate();
    assert.equal(await role(kid), 'user', 'the restart promoted the next-oldest member');

    // the step's real job is untouched: a pre-multi-user install's one account, with no username, becomes the admin
    await q('DELETE FROM users');
    const legacy = await mk(null, 'user', '2000-01-01');
    await migrate();
    const row = (await q<{ role: string; username: string | null }>('SELECT role, username FROM users WHERE id = $1', [legacy]))[0];
    assert.deepEqual(row, { role: 'admin', username: 'admin' });
  } finally {
    await q('DELETE FROM users');
    await pool.end();
  }
});
