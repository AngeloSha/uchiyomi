// Real BFF authentication on a disposable database, bound only to loopback.
import { createRequire } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../../../bff/package.json', import.meta.url));
if (!process.env.TEST_DATABASE_URL || !process.env.UCHI_AUTH_READY_FILE) throw new Error('Use test-auth.sh with its disposable database');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = 'native-fixture-secret-at-least-16-chars';
process.env.LIBRARY_BACKEND = 'owned';
process.env.UCHIYOMI_PING_URL = '';
process.env.CONFIG_DIR = process.env.UCHI_AUTH_CONFIG_DIR;
const { migrate } = require('./src/lib/migrate.ts');
const { q, pool } = require('./src/lib/db.ts');
const { generateSecret } = require('./src/lib/totp.ts');
const { hash } = require('@node-rs/argon2');
const app = require('fastify')();
const username = 'native-' + randomUUID();
const password = 'disposable-test-only';
const secret = generateSecret();
function codeAt(step) {
  let bits = 0, value = 0; const bytes = [];
  for (const c of secret) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
await migrate();
const [{id}] = await q(`INSERT INTO users (username,display_name,password_hash,role,auth_kind,totp_enabled,totp_secret)
  VALUES ($1,$1,$2,'user','password',true,$3) RETURNING id`, [username, await hash(password), secret]);
await app.register(require('@fastify/cookie'));
await app.register(require('@fastify/jwt'), {secret: process.env.JWT_SECRET});
await app.register(require('./src/routes/auth.ts').default);
// This fixture-only route never ships in the app or BFF.
app.get('/__code', async () => ({code: codeAt(Math.floor(Date.now()/30000))}));
await app.listen({host: '127.0.0.1', port: 0});
await writeFile(process.env.UCHI_AUTH_READY_FILE, JSON.stringify({port: app.server.address().port, username, password, id}));
process.once('SIGTERM', async () => {
  await app.close(); await q('DELETE FROM users WHERE id=$1',[id]); await pool.end(); process.exit(0);
});
