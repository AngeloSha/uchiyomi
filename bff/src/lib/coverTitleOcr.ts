// OCR-only adapter: no translation engine/LLM, downloads, database access or artwork publication.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { OcrWorker, type PageText } from './translate/ocr';
import { detSize, OCR_MAX_SIDE } from './translate/ocrCore';
import { assessCoverTitleQuality, isCoverTitleCalibration, normalizeCoverTitleText, coverTitleOcrReading,
  type CoverTitleCalibration, type CoverTitleQualityInput, type CoverTitleQualityResult } from './coverTitleQuality';

const OCR_PACK = 'e9e37c7cb2b7af61042a41f5f188a5e9c14cfeb78c35425551118f2e288c7d09';
const CURRENT_MODEL = '9cd371602da73a8c1f9ae8902b4aa33b4658bc6133821720ff63ac17e56945c8';
const HASH = /^[a-f0-9]{64}$/;
const BYTE_LIMIT = 12 * 1024 * 1024;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function boundedOcr(width: number, height: number): boolean {
  // OCR expands the short side to736px. A thin cutout can therefore exceed the detector's memory budget even
  // when its compressed bytes and original pixels are tiny. Such a cutout is still available for visual review.
  if (width > 1600 || height > 1600) return false;
  const scale = Math.min(1, OCR_MAX_SIDE / Math.max(width, height));
  const size = detSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  return size.w * size.h <= 3_000_000;
}
export function coverTitleVerifierFingerprint(modelFingerprint: string, ocrFingerprint = OCR_PACK): string {
  if (!HASH.test(modelFingerprint) || !HASH.test(ocrFingerprint)) throw new Error('Invalid title verifier fingerprint');
  return sha(JSON.stringify({ policy: 'strict-v1', adapter: 'prepared-source-dark-primary-v1', model: modelFingerprint, ocr: ocrFingerprint }));
}

export interface CoverTitleOcrCapability { available: boolean; calibrated: boolean; verifierFingerprint: string | null }
export interface CoverTitleCandidateInput {
  sourceBytes: Buffer; candidateBytes: Buffer; sourceSha256: string; modelFingerprint: string; lang: string;
  evidence: CoverTitleQualityInput;
}
export interface CoverTitleOcrInspection {
  quality: CoverTitleQualityResult; verifierFingerprint: string | null;
  sourceOcr: PageText | null; candidateLightOcr: PageText | null; candidateDarkOcr: PageText | null;
}
type Reader = Pick<OcrWorker, 'read' | 'stop'>;
interface Dependencies {
  directory: () => string; calibrationFile: () => string;
  worker?: (directory: string) => Reader;
  // Injected only by deterministic tests, never from request/worker data.
  verifyPack?: (directory: string) => Promise<string>;
  loadCalibration?: (file: string) => Promise<CoverTitleCalibration | undefined>;
}

async function smallJson(file: string, maxBytes: number) {
  const s = await lstat(file);
  if (!s.isFile() || s.size > maxBytes) throw new Error('Invalid title OCR metadata');
  const bytes = await readFile(file);
  if (bytes.length > maxBytes) throw new Error('Title OCR metadata exceeds its limit');
  return JSON.parse(bytes.toString('utf8'));
}
async function verifyPack(directory: string): Promise<string> {
  const base = await realpath(directory);
  const manifest = await smallJson(path.join(base, 'title-ocr.json'), 128 * 1024);
  if (manifest.version !== 1 || manifest.runtimeVersion !== '1.30.0' || manifest.fingerprint !== OCR_PACK
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Unpinned title OCR pack');
  const entries = Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b));
  // prepare-ocr.mjs uses JavaScript's default UTF-16 key sort, not locale-dependent filename ordering.
  const fingerprint = sha(JSON.stringify(Object.fromEntries(Object.entries(manifest.files).sort())));
  if (fingerprint !== OCR_PACK || entries.length > 256) throw new Error('Title OCR manifest fingerprint mismatch');
  for (const required of ['ocr/det.onnx', 'ocr/rec.onnx', 'ocr/rec-ko.onnx', 'ocr/rec.txt', 'ocr/rec-ko.txt',
    'ort/ort.node.min.mjs', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm']) {
    if (!Object.hasOwn(manifest.files, required)) throw new Error('Incomplete title OCR pack');
  }
  let total = 0;
  for (const [name, expected] of entries) {
    if (!HASH.test(String(expected)) || name.includes('\\') || name.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('Invalid title OCR file');
    const file = path.join(base, name), actualPath = await realpath(file);
    if (!actualPath.startsWith(base + path.sep) || !(await lstat(file)).isFile()) throw new Error('Unsafe title OCR file');
    const digest = createHash('sha256'); let count = 0;
    for await (const chunk of createReadStream(file)) {
      count += chunk.length; total += chunk.length;
      if (count > 128 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error('Title OCR pack exceeds its limits');
      digest.update(chunk);
    }
    if (digest.digest('hex') !== expected) throw new Error('Title OCR file checksum mismatch');
  }
  return OCR_PACK;
}
async function loadCalibration(file: string): Promise<CoverTitleCalibration | undefined> {
  if (!file) return undefined;
  try { const profile = await smallJson(file, 64 * 1024); return isCoverTitleCalibration(profile) ? profile : undefined; }
  catch { return undefined; }
}

/** One bounded worker and cache. Source hashes come from bytes, never a supplied cache key alone. */
export function createCoverTitleOcr(deps: Dependencies) {
  let reader: Reader | null = null, readerDirectory = '', packPromise: Promise<string> | null = null;
  let serial: Promise<unknown> = Promise.resolve(), generation = 0;
  const sources = new Map<string, PageText>();
  const pack = async () => {
    const directory = deps.directory().trim();
    if (!directory) throw new Error('Title OCR is not configured');
    if (directory !== readerDirectory) { reader?.stop(); reader = null; sources.clear(); packPromise = null; readerDirectory = directory; }
    if (!packPromise) packPromise = (deps.verifyPack ?? verifyPack)(directory).catch((error) => { packPromise = null; throw error; });
    return { directory, fingerprint: await packPromise };
  };
  const capability = async (modelFingerprint?: string): Promise<CoverTitleOcrCapability> => {
    try {
      const installed = await pack();
      const verifierFingerprint = modelFingerprint && HASH.test(modelFingerprint) ? coverTitleVerifierFingerprint(modelFingerprint, installed.fingerprint) : null;
      const profile = await (deps.loadCalibration ?? loadCalibration)(deps.calibrationFile());
      return { available: true, calibrated: !!profile && isCoverTitleCalibration(profile) && profile.verifierFingerprint === verifierFingerprint, verifierFingerprint };
    } catch { return { available: false, calibrated: false, verifierFingerprint: null }; }
  };
  const inspect = (want: CoverTitleCandidateInput): Promise<CoverTitleOcrInspection> => {
    const at = generation;
    const task = serial.then(async (): Promise<CoverTitleOcrInspection> => {
      const evidence = { ...want.evidence, sourceOcr: undefined, candidateOcr: undefined, verifierFingerprint: undefined };
      const fallback = (): CoverTitleOcrInspection => ({ quality: assessCoverTitleQuality(evidence), verifierFingerprint: null,
        sourceOcr: null, candidateLightOcr: null, candidateDarkOcr: null });
      if (at !== generation) return fallback();
      if (!assessCoverTitleQuality(evidence).manualApplyAllowed) return fallback();
      if (!boundedOcr(evidence.sourceWidth, evidence.sourceHeight) || !boundedOcr(evidence.candidateWidth, evidence.candidateHeight)) return fallback();
      // Images are already bounded by the extraction adapter, and are bounded again before invoking OCR/Sharp.
      if (!want.sourceBytes.length || want.sourceBytes.length > BYTE_LIMIT || !want.candidateBytes.length || want.candidateBytes.length > BYTE_LIMIT
        || sha(want.sourceBytes) !== want.sourceSha256 || !HASH.test(want.modelFingerprint)) return fallback();
      try {
        const installed = await pack();
        if (at !== generation) return fallback();
        const verifierFingerprint = coverTitleVerifierFingerprint(want.modelFingerprint, installed.fingerprint);
        const profile = await (deps.loadCalibration ?? loadCalibration)(deps.calibrationFile());
        reader ??= deps.worker?.(installed.directory) ?? new OcrWorker(installed.directory, 2);
        const language = want.lang.toLowerCase().split(/[-_]/)[0];
        const cacheKey = `${want.sourceSha256}:${language}:${evidence.sourceWidth}x${evidence.sourceHeight}`;
        let sourceOcr = sources.get(cacheKey);
        if (!sourceOcr) {
          const prepared = await sharp(want.sourceBytes, { limitInputPixels: 12_000_000 }).rotate()
            .resize(evidence.sourceWidth, evidence.sourceHeight, { fit: 'fill' }).removeAlpha().png().toBuffer();
          sourceOcr = await reader.read(prepared, language, 60_000);
          sources.set(cacheKey, sourceOcr);
          while (sources.size > 8) sources.delete(sources.keys().next().value!);
        }
        const image = sharp(want.candidateBytes, { limitInputPixels: 8_000_000 });
        const dimensions = await image.metadata();
        if (dimensions.width !== evidence.candidateWidth || dimensions.height !== evidence.candidateHeight) return fallback();
        const stats = await image.stats();
        if (!dimensions.hasAlpha || stats.isOpaque || (stats.channels.at(-1)?.max ?? 0) === 0) {
          const invalid = fallback();
          invalid.quality.manualApplyAllowed = false;
          invalid.quality.reasons.push({ code: !dimensions.hasAlpha || stats.isOpaque ? 'opaque_foreground' : 'empty_foreground', severity: 'error' });
          return invalid;
        }
        const light = await image.clone().flatten({ background: '#ffffff' }).png().toBuffer();
        const dark = await image.clone().flatten({ background: '#15131f' }).png().toBuffer();
        const candidateLightOcr = await reader.read(light, language, 60_000);
        const candidateDarkOcr = await reader.read(dark, language, 60_000);
        if (at !== generation) return fallback();
        // The actual hero is dark: source+dark must pass. White lettering can legitimately vanish on a white
        // inspection sheet, so weak/empty light OCR cannot veto it. Confident contradictory light text still can.
        const quality = assessCoverTitleQuality({ ...evidence, verifierFingerprint, sourceOcr: sourceOcr.lines, candidateOcr: candidateDarkOcr.lines }, profile);
        const lightCheck = assessCoverTitleQuality({ ...evidence, verifierFingerprint, sourceOcr: sourceOcr.lines, candidateOcr: candidateLightOcr.lines }, profile);
        const lightLines = candidateLightOcr.lines.filter((l) => l.text.trim());
        const invalidLight = lightCheck.reasons.some((r) => r.code === 'ocr_evidence_invalid');
        const lightRead = invalidLight ? '' : coverTitleOcrReading(lightLines, evidence.readingDirection);
        const expected = normalizeCoverTitleText(quality.matchedAlias ?? '');
        if (invalidLight || (lightLines.length > 0 && lightLines.every((l) => l.score >= .98) && expected && !expected.includes(lightRead))) {
          quality.reasons.push({ code: invalidLight ? 'ocr_evidence_invalid' : 'light_ocr_contradiction', severity: 'warning' });
          quality.safeToApply = false;
        }
        quality.needsReview = !quality.safeToApply;
        return { quality, verifierFingerprint, sourceOcr, candidateLightOcr, candidateDarkOcr };
      } catch { return fallback(); }
    });
    serial = task.then(() => undefined, () => undefined);
    return task;
  };
  const stop = () => { generation++; reader?.stop(); reader = null; sources.clear(); };
  return { capability, inspect, assess: async (want: CoverTitleCandidateInput) => (await inspect(want)).quality, stop };
}

const current = createCoverTitleOcr({ directory: () => process.env.TITLE_EXTRACTOR_OCR_DIR ?? '',
  calibrationFile: () => process.env.TITLE_EXTRACTOR_CALIBRATION_FILE ?? '' });
export const coverTitleOcrCapability = (modelFingerprint = CURRENT_MODEL) => current.capability(modelFingerprint);
export const inspectCoverTitleCandidate = current.inspect;
export const assessCoverTitleCandidate = current.assess;
export const stopCoverTitleOcr = current.stop;
