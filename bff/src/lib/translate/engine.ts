import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { OcrWorker } from './ocr';
import { TranslationModel } from './llm';
import { MODELS, PACK_TAG, PACKS, platformKey, type EngineSize, type PinnedFile } from './pin';
import { isDesktop } from '../desktop';

/**
 * The translation engine: an optional download (Admin -> Settings -> Translate pages), never part of the image. Until
 * an admin presses Download nothing here runs, nothing is fetched and no file is written.
 *
 * On disk, in TRANSLATE_DIR (default <CONFIG_DIR>/translate):
 *   pack/            llama-server, onnxruntime-web, the OCR models, the fonts (the platform's pack, unpacked)
 *   models/<size>/   the translation model (model.gguf, and mmproj.gguf for the large one)
 *   installed.json   written last, after every file matched its SHA-256: no file is used before it exists
 */

const GiB = 1024 ** 3;
/** The model and the OCR worker are stopped after this long without a page, giving their memory back. */
const IDLE_MS = 10 * 60_000;

export const translateDir = () => process.env.TRANSLATE_DIR || path.join(process.env.CONFIG_DIR || '/config', 'translate');
/** An existing llama.cpp-compatible server to translate with (a machine with a GPU, say): no model is downloaded then. */
const externalUrl = () => process.env.TRANSLATE_ENGINE_URL?.trim() || '';

interface Installed { tag: string; platform: string; size: EngineSize | null; at: string }

export interface EngineStatus {
  state: 'unsupported' | 'missing' | 'downloading' | 'ready' | 'failed';
  /** The size installed (or being fetched), and the one Download would choose on this machine. */
  size: EngineSize | null;
  pick: EngineSize;
  done: number;
  total: number;
  /** Bytes still to fetch for `pick`, and bytes free where they would go. */
  need: number;
  free: number;
  memGiB: number;
  /** Memory the engine takes while it runs, with `pick`'s model (bytes; 0 through TRANSLATE_ENGINE_URL). */
  ram: number;
  running: boolean;
  external: boolean;
  error?: string;
}

let job: { size: EngineSize | null; done: number; total: number; abort: AbortController; promise: Promise<void> } | null = null;
let lastError: string | undefined;

const memGiB = () => os.totalmem() / GiB;
/** The size for this machine: the large model where there is room for it, the small one elsewhere (or TRANSLATE_MODEL). */
export const pickSize = (): EngineSize => {
  const forced = process.env.TRANSLATE_MODEL;
  if (forced === 'large' || forced === 'small') return forced;
  return memGiB() >= MODELS.large.memGiB ? 'large' : 'small';
};

async function readInstalled(): Promise<Installed | null> {
  if (!supported()) return null;
  try {
    const j = JSON.parse(await fsp.readFile(path.join(translateDir(), 'installed.json'), 'utf8')) as Installed;
    return j.tag === PACK_TAG && j.platform === platformKey() ? j : null;
  } catch { return null; }
}

const filesFor = (size: EngineSize | null): (PinnedFile & { dest: string })[] => [
  { ...PACKS[platformKey()], dest: 'pack.tar.gz' },
  ...(size ? MODELS[size].files.map((f) => ({ ...f, dest: path.join('models', size, f.name) })) : []),
];

/** Free bytes where `dir` is, or would be: the nearest folder that exists (nothing is made just to ask). */
async function freeBytes(dir: string): Promise<number> {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try { const s = await fsp.statfs(d); return s.bavail * s.bsize; } catch { /* not there yet: its parent */ }
    if (d === path.dirname(d)) return 0;
  }
}

/** Docker installs only for now: the desktop app's server runs inside Electron, which the engine's processes do not. */
const supported = () => !isDesktop() && !!PACKS[platformKey()];

export async function engineStatus(): Promise<EngineStatus> {
  const pick = pickSize();
  const ram = externalUrl() ? 0 : MODELS[pick].files.reduce((s, f) => s + f.bytes, 0) + GiB;
  const base = { pick, memGiB: Math.round(memGiB()), ram, external: !!externalUrl(), running: !!procs && (procs.model.running || procs.ocr.running) };
  if (!supported()) return { ...base, state: 'unsupported', size: null, done: 0, total: 0, need: 0, free: 0 };
  const free = await freeBytes(translateDir());
  const need = filesFor(externalUrl() ? null : pick).reduce((s, f) => s + f.bytes, 0);
  if (job) return { ...base, state: 'downloading', size: job.size, done: job.done, total: job.total, need, free };
  const inst = await readInstalled();
  if (inst) return { ...base, state: 'ready', size: inst.size, done: 0, total: 0, need, free };
  return { ...base, state: lastError ? 'failed' : 'missing', size: null, done: 0, total: 0, need, free, error: lastError };
}

export const engineInstalled = async () => !!(await readInstalled());
/** The installed model size (null: translating through TRANSLATE_ENGINE_URL), or undefined when nothing is installed. */
export async function installedSize(): Promise<EngineSize | null | undefined> {
  const i = await readInstalled();
  return i ? (externalUrl() ? null : i.size) : undefined;
}

/** One pinned file into `dest`, resuming a partial download, its SHA-256 checked before it is kept. */
export async function fetchPinned(f: PinnedFile, dest: string, signal: AbortSignal, onBytes: (n: number) => void) {
  const part = `${dest}.part`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let have = 0;
  try { have = (await fsp.stat(part)).size; } catch { /* a fresh start */ }
  if (have > f.bytes) { await fsp.rm(part, { force: true }); have = 0; }
  const hash = crypto.createHash('sha256');
  if (have) {
    for await (const chunk of fs.createReadStream(part)) hash.update(chunk as Buffer);
    onBytes(have);
  }
  if (have < f.bytes) {
    const r = await fetch(f.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal });
    if (!r.ok || !r.body) throw new Error(`${f.name}: the download answered ${r.status}`);
    if (have && r.status !== 206) throw new Error(`${f.name}: the server cannot resume; remove the engine and download it again`);
    const count = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); onBytes(chunk.length); cb(null, chunk); } });
    await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), count, fs.createWriteStream(part, { flags: have ? 'a' : 'w' }), { signal });
  }
  const got = hash.digest('hex');
  if (got !== f.sha256) {
    await fsp.rm(part, { force: true });
    throw new Error(`${f.name} did not match its checksum, so it was thrown away`);
  }
  await fsp.rename(part, dest);
}

const untar = (file: string, into: string) => new Promise<void>((resolve, reject) => {
  const p = spawn('tar', ['-xzf', file, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unpacking the engine failed: ${err.trim().slice(0, 200)}`))));
});

/** Starts the download in the background (one at a time). Size: the one this machine picks, unless forced. */
export function startDownload(size: EngineSize = pickSize()): void {
  if (job || !supported()) return;
  const dir = translateDir();
  const want = externalUrl() ? null : size;
  const files = filesFor(want);
  const abort = new AbortController();
  lastError = undefined;
  const j = { size: want, done: 0, total: files.reduce((s, f) => s + f.bytes, 0), abort, promise: Promise.resolve() };
  j.promise = (async () => {
    stopEngine();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rm(path.join(dir, 'installed.json'), { force: true });
    if ((await freeBytes(dir)) < j.total + GiB) throw new Error(`not enough free disk space: the engine needs ${Math.ceil(j.total / GiB)} GB plus 1 GB to spare`);
    for (const f of files) {
      const dest = path.join(dir, f.dest);
      await fetchPinned(f, dest, abort.signal, (n) => { j.done += n; });
    }
    const next = path.join(dir, 'pack.new');
    await fsp.rm(next, { recursive: true, force: true });
    await fsp.mkdir(next, { recursive: true });
    await untar(path.join(dir, 'pack.tar.gz'), next);
    await fsp.rm(path.join(dir, 'pack'), { recursive: true, force: true });
    await fsp.rename(next, path.join(dir, 'pack'));
    await fsp.rm(path.join(dir, 'pack.tar.gz'), { force: true });
    // the other size's model, if one was there, is not needed any more
    for (const other of ['large', 'small'] as const) if (other !== want) await fsp.rm(path.join(dir, 'models', other), { recursive: true, force: true });
    const inst: Installed = { tag: PACK_TAG, platform: platformKey(), size: want, at: new Date().toISOString() };
    await fsp.writeFile(path.join(dir, 'installed.json'), JSON.stringify(inst));
  })().catch((e) => { lastError = abort.signal.aborted ? undefined : (e as Error).message; }).finally(() => { job = null; });
  job = j;
}

/** Stops everything and deletes the engine's files (the folder itself stays). */
export async function removeEngine(): Promise<void> {
  if (job) { job.abort.abort(); await job.promise.catch(() => {}); }
  stopEngine();
  lastError = undefined;
  const dir = translateDir();
  for (const e of await fsp.readdir(dir).catch(() => [] as string[])) await fsp.rm(path.join(dir, e), { recursive: true, force: true });
}

// ---- running it ----

export interface Engine { ocr: Pick<OcrWorker, 'read' | 'stop' | 'running'>; model: Pick<TranslationModel, 'chat' | 'stop' | 'running' | 'vision'>; fontDir: string }
let procs: Engine | null = null;
let idle: NodeJS.Timeout | null = null;
let testEngine: Engine | null = null;

/** Tests: an engine of fakes (no download, no processes). */
export function _setEngineForTests(e: Engine | null): void { testEngine = e; }

function memAvailable(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  return os.freemem();
}

/** The running engine, started if needed; every call pushes the idle stop back. Throws when it is not installed. */
export async function acquireEngine(): Promise<Engine> {
  if (idle) clearTimeout(idle);
  idle = setTimeout(stopEngine, IDLE_MS);
  idle.unref?.();
  if (testEngine) return testEngine;
  if (procs) return procs;
  const inst = await readInstalled();
  if (!inst) throw new Error('the translation engine is not installed');
  const dir = translateDir();
  const pack = path.join(dir, 'pack');
  const threads = Math.max(2, Number(process.env.TRANSLATE_THREADS) || Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2));
  const url = externalUrl();
  if (!url && inst.size) {
    const model = MODELS[inst.size];
    const size = model.files.reduce((s, f) => s + f.bytes, 0);
    if (memAvailable() < size + GiB) throw new Error(`not enough free memory for the translation model (it needs about ${Math.ceil(size / GiB) + 1} GB)`);
  }
  const model = inst.size && !url ? MODELS[inst.size] : null;
  procs = {
    ocr: new OcrWorker(pack, Math.min(4, threads)),
    model: new TranslationModel(url
      ? { url, threads }
      : {
        bin: path.join(pack, 'bin', 'llama-server'),
        model: path.join(dir, 'models', inst.size!, 'model.gguf'),
        mmproj: model?.vision ? path.join(dir, 'models', inst.size!, 'mmproj.gguf') : undefined,
        mtp: model?.mtp,
        threads,
      }),
    fontDir: path.join(pack, 'fonts'),
  };
  return procs;
}

export function stopEngine(): void {
  if (idle) { clearTimeout(idle); idle = null; }
  const p = procs;
  procs = null;
  p?.ocr.stop();
  p?.model.stop();
}
