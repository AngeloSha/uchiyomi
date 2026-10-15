// The registered sign-in applications and the MyAnimeList code exchange. Needs Postgres (CI provides one).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

test('an admin-saved application is offered to the browser, with the secret kept server-side', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const o = await import('../src/lib/trackerOauth');
  await migrate();
  await q(`DELETE FROM tracker_oauth_apps`);
  delete process.env.ANILIST_CLIENT_ID;

  assert.deepEqual(await o.connectInfo('anilist'), { method: 'oauth-implicit', configured: false });
  assert.deepEqual(await o.connectInfo('kitsu'), { method: 'token', configured: true }, 'a service with nothing to register is always ready: its row takes a pasted token');

  await o.saveApp('myanimelist', 'mal-client', 'shh');
  const info = await o.connectInfo('myanimelist');
  assert.equal(info.configured, true);
  assert.equal(info.clientId, 'mal-client');
  assert.match(info.authorizeUrl!, /myanimelist\.net\/v1\/oauth2\/authorize/);
  assert.ok(!JSON.stringify(info).includes('shh'), 'the secret must never be part of what the browser gets');
  const stored = await q<{ client_secret: string }>(`SELECT client_secret FROM tracker_oauth_apps WHERE provider = 'myanimelist'`);
  assert.notEqual(stored[0].client_secret, 'shh', 'stored sealed');
  assert.equal((await o.getApp('myanimelist'))!.clientSecret, 'shh');

  process.env.ANILIST_CLIENT_ID = 'from-env';
  assert.equal((await o.getApp('anilist'))!.clientId, 'from-env');
  await o.saveApp('anilist', 'from-admin', null);
  assert.equal((await o.getApp('anilist'))!.clientId, 'from-admin', 'what an admin saved wins over the environment');
  await o.clearApp('anilist');
  assert.equal((await o.getApp('anilist'))!.source, 'env');

  delete process.env.ANILIST_CLIENT_ID;
  await q(`DELETE FROM tracker_oauth_apps`);
});

test('MyAnimeList: the code is swapped with the verifier and the saved client', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const o = await import('../src/lib/trackerOauth');
  await migrate();
  await q(`DELETE FROM tracker_oauth_apps`);
  await assert.rejects(() => o.exchangeMalCode('c', 'v'.repeat(50), 'http://x/tracker-callback/'), /not set up/);

  await o.saveApp('myanimelist', 'mal-client', 'shh');
  const real = globalThis.fetch;
  let sent = '';
  globalThis.fetch = (async (_u: any, init: any) => {
    sent = String(init.body);
    return new Response(JSON.stringify({ access_token: 'mal_token_value', expires_in: 2678400 }), { status: 200 });
  }) as typeof fetch;
  try {
    const g = await o.exchangeMalCode('thecode', 'v'.repeat(50), 'http://timnode:3000/tracker-callback/');
    assert.equal(g.token, 'mal_token_value');
    assert.equal(g.expiresInSec, 2678400);
    const p = new URLSearchParams(sent);
    assert.equal(p.get('client_id'), 'mal-client');
    assert.equal(p.get('client_secret'), 'shh');
    assert.equal(p.get('grant_type'), 'authorization_code');
    assert.equal(p.get('code_verifier'), 'v'.repeat(50));
    assert.equal(p.get('redirect_uri'), 'http://timnode:3000/tracker-callback/');
  } finally { globalThis.fetch = real; }
  await q(`DELETE FROM tracker_oauth_apps`);
});
