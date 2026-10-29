#!/usr/bin/env node
// The pinned OCR portion of the translation pack, without a translation model or server.
import { FILES, NPM, ALPHABETS, onnxAlphabet, ymlAlphabet } from '../translate-pack/pack.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, cp, readdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hash = (bytes, algo = 'sha256', encoding = 'hex') => createHash(algo).update(bytes).digest(encoding);
async function download(url, expected, algorithm = 'sha256') {
  const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok || !r.body) throw Error(`OCR download returned ${r.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > 256 * 1024 * 1024) { await r.body.cancel?.().catch(() => {}); throw Error('OCR download exceeds its byte limit'); }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const actual = algorithm === 'sha512' ? 'sha512-' + hash(bytes, algorithm, 'base64') : hash(bytes);
  if (actual !== expected) throw Error('OCR download checksum mismatch: ' + url);
  return bytes;
}
export async function prepareOcr(destination) {
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(path.join(tmpdir(), 'uchiyomi-title-ocr-'));
  try {
    const bytes = new Map();
    for (const name of ['det.onnx', 'rec.onnx', 'rec-ko.onnx', 'rec-ko.yml', 'LICENSE-PaddleOCR', 'LICENSE-onnxruntime']) {
      const file = FILES[name]; bytes.set(name, await download(file.url, file.sha256));
    }
    for (const part of ['ocr', 'ort', 'licenses']) await mkdir(path.join(stage, part), { recursive: true });
    for (const name of ['det.onnx', 'rec.onnx', 'rec-ko.onnx']) await writeFile(path.join(stage, 'ocr', name), bytes.get(name));
    const alphabets = { 'rec.txt': onnxAlphabet(bytes.get('rec.onnx')), 'rec-ko.txt': ymlAlphabet(bytes.get('rec-ko.yml').toString('utf8')) };
    for (const [name, text] of Object.entries(alphabets)) {
      if (hash(text) !== ALPHABETS[name]) throw Error('OCR alphabet checksum mismatch');
      await writeFile(path.join(stage, 'ocr', name), text);
    }
    for (const name of ['LICENSE-PaddleOCR', 'LICENSE-onnxruntime']) await writeFile(path.join(stage, 'licenses', name), bytes.get(name));
    for (const name of ['onnxruntime-web', 'onnxruntime-common']) {
      const pin = NPM[name];
      const archive = path.join(stage, name + '.tgz');
      await writeFile(archive, await download(`https://registry.npmjs.org/${name}/-/${name}-${pin.version}.tgz`, pin.integrity, 'sha512'));
      const unpacked = path.join(stage, name); await mkdir(unpacked);
      execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', unpacked]);
      if (name === 'onnxruntime-web') for (const file of ['ort.node.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
        await copyFile(path.join(unpacked, 'dist', file), path.join(stage, 'ort', file));
      } else await cp(unpacked, path.join(stage, 'ort', 'node_modules', name), { recursive: true });
      await rm(archive); await rm(unpacked, { recursive: true });
    }
    const files = {};
    async function walk(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const rel = prefix + entry.name, file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file, rel + '/');
        else if (entry.isFile()) files[rel] = hash(await readFile(file));
      }
    }
    await walk(stage);
    const fingerprint = hash(JSON.stringify(Object.fromEntries(Object.entries(files).sort())));
    await writeFile(path.join(stage, 'title-ocr.json'), JSON.stringify({ version: 1, fingerprint, files, runtimeVersion: NPM['onnxruntime-web'].version }, null, 2) + '\n');
    for (const name of await readdir(stage)) await cp(path.join(stage, name), path.join(destination, name), { recursive: true });
    return { destination, fingerprint, files: Object.keys(files).length };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.argv[2]) throw Error('Usage: prepare-ocr.mjs /absolute/output/directory');
  console.log(JSON.stringify(await prepareOcr(path.resolve(process.argv[2]))));
}
