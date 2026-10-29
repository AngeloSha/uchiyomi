// Necessary checks for extracted cover titles. They describe review evidence, never certify a complete design.
// Hi-SAM's mask score and OCR confidence are not calibrated probabilities of a faithful, complete title cutout.
import type { OcrLine } from './translate/ocrCore';

export type CoverTitleQualityCode =
  | 'automatic_verification_unvalidated' | 'invalid_geometry' | 'invalid_mask_statistics'
  | 'empty_foreground' | 'opaque_foreground' | 'missing_verified_alias' | 'title_alias_too_short'
  | 'ocr_unavailable' | 'ocr_evidence_invalid' | 'source_title_not_confirmed' | 'candidate_title_not_confirmed'
  | 'ocr_low_confidence' | 'title_ocr_disagrees' | 'additional_text' | 'source_text_clipped'
  | 'source_resolution_low' | 'candidate_resolution_low' | 'possible_mask_clipping' | 'sparse_foreground'
  | 'dense_foreground' | 'quality_evidence_incomplete' | 'foreground_lost' | 'foreground_changed' | 'low_contrast'
  | 'manual_mask_edit' | 'title_identity_unverified' | 'verifier_profile_mismatch' | 'light_ocr_contradiction';

export interface CoverTitleQualityInput {
  /** Normalized left, top, right, bottom in the exact prepared source image used by sourceOcr. */
  region: readonly [number, number, number, number];
  sourceWidth: number; sourceHeight: number; candidateWidth: number; candidateHeight: number;
  /** Diagnostic only; deliberately never used as a title-quality or acceptance threshold. */
  maskScore: number | null;
  foregroundFraction: number; edgeInkFraction: number;
  /** Full canonical native/English/romaji titles from the CURRENT checked manga link, never scraped synonyms. */
  aliases: readonly string[];
  linkedAnilistId?: string | null; aliasesAnilistId?: string | null;
  /** Fingerprint of the actual pinned segmentation+OCR+preprocessing pipeline, supplied by the worker adapter. */
  verifierFingerprint?: string;
  readingDirection?: 'horizontal' | 'vertical-ltr' | 'vertical-rtl';
  /** Source boxes use the full prepared source coordinates; candidate boxes use the final cutout coordinates. */
  sourceOcr?: readonly OcrLine[]; candidateOcr?: readonly OcrLine[];
  /** Additional measured evidence. Preserving a model mask does not prove that model detected every title stroke. */
  maskRetainedFraction?: number; foregroundChangedFraction?: number; darkBackgroundContrastRatio?: number;
}

export interface CoverTitleQualityResult {
  policyVersion: 'strict-v1';
  safeToApply: boolean;
  manualApplyAllowed: boolean;
  needsReview: boolean;
  reasons: Array<{ code: CoverTitleQualityCode; severity: 'warning' | 'error' }>;
  sourceTitleMatched: boolean | null; candidateTitleMatched: boolean | null; matchedAlias: string | null;
}

/** Trusted, explicitly approved calibration from backend configuration/code, NEVER from a worker or request body.
 * Counts describe actual cover runs and visual whole-title comparison, not synthetic fixtures or policy predictions.
 * The reviewer field records whether that audit was by a person or an agent; neither implies a correctness guarantee.
 * A changed model, alphabet, preprocessing or policy must change the verifier fingerprint and be reviewed again.
 */
export interface CoverTitleCalibration {
  profile: 'strict-v1'; verifierFingerprint: string; corpusSha256: string;
  reviewedCases: number; knownUnsafeCases: number; rejectedUnsafeCases: number; falseAccepts: number;
  unassistedCleanCasesPassed: number; visuallyReviewed: true; reviewMethod: 'operator_visual_audit';
  reviewer: 'human' | 'codex'; automaticAcceptanceApproved: true;
}

export function isCoverTitleCalibration(profile: CoverTitleCalibration | undefined): profile is CoverTitleCalibration {
  const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return !!profile && profile.profile === 'strict-v1' && hash(profile.verifierFingerprint) && hash(profile.corpusSha256)
    && profile.visuallyReviewed === true && profile.reviewMethod === 'operator_visual_audit' && ['human', 'codex'].includes(profile.reviewer)
    && profile.automaticAcceptanceApproved === true && count(profile.reviewedCases)
    && profile.reviewedCases >= 10 && count(profile.knownUnsafeCases) && profile.knownUnsafeCases >= 3
    && profile.rejectedUnsafeCases === profile.knownUnsafeCases && profile.falseAccepts === 0
    && count(profile.unassistedCleanCasesPassed) && profile.unassistedCleanCasesPassed >= 1
    && profile.knownUnsafeCases + profile.unassistedCleanCasesPassed <= profile.reviewedCases;
}

const fraction = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const dimension = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
// Preserve punctuation that can distinguish titles (+99, Re:Zero, numbered sequels). No fuzzy/OCR-confusion folding.
const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[‐‑–—]/g, '-').replace(/\s+/gu, '');
const area = (b: OcrLine['box']) => (b[2] - b[0]) * (b[3] - b[1]);
const intersection = (a: readonly number[], b: readonly number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

function validOcr(lines: readonly OcrLine[], width: number, height: number): boolean {
  const box = (b: unknown): boolean => Array.isArray(b) && b.length === 4 && b.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
    && b[0] >= 0 && b[1] >= 0 && b[2] > b[0] && b[3] > b[1] && b[2] <= width && b[3] <= height;
  return Array.isArray(lines) && lines.length <= 128 && lines.every((l) => l && typeof l.text === 'string' && l.text.length <= 500
    && fraction(l.score) && typeof l.tall === 'boolean' && box(l.box) && (l.contentBox === undefined || (box(l.contentBox)
      && l.contentBox[0] >= l.box[0] && l.contentBox[1] >= l.box[1] && l.contentBox[2] <= l.box[2] && l.contentBox[3] <= l.box[3])));
}

function readings(lines: readonly OcrLine[], direction: CoverTitleQualityInput['readingDirection']): string[] {
  const clean = lines.filter((l) => l.text.trim());
  // Never permute fragments or discard author/volume lines to manufacture a match. Reading direction is evidence
  // from the prepared source, not whichever permutation happens to agree with a desired title.
  const order = [...clean].sort(direction === 'vertical-rtl' ? (a, b) => b.box[0] - a.box[0] || a.box[1] - b.box[1]
    : direction === 'vertical-ltr' ? (a, b) => a.box[0] - b.box[0] || a.box[1] - b.box[1]
    : (a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  return [key(order.map((l) => l.text).join(' '))];
}
export const normalizeCoverTitleText = key;
export const coverTitleOcrReading = (lines: readonly OcrLine[], direction?: CoverTitleQualityInput['readingDirection']) => readings(lines, direction)[0];

function evidence(lines: readonly OcrLine[], aliases: readonly string[], direction: CoverTitleQualityInput['readingDirection']) {
  const read = readings(lines, direction);
  const match = aliases.find((alias) => read.includes(key(alias))) ?? null;
  const extra = !match && aliases.some((alias) => read.some((r) => r.includes(key(alias)) && r !== key(alias)));
  const confidence = lines.every((l) => !l.text.trim() || l.score >= .98);
  return { match, extra, confidence };
}

/** Pure, bounded and fail-closed. Valid rough cutouts remain usable in an explicit visual-review workflow. */
export function assessCoverTitleQuality(input: CoverTitleQualityInput, calibration?: CoverTitleCalibration): CoverTitleQualityResult {
  const result: CoverTitleQualityResult = { policyVersion: 'strict-v1', safeToApply: false, manualApplyAllowed: true,
    needsReview: true, reasons: [], sourceTitleMatched: null, candidateTitleMatched: null, matchedAlias: null };
  const add = (code: CoverTitleQualityCode, severity: 'warning' | 'error' = 'warning') => {
    if (!result.reasons.some((r) => r.code === code)) result.reasons.push({ code, severity });
    if (severity === 'error') result.manualApplyAllowed = false;
  };
  if (!isCoverTitleCalibration(calibration)) add('automatic_verification_unvalidated');
  else if (input.verifierFingerprint !== calibration.verifierFingerprint) add('verifier_profile_mismatch');
  if (!input.linkedAnilistId || !/^[1-9][0-9]{0,9}$/.test(input.linkedAnilistId) || input.aliasesAnilistId !== input.linkedAnilistId) add('title_identity_unverified');
  const r = input.region;
  const geometry = dimension(input.sourceWidth) && dimension(input.sourceHeight) && input.sourceWidth * input.sourceHeight <= 12_000_000
    && dimension(input.candidateWidth) && dimension(input.candidateHeight) && input.candidateWidth * input.candidateHeight <= 8_000_000
    && Array.isArray(r) && r.length === 4 && r.every(fraction) && r[0] < r[2] && r[1] < r[3];
  if (!geometry) { add('invalid_geometry', 'error'); return result; }
  if (!fraction(input.foregroundFraction) || !fraction(input.edgeInkFraction)) { add('invalid_mask_statistics', 'error'); return result; }
  if (input.foregroundFraction === 0) add('empty_foreground', 'error');
  if (input.foregroundFraction === 1) add('opaque_foreground', 'error');
  if (Math.min(input.sourceWidth, input.sourceHeight) < 300) add('source_resolution_low');
  if (Math.min(input.candidateWidth, input.candidateHeight) < 32 || Math.max(input.candidateWidth, input.candidateHeight) < 96) add('candidate_resolution_low');
  if (input.edgeInkFraction > 0) add('possible_mask_clipping');
  if (input.foregroundFraction > 0 && input.foregroundFraction < .005) add('sparse_foreground');
  if (input.foregroundFraction < 1 && input.foregroundFraction > .65) add('dense_foreground');

  const aliases = Array.isArray(input.aliases) ? [...new Set(input.aliases.slice(0, 16).filter((a) => typeof a === 'string' && a.trim() && a.length <= 256))] : [];
  if (!aliases.length) add('missing_verified_alias');
  if (input.sourceOcr === undefined || input.candidateOcr === undefined) add('ocr_unavailable');
  const sourceValid = input.sourceOcr !== undefined && validOcr(input.sourceOcr, input.sourceWidth, input.sourceHeight);
  const candidateValid = input.candidateOcr !== undefined && validOcr(input.candidateOcr, input.candidateWidth, input.candidateHeight);
  if ((input.sourceOcr !== undefined && !sourceValid) || (input.candidateOcr !== undefined && !candidateValid)) add('ocr_evidence_invalid');
  const box = [r[0] * input.sourceWidth, r[1] * input.sourceHeight, r[2] * input.sourceWidth, r[3] * input.sourceHeight];
  const sourceLines = sourceValid ? input.sourceOcr!.filter((l) => l.text.trim() && intersection(box, l.contentBox ?? l.box) > 0) : [];
  if (sourceLines.some((l) => intersection(box, l.contentBox ?? l.box) < area(l.contentBox ?? l.box))) add('source_text_clipped');
  const source = sourceValid ? evidence(sourceLines, aliases, input.readingDirection) : null;
  const candidate = candidateValid ? evidence(input.candidateOcr!, aliases, input.readingDirection) : null;
  result.sourceTitleMatched = source ? !!source.match : null;
  result.candidateTitleMatched = candidate ? !!candidate.match : null;
  result.matchedAlias = candidate?.match ?? source?.match ?? null;
  if (source && !source.match) add('source_title_not_confirmed');
  if (candidate && !candidate.match) add('candidate_title_not_confirmed');
  if (source?.extra || candidate?.extra) add('additional_text');
  if ((source && !source.confidence) || (candidate && !candidate.confidence)) add('ocr_low_confidence');
  if (source?.match && candidate?.match && key(source.match) !== key(candidate.match)) add('title_ocr_disagrees');
  if (result.matchedAlias) {
    const normalized = key(result.matchedAlias);
    const letters = [...normalized].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
    if (letters < (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalized) ? 3 : 6)) add('title_alias_too_short');
  }
  if (input.maskRetainedFraction === undefined || input.foregroundChangedFraction === undefined || input.darkBackgroundContrastRatio === undefined) add('quality_evidence_incomplete');
  if (input.maskRetainedFraction !== undefined && (!fraction(input.maskRetainedFraction) || input.maskRetainedFraction < 1)) add('foreground_lost');
  if (input.foregroundChangedFraction !== undefined && (!fraction(input.foregroundChangedFraction) || input.foregroundChangedFraction > 0)) add('foreground_changed');
  if (input.darkBackgroundContrastRatio !== undefined && (!Number.isFinite(input.darkBackgroundContrastRatio)
    || input.darkBackgroundContrastRatio < 3 || input.darkBackgroundContrastRatio > 21)) add('low_contrast');
  result.safeToApply = result.reasons.length === 0 && result.sourceTitleMatched === true && result.candidateTitleMatched === true;
  result.needsReview = !result.safeToApply;
  return result;
}
