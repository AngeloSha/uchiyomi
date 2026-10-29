import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCoverTitleOcr, coverTitleVerifierFingerprint, type CoverTitleCandidateInput } from '../src/lib/coverTitleOcr';
import type { CoverTitleCalibration } from '../src/lib/coverTitleQuality';

const model = 'c'.repeat(64), pack = 'd'.repeat(64), verifier = coverTitleVerifierFingerprint(model, pack);
const profile: CoverTitleCalibration = { profile: 'strict-v1', verifierFingerprint: verifier, corpusSha256: 'e'.repeat(64),
  reviewedCases: 10, knownUnsafeCases: 4, rejectedUnsafeCases: 4, falseAccepts: 0, unassistedCleanCasesPassed: 1,
  visuallyReviewed: true, reviewMethod: 'operator_visual_audit', reviewer: 'codex', automaticAcceptanceApproved: true };
async function fixture(partialDark = false) {
  const sourceBytes = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const candidateBytes = await sharp({ create: { width: 400, height: 120, channels: 4, background: '#00000000' } }).png().toBuffer();
  let calls = 0, stops = 0, active = 0, peak = 0;
  const adapter = createCoverTitleOcr({ directory: () => '/test-ocr', calibrationFile: () => '/trusted-calibration',
    verifyPack: async () => pack, loadCalibration: async () => profile, worker: () => ({
      stop: () => { stops++; },
      read: async (bytes) => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const m = await sharp(bytes).metadata(); active--;
        return { width: m.width!, height: m.height!, ms: 1,
          lines: [{ box: [10, 10, 300, 60], text: partialDark && calls === 3 ? 'NEP ECE' : 'ONE PIECE', score: .99, tall: false }] };
      },
    }) });
  const want: CoverTitleCandidateInput = { sourceBytes, candidateBytes, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    modelFingerprint: model, lang: 'en', evidence: { region: [0, 0, 1, .4], sourceWidth: 800, sourceHeight: 1200,
      candidateWidth: 400, candidateHeight: 120, maskScore: .8, foregroundFraction: .05, edgeInkFraction: 0,
      aliases: ['ONE PIECE'], linkedAnilistId: '30013', aliasesAnilistId: '30013', maskRetainedFraction: 1,
      foregroundChangedFraction: 0, darkBackgroundContrastRatio: 5 } };
  return { adapter, want, counts: () => ({ calls, stops, peak }) };
}

test('OCR-only capability separates missing pack, ready pack and matching reviewed calibration', async () => {
  const missing = createCoverTitleOcr({ directory: () => '', calibrationFile: () => '' });
  assert.deepEqual(await missing.capability(model), { available: false, calibrated: false, verifierFingerprint: null });
  const f = await fixture();
  assert.deepEqual(await f.adapter.capability(model), { available: true, calibrated: true, verifierFingerprint: verifier });
  assert.equal((await f.adapter.capability('f'.repeat(64))).calibrated, false);
  assert.equal(f.counts().calls, 0, 'checking capability starts no OCR inference');
});

test('only actual source and both candidate backgrounds authorize a strict pass', async () => {
  const f = await fixture(); const result = await f.adapter.inspect(f.want);
  assert.equal(result.quality.safeToApply, true); assert.equal(result.verifierFingerprint, verifier);
  assert.equal(result.sourceOcr?.width, 800); assert.equal(result.sourceOcr?.height, 1200);
  assert.equal(f.counts().calls, 3);
  const partial = await fixture(true); const bad = await partial.adapter.inspect(partial.want);
  assert.equal(bad.quality.safeToApply, false); assert.equal(bad.quality.manualApplyAllowed, true);
  assert.ok(bad.quality.reasons.some((r) => r.code === 'candidate_title_not_confirmed'));
});

test('source cache is tied to actual byte hash/language/prepared dimensions and OCR calls are serialized', async () => {
  const f = await fixture();
  await Promise.all([f.adapter.assess(f.want), f.adapter.assess(f.want)]);
  assert.equal(f.counts().calls, 5, 'one cached source and two pairs of candidate readings');
  assert.equal(f.counts().peak, 1);
  await f.adapter.assess({ ...f.want, lang: 'ko' }); assert.equal(f.counts().calls, 8);
  f.adapter.stop(); assert.equal(f.counts().stops, 1);
});

test('untrusted source hashes, oversized geometry and missing runtime cannot bypass checks or start inference', async () => {
  const f = await fixture();
  for (const want of [{ ...f.want, sourceSha256: '0'.repeat(64) }, { ...f.want, modelFingerprint: 'bad' },
    { ...f.want, evidence: { ...f.want.evidence, sourceWidth: 12_000_001 } }]) {
    assert.equal((await f.adapter.assess(want)).safeToApply, false);
  }
  assert.equal(f.counts().calls, 0);
  const badPack = createCoverTitleOcr({ directory: () => '/bad', calibrationFile: () => '', verifyPack: async () => { throw Error('mismatch'); } });
  const preview = await badPack.assess(f.want);
  assert.equal(preview.safeToApply, false); assert.equal(preview.manualApplyAllowed, true);
});
