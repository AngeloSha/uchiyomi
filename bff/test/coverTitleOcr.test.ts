import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCoverTitleOcr, coverTitleVerifierFingerprint, prepareCoverTitleOcrCanvas, type CoverTitleCandidateInput } from '../src/lib/coverTitleOcr';
import type { CoverTitleCalibration } from '../src/lib/coverTitleQuality';

const model = 'c'.repeat(64), pack = 'd'.repeat(64), verifier = coverTitleVerifierFingerprint(model, pack);
const profile: CoverTitleCalibration = { profile: 'strict-v1', verifierFingerprint: verifier, corpusSha256: 'e'.repeat(64),
  reviewedCases: 10, knownUnsafeCases: 4, rejectedUnsafeCases: 4, falseAccepts: 0, unassistedCleanCasesPassed: 1,
  visuallyReviewed: true, reviewMethod: 'operator_visual_audit', reviewer: 'codex', automaticAcceptanceApproved: true };
async function fixture(partialDark = false, lightText = 'ONE PIECE', calibrated = true) {
  const sourceBytes = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const candidateBytes = await sharp({ create: { width: 400, height: 120, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 250, height: 40, channels: 4, background: '#ffffffff' } }).png().toBuffer(), left: 10, top: 10 }]).png().toBuffer();
  let calls = 0, stops = 0, active = 0, peak = 0;
  const adapter = createCoverTitleOcr({ directory: () => '/test-ocr', calibrationFile: () => '/trusted-calibration',
    verifyPack: async () => pack, loadCalibration: async () => calibrated ? profile : undefined, worker: () => ({
      stop: () => { stops++; },
      read: async (bytes) => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const m = await sharp(bytes).metadata(); active--;
        return { width: m.width!, height: m.height!, ms: 1,
          lines: [{ box: [10, 10, 300, 60], text: partialDark && calls === 3 ? 'NEP ECE' : calls === 2 ? lightText : 'ONE PIECE', score: .99, tall: false }] };
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

test('source and the actual dark hero must pass; empty/weak light inspection is allowed but contradictions are not', async () => {
  const f = await fixture(); const result = await f.adapter.inspect(f.want);
  assert.equal(result.quality.safeToApply, true); assert.equal(result.verifierFingerprint, verifier);
  assert.equal(result.sourceOcr?.width, 800); assert.equal(result.sourceOcr?.height, 1200);
  assert.equal(f.counts().calls, 3);
  const partial = await fixture(true); const bad = await partial.adapter.inspect(partial.want);
  assert.equal(bad.quality.safeToApply, false); assert.equal(bad.quality.manualApplyAllowed, true);
  assert.ok(bad.quality.reasons.some((r) => r.code === 'candidate_title_not_confirmed'));
  const whiteLetters = await fixture(false, '');
  assert.equal((await whiteLetters.adapter.assess(whiteLetters.want)).safeToApply, true, 'white letters disappear on a white inspection sheet');
  const contradiction = await fixture(false, 'VOLUME ONE');
  const conflict = await contradiction.adapter.assess(contradiction.want);
  assert.equal(conflict.safeToApply, false);
  assert.ok(conflict.reasons.some((r) => r.code === 'light_ocr_contradiction'));
});

test('available checks use actual OCR without calibration, and contradictory light text vetoes both modes', async () => {
  const f = await fixture(false, 'ONE PIECE', false);
  const result = await f.adapter.inspect(f.want);
  assert.equal(result.quality.availableChecksPassed, true);
  assert.equal(result.quality.safeToApply, false);
  assert.equal((await f.adapter.capability(model)).calibrated, false);
  assert.equal(f.counts().calls, 3, 'the available-checks mode still reads source and both inspection backgrounds');
  const bad = await fixture(false, 'VOLUME ONE', false);
  const conflict = await bad.adapter.assess(bad.want);
  assert.equal(conflict.availableChecksPassed, false);
  assert.equal(conflict.safeToApply, false);
  assert.ok(conflict.reasons.some((r) => r.code === 'light_ocr_contradiction'));
  const partial = await fixture(true, 'ONE PIECE', false);
  assert.equal((await partial.adapter.assess(partial.want)).availableChecksPassed, false);
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
    { ...f.want, evidence: { ...f.want.evidence, sourceWidth: 12_000_001 } },
    { ...f.want, evidence: { ...f.want.evidence, candidateWidth: 1600, candidateHeight: 1 } },
    { ...f.want, evidence: { ...f.want.evidence, sourceWidth: 1200, sourceHeight: 10 } }]) {
    assert.equal((await f.adapter.assess(want)).safeToApply, false);
  }
  assert.equal(f.counts().calls, 0);
  const badPack = createCoverTitleOcr({ directory: () => '/bad', calibrationFile: () => '', verifyPack: async () => { throw Error('mismatch'); } });
  const preview = await badPack.assess(f.want);
  assert.equal(preview.safeToApply, false); assert.equal(preview.manualApplyAllowed, true);
});

test('a worker claim cannot turn an opaque rectangle or empty alpha plane into a valid title cutout', async () => {
  for (const background of ['#ffffffff', '#00000000']) {
    const f = await fixture();
    const candidateBytes = await sharp({ create: { width: 400, height: 120, channels: 4, background } }).png().toBuffer();
    const quality = await f.adapter.assess({ ...f.want, candidateBytes });
    assert.equal(quality.safeToApply, false); assert.equal(quality.manualApplyAllowed, false);
    assert.ok(quality.reasons.some((r) => r.severity === 'error'));
  }
});

test('wide wordmarks gain only uniform padding, retaining every foreground pixel and bounded detector aspect', async () => {
  const original = await sharp({ create: { width: 800, height: 80, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 600, height: 30, channels: 4, background: '#4488ddff' } }).png().toBuffer(), left: 50, top: 20 }]).png().toBuffer();
  const prepared = await prepareCoverTitleOcrCanvas(original, 'dark');
  assert.equal(prepared.width, 800); assert.equal(prepared.height, 200);
  assert.deepEqual(prepared.padding, { left: 0, top: 60, right: 0, bottom: 60 });
  const raw = await sharp(prepared.bytes).raw().toBuffer();
  const pixel = (x: number, y: number) => [...raw.subarray((y * 800 + x) * 3, (y * 800 + x) * 3 + 3)];
  assert.deepEqual(pixel(50, 80), [68, 136, 221]);
  assert.deepEqual(pixel(649, 109), [68, 136, 221]);
  assert.deepEqual(pixel(50, 20), [21, 19, 31]);
  const crop = await sharp(prepared.bytes).extract({ left: 0, top: 60, width: 800, height: 80 }).raw().toBuffer();
  const expected = await sharp(original).flatten({ background: '#15131f' }).raw().toBuffer();
  assert.ok(crop.equals(expected), 'padding neither crops nor resamples the original flattened pixels');
});

test('OCR boxes on a padded wordmark are mapped back to original cutout coordinates', async () => {
  const f = await fixture(); let calls = 0;
  const candidateBytes = await sharp({ create: { width: 800, height: 80, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 600, height: 30, channels: 4, background: '#ffffffff' } }).png().toBuffer(), left: 50, top: 20 }]).png().toBuffer();
  const adapter = createCoverTitleOcr({ directory: () => '/fake', calibrationFile: () => '/approved',
    verifyPack: async () => pack, loadCalibration: async () => profile, worker: () => ({ stop() {},
      read: async (bytes) => { const m = await sharp(bytes).metadata(); calls++; return { width: m.width!, height: m.height!, ms: 1,
        lines: [{ text: 'ONE PIECE', score: .99, tall: false, box: calls === 1 ? [10, 10, 300, 60] : [10, 70, 300, 120] }] }; } }) });
  const result = await adapter.inspect({ ...f.want, candidateBytes, evidence: { ...f.want.evidence, candidateWidth: 800, candidateHeight: 80 } });
  assert.equal(result.quality.safeToApply, true);
  assert.deepEqual(result.candidateDarkOcr?.lines[0].box, [10, 10, 300, 60]);
  assert.equal(result.candidateDarkOcr?.height, 80);
  adapter.stop(); f.adapter.stop();
});
