// OPDS tokens, and the fact that they now stop working.
//
// This is the one credential that lives in a third-party reader's settings on someone's phone, typed in once
// and forgotten. It had no expiry at all: one per user, replaced only when the owner happened to regenerate
// it, valid forever otherwise. Everything else in this app is bounded -- sessions expire, JWTs are fifteen
// minutes, API tokens are revocable and listed -- so this was the odd one out, and it is the one most likely
// to end up in a backup, a screenshot, or a config file someone syncs.
//
// The upgrade case is the one worth being careful about. Existing tokens must NOT be invalidated on the spot:
// that would sign every e-reader in a household out simultaneously, with no warning and no obvious cause.
// They get a year from now instead.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'opds-token-test';
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  await migrate();
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','user','password') RETURNING id`, [USER],
  );
  return { q, auth, userId: u[0].id };
}

test('OPDS tokens', { skip }, async (t) => {
  const { q, auth, userId } = await setup();

  try {
    await t.test('a fresh token works', async () => {
      const token = await auth.issueOpdsToken(userId);
      assert.equal((await auth.resolveOpdsBasic(basic(USER, token)))?.userId, userId);
    });

    await t.test('THE POINT: an expired token does not', async () => {
      const token = await auth.issueOpdsToken(userId);
      assert.equal((await auth.resolveOpdsBasic(basic(USER, token)))?.userId, userId, 'valid before expiry');

      await q(`UPDATE opds_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [userId]);
      assert.equal(await auth.resolveOpdsBasic(basic(USER, token)), null,
        'an expired token still authenticated, which is the bug this file exists for');
    });

    await t.test('issuing a new one replaces the old, and clears its last-used', async () => {
      const first = await auth.issueOpdsToken(userId);
      await auth.resolveOpdsBasic(basic(USER, first));
      // Wait for the fire-and-forget stamp to land before replacing the token. Without this the test is
      // racing the very ordering it is checking, and it passed locally while failing on CI.
      for (let i = 0; i < 40 && !(await auth.opdsTokenStatus(userId)).lastSeen; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const second = await auth.issueOpdsToken(userId);
      assert.notEqual(first, second);

      // Checked BEFORE the new token is used, because using it legitimately stamps it. The first version of
      // this test asserted afterwards and was simply wrong -- it passed locally only because the write had
      // not landed yet, which is a race, not a pass.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await auth.opdsTokenStatus(userId)).lastSeen, null,
        'a freshly issued token must not inherit the last-used date of the one it replaced');

      assert.equal(await auth.resolveOpdsBasic(basic(USER, first)), null, 'the replaced token must stop working');
      assert.equal((await auth.resolveOpdsBasic(basic(USER, second)))?.userId, userId);
    });

    await t.test('revoking works immediately', async () => {
      const token = await auth.issueOpdsToken(userId);
      await auth.revokeOpdsToken(userId);
      assert.equal(await auth.resolveOpdsBasic(basic(USER, token)), null);
      assert.equal((await auth.opdsTokenStatus(userId)).exists, false);
    });

    await t.test('status reports what the profile page shows', async () => {
      await auth.issueOpdsToken(userId);
      const before = await auth.opdsTokenStatus(userId);
      assert.equal(before.exists, true);
      assert.equal(before.expired, false);
      assert.equal(before.lastSeen, null, 'never used yet');
      assert.ok(before.expiresAt, 'an expiry must be reported, or the UI cannot warn anyone');
      assert.ok(new Date(before.expiresAt!).getTime() > Date.now(), 'a fresh token expires in the future');

      const token = await auth.issueOpdsToken(userId);
      await auth.resolveOpdsBasic(basic(USER, token));
      // resolveOpdsBasic stamps last_seen fire-and-forget on purpose: authenticating a reader should not
      // wait on a bookkeeping write. So poll for it rather than assuming it has already landed.
      let after = await auth.opdsTokenStatus(userId);
      for (let i = 0; i < 40 && !after.lastSeen; i++) {
        await new Promise((r) => setTimeout(r, 25));
        after = await auth.opdsTokenStatus(userId);
      }
      assert.ok(after.lastSeen, 'using a token should record when');
    });

    await t.test('THE UPGRADE: a token from before this change is not invalidated', async () => {
      // An install upgrading has rows with expires_at NULL until the migration backfills them. Neither state
      // may sign someone's e-reader out: NULL means "no expiry recorded", not "expired".
      const token = await auth.issueOpdsToken(userId);
      // Age the row. This is the whole test: a real install upgrading has tokens issued long ago, and a
      // backfill dated from created_at would expire them the moment the migration ran. A freshly created
      // row cannot catch that, because any offset from "just now" is still in the future.
      await q(
        `UPDATE opds_tokens SET expires_at = NULL, created_at = now() - interval '2 years' WHERE user_id = $1`,
        [userId],
      );
      assert.equal((await auth.resolveOpdsBasic(basic(USER, token)))?.userId, userId,
        'a pre-expiry token must keep working until the backfill gives it a date');

      const { migrate } = await import('../src/lib/migrate');
      await migrate();
      const st = await auth.opdsTokenStatus(userId);
      assert.ok(st.expiresAt, 'the migration should backfill an expiry');
      assert.ok(new Date(st.expiresAt!).getTime() > Date.now(),
        'backfilled expiry must be in the FUTURE -- dating it from issue would expire live tokens on upgrade');
      assert.equal((await auth.resolveOpdsBasic(basic(USER, token)))?.userId, userId, 'and it still works afterwards');
    });

    await t.test('the 18+ preference rides on the credential, off by default', async () => {
      // A reader has no other way to say it: no session, no button, no query parameter it knows about.
      // Reintroduce by returning a bare user id from resolveOpdsBasic again: the feed cannot tell the two
      // readers apart and the toggle on the profile page does nothing.
      const token = await auth.issueOpdsToken(userId);
      assert.equal((await auth.resolveOpdsBasic(basic(USER, token)))?.showAdult, false, 'must default to hidden');
      assert.equal(await auth.setOpdsShowAdult(userId, true), true);
      assert.equal((await auth.resolveOpdsBasic(basic(USER, token)))?.showAdult, true);
      assert.equal((await auth.opdsTokenStatus(userId)).showAdult, true, 'the profile page reads it from status');
      // Regenerating keeps the preference: it belongs to the reader, not to the secret.
      const again = await auth.issueOpdsToken(userId);
      assert.equal((await auth.resolveOpdsBasic(basic(USER, again)))?.showAdult, true);
      await auth.revokeOpdsToken(userId);
      assert.equal(await auth.setOpdsShowAdult(userId, true), false, 'nothing to set it on');
    });

    await t.test('a wrong password is refused, and a missing header is not a crash', async () => {
      await auth.issueOpdsToken(userId);
      assert.equal(await auth.resolveOpdsBasic(basic(USER, 'not-the-token')), null);
      assert.equal(await auth.resolveOpdsBasic(undefined), null);
      assert.equal(await auth.resolveOpdsBasic('Bearer something'), null);
      assert.equal(await auth.resolveOpdsBasic('Basic !!!not-base64!!!'), null);
    });
  } finally {
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  }
});
