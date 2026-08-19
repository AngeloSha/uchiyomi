// Tracker tokens are stored encrypted rather than hashed, because we have to replay them to AniList.
// That makes these properties load-bearing: a silent failure here would either leak tokens in a database
// dump or, worse, let a tampered row decrypt to something we'd then send to a third party.
import test from 'node:test';
import assert from 'node:assert/strict';

// The key is derived from JWT_SECRET, so it has to exist before the module is loaded. Loading is deferred
// into the tests (rather than a top-level await) because this project compiles to CommonJS.
process.env.JWT_SECRET ||= 'test-secret-for-secretbox-tests-only';
process.env.DATABASE_URL ||= 'postgres://unused/unused';

const load = () => import('../src/lib/secretbox');

test('seal/open round-trips', async () => {
  const { seal, open } = await load();
  const token = 'anilist_token_' + 'x'.repeat(80);
  assert.equal(open(seal(token)), token);
});

test('ciphertext does not contain the plaintext', async () => {
  const { seal } = await load();
  const token = 'super-secret-value-12345';
  assert.ok(!seal(token).includes(token));
});

test('same plaintext seals differently each time (random IV)', async () => {
  // Deterministic output would let anyone with the DB tell which users share a token.
  const { seal } = await load();
  assert.notEqual(seal('same'), seal('same'));
});

test('tampered ciphertext is rejected, not silently mangled', async () => {
  const { seal, open } = await load();
  const parts = seal('original-token').split(':');
  const ct = parts[3];
  parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1); // flip a character in the ciphertext
  assert.equal(open(parts.join(':')), null);
});

test('tampered auth tag is rejected', async () => {
  const { seal, open } = await load();
  const parts = seal('original-token').split(':');
  const tag = parts[2];
  parts[2] = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
  assert.equal(open(parts.join(':')), null);
});

test('malformed input returns null rather than throwing', async () => {
  // A garbled row must disconnect the tracker cleanly, never crash a reading request.
  const { open } = await load();
  for (const bad of ['', 'nonsense', 'v1:', 'v1:a:b', 'v2:a:b:c', ':::']) {
    assert.equal(open(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('a different JWT_SECRET cannot read the token', async () => {
  // The point of encrypting at rest: a stolen database alone is not enough.
  const { seal } = await load();
  const sealed = seal('anilist-token');
  const { createDecipheriv, scryptSync } = await import('crypto');
  const wrong = scryptSync('a-completely-different-secret', 'uchiyomi.tracker.v1', 32);
  const [, iv, tag, ct] = sealed.split(':');
  assert.throws(() => {
    const d = createDecipheriv('aes-256-gcm', wrong, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  });
});

test('unicode survives the round trip', async () => {
  const { seal, open } = await load();
  const s = '読み・トークン・🔐';
  assert.equal(open(seal(s)), s);
});
