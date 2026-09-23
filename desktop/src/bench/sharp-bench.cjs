'use strict';
/**
 * sharp throughput under whatever runtime runs this file: plain Node, Electron as Node, or an Electron
 * utilityProcess (`Uchiyomi --bench`).
 *
 * Why it exists (spike S1): Electron's V8 runs with the memory cage on, which forbids ArrayBuffers that point
 * outside V8's heap, so sharp COPIES every buffer it hands back instead of wrapping libvips' memory
 * (electronjs.org/blog/v8-memory-cage, lovell/sharp#3384). The page-hash backfill decodes every page of every
 * chapter, which is the heaviest thing the bff does; if the copy costs too much, the bff should run on a
 * bundled Node instead.
 *
 * Workloads, all on the SAME generated pages:
 *   pageHash  the bff's own function (bff/dist/lib/pageHash.js), 2 workers like pageHashJob.ts CONCURRENCY
 *   cover     a cover-sized webp re-encode (routes/images.ts:268 shape), 4 in flight
 *   rawDecode full-size raw RGB out (2.9 MB per page) -- the worst case for a copy-on-return
 *
 *   node sharp-bench.cjs --bff <resources/bff> --out result.json [--label x] [--images 200] [--rounds 3]
 */
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const BFF = path.resolve(opt('bff', path.join(__dirname, '..', '..', 'resources', 'bff')));
const OUT = opt('out', '');
const LABEL = opt('label', process.versions.electron ? (process.env.ELECTRON_RUN_AS_NODE ? 'electron-as-node' : 'electron') : 'node');
const N = Number(opt('images', 200));
const ROUNDS = Number(opt('rounds', 3));

const sharp = require(path.join(BFF, 'node_modules', 'sharp'));
const { pageHash } = require(path.join(BFF, 'dist', 'lib', 'pageHash.js'));

/** A page-shaped image: gradient + blocks (the seed.py/pageHash.test.ts generator) + grain, so it compresses like a scan. */
function pageRaw(w, h, seed) {
  const buf = Buffer.allocUnsafe(w * h * 3);
  let r = (seed * 2654435761) >>> 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 40 + ((x / w) * 120) + ((y / h) * 60);
      const bx = Math.floor((x / w) * 7);
      const by = Math.floor((y / h) * 11);
      if ((bx * 5 + by * 3 + seed * 13) % 6 === 0) v = 235;
      else if ((bx * 3 + by * 7 + seed * 5) % 8 === 0) v = 20;
      r = (r * 1103515245 + 12345) >>> 0;
      v += ((r >>> 24) & 31) - 16;
      const o = (y * w + x) * 3;
      buf[o] = v; buf[o + 1] = v * 0.97; buf[o + 2] = v * 0.93;
    }
  }
  return buf;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      await fn(items[k]);
    }
  }));
}

async function timed(pages, n, fn) {
  const t0 = process.hrtime.bigint();
  await pool(pages, n, fn);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms: Math.round(ms), perSec: +(pages.length / (ms / 1000)).toFixed(2) };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

(async () => {
  const W = 800;
  const H = 1200;
  const g0 = Date.now();
  const pages = [];
  for (let i = 0; i < N; i++) {
    pages.push(await sharp(pageRaw(W, H, i + 1), { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 82 }).toBuffer());
  }
  const genMs = Date.now() - g0;
  const bytes = pages.reduce((a, b) => a + b.length, 0);

  // Warm-up (first calls load libvips operations and fill caches), not measured.
  await pool(pages.slice(0, 10), 2, async (p) => { await pageHash(p); });

  const results = { pageHash: [], cover: [], rawDecode: [] };
  let hashed = 0;
  let nulls = 0;
  for (let r = 0; r < ROUNDS; r++) {
    results.pageHash.push(await timed(pages, 2, async (p) => { const h = await pageHash(p); if (h) hashed++; else nulls++; }));
    results.cover.push(await timed(pages, 4, async (p) => {
      await sharp(p).resize(600, 900, { fit: 'cover', position: 'attention' }).modulate({ brightness: 0.95 }).webp({ quality: 82 }).toBuffer();
    }));
    results.rawDecode.push(await timed(pages, 4, async (p) => { await sharp(p).raw().toBuffer(); }));
  }
  const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { rounds: v, medianPerSec: median(v.map((x) => x.perSec)) }]));
  const out = {
    label: LABEL,
    runtime: { node: process.versions.node, electron: process.versions.electron || null, v8: process.versions.v8, runAsNode: !!process.env.ELECTRON_RUN_AS_NODE, utilityProcess: !!process.parentPort, platform: process.platform, arch: process.arch },
    sharp: { versions: sharp.versions, concurrency: sharp.concurrency(), simd: sharp.simd() },
    images: N, imageSize: `${W}x${H} jpeg`, avgImageBytes: Math.round(bytes / N), generateMs: genMs,
    hashed: hashed / ROUNDS, nullHashes: nulls / ROUNDS,
    results: summary,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
  const line = JSON.stringify(out);
  console.log(`BENCH ${LABEL} pageHash=${summary.pageHash.medianPerSec}/s cover=${summary.cover.medianPerSec}/s rawDecode=${summary.rawDecode.medianPerSec}/s`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  else console.log(line);
  if (process.parentPort) process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
