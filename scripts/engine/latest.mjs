#!/usr/bin/env node
// latest.mjs: which extension engines the weekly canary tests this time (.github/workflows/engine-canary.yml).
//
//   node scripts/engine/latest.mjs [--version vX.Y.Z] [--preview true|false] [--github-output <file>]
//
// Prints one JSON object -- {pin, stable, preview, matrix, notes} -- and, with --github-output, writes `matrix` (the
// probe job's rows) and `summary` to that file. The rows:
//   * pin: the engine every install runs today (desktop/src/engine-pin.json), always -- the control. If it fails, it is
//     the canary (or the image under that tag) that changed, not the new engine;
//   * stable: the newest Suwayomi-Server release, when it is not the pin; or the version asked for (--version);
//   * preview: the newest Suwayomi-Server-preview release, report only (--preview, default true).
//
// ⚠️ A plain GHCR tag vX.Y.Z can be a PREVIEW build: the image repository is shared, and a stable release is the one
// whose `vX.Y.Z` has the same digest as `vX.Y.Z-stable`. So a stable row is added only when the two digests are equal;
// otherwise the release is left out (asked for by --version, it becomes a preview row) and a note says why.
//
// A stable release younger than 14 days is marked `fresh`: still settling, and upstream's first fixes land in that
// window, so the report says so instead of urging a bump.
//
// Test hooks: --api <url> (GitHub's REST API), --registry <url> (ghcr.io), --pin <file>, --now <iso>.
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const IMAGE = 'ghcr.io/suwayomi/suwayomi-server';
const FRESH_DAYS = 14;
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export async function resolveEngines(o = {}) {
  const api = (o.api ?? 'https://api.github.com').replace(/\/+$/, '');
  const registry = (o.registry ?? 'https://ghcr.io').replace(/\/+$/, '');
  const now = o.now ? Date.parse(o.now) : Date.now();
  const pin = JSON.parse(readFileSync(o.pin ?? join(ROOT, 'desktop', 'src', 'engine-pin.json'), 'utf8')).version;
  const gh = { accept: 'application/vnd.github+json', 'user-agent': 'uchiyomi-engine-canary', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) };
  const getJson = async (url, headers = gh) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  };
  let token = null;
  const digest = async (tag) => {
    token ??= (await getJson(`${registry}/token?scope=repository:suwayomi/suwayomi-server:pull`, {})).token;
    const r = await fetch(`${registry}/v2/suwayomi/suwayomi-server/manifests/${tag}`, {
      method: 'HEAD', headers: { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES }, signal: AbortSignal.timeout(20_000),
    });
    return r.ok ? r.headers.get('docker-content-digest') : null;
  };

  const notes = [];
  const matrix = [{ kind: 'pin', tag: pin, image: `${IMAGE}:${pin}`, pin, fresh: false, publishedAt: null }];
  let stable = null;
  const asked = (o.version ?? '').trim();
  if (asked && !/^v\d+\.\d+\.\d+$/.test(asked)) throw new Error(`--version ${asked} is not a release tag (vX.Y.Z)`);
  const release = asked ? await getJson(`${api}/repos/Suwayomi/Suwayomi-Server/releases/tags/${asked}`).catch(() => ({ tag_name: asked }))
    : await getJson(`${api}/repos/Suwayomi/Suwayomi-Server/releases/latest`);
  const tag = release.tag_name;
  const [plain, marked] = await Promise.all([digest(tag), digest(`${tag}-stable`)]);
  const isStable = !!plain && plain === marked;
  if (!isStable) {
    notes.push(`${IMAGE}:${tag} is not the stable build (${plain ?? 'no such tag'} vs ${tag}-stable ${marked ?? 'no such tag'})`);
  }
  if (isStable) {
    const publishedAt = release.published_at ?? null;
    const fresh = !!publishedAt && now - Date.parse(publishedAt) < FRESH_DAYS * 86_400_000;
    stable = { tag, publishedAt, fresh, digest: plain };
    if (tag !== pin) matrix.push({ kind: 'stable', tag, image: `${IMAGE}:${tag}`, pin, fresh, publishedAt });
    else notes.push(`${tag} is already the pin`);
  } else if (asked) {
    // Asked for by name and not a stable build: tested, and only reported.
    matrix.push({ kind: 'preview', tag, image: `${IMAGE}:${tag}`, pin, fresh: false, publishedAt: release.published_at ?? null });
  }

  let preview = null;
  if (o.preview !== false && !asked) {
    const [p] = await getJson(`${api}/repos/Suwayomi/Suwayomi-Server-preview/releases?per_page=1`);
    if (p?.tag_name && p.tag_name !== tag && p.tag_name !== pin) {
      preview = { tag: p.tag_name, publishedAt: p.published_at ?? null };
      matrix.push({ kind: 'preview', tag: p.tag_name, image: `${IMAGE}:preview`, pin, fresh: false, publishedAt: p.published_at ?? null });
    }
  }
  return { pin, stable, preview, matrix, notes };
}

async function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const r = await resolveEngines({
    version: opt('--version'), preview: opt('--preview') !== 'false', api: opt('--api'), registry: opt('--registry'),
    pin: opt('--pin'), now: opt('--now'), token: process.env.GITHUB_TOKEN || undefined,
  });
  console.log(JSON.stringify(r, null, 2));
  const out = opt('--github-output');
  if (out) {
    const summary = [`pin ${r.pin}`, r.stable ? `stable ${r.stable.tag}${r.stable.fresh ? ' (fresh)' : ''}` : 'no stable row', r.preview ? `preview ${r.preview.tag}` : null, ...r.notes]
      .filter(Boolean).join('; ');
    appendFileSync(out, `matrix=${JSON.stringify(r.matrix)}\nsummary=${summary.replace(/\n/g, ' ')}\n`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e?.message ?? e); process.exit(1); });
}
