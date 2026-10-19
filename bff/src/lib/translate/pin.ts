/**
 * What "Download the translation engine" fetches, each file pinned by size and SHA-256 and checked as it streams. A file
 * whose hash differs is thrown away, never used.
 *
 * - The pack: llama.cpp's llama-server built for the image (Alpine, musl), onnxruntime-web's Node build, PaddleOCR's
 *   models and the fonts. Built and published by .github/workflows/translate-pack.yml on its own prerelease, never
 *   replaced once an app version pins it (the same rules as the desktop app's extension engine pack).
 * - The model: from Hugging Face at a pinned revision. Both are Apache-2.0 and downloadable without an account.
 */
export interface PinnedFile { name: string; url: string; sha256: string; bytes: number }

export type EngineSize = 'large' | 'small';

export interface ModelPin {
  label: string;
  files: PinnedFile[];
  /** Total memory (GiB) a machine needs before Download picks this size. */
  memGiB: number;
  /** Carries draft heads: llama-server's `--spec-type draft-mtp` (about 70% of drafts accepted on this model). */
  mtp: boolean;
  /** Has a vision projector (mmproj.gguf): the model can be shown the page when the OCR looks unreliable. */
  vision: boolean;
}

export const PACK_TAG = 'translate-v1';

/** Per platform (`${process.platform}-${process.arch}`): the pack tarball on the PACK_TAG prerelease. */
export const PACKS: Record<string, PinnedFile> = {
  'linux-x64': {
    name: 'translate-pack-linux-x64.tar.gz',
    url: `https://github.com/AngeloSha/uchiyomi/releases/download/${PACK_TAG}/translate-pack-linux-x64.tar.gz`,
    sha256: '9fcc16a81c51c0425ae9c3b811fd87102031e4ef37678c9fecac6402b68c7d7c',
    bytes: 69447114,
  },
  'linux-arm64': {
    name: 'translate-pack-linux-arm64.tar.gz',
    url: `https://github.com/AngeloSha/uchiyomi/releases/download/${PACK_TAG}/translate-pack-linux-arm64.tar.gz`,
    sha256: '74cae220948e8c01a2e7f5cb997841a7bbc89eda6ac69367e62bc89d3f4a574e',
    bytes: 64710756,
  },
};

const hf = (repo: string, rev: string, file: string) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;

export const MODELS: Record<EngineSize, ModelPin> = {
  large: {
    label: 'Qwen3.6 35B-A3B',
    memGiB: 28,
    mtp: true,
    vision: true,
    files: [
      {
        name: 'model.gguf',
        url: hf('unsloth/Qwen3.6-35B-A3B-MTP-GGUF', '5bc3e238d916f48a861bac2f8a1990a0e9b7e98d', 'Qwen3.6-35B-A3B-UD-IQ4_XS.gguf'),
        sha256: 'df27a780435b7b45c2597536112ea3cb091f8544c3d0c3318d9f4258b31f7adf',
        bytes: 18209036576,
      },
      {
        name: 'mmproj.gguf',
        url: hf('unsloth/Qwen3.6-35B-A3B-MTP-GGUF', '5bc3e238d916f48a861bac2f8a1990a0e9b7e98d', 'mmproj-F16.gguf'),
        sha256: '71f3cbc1f7cc0f30d09d41cfa924c0060827ebc33bf15ace7e86661e856f0160',
        bytes: 899283584,
      },
    ],
  },
  small: {
    label: 'Qwen3 4B',
    memGiB: 0,
    mtp: false,
    vision: false,
    files: [
      {
        name: 'model.gguf',
        url: hf('unsloth/Qwen3-4B-Instruct-2507-GGUF', 'a06e946bb6b655725eafa393f4a9745d460374c9', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
        sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
        bytes: 2497281120,
      },
    ],
  },
};

export const platformKey = () => `${process.platform}-${process.arch}`;
