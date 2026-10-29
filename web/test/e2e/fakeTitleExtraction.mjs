// Dependency-free fixture service. It exercises the real API/job/image flow without downloading any models.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get('--port') || 29379);
const token = process.env.TITLE_EXTRACTOR_TOKEN || 'e2e-title-extractor-only-token';
const candidate = readFileSync(new URL('../fixtures/title-logo.png', import.meta.url));
const fingerprint = createHash('sha256').update(candidate).digest('hex');
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
  log.push({ mode: thisMode, region: body.region ?? null, exclusions: body.exclusions ?? [], expectedTitles: body.expectedTitles ?? [] });
  await new Promise((resolve) => setTimeout(resolve, thisMode === 'slow' ? 8000 : 700));
  if (response.destroyed) return;
  if (thisMode === 'unavailable') return json(response, 503, { error: 'not_ready' });
  if (thisMode === 'empty') return json(response, 422, { error: 'no_text' });
  return json(response, 200, { version: 1, sourceSha256: createHash('sha256').update(source).digest('hex'),
    candidateBase64: candidate.toString('base64'), width: candidate.readUInt32BE(16), height: candidate.readUInt32BE(20),
    sourceWidth: source.readUInt32BE(16), sourceHeight: source.readUInt32BE(20),
    region: body.region || { left: .05, top: .05, width: .9, height: .35 }, ms: 1, modelFingerprint: fingerprint,
    evidence: { maskScore: .9, foregroundFraction: .25, edgeInkFraction: 0, maskRetainedFraction: 1, foregroundChangedFraction: 0 } });
});
server.listen(port, '0.0.0.0', () => console.log(`fake title extraction listening on ${port}`));
