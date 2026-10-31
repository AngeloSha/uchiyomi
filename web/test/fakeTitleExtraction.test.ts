// Exercise the dependency-free worker itself: small real PNGs must satisfy the real adapter's geometry contract.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
let child: ChildProcess, base: string;
const token = 'fixture-title-worker-only';
const crc = (bytes: Buffer) => { let v = 0xffffffff; for (const b of bytes) { v ^= b; for (let n = 0; n < 8; n++) v = v & 1 ? (v >>> 1) ^ 0xedb88320 : v >>> 1; } return (v ^ 0xffffffff) >>> 0; };
const chunk = (name: string, data: Buffer) => { const type = Buffer.from(name), n = Buffer.alloc(4), sum = Buffer.alloc(4); n.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([n, type, data, sum]); };
function cover(width: number, height: number) {
  const head = Buffer.alloc(13); head.writeUInt32BE(width); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const n = y * (width * 3 + 1) + x * 3 + 1; rows[n] = (x * 17 + y * 3) % 256; rows[n + 1] = (x * 5 + y * 11) % 256; rows[n + 2] = (x + y * 19) % 256; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
before(async () => {
  const socket = createServer(); await new Promise<void>((r) => socket.listen(0, '127.0.0.1', r));
  const port = (socket.address() as AddressInfo).port; await new Promise<void>((r) => socket.close(() => r())); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(__dirname, 'e2e/fakeTitleExtraction.mjs'), '--port', String(port)], { env: { ...process.env, TITLE_EXTRACTOR_TOKEN: token }, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let n = 0; n < 100; n++) { try { if ((await fetch(base + '/healthz', { headers: { authorization: 'Bearer ' + token } })).ok) return; } catch {} await new Promise((r) => setTimeout(r, 25)); }
  throw Error('fixture worker did not start');
});
after(() => child?.kill('SIGTERM'));
for (const [width, height] of [[24, 24], [64, 64], [600, 900], [2, 2]]) test(`${width}x${height} source yields bounded transparent geometry and exact source RGB`, async () => {
  const response = await fetch(base + '/v1/extract', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ imageBase64: cover(width, height).toString('base64'), exclusions: [], expectedTitles: [] }) });
  assert.equal(response.status, 200); const result = await response.json(), r = result.candidateRegion;
  assert.equal(result.width, Math.min(200, width)); assert.equal(result.height, Math.min(80, height));
  assert.ok(r.left >= 0 && r.top >= 0 && r.width > 0 && r.height > 0 && r.left + r.width <= 1 && r.top + r.height <= 1);
  const bytes = Buffer.from(result.candidateBase64, 'base64'), data: Buffer[] = [];
  assert.equal(bytes.readUInt32BE(16), result.width); assert.equal(bytes.readUInt32BE(20), result.height);
  for (let n = 8; n < bytes.length;) { const size = bytes.readUInt32BE(n); if (bytes.toString('ascii', n + 4, n + 8) === 'IDAT') data.push(bytes.subarray(n + 8, n + 8 + size)); n += size + 12; }
  const raw = inflateSync(Buffer.concat(data)); let opaque = 0, transparent = 0;
  for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
    const n = y * (result.width * 4 + 1) + 1 + x * 4, sx = Math.round(r.left * width) + x, sy = Math.round(r.top * height) + y;
    assert.deepEqual([...raw.subarray(n, n + 3)], [(sx * 17 + sy * 3) % 256, (sx * 5 + sy * 11) % 256, (sx + sy * 19) % 256]);
    if (raw[n + 3] === 255) opaque++; else { assert.equal(raw[n + 3], 0); transparent++; }
  }
  assert.ok(opaque > 0 && transparent > 0);
  assert.equal(raw[Math.floor(result.height * .8) * (result.width * 4 + 1) + 1 + Math.floor(result.width * .8) * 4 + 3], height === 2 ? 255 : 0);
  const entries = await (await fetch(base + '/__log')).json(), last = entries.at(-1);
  assert.equal(last.sourceWidth, width); assert.equal(last.sourceHeight, height); assert.equal(last.candidateWidth, result.width); assert.deepEqual(last.candidateRegion, r);
});
test('a one-pixel cover returns no_text rather than physically impossible transparent geometry', async () => {
  const response = await fetch(base + '/v1/extract', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ imageBase64: cover(1, 1).toString('base64') }) });
  assert.equal(response.status, 422); assert.equal((await response.json()).error, 'no_text');
});
