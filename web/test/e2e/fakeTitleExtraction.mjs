// Dependency-free fixture service. It exercises the real API/job/image flow without downloading any models.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get('--port') || 29379);
const token = process.env.TITLE_EXTRACTOR_TOKEN || 'e2e-title-extractor-only-token';
const fingerprint = createHash('sha256').update('deterministic-source-mask-fixture-v6').digest('hex');
const crc = (bytes) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let n = 0; n < 8; n++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
const chunk = (name, bytes) => { const type = Buffer.from(name), data = Buffer.concat([type, bytes]), size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(bytes.length); check.writeUInt32BE(crc(data)); return Buffer.concat([size, data, check]); };
function png(width, height, rgba) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(rows, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function sourcePixels(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), channels = bytes[25] === 6 ? 4 : bytes[25] === 2 ? 3 : 0;
  if (bytes[24] !== 8 || !channels || bytes[28] !== 0) throw Error('unsupported fixture source');
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) { const length = bytes.readUInt32BE(offset); if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length)); offset += length + 12; }
  const raw = inflateSync(Buffer.concat(compressed)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a + b - c, aa = Math.abs(p - a), bb = Math.abs(p - b), cc = Math.abs(p - c); return aa <= bb && aa <= cc ? a : bb <= cc ? b : c; };
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    const filter = raw[y * (stride + 1)], value = raw[y * (stride + 1) + x + 1], left = x >= channels ? pixels[y * stride + x - channels] : 0;
    const up = y ? pixels[(y - 1) * stride + x] : 0, corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
    pixels[y * stride + x] = value + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, corner) : 0);
  }
  return { width, height, channels, pixels };
}
function cutout(source, region) {
  const decoded = sourcePixels(source), width = Math.min(200, decoded.width), height = Math.min(80, decoded.height);
  const left = Math.max(0, Math.min(decoded.width - width, Math.floor((region?.left ?? .05) * decoded.width) + 5));
  const top = Math.max(0, Math.min(decoded.height - height, Math.floor((region?.top ?? .05) * decoded.height) + 5));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = ((top + y) * decoded.width + left + x) * decoded.channels, to = (y * width + x) * 4;
    rgba[to] = decoded.pixels[from]; rgba[to + 1] = decoded.pixels[from + 1]; rgba[to + 2] = decoded.pixels[from + 2];
    const rx = x / width, ry = y / height;
    const hole = width >= 4 && height >= 4 && rx >= .4 && rx <= .5 && ry >= .375 && ry <= .625;
    rgba[to + 3] = rx >= .15 && rx <= .85 && ry >= .25 && ry <= .75 && !hole ? 255 : 0;
  }
  return { bytes: png(width, height, rgba), width, height, candidateRegion: { left: left / decoded.width, top: top / decoded.height, width: width / decoded.width, height: height / decoded.height } };
}
const log = [];
let mode = 'ok';
const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
const server = http.createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body = {};
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { return json(response, 400, { error: 'bad_json' }); }
  if (path === '/__log') return json(response, 200, log);
  if (path === '/__mode') {
    if (request.method === 'POST' && ['ok', 'slow', 'unavailable', 'empty'].includes(body.mode)) mode = body.mode;
    return json(response, 200, { mode });
  }
  if (request.headers.authorization !== 'Bearer ' + token) return json(response, 401, { error: 'unauthorized' });
  if (path === '/healthz') return json(response, 200, { ready: true, version: 1, model: 'fixture', ocrReady: false, modelFingerprint: fingerprint });
  if (path !== '/v1/extract' || request.method !== 'POST') return json(response, 404, { error: 'not_found' });
  const source = Buffer.from(body.imageBase64 || '', 'base64');
  if (source.length < 24 || source.toString('hex', 0, 8) !== '89504e470d0a1a0a') return json(response, 422, { error: 'no_text' });
  const thisMode = mode;
  const entry = { mode: thisMode, region: body.region ?? null, exclusions: body.exclusions ?? [], expectedTitles: body.expectedTitles ?? [],
    sourceWidth: source.readUInt32BE(16), sourceHeight: source.readUInt32BE(20) };
  log.push(entry);
  await new Promise((resolve) => setTimeout(resolve, thisMode === 'slow' ? 8000 : 700));
  if (response.destroyed) return;
  if (thisMode === 'unavailable') { entry.responseStatus = 503; return json(response, 503, { error: 'not_ready' }); }
  if (thisMode === 'empty' || entry.sourceWidth < 2 || entry.sourceHeight < 2) { entry.responseStatus = 422; return json(response, 422, { error: 'no_text' }); }
  const candidate = cutout(source, body.region);
  Object.assign(entry, { candidateWidth: candidate.width, candidateHeight: candidate.height, candidateRegion: candidate.candidateRegion, responseStatus: 200 });
  return json(response, 200, { version: 1, sourceSha256: createHash('sha256').update(source).digest('hex'),
    candidateBase64: candidate.bytes.toString('base64'), width: candidate.width, height: candidate.height, candidateRegion: candidate.candidateRegion,
    sourceWidth: source.readUInt32BE(16), sourceHeight: source.readUInt32BE(20),
    region: body.region || { left: .05, top: .05, width: .9, height: .35 }, ms: 1, modelFingerprint: fingerprint,
    evidence: { maskScore: .9, foregroundFraction: .25, edgeInkFraction: 0, maskRetainedFraction: 1, foregroundChangedFraction: 0 } });
});
server.listen(port, '0.0.0.0', () => console.log(`fake title extraction listening on ${port}`));
