// What "Download the translation engine" fetches (lib/translate/pin.ts) is pinned before a release ships: each platform's
// pack by SHA-256 and size on its translate-v* prerelease (translate-pack.yml publishes it; the hashes are written here
// afterwards), and each model file by SHA-256 and size at a fixed Hugging Face revision. A placeholder left in would
// fail every Download with "did not match its checksum". No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODELS, PACK_TAG, PACKS } from '../src/lib/translate/pin';

const HEX64 = /^[0-9a-f]{64}$/;

test('every platform\'s pack is pinned, on the tag the workflow publishes', () => {
  assert.match(PACK_TAG, /^translate-v\d+$/, 'never a v* tag: release.yml would build images for it');
  assert.deepEqual(Object.keys(PACKS).sort(), ['linux-arm64', 'linux-x64']);
  for (const [platform, p] of Object.entries(PACKS)) {
    assert.equal(p.name, `translate-pack-${platform}.tar.gz`);
    assert.equal(p.url, `https://github.com/AngeloSha/uchiyomi/releases/download/${PACK_TAG}/${p.name}`);
    // Reintroduce by leaving the zeros the pack was written with: every Download fails on the pack.
    assert.match(p.sha256, HEX64, platform);
    assert.notEqual(p.sha256, '0'.repeat(64), `${platform}: the pack is not pinned yet (publish ${PACK_TAG}, then write its sha256 and size here)`);
    assert.ok(p.bytes > 1_000_000, `${platform}: ${p.bytes} bytes`);
  }
  // The workflow reads the tag from the source with this exact shape.
  assert.match(readFileSync(join(__dirname, '..', 'src', 'lib', 'translate', 'pin.ts'), 'utf8'), /^export const PACK_TAG = 'translate-v\d+';$/m);
});

test('every model file is pinned by checksum and size at a fixed revision', () => {
  for (const [size, m] of Object.entries(MODELS)) {
    assert.ok(m.files.some((f) => f.name === 'model.gguf'), size);
    for (const f of m.files) {
      assert.match(f.sha256, HEX64, `${size}/${f.name}`);
      assert.ok(f.bytes > 100_000_000, `${size}/${f.name}`);
      // Reintroduce a branch name (resolve/main/): the file behind the URL can change under the pin.
      assert.match(f.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/[^/]+\.gguf$/, `${size}/${f.name}`);
    }
    assert.equal(m.vision, m.files.some((f) => f.name === 'mmproj.gguf'), `${size}: vision is having the projector`);
  }
  assert.ok(MODELS.large.memGiB > MODELS.small.memGiB);
});
