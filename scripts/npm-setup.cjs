// Creates/updates the Nginx Proxy Manager host for Yomi via its API.
// Run through scripts/add-proxy.sh (which supplies creds via env).
const NPM = process.env.NPM_URL || 'http://npm:81';
const EMAIL = process.env.NPM_EMAIL;
const PASS = process.env.NPM_PASS;
const LE_EMAIL = process.env.LE_EMAIL || EMAIL;
const DOMAIN = process.env.DOMAIN || 'yomi.example.com';

async function call(method, path, token, body) {
  const r = await fetch(NPM + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return data;
}

const baseHost = (certId, ssl) => ({
  domain_names: [DOMAIN],
  forward_scheme: 'http',
  forward_host: 'yomi-web',
  forward_port: 80,
  access_list_id: '0',
  certificate_id: certId || 0,
  ssl_forced: ssl,
  http2_support: ssl,
  hsts_enabled: ssl,
  hsts_subdomains: false,
  block_exploits: true,
  caching_enabled: false,
  allow_websocket_upgrade: true,
  advanced_config: '',
  locations: [],
  meta: { letsencrypt_agree: ssl, dns_challenge: false },
});

(async () => {
  const token = (await call('POST', '/api/tokens', null, { identity: EMAIL, secret: PASS })).token;
  console.log('✓ Authenticated to NPM');

  const hosts = await call('GET', '/api/nginx/proxy-hosts', token);
  let host = hosts.find((h) => h.domain_names.includes(DOMAIN));
  if (host) {
    console.log(`• Proxy host already exists (id ${host.id})`);
  } else {
    host = await call('POST', '/api/nginx/proxy-hosts', token, baseHost(0, false));
    console.log(`✓ Created proxy host ${DOMAIN} -> yomi-web:80 (id ${host.id})`);
  }

  let certId = host.certificate_id || 0;
  if (!certId) {
    try {
      const cert = await call('POST', '/api/nginx/certificates', token, {
        provider: 'letsencrypt',
        nice_name: DOMAIN,
        domain_names: [DOMAIN],
        meta: { letsencrypt_email: LE_EMAIL, letsencrypt_agree: true, dns_challenge: false },
      });
      certId = cert.id;
      console.log(`✓ Issued Let's Encrypt certificate (id ${certId})`);
    } catch (e) {
      console.log('⚠ Could not issue certificate — is the DNS A record for', DOMAIN, 'pointed at this server yet?');
      console.log('  ', e.message);
      console.log('  Point DNS, then re-run this script to enable HTTPS.');
    }
  }

  if (certId) {
    await call('PUT', '/api/nginx/proxy-hosts/' + host.id, token, baseHost(certId, true));
    console.log('✓ HTTPS enabled + forced');
  }

  console.log(`\nDone. Once DNS resolves, open: https://${DOMAIN}`);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
