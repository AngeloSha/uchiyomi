#!/usr/bin/env node
// Boot a translation engine pack the way Uchiyomi uses it, before it is published (translate-pack.yml). Run in
// node:24-alpine, the app image's base, on the pack's own architecture:
//
//   node scripts/translate-pack/check.mjs pack-out/translate-pack-linux-x64.tar.gz
//
// 1. It unpacks with tar, as the app does (lib/translate/engine.ts).
// 2. llama-server starts, loads a 1 MB test model (pinned by SHA-256) and writes a few tokens: the libraries resolve
//    beside the binary, and a CPU variant loads on this machine.
// 3. onnxruntime-web's Node build loads from ort/ with its WASM, and runs each OCR model once; each recogniser's output
//    has exactly one class per letter of its alphabet, plus blank and space (lib/translate/ocrCore.ts alphabet).
// 4. The fonts are fonts.
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_MODEL = {
  url: 'https://huggingface.co/ggml-org/models-moved/resolve/499bc8821c6b12b4e53c5bffcb21ec206f212d81/tinyllamas/stories260K.gguf',
  sha256: '270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d',
};

const tarball = process.argv[2];
if (!tarball) throw new Error('usage: check.mjs <translate-pack-*.tar.gz>');
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'translate-check-'));
const step = (m) => console.log(`-- ${m}`);
const fail = (m) => { console.error(`::error::${m}`); process.exit(1); };

step(`unpack ${tarball}`);
execFileSync('tar', ['-xzf', path.resolve(tarball), '-C', dir]);
for (const f of ['bin/llama-server', 'ort/ort.node.min.mjs', 'ort/node_modules/onnxruntime-common/package.json', 'ocr/det.onnx', 'ocr/rec.onnx',
  'ocr/rec.txt', 'ocr/rec-ko.onnx', 'ocr/rec-ko.txt', 'fonts/ComicNeue-Bold.ttf', 'fonts/NotoSans.ttf', 'fonts/NotoSansArabic.ttf',
  'fonts/NotoSansSC.ttf', 'NOTICE.md', 'pack.json']) {
  if (!fs.existsSync(path.join(dir, f))) fail(`the pack has no ${f}`);
}

step('llama-server writes a few tokens');
const model = path.join(dir, 'test.gguf');
const r = await fetch(TEST_MODEL.url, { redirect: 'follow' });
if (!r.ok) fail(`test model: HTTP ${r.status}`);
const bytes = Buffer.from(await r.arrayBuffer());
if (crypto.createHash('sha256').update(bytes).digest('hex') !== TEST_MODEL.sha256) fail('the test model does not match its pin');
await fsp.writeFile(model, bytes);
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
// The environment the app gives it: PATH and nothing else.
const server = spawn(path.join(dir, 'bin', 'llama-server'), ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', '256', '-t', '2', '--no-webui'],
  { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'inherit', 'inherit'] });
try {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (server.exitCode != null) fail(`llama-server exited (${server.exitCode})`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* loading */ }
    if (Date.now() > deadline) fail('llama-server did not come up in 120 s');
    await new Promise((res) => setTimeout(res, 500));
  }
  const c = await (await fetch(`${base}/completion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Once upon a time', n_predict: 8 }) })).json();
  if (typeof c.content !== 'string' || !c.content.length) fail(`no completion: ${JSON.stringify(c).slice(0, 200)}`);
  console.log(`   wrote: ${JSON.stringify(c.content)}`);
} finally {
  server.kill();
}

step('the OCR models run under onnxruntime-web');
const ort = await import(pathToFileURL(path.join(dir, 'ort', 'ort.node.min.mjs')).href);
ort.env.wasm.numThreads = 2;
ort.env.logLevel = 'error';
const session = (f) => ort.InferenceSession.create(fs.readFileSync(path.join(dir, 'ocr', f)), { logSeverityLevel: 3 });
const det = await session('det.onnx');
const d = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * 64 * 64), [1, 3, 64, 64]) });
const dOut = d[det.outputNames[0]];
if (dOut.dims.join('x') !== '1x1x64x64') fail(`detection output ${dOut.dims.join('x')}`);
for (const [model, alphabet] of [['rec.onnx', 'rec.txt'], ['rec-ko.onnx', 'rec-ko.txt']]) {
  const rec = await session(model);
  const o = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * 48 * 320), [1, 3, 48, 320]) });
  const dims = o[rec.outputNames[0]].dims;
  const letters = fs.readFileSync(path.join(dir, 'ocr', alphabet), 'utf8').split('\n').length - 1;
  // Reintroduce a mismatched alphabet (the v5 dictionary beside the v6 model): every letter is read as its neighbour.
  if (dims[2] !== letters + 2) fail(`${model}: ${dims[2]} classes for an alphabet of ${letters} (+ blank and space)`);
  console.log(`   ${model}: ${dims.join('x')}, ${letters} letters`);
}

step('the fonts are fonts');
for (const f of fs.readdirSync(path.join(dir, 'fonts'))) {
  const magic = fs.readFileSync(path.join(dir, 'fonts', f)).subarray(0, 4).toString('hex');
  if (magic !== '00010000' && magic !== '4f54544f') fail(`fonts/${f} is not a TrueType/OpenType font (${magic})`);
}

await fsp.rm(dir, { recursive: true, force: true });
console.log('-- the pack boots');
process.exit(0);
