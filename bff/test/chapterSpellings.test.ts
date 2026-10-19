// One chapter, one file: the two ways Uchiyomi itself saved a chapter twice (19 Oct 2026, the owner's library).
//
//  - Natomanga's chapter list carried chapter 1 a second time numbered -1, at the same address. The library did not hold
//    -1, so it was downloaded as `Chapter -1.cbz`, which every scan reads as chapter 1: ten series held chapter 1 twice.
//  - Natomanga numbers one chapter 84.29999999999998; the database gives it back as 84.3. A task holding one spelling
//    looked for the file named by it and missed the one another task had just written under the other.
//
// No database: the source registry, the downloader's own path check and the have-set are all in memory.
process.env.MIN_FREE_GB = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'yomi-spell-'));
process.env.DL_ROOT = ROOT;
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('a chapter a source numbers below zero is never listed', async () => {
  const { registerAdapter, unregisterAdapter, getSource } = await import('../src/lib/sources/loader');
  // Natomanga's answer for Pick Me Up, as the engine turned it into chapters: 1 twice, once as -1, at one address.
  const raw = [
    { sourceId: 'https://n.example/pick-me-up/chapter-1', number: 1, title: 'Chapter 1' },
    { sourceId: 'https://n.example/pick-me-up/chapter-1', number: -1, title: 'Chapter -1' },
    { sourceId: 'https://n.example/pick-me-up/chapter-2', number: 2, title: 'Chapter 2' },
  ];
  const adapter = {
    id: 'spell-neg', name: 'Negative Source',
    search: async () => [], getSeries: async () => null, getPageUrls: async () => [],
    listChapters: async () => raw,
  };
  assert.ok(registerAdapter(adapter as any));
  const listed = await getSource('spell-neg')!.listChapters('pick-me-up');
  assert.deepEqual(listed.map((c) => c.number), [1, 2], 'the -1 is gone; chapter 1 and 2 are as the source sent them');
  assert.equal(raw.length, 3, "the adapter's own array is left alone");

  // Switched off and on again (a MangaDex language does this): the same object, wrapped once.
  assert.ok(unregisterAdapter('spell-neg'));
  assert.ok(registerAdapter(adapter as any));
  assert.deepEqual((await getSource('spell-neg')!.listChapters('pick-me-up')).map((c) => c.number), [1, 2]);
  unregisterAdapter('spell-neg');
});

test('a chapter saved under another spelling of its number is not fetched again', async () => {
  const { downloadChapter } = await import('../src/lib/downloader');
  const { registerAdapter, unregisterAdapter } = await import('../src/lib/sources/loader');
  let asked = 0;
  registerAdapter({
    id: 'spell-dl', name: 'Spelling Source',
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async () => { asked++; return []; },
  } as any);
  // The last check before the source is asked (the slot has opened): saying "paused" there proves a download got past
  // the path check, without asking the source or writing a file.
  const paused = { preflight: async () => 'paused' as const };
  const folder = 'Aqua Manga (EN)/Standard of Reincarnation';
  const download = (number: number) => downloadChapter({ sourceId: 'spell-dl', seriesFolder: folder, chapter: { sourceId: `c${number}`, number } }, paused)
    .then((r) => r, (e) => e);
  mkdirSync(join(ROOT, folder), { recursive: true });
  try {
    // What the first task wrote, from the source's own number.
    writeFileSync(join(ROOT, folder, 'Chapter 84.29999999999998.cbz'), 'pages');
    assert.equal(await download(84.3), null, "the database's 84.3 finds the file saved as 84.29999999999998");

    // And the other way round.
    writeFileSync(join(ROOT, folder, 'Chapter 12.cbz'), 'pages');
    assert.equal(await download(12.0000001), null, 'a source\'s 12.0000001 finds `Chapter 12.cbz`');

    // Another chapter is still fetched: 84.2 is not 84.3, and the `Chapter -1.cbz` beside it is not chapter 1.
    writeFileSync(join(ROOT, folder, 'Chapter -1.cbz'), 'pages');
    for (const number of [84.2, 1]) {
      assert.equal((await download(number))?.name, 'DownloadPreflightError', `chapter ${number} goes on to be fetched`);
    }
    assert.equal(asked, 0, 'and nothing here ever reached the source');
  } finally {
    unregisterAdapter('spell-dl');
  }
});
