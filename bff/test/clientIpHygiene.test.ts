// Who a visitor is, decided in one place (lib/clientAddr.ts clientIp, which reads `req.ip` as Fastify resolved it under
// TRUST_PROXY; trustProxy.test.ts).
//
// Every sign-in limit, the lockout budget per address and name, and the activity log rest on that address. A reader of
// a forwarding header of its own -- the first X-Forwarded-For entry, X-Real-IP, CF-Connecting-IP -- is a header the
// visitor writes, and the bug v0.69.1 removed: clientIp read the first X-Forwarded-For entry whatever `trustProxy` said.
// Three places still copied X-Forwarded-For into a stand-in request for a later audit line, where nothing read it.
// So no source file names one outside a comment. Reintroduce any reader and this lists the line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'src');
// A header NAME, quoted whole as a lookup or a key takes it -- not a sentence that mentions one (lib/auth.ts says
// "X-Forwarded-For" to the operator in trustProxyWarnings).
const HEADER = /['"`](x-forwarded-[a-z]+|x-real-ip|cf-connecting-ip|true-client-ip|forwarded)['"`]|headers\.forwarded\b/i;
/**
 * The places that may name one, each with why. Each is matched as the line's code, so a second use in the same file
 * still fails.
 */
const ALLOWED: Record<string, string> = {
  // zoneOf: whether the header is there at all, never what it says -- forwarded by a peer TRUST_PROXY does not name
  // means the address seen is not the visitor's, so the request is not at home.
  "lib/clientAddr.ts: if (req.headers['x-forwarded-for'] !== undefined && (req.ips?.length ?? 1) <= 1) return 'remote';": 'presence only',
  // viaCloudflare: whether Cloudflare's edge passed the request on at all, never the address it reports -- such a
  // request is not at home, and a visitor who adds the header only puts themselves outside.
  "lib/clientAddr.ts: return req.headers['cf-connecting-ip'] !== undefined || req.headers['cf-ray'] !== undefined;": 'presence only',
};

test('no source file reads a forwarding header of its own', () => {
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 100, `only ${files.length} files under src/: the check is not looking at the source`);
  const found: string[] = [];
  for (const f of files) {
    readFileSync(join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
      const code = line.trimStart();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      const file = f.replace(/\\/g, '/');
      if (!HEADER.test(code.replace(/\/\/.*$/, '')) || `${file}: ${code}` in ALLOWED) return;
      found.push(`src/${file}:${i + 1}: ${code.slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], 'read the address with clientIp (lib/clientAddr.ts), never a header');
});
