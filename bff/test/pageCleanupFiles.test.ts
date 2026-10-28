import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { applyPageCleanup, previewPageCleanup, pageCleanupMetadata, CLEANUP_MANIFEST } from '../src/lib/pageCleanupFiles';
import { zipEntryCapped } from '../src/lib/archiveCaps';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StreamZip = require('node-stream-zip');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uchiyomi-page-cleanup-'));
  const file = join(root, 'Chapter 1.cbz');
  const bytes = await Promise.all(['red', 'green', 'blue'].map((background) => sharp({ create: { width: 120, height: 180, channels: 3, background } }).png().toBuffer()));
  const zip = new AdmZip();
  bytes.forEach((b, i) => zip.addFile(`pages/${String(i + 1).padStart(3, '0')}.png`, b));
  zip.addFile('ComicInfo.xml', Buffer.from('<ComicInfo><Title>Unchanged title</Title></ComicInfo>'));
  await writeFile(file, zip.toBuffer()); await chmod(file, 0o640);
  return { root, file, bytes, target: { bookId: 'saved-chapter-id', file, store: join(root, 'trash') },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function entry(file: string, name: string) {
  const zip = new StreamZip.async({ file });
  try { return await zipEntryCapped(zip, name); } finally { await zip.close(); }
}

test('removing an image keeps every page name/number and restores its exact original bytes', async () => {
  const f = await fixture();
  try {
    const preview = await previewPageCleanup(f.target);
    const removed = await applyPageCleanup(f.target, 'remove', [2], preview.revision);
    assert.deepEqual(removed.pages.map((p) => [p.number, p.name, p.removed]), [[1, 'pages/001.png', false], [2, 'pages/002.png', true], [3, 'pages/003.png', false]]);
    assert.deepEqual(await entry(f.file, 'pages/001.png'), f.bytes[0]);
    assert.deepEqual(await entry(f.file, 'pages/003.png'), f.bytes[2]);
    assert.notDeepEqual(await entry(f.file, 'pages/002.png'), f.bytes[1]);
    assert.equal((await sharp(await entry(f.file, 'pages/002.png')).metadata()).format, 'png');
    assert.deepEqual(JSON.parse((await entry(f.file, CLEANUP_MANIFEST)).toString()).removed.map((p: any) => p.page), [2]);
    assert.deepEqual([...((await pageCleanupMetadata(f.target)).removed)], [2]);
    assert.equal((await stat(f.file)).mode & 0o777, 0o640);
    const restored = await applyPageCleanup(f.target, 'restore', [2], removed.revision);
    assert.deepEqual(restored.pages.map((p) => p.removed), [false, false, false]);
    assert.deepEqual(await entry(f.file, 'pages/002.png'), f.bytes[1]);
    assert.match((await entry(f.file, 'ComicInfo.xml')).toString(), /Unchanged title/);
    assert.match((await pageCleanupMetadata(f.target)).revision!, /^[a-f0-9]{64}$/);
    assert.equal(restored.retainedBytes, f.bytes[1].length, 'restored originals still consume retained storage until explicitly cleared');
    assert.equal(restored.unusedRetainedImages, 1);
    assert.equal(restored.pages[1].bytes, f.bytes[1].length);
    const cleared = await applyPageCleanup(f.target, 'purge-unused', [], restored.revision);
    assert.equal(cleared.retainedBytes, 0);
  } finally { await f.cleanup(); }
});

test('deduplicated originals are retained while any unpurged removed slot needs them', async () => {
  const f = await fixture();
  try {
    const z = new AdmZip(); z.addFile('001.png', f.bytes[0]); z.addFile('002.png', f.bytes[0]); z.addFile('003.png', f.bytes[2]);
    await writeFile(f.file, z.toBuffer());
    const before = await previewPageCleanup(f.target);
    const removed = await applyPageCleanup(f.target, 'remove', [1, 2], before.revision);
    assert.equal(removed.retainedBytes, f.bytes[0].length, 'identical originals share one verified blob');
    assert.equal(removed.pages[0].bytes, (await entry(f.file, '001.png')).length);
    const purged = await applyPageCleanup(f.target, 'purge', [1], removed.revision);
    assert.equal(purged.pages[0].restorable, false); assert.equal(purged.pages[1].restorable, true);
    assert.equal(purged.retainedBytes, f.bytes[0].length, 'page two still needs the shared original');
    await assert.rejects(applyPageCleanup(f.target, 'restore', [1], purged.revision), /permanently deleted/);
    await assert.rejects(applyPageCleanup(f.target, 'restore', [2], removed.revision), /changed since the preview/);
    const restored = await applyPageCleanup(f.target, 'restore', [2], purged.revision);
    assert.deepEqual(await entry(f.file, '002.png'), f.bytes[0]);
    assert.equal(restored.unusedRetainedBytes, f.bytes[0].length);
    const cleared = await applyPageCleanup(f.target, 'purge-unused', [], restored.revision);
    assert.equal(cleared.retainedBytes, 0);
    assert.equal(cleared.pages[0].removed, true); assert.equal(cleared.pages[0].restorable, false);
  } finally { await f.cleanup(); }
});

test('interruption after a purge journal keeps originals unused until an explicit cleanup retries unlink', async () => {
  const f = await fixture();
  try {
    const before = await previewPageCleanup(f.target);
    const removed = await applyPageCleanup(f.target, 'remove', [2], before.revision);
    await assert.rejects(applyPageCleanup(f.target, 'purge', [2], removed.revision, {
      beforeUnlink: async () => { throw new Error('interrupted before unlink'); },
    }), /interrupted before unlink/);
    const pending = await previewPageCleanup(f.target);
    assert.equal(pending.pages[1].removed, true); assert.equal(pending.pages[1].restorable, false);
    assert.equal(pending.unusedRetainedBytes, f.bytes[1].length);
    assert.equal((await pageCleanupMetadata(f.target)).restorable.size, 0);
    await assert.rejects(applyPageCleanup(f.target, 'restore', [2], pending.revision), /permanently deleted/);
    const cleared = await applyPageCleanup(f.target, 'purge-unused', [], pending.revision);
    assert.equal(cleared.retainedBytes, 0);
  } finally { await f.cleanup(); }
});

test('copied cleanup archives explain removed slots but cannot access another chapter\'s trash', async () => {
  const f = await fixture();
  try {
    const before = await previewPageCleanup(f.target);
    await applyPageCleanup(f.target, 'remove', [2], before.revision);
    const copied = { ...f.target, bookId: 'another-chapter', file: join(f.root, 'Copied.cbz') };
    await writeFile(copied.file, await readFile(f.file));
    const metadata = await pageCleanupMetadata(copied);
    assert.deepEqual([...metadata.removed], [2]); assert.deepEqual([...metadata.restorable], []);
    await assert.rejects(previewPageCleanup(copied), /original page trash is required/);
  } finally { await f.cleanup(); }
});

test('a stale preview or a replacement archive cannot receive removed pages', async () => {
  const f = await fixture();
  try {
    const before = await previewPageCleanup(f.target);
    const removed = await applyPageCleanup(f.target, 'remove', [1], before.revision);
    await assert.rejects(applyPageCleanup(f.target, 'remove', [2], before.revision), /changed since the preview/);
    const replacement = new AdmZip(); replacement.addFile('001.png', f.bytes[2]); await writeFile(f.file, replacement.toBuffer());
    const kept = await readFile(f.file);
    await assert.rejects(applyPageCleanup(f.target, 'restore', [1], removed.revision), /replaced outside page cleanup/);
    assert.deepEqual(await readFile(f.file), kept);
    assert.equal((await pageCleanupMetadata(f.target)).stale, true);
  } finally { await f.cleanup(); }
});

test('a failure after durable journal preparation leaves the original readable and a retry can recover', async () => {
  const f = await fixture();
  try {
    const before = await previewPageCleanup(f.target);
    const original = await readFile(f.file);
    await assert.rejects(applyPageCleanup(f.target, 'remove', [2], before.revision, { beforeReplace: async () => { throw new Error('simulated interruption'); } }), /simulated interruption/);
    assert.deepEqual(await readFile(f.file), original);
    assert.deepEqual([...((await pageCleanupMetadata(f.target)).removed)], []);
    const removed = await applyPageCleanup(f.target, 'remove', [2], before.revision);
    assert.deepEqual([...((await pageCleanupMetadata(f.target)).removed)], [2]);
    await applyPageCleanup(f.target, 'restore', [2], removed.revision);
    assert.deepEqual(await entry(f.file, 'pages/002.png'), f.bytes[1]);
  } finally { await f.cleanup(); }
});

test('an external writer at the actual replacement boundary wins without being overwritten', async () => {
  const f = await fixture();
  try {
    const before = await previewPageCleanup(f.target);
    const external = Buffer.from('another program replaced this file');
    await assert.rejects(applyPageCleanup(f.target, 'remove', [2], before.revision, { beforeReplace: () => writeFile(f.file, external) }), /Another program changed/);
    assert.deepEqual(await readFile(f.file), external);
  } finally { await f.cleanup(); }
});

test('corrupt saved bytes refuse restoration and all real pages cannot be removed', async () => {
  const f = await fixture();
  try {
    const before = await previewPageCleanup(f.target);
    await assert.rejects(applyPageCleanup(f.target, 'remove', [1, 2, 3], before.revision), /at least one real page/);
    const removed = await applyPageCleanup(f.target, 'remove', [2], before.revision);
    const [dir] = await readdir(f.target.store);
    const blob = (await readdir(join(f.target.store, dir))).find((n) => n.endsWith('.bin'))!;
    await writeFile(join(f.target.store, dir, blob), Buffer.alloc(f.bytes[1].length));
    const kept = await readFile(f.file);
    await assert.rejects(applyPageCleanup(f.target, 'restore', [2], removed.revision), /failed verification/);
    assert.deepEqual(await readFile(f.file), kept);
  } finally { await f.cleanup(); }
});

test('unsupported formats and partial downloads keep the physical editor closed', async () => {
  const f = await fixture();
  try {
    await assert.rejects(previewPageCleanup({ ...f.target, file: f.file.replace(/cbz$/, 'cbr') }), /local CBZ files only/);
    const zip = new AdmZip(); zip.addFile('001.png', f.bytes[0]); zip.addFile('uchiyomi-partial.json', Buffer.from('{}')); await writeFile(f.file, zip.toBuffer());
    await assert.rejects(previewPageCleanup(f.target), /Finish downloading/);
  } finally { await f.cleanup(); }
});
