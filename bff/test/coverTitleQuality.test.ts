import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCoverTitleQuality as assess, type CoverTitleQualityInput, type CoverTitleCalibration } from '../src/lib/coverTitleQuality';
import type { OcrLine } from '../src/lib/translate/ocrCore';

const FINGERPRINT = 'a'.repeat(64);
// Synthetic evidence tests the gate's logic; it is deliberately not an application calibration file.
const profile: CoverTitleCalibration = { profile: 'strict-v1', verifierFingerprint: FINGERPRINT, corpusSha256: 'b'.repeat(64),
  reviewedCases: 10, knownUnsafeCases: 4, rejectedUnsafeCases: 4, falseAccepts: 0, unassistedCleanCasesPassed: 1,
  visuallyReviewed: true, reviewMethod: 'operator_visual_audit', reviewer: 'codex', automaticAcceptanceApproved: true };
const line = (text = 'ONE PIECE', score = .99, box: OcrLine['box'] = [50, 50, 300, 90]): OcrLine => ({ text, score, box, tall: false });
const input = (changes: Partial<CoverTitleQualityInput> = {}): CoverTitleQualityInput => ({
  region: [0, 0, 1, .4], sourceWidth: 800, sourceHeight: 1200, candidateWidth: 400, candidateHeight: 120,
  maskScore: .8, foregroundFraction: .05, edgeInkFraction: 0, aliases: ['ONE PIECE'],
  linkedAnilistId: '30013', aliasesAnilistId: '30013', verifierFingerprint: FINGERPRINT,
  sourceOcr: [line()], candidateOcr: [line()], maskRetainedFraction: 1, foregroundChangedFraction: 0,
  darkBackgroundContrastRatio: 5, ...changes,
});
const reasons = (value: ReturnType<typeof assess>) => value.reasons.map((r) => r.code);

test('a complete strict pass needs both measured evidence and an explicitly reviewed matching calibration', () => {
  const good = assess(input(), profile);
  assert.equal(good.safeToApply, true); assert.equal(good.manualApplyAllowed, true);
  assert.deepEqual(good.reasons, []); assert.equal(good.matchedAlias, 'ONE PIECE');
  const preview = assess(input());
  assert.equal(preview.safeToApply, false); assert.equal(preview.manualApplyAllowed, true);
  assert.ok(reasons(preview).includes('automatic_verification_unvalidated'));
});

test('incomplete/failed/unreviewed synthetic calibration or changed pipeline never enables automatic use', () => {
  for (const patch of [{ reviewedCases: 9 }, { knownUnsafeCases: 0 }, { rejectedUnsafeCases: 3 }, { falseAccepts: 1 },
    { unassistedCleanCasesPassed: 0 }, { visuallyReviewed: false }, { reviewer: 'unknown' },
    { automaticAcceptanceApproved: false }, { corpusSha256: '' }, { reviewedCases: Number.NaN }]) {
    assert.equal(assess(input(), { ...profile, ...patch } as CoverTitleCalibration).safeToApply, false);
  }
  assert.ok(reasons(assess(input({ verifierFingerprint: 'c'.repeat(64) }), profile)).includes('verifier_profile_mismatch'));
});

test('high segmentation and OCR scores never rescue a partial title, abbreviation or missing symbol', () => {
  for (const [alias, read] of [['ONE PIECE', 'NEP ECE'], ['Tower of God', 'of'], ['SSS-Class Suicide Hunter', 'SSS Hunter'],
    ['+99 Wooden Stick', '99 Wooden Stick'], ['Re:Zero', 'ReZero']]) {
    const result = assess(input({ aliases: [alias], sourceOcr: [line(alias)], candidateOcr: [line(read, 1)], maskScore: 1 }), profile);
    assert.equal(result.safeToApply, false); assert.equal(result.manualApplyAllowed, true);
    assert.ok(reasons(result).includes('candidate_title_not_confirmed'));
  }
  assert.ok(reasons(assess(input({ aliases: ['OP'], sourceOcr: [line('OP')], candidateOcr: [line('OP')] }), profile)).includes('title_alias_too_short'));
});

test('native Korean/CJK full titles can match exactly without transliteration or script erasure', () => {
  for (const alias of ['전지적 독자 시점', '妖神记', '鬼滅の刃']) {
    const result = assess(input({ aliases: ['A different English title', alias], sourceOcr: [line(alias)], candidateOcr: [line(alias)] }), profile);
    assert.equal(result.safeToApply, true); assert.equal(result.matchedAlias, alias);
  }
  assert.equal(assess(input({ aliases: ['妖神记'], sourceOcr: [line('妖神记')], candidateOcr: [line('妖神記')] }), profile).safeToApply, false);
  assert.equal(assess(input({ sourceOcr: [line('One Piece')], candidateOcr: [line('ＯＮＥ　ＰＩＥＣＥ')] }), profile).safeToApply, true);
});

test('unlinked and stale native aliases are reviewable but cannot authorize automatic title identity', () => {
  for (const patch of [{ linkedAnilistId: null }, { aliasesAnilistId: null }, { aliasesAnilistId: '87216' }, { linkedAnilistId: '0' }]) {
    const result = assess(input(patch), profile);
    assert.equal(result.safeToApply, false); assert.equal(result.manualApplyAllowed, true);
    assert.ok(reasons(result).includes('title_identity_unverified'));
  }
});

test('credits outside the selected source region are harmless; credits or a volume in the cutout require review', () => {
  const credit = line('EIICHIRO ODA', .99, [50, 900, 300, 950]);
  assert.equal(assess(input({ sourceOcr: [line(), credit] }), profile).safeToApply, true);
  for (const extra of ['EIICHIRO ODA', 'VOL. 1', 'JUMP COMICS']) {
    const result = assess(input({ candidateOcr: [line(), line(extra, .99, [50, 95, 300, 115])] }), profile);
    assert.equal(result.safeToApply, false); assert.ok(reasons(result).includes('additional_text'));
  }
});

test('OCR fragment reordering cannot manufacture a complete expected title', () => {
  const lines = [line('ONE', .99, [50, 90, 200, 110]), line('PIECE', .99, [50, 10, 200, 40])];
  assert.equal(assess(input({ sourceOcr: lines, candidateOcr: lines }), profile).safeToApply, false);
  const native = ['전지적', '독자시점'];
  const vertical = [line(native[0], .99, [30, 10, 60, 100]), line(native[1], .99, [80, 10, 110, 100])];
  assert.equal(assess(input({ aliases: ['전지적 독자 시점'], sourceOcr: vertical, candidateOcr: vertical, readingDirection: 'vertical-ltr' }), profile).safeToApply, true);
  assert.equal(assess(input({ aliases: ['전지적 독자 시점'], sourceOcr: vertical, candidateOcr: vertical, readingDirection: 'vertical-rtl' }), profile).safeToApply, false);
});

test('missing/weak/invalid OCR remains a preview warning, and no malformed extra line is silently discarded', () => {
  for (const patch of [{ sourceOcr: undefined }, { candidateOcr: undefined }, { candidateOcr: [] },
    { candidateOcr: [line('ONE PIECE', .979)] }, { candidateOcr: [line(), line('Author', Number.NaN)] },
    { candidateOcr: [line('ONE PIECE', .99, [0, 0, 500, 100])] }, { candidateOcr: Array.from({ length: 129 }, () => line()) }]) {
    const result = assess(input(patch), profile);
    assert.equal(result.safeToApply, false); assert.equal(result.manualApplyAllowed, true);
  }
});

test('source clipping, any edge ink, alpha loss, RGB changes and poor contrast prevent automatic acceptance', () => {
  for (const patch of [{ sourceOcr: [line('ONE PIECE', .99, [50, 450, 300, 500])] }, { edgeInkFraction: .000001 },
    { maskRetainedFraction: .99999 }, { foregroundChangedFraction: .000001 }, { darkBackgroundContrastRatio: 2.99 },
    { maskRetainedFraction: undefined }, { darkBackgroundContrastRatio: undefined }, { foregroundChangedFraction: undefined }]) {
    const result = assess(input(patch), profile);
    assert.equal(result.safeToApply, false); assert.equal(result.manualApplyAllowed, true);
  }
});

test('invalid geometry, invalid mask fractions, empty foreground and opaque extraction cannot be applied manually either', () => {
  for (const patch of [{ region: [0, 0, 2, 1] }, { sourceWidth: 0 }, { candidateWidth: Number.NaN },
    { sourceWidth: 12_000_001 }, { candidateWidth: 8_000_001 }, { foregroundFraction: 0 }, { foregroundFraction: 1 },
    { foregroundFraction: Number.NaN }, { edgeInkFraction: -.1 }]) {
    const result = assess(input(patch as Partial<CoverTitleQualityInput>), profile);
    assert.equal(result.safeToApply, false); assert.equal(result.manualApplyAllowed, false);
    assert.ok(result.reasons.some((r) => r.severity === 'error'));
  }
});

test('a rough mask and low resolution stay visible for explicit review instead of being silently discarded', () => {
  const result = assess(input({ sourceWidth: 200, sourceHeight: 300, candidateWidth: 80, candidateHeight: 20,
    sourceOcr: undefined, candidateOcr: undefined, foregroundFraction: .001, maskScore: .1, edgeInkFraction: .2 }), profile);
  assert.equal(result.safeToApply, false); assert.equal(result.manualApplyAllowed, true);
  assert.ok(reasons(result).includes('candidate_resolution_low'));
  assert.ok(reasons(result).includes('possible_mask_clipping'));
});

test('a high-quality mask never substitutes for native title/OCR evidence', () => {
  const result = assess(input({ maskScore: 1, aliases: [], sourceOcr: undefined, candidateOcr: undefined }), profile);
  assert.equal(result.safeToApply, false); assert.equal(result.manualApplyAllowed, true);
  assert.ok(reasons(result).includes('missing_verified_alias'));
  assert.ok(reasons(result).includes('ocr_unavailable'));
});
