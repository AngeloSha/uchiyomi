// ID token verification, against a real HTTP issuer with real keys.
//
// This is the part of SSO where a mistake is a silent authentication bypass, so it is tested with an actual
// key pair and an actual discovery + JWKS endpoint rather than by stubbing the verifier out. Each negative
// case is a way someone could try to walk in: a token signed by the wrong key, one minted for a different
// client, an expired one, a replayed one, or one with the signature stripped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const CLIENT_ID = 'uchiyomi-test';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
// a second, unrelated key: tokens signed with this must never be accepted
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

let server: Server;
let issuer = '';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Mint an ID token the way an identity provider would. */
function mintToken(payload: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey } = {}): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: opts.kid ?? 'test-key' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: issuer, aud: CLIENT_ID, sub: 'user-1', iat: now, exp: now + 300, ...payload };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(body))}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(opts.key ?? privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

async function setup() {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      }));
    } else if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.DATABASE_URL ||= 'postgres://unused/unused';
  process.env.PUBLIC_ORIGIN ||= 'http://localhost:3000';

  return await import('../src/lib/oidc');
}

test('OIDC ID token verification', async (t) => {
  const oidc = await setup();
  const NONCE = randomUUID();

  await t.test('accepts a correctly signed token and reads its claims', async () => {
    const tok = mintToken({
      nonce: NONCE,
      preferred_username: 'tester',
      name: 'Test Person',
      email: 'tester@example.com',
      email_verified: true,
      groups: ['media', 'admins'],
    });
    const claims = await oidc.verifyIdToken(tok, NONCE);
    assert.equal(claims.sub, 'user-1');
    assert.equal(claims.username, 'tester');
    assert.equal(claims.displayName, 'Test Person');
    assert.equal(claims.email, 'tester@example.com');
    assert.equal(claims.emailVerified, true);
    assert.deepEqual(claims.groups, ['media', 'admins']);
    assert.equal(claims.issuer, issuer);
  });

  await t.test('rejects a token signed with a different key', async () => {
    const tok = mintToken({ nonce: NONCE }, { key: other.privateKey });
    await assert.rejects(() => oidc.verifyIdToken(tok, NONCE), /signature/i);
  });

  await t.test('rejects a token whose payload was edited after signing', async () => {
    const tok = mintToken({ nonce: NONCE, preferred_username: 'tester' });
    const [h, , s] = tok.split('.');
    const forged = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
    forged.sub = 'someone-else';
    await assert.rejects(
      () => oidc.verifyIdToken(`${h}.${b64u(JSON.stringify(forged))}.${s}`, NONCE),
      /signature/i,
    );
  });

  await t.test('rejects a token minted for a different client', async () => {
    const tok = mintToken({ nonce: NONCE, aud: 'some-other-app' });
    await assert.rejects(() => oidc.verifyIdToken(tok, NONCE), /not issued for this client/i);
  });

  await t.test('rejects a token from a different issuer', async () => {
    const tok = mintToken({ nonce: NONCE, iss: 'https://evil.example.com' });
    await assert.rejects(() => oidc.verifyIdToken(tok, NONCE), /issuer mismatch/i);
  });

  await t.test('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = mintToken({ nonce: NONCE, exp: now - 600 });
    await assert.rejects(() => oidc.verifyIdToken(tok, NONCE), /expired/i);
  });

  await t.test('rejects a replayed token from someone else\'s login', async () => {
    // the nonce is what ties a token to the login WE started
    const tok = mintToken({ nonce: 'a-different-login' });
    await assert.rejects(() => oidc.verifyIdToken(tok, NONCE), /nonce/i);
  });

  await t.test('rejects a token with no nonce at all', async () => {
    await assert.rejects(() => oidc.verifyIdToken(mintToken({}), NONCE), /nonce/i);
  });

  await t.test('rejects a token signed by a key the issuer does not publish', async () => {
    const tok = mintToken({ nonce: NONCE }, { kid: 'unknown-key', key: other.privateKey });
    await assert.rejects(() => oidc.verifyIdToken(tok, NONCE), /signing key|signature/i);
  });

  await t.test('rejects the "alg: none" trick', async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iss: issuer, aud: CLIENT_ID, sub: 'admin', exp: now + 300, nonce: NONCE }));
    await assert.rejects(() => oidc.verifyIdToken(`${header}.${body}.`, NONCE), /unsupported/i);
  });

  await t.test('rejects malformed tokens', async () => {
    for (const bad of ['', 'a.b', 'not-a-token', '...']) {
      await assert.rejects(() => oidc.verifyIdToken(bad, NONCE), `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  await t.test('discovery drives the authorization URL, with PKCE', async () => {
    const start = await oidc.beginLogin();
    const url = new URL(start.url);
    assert.equal(url.origin + url.pathname, `${issuer}/authorize`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('state'));
    assert.ok(url.searchParams.get('nonce'));
    // the verifier must never be the challenge itself
    assert.notEqual(url.searchParams.get('code_challenge'), start.verifier);
  });

  await t.test('each login gets fresh state, nonce and verifier', async () => {
    const a = await oidc.beginLogin();
    const b = await oidc.beginLogin();
    assert.notEqual(a.state, b.state);
    assert.notEqual(a.nonce, b.nonce);
    assert.notEqual(a.verifier, b.verifier);
  });

  await new Promise<void>((r) => server.close(() => r()));
});
