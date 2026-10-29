/**
 * The OCR worker: a child process (forked by ocr.ts) that holds PaddleOCR's models in onnxruntime-web and reads the text
 * of one page at a time. A child, not the server: a page is a second or two of CPU on every thread it is given, and the
 * server's event loop must not stall for it.
 *
 * onnxruntime-web is not a dependency of the app. It comes in the translation engine's download, with the models,
 * and is imported from there (`<dir>/ort/ort.node.min.mjs`, its Node build: it reads its .wasm from disk): installs that never press Download carry none of it.
 *
 * Messages (advanced serialization, so page bytes travel as a Buffer):
 *   in:  { type: 'init', dir, threads }   then   { type: 'ocr', id, bytes, lang }
 *   out: { type: 'ready' } | { type: 'result', id, lines, width, height, ms } | { type: 'error', id?, message }
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {
  alphabet, bgrPlanes, ctcDecode, dbBoxes, detSize, isTall, OCR_MAX_SIDE, REC_BATCH, REC_HEIGHT, recBatch, recWidth,
  type Box, type OcrLine,
} from './ocrCore';

/** A tall strip is read in tiles this high, overlapping by OVERLAP, instead of being shrunk until its text is unreadable. */
const TILE = OCR_MAX_SIDE;
const OVERLAP = 240;
const STRIP = 2.2;
/** Lines below this recognition score are noise (stray strokes, screentone) more often than text. */
const MIN_SCORE = 0.5;

// onnxruntime-web is loaded at run time from the download, so it has no static type here.
type Session = { inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>> };
let ort: { Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown; InferenceSession: { create(model: Uint8Array, opts: object): Promise<Session> }; env: { wasm: { numThreads: number }; logLevel: string } };
let det: Session;
let modelDir = '';
const recs = new Map<'main' | 'ko', { s: Session; chars: string[] }>();

async function init(dir: string, threads: number) {
  modelDir = dir;
  ort = await import(pathToFileURL(path.join(dir, 'ort', 'ort.node.min.mjs')).href);
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';
  det = await load('det.onnx');
  await rec('main');
}
const load = (file: string) => ort.InferenceSession.create(fs.readFileSync(path.join(modelDir, 'ocr', file)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
/** Korean has its own recogniser (PP-OCRv6 small has none); loaded the first time a Korean page comes. */
async function rec(kind: 'main' | 'ko') {
  let r = recs.get(kind);
  if (!r) {
    const base = kind === 'ko' ? 'rec-ko' : 'rec';
    r = { s: await load(`${base}.onnx`), chars: alphabet(fs.readFileSync(path.join(modelDir, 'ocr', `${base}.txt`), 'utf8')) };
    recs.set(kind, r);
  }
  return r;
}

const raw3 = (width: number, height: number) => ({ raw: { width, height, channels: 3 as const } });

/** Text lines of one tile (an RGB buffer) in the tile's own coordinates. */
async function readTile(rgb: Buffer, W: number, H: number, kind: 'main' | 'ko'): Promise<OcrLine[]> {
  const { w, h } = detSize(W, H);
  const px = await sharp(rgb, raw3(W, H)).resize(w, h, { fit: 'fill' }).raw().toBuffer();
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', bgrPlanes(px, w, h), [1, 3, h, w]) });
  const boxes = dbBoxes(out[det.outputNames[0]].data, w, h, W, H);
  const crops: { b: Box; buf: Uint8Array; w: number; tall: boolean }[] = [];
  for (const b of boxes) {
    const tall = isTall(b);
    const cw = b.x1 - b.x0, chh = b.y1 - b.y0;
    // ⚠️ Two steps: sharp applies a rotation before an extract made in the same pipeline, so a tall crop must be cut
    // out first and turned afterwards ("bad extract area" otherwise).
    const cut = await sharp(rgb, raw3(W, H)).extract({ left: b.x0, top: b.y0, width: cw, height: chh }).raw().toBuffer();
    const rw = tall ? recWidth(chh, cw) : recWidth(cw, chh);
    const buf = await sharp(cut, raw3(cw, chh)).rotate(tall ? -90 : 0).resize(rw, REC_HEIGHT, { fit: 'fill' }).raw().toBuffer();
    crops.push({ b, buf, w: rw, tall });
  }
  const r = await rec(kind);
  const order = crops.map((_, i) => i).sort((a, b) => crops[a].w - crops[b].w);
  const lines: OcrLine[] = [];
  for (let s = 0; s < order.length; s += REC_BATCH) {
    const batch = order.slice(s, s + REC_BATCH).map((i) => crops[i]);
    const { data, width } = recBatch(batch);
    const o = await r.s.run({ [r.s.inputNames[0]]: new ort.Tensor('float32', data, [batch.length, 3, REC_HEIGHT, width]) });
    const t = o[r.s.outputNames[0]];
    const [, T, C] = t.dims;
    ctcDecode(t.data, batch.length, T, C, r.chars).forEach((res, k) => {
      const c = batch[k];
      if (res.text.trim() && res.score >= MIN_SCORE) lines.push({ box: [c.b.x0, c.b.y0, c.b.x1, c.b.y1], text: res.text, score: res.score, tall: c.tall,
        ...(c.b.contentBox ? { contentBox: c.b.contentBox } : {}) });
    });
  }
  return lines;
}

const iou = (a: OcrLine['box'], b: OcrLine['box']) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy, area = (r: OcrLine['box']) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / Math.max(1, Math.min(area(a), area(b)));
};

/** Every text line of a page, in the page's own pixel coordinates. */
export async function readPage(bytes: Buffer, lang: string): Promise<{ lines: OcrLine[]; width: number; height: number }> {
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0, height = meta.height ?? 0;
  if (!width || !height) return { lines: [], width, height };
  // A page is scaled to OCR_MAX_SIDE on its long side, as RapidOCR does. A webtoon strip (more than STRIP times taller
  // than wide) keeps its width instead and is read in tiles: shrunk to 2,000 px tall, its text would be a few pixels high.
  const strip = height / width > STRIP;
  const scale = strip ? Math.min(1, OCR_MAX_SIDE / width) : Math.min(1, OCR_MAX_SIDE / Math.max(width, height));
  const W = Math.max(1, Math.round(width * scale)), H = Math.max(1, Math.round(height * scale));
  const rgb = await sharp(bytes).removeAlpha().toColourspace('srgb').resize(W, H, { fit: 'fill' }).raw().toBuffer();
  const kind = lang === 'ko' ? 'ko' : 'main';
  const all: OcrLine[] = [];
  for (let top = 0; ; top += TILE - OVERLAP) {
    const th = Math.min(TILE, H - top);
    const tile = th === H ? rgb : rgb.subarray(top * W * 3, (top + th) * W * 3);
    for (const l of await readTile(Buffer.from(tile), W, th, kind)) {
      const box: OcrLine['box'] = [l.box[0], l.box[1] + top, l.box[2], l.box[3] + top];
      const contentBox: OcrLine['contentBox'] = l.contentBox ? [l.contentBox[0], l.contentBox[1] + top, l.contentBox[2], l.contentBox[3] + top] : undefined;
      const dup = all.findIndex((o) => iou(o.box, box) > 0.5);
      if (dup === -1) all.push({ ...l, box, ...(contentBox ? { contentBox } : {}) });
      else if (l.score > all[dup].score) all[dup] = { ...l, box, ...(contentBox ? { contentBox } : {}) };
    }
    if (top + th >= H) break;
  }
  const inv = 1 / scale;
  return {
    width, height,
    lines: all.map((l) => ({ ...l, box: l.box.map((v) => Math.round(v * inv)) as OcrLine['box'],
      ...(l.contentBox ? { contentBox: l.contentBox.map((v) => Math.round(v * inv)) as OcrLine['box'] } : {}) })),
  };
}

// Only when forked as the worker (ocr.ts sets the flag): importing this file in a test must not start listening.
if (process.env.UCHIYOMI_OCR_WORKER === '1') {
  // The server went away (a crash, a restart): the WASM threads would otherwise keep this process alive on its own.
  process.on('disconnect', () => process.exit(0));
  process.on('message', (msg: { type: string; id?: number; dir?: string; threads?: number; bytes?: Buffer; lang?: string }) => {
    void (async () => {
      try {
        if (msg.type === 'init') {
          await init(msg.dir!, msg.threads ?? 2);
          process.send?.({ type: 'ready' });
        } else if (msg.type === 'ocr') {
          const t0 = performance.now();
          const r = await readPage(Buffer.from(msg.bytes!), msg.lang ?? '');
          process.send?.({ type: 'result', id: msg.id, ...r, ms: Math.round(performance.now() - t0) });
        }
      } catch (e) {
        process.send?.({ type: 'error', id: msg.id, message: (e as Error).message });
      }
    })();
  });
}
