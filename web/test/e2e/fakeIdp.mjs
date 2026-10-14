// A fake OpenID Connect provider for the browser walks (v0.63.0, v630Walk.mjs): discovery, keys, an authorize page that
// approves at once as whoever the walk said is signed in at the provider, and a token endpoint. Never for anything else.
//
//   node web/test/e2e/fakeIdp.mjs --port 28630 --internal http://idp:28630 --browser http://127.0.0.1:28630
//
// `--internal` is the address the server reaches it at (the issuer, its keys and its token endpoint) and `--browser` the
// one a browser does (the authorize page): in Docker they differ. POST /__as {sub, preferred_username?, groups?} says who
// is signed in at the provider for the next authorizations; GET /__log lists the sign-ins it approved.
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', '28630'));
const INTERNAL = arg('internal', `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const BROWSER = arg('browser', INTERNAL).replace(/\/$/, '');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'RS256', use: 'sig' };
const b64u = (b) => Buffer.from(b).toString('base64url');

let who = { sub: 'nobody', preferred_username: 'nobody', groups: [] };
/** Authorization codes waiting for the token endpoint: who, the nonce, the client. */
const codes = new Map();
const log = [];

function mint(payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'e2e' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: INTERNAL, iat: now, exp: now + 300, ...payload };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(body))}`;
  return `${input}.${b64u(createSign('RSA-SHA256').update(input).sign(privateKey))}`;
}

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, BROWSER);
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer: INTERNAL, authorization_endpoint: `${BROWSER}/authorize`, token_endpoint: `${INTERNAL}/token`, jwks_uri: `${INTERNAL}/jwks` });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = randomBytes(12).toString('hex');
      codes.set(code, { who, nonce: url.searchParams.get('nonce'), client: url.searchParams.get('client_id') });
      log.push({ sub: who.sub, at: Date.now() });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const got = codes.get(new URLSearchParams(body).get('code') ?? '');
      if (!got) return json(400, { error: 'invalid_grant' });
      codes.delete(new URLSearchParams(body).get('code'));
      return json(200, { id_token: mint({ aud: got.client, nonce: got.nonce, ...got.who }), token_type: 'Bearer' });
    }
    if (url.pathname === '/__as' && req.method === 'POST') {
      who = { groups: [], ...JSON.parse(body || '{}') };
      return json(200, { ok: true, who });
    }
    if (url.pathname === '/__log') return json(200, log);
    return json(404, {});
  });
}).listen(PORT, '0.0.0.0');
