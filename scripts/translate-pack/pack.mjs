#!/usr/bin/env node
// The translation engine pack for one platform (Admin -> Settings -> Translate pages -> Download): llama-server (built by
// build-llama.sh), onnxruntime-web's Node build, PaddleOCR's models, the fonts and their licences, as
//
//   bin/       llama-server and its libraries        ort/    ort.node.min.mjs + its WASM + node_modules/onnxruntime-common
//   ocr/       det.onnx rec.onnx rec.txt rec-ko.onnx rec-ko.txt                   fonts/  the four fonts render.ts draws with
//   licenses/  every licence the pieces come under    NOTICE.md, pack.json
//
// which bff/src/lib/translate/ reads from <TRANSLATE_DIR>/pack. Every download below is pinned by SHA-256 (npm packages
// by their registry integrity) and checked before it is used; a mismatch stops the build.
//
//   node scripts/translate-pack/pack.mjs --platform linux-x64|linux-arm64 --llama <build-llama.sh's out> --out <dir>
//     [--cache <dir>] [--tag translate-v1]
//
// Writes translate-pack-<platform>.tar.gz, its .sha256 and a .json with the sizes. check.mjs boots what it wrote.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MS = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx';
const GF = 'https://raw.githubusercontent.com/google/fonts/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl';
const HF_KO = 'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/5c6f574b8e2230adf4287b33e736d71b9fabd28e';

/** Everything fetched, by the name it is cached under. */
export const FILES = {
  // PaddleOCR PP-OCRv6 small, as RapidOCR 3.10 converts and publishes it (the recogniser carries its alphabet).
  'det.onnx': { url: `${MS}/PP-OCRv6/det/PP-OCRv6_det_small.onnx`, sha256: '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f' },
  'rec.onnx': { url: `${MS}/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`, sha256: '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884' },
  // Korean: PP-OCRv6 has no Korean recogniser; PaddlePaddle's own PP-OCRv5 mobile one, its alphabet in inference.yml.
  'rec-ko.onnx': { url: `${HF_KO}/inference.onnx`, sha256: '92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08' },
  'rec-ko.yml': { url: `${HF_KO}/inference.yml`, sha256: 'f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998' },
  'ComicNeue-Bold.ttf': { url: `${GF}/comicneue/ComicNeue-Bold.ttf`, sha256: '3e7e5fccfd7e0788f317b43312151c1bd5cf058c9697a8d83eac3939050bd61e' },
  'NotoSans.ttf': { url: `${GF}/notosans/NotoSans%5Bwdth,wght%5D.ttf`, sha256: 'bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d' },
  'NotoSansArabic.ttf': { url: `${GF}/notosansarabic/NotoSansArabic%5Bwdth,wght%5D.ttf`, sha256: '63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e' },
  'NotoSansSC.ttf': { url: `${GF}/notosanssc/NotoSansSC%5Bwght%5D.ttf`, sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da' },
  'OFL-ComicNeue.txt': { url: `${GF}/comicneue/OFL.txt`, sha256: '7c38a22e5878e60fe423360553e63dd7be23d29f1f60336034935dbfc96e8320' },
  'OFL-NotoSans.txt': { url: `${GF}/notosans/OFL.txt`, sha256: 'cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a' },
  'OFL-NotoSansArabic.txt': { url: `${GF}/notosansarabic/OFL.txt`, sha256: '07fc70bfeb985cc1a87a8587d0a0c80bab11c86c9dc3fd95b6f0cb332f983e96' },
  'OFL-NotoSansSC.txt': { url: `${GF}/notosanssc/OFL.txt`, sha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9' },
  'LICENSE-PaddleOCR': { url: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/LICENSE', sha256: '3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e' },
  'LICENSE-onnxruntime': { url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7/LICENSE', sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c' },
};

/** npm packages, checked against their registry integrity (sha512). */
export const NPM = {
  'onnxruntime-web': { version: '1.30.0', integrity: 'sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ==' },
  'onnxruntime-common': { version: '1.30.0', integrity: 'sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==' },
};

/** The two alphabets, as the OCR worker reads them: one character per line, a newline at the end. */
export const ALPHABETS = {
  'rec.txt': 'b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d',
  'rec-ko.txt': 'a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7',
};

const sha = (algo, b, enc = 'hex') => crypto.createHash(algo).update(b).digest(enc);

async function fetchTo(url, dest) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(`${dest}.part`));
      await fsp.rename(`${dest}.part`, dest);
      return;
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, attempt * 5000));
    }
  }
}

/** A pinned file, from the cache when it is there and still matches. */
async function pinned(name, cache) {
  const f = FILES[name];
  const dest = path.join(cache, name);
  if (!fs.existsSync(dest) || sha('sha256', await fsp.readFile(dest)) !== f.sha256) {
    await fetchTo(f.url, dest);
    const got = sha('sha256', await fsp.readFile(dest));
    if (got !== f.sha256) throw new Error(`${name}: sha256 ${got}, pinned ${f.sha256} (${f.url})`);
  }
  return dest;
}

async function npmPackage(name, cache) {
  const p = NPM[name];
  const dest = path.join(cache, `${name}-${p.version}.tgz`);
  const ok = () => fs.existsSync(dest) && `sha512-${sha('sha512', fs.readFileSync(dest), 'base64')}` === p.integrity;
  if (!ok()) {
    await fetchTo(`https://registry.npmjs.org/${name}/-/${name}-${p.version}.tgz`, dest);
    if (!ok()) throw new Error(`${name}@${p.version}: the tarball does not match its registry integrity`);
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  execFileSync('tar', ['-xzf', dest, '-C', dir]);
  return path.join(dir, 'package');
}

/** The recogniser's alphabet from its ONNX metadata ("character"): a protobuf walk of ModelProto.metadata_props (14). */
export function onnxAlphabet(buf) {
  const varint = (o) => { let v = 0, s = 1, x; do { x = buf[o++]; v += (x & 0x7f) * s; s *= 128; } while (x & 0x80); return [v, o]; };
  const fields = (from, to) => {
    const out = [];
    for (let o = from; o < to;) {
      let key; [key, o] = varint(o);
      const f = Math.floor(key / 8), wt = key & 7;
      if (wt === 0) { [, o] = varint(o); } else if (wt === 1) o += 8; else if (wt === 5) o += 4;
      else if (wt === 2) { let n; [n, o] = varint(o); out.push({ f, s: o, e: o + n }); o += n; } else throw new Error(`protobuf wire type ${wt}`);
    }
    return out;
  };
  for (const prop of fields(0, buf.length).filter((x) => x.f === 14)) {
    const kv = Object.fromEntries(fields(prop.s, prop.e).map((x) => [x.f, buf.subarray(x.s, x.e).toString('utf8')]));
    if (kv[1] === 'character') return `${kv[2]}\n`;
  }
  throw new Error('the recogniser carries no "character" metadata');
}

/** The alphabet in PaddleOCR's inference.yml: PostProcess.character_dict, a block list of plain or single-quoted entries. */
export function ymlAlphabet(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*character_dict:\s*$/.test(l));
  if (at < 0) throw new Error('no character_dict in the yml');
  const out = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^\s*- (.*)$/.exec(l);
    if (!m) { if (l.trim()) break; continue; }
    let v = m[1];
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    else if (v.startsWith('"')) throw new Error(`a double-quoted entry this reader does not decode: ${v}`);
    out.push(v);
  }
  return `${out.join('\n')}\n`;
}

async function copyInto(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
}

export async function pack({ platform, llama, out, cache, tag }) {
  if (!['linux-x64', 'linux-arm64'].includes(platform)) throw new Error(`unknown platform ${platform}`);
  await fsp.mkdir(cache, { recursive: true });
  await fsp.mkdir(out, { recursive: true });
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'translate-pack-'));

  // bin/: llama-server and its libraries, symlinks kept; its licence goes with the others.
  await fsp.mkdir(path.join(stage, 'bin'));
  for (const e of await fsp.readdir(llama)) {
    if (e === 'LICENSE-llama.cpp' || e === 'BUILD') continue;
    await fsp.cp(path.join(llama, e), path.join(stage, 'bin', e), { verbatimSymlinks: true });
  }
  if (!fs.existsSync(path.join(stage, 'bin', 'llama-server'))) throw new Error(`no llama-server in ${llama}`);
  await copyInto(path.join(llama, 'LICENSE-llama.cpp'), path.join(stage, 'licenses', 'LICENSE-llama.cpp'));
  const built = (await fsp.readFile(path.join(llama, 'BUILD'), 'utf8')).trim();

  // ort/: the Node build of onnxruntime-web, its WASM beside it, and the one package it imports.
  const web = await npmPackage('onnxruntime-web', cache);
  for (const f of ['ort.node.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    await copyInto(path.join(web, 'dist', f), path.join(stage, 'ort', f));
  }
  const common = await npmPackage('onnxruntime-common', cache);
  await fsp.cp(common, path.join(stage, 'ort', 'node_modules', 'onnxruntime-common'), { recursive: true });

  // ocr/: the models, and their alphabets checked against the ones the pipeline was measured with.
  for (const f of ['det.onnx', 'rec.onnx', 'rec-ko.onnx']) await copyInto(await pinned(f, cache), path.join(stage, 'ocr', f));
  const alpha = {
    'rec.txt': onnxAlphabet(await fsp.readFile(await pinned('rec.onnx', cache))),
    'rec-ko.txt': ymlAlphabet(await fsp.readFile(await pinned('rec-ko.yml', cache), 'utf8')),
  };
  for (const [f, text] of Object.entries(alpha)) {
    if (sha('sha256', text) !== ALPHABETS[f]) throw new Error(`${f}: the alphabet read from the model is not the pinned one`);
    await fsp.writeFile(path.join(stage, 'ocr', f), text);
  }

  // fonts/ and licenses/.
  for (const f of ['ComicNeue-Bold.ttf', 'NotoSans.ttf', 'NotoSansArabic.ttf', 'NotoSansSC.ttf']) await copyInto(await pinned(f, cache), path.join(stage, 'fonts', f));
  for (const f of ['OFL-ComicNeue.txt', 'OFL-NotoSans.txt', 'OFL-NotoSansArabic.txt', 'OFL-NotoSansSC.txt', 'LICENSE-PaddleOCR', 'LICENSE-onnxruntime']) {
    await copyInto(await pinned(f, cache), path.join(stage, 'licenses', f));
  }
  await fsp.writeFile(path.join(stage, 'NOTICE.md'), [
    `# Uchiyomi translation engine pack (${tag}, ${platform})`,
    '',
    'Downloaded by Uchiyomi (Admin -> Settings -> Translate pages) and checked against the SHA-256 the app pins. Not meant',
    'to be used by hand. Built by .github/workflows/translate-pack.yml (scripts/translate-pack/). What is inside:',
    '',
    `- bin/: llama-server from llama.cpp (MIT, licenses/LICENSE-llama.cpp), ${built}.`,
    `- ort/: onnxruntime-web ${NPM['onnxruntime-web'].version} and onnxruntime-common ${NPM['onnxruntime-common'].version} (MIT, licenses/LICENSE-onnxruntime).`,
    '- ocr/: PaddleOCR PP-OCRv6 small detection and recognition as converted by RapidOCR 3.10, and PaddleOCR PP-OCRv5',
    '  mobile Korean recognition (Apache-2.0, licenses/LICENSE-PaddleOCR); rec.txt and rec-ko.txt are their alphabets.',
    '- fonts/: Comic Neue Bold, Noto Sans, Noto Sans Arabic and Noto Sans SC from google/fonts (SIL Open Font License 1.1,',
    '  licenses/OFL-*.txt).',
    '',
  ].join('\n'));
  await fsp.writeFile(path.join(stage, 'pack.json'), `${JSON.stringify({ tag, platform, llama: built, at: new Date().toISOString() }, null, 2)}\n`);

  const name = `translate-pack-${platform}.tar.gz`;
  const file = path.join(out, name);
  // The staging folder is mkdtemp's 0700, and the tarball's "." would hand that to the folder it is unpacked into.
  await fsp.chmod(stage, 0o755);
  execFileSync('tar', ['-czf', file, '-C', stage, '.']);
  const bytes = (await fsp.stat(file)).size;
  const digest = sha('sha256', await fsp.readFile(file));
  await fsp.writeFile(`${file}.sha256`, `${digest}  ${name}\n`);
  const listing = execFileSync('du', ['-sk', 'bin', 'ort', 'ocr', 'fonts'], { cwd: stage, encoding: 'utf8' });
  await fsp.writeFile(path.join(out, `translate-pack-${platform}.json`), `${JSON.stringify({ tag, platform, file: name, bytes, sha256: digest, llama: built, parts: listing.trim().split('\n') }, null, 2)}\n`);
  await fsp.rm(stage, { recursive: true, force: true });
  console.log(`${name}: ${bytes} bytes, sha256 ${digest}`);
  return { file, bytes, sha256: digest };
}

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
if (import.meta.url === `file://${process.argv[1]}`) {
  await pack({
    platform: arg('platform'),
    llama: path.resolve(arg('llama', 'llama-out')),
    out: path.resolve(arg('out', 'pack-out')),
    cache: path.resolve(arg('cache', path.join(os.tmpdir(), 'translate-pack-cache'))),
    tag: arg('tag', 'translate-v1'),
  });
}
