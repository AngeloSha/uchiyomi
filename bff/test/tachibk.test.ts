// The Mihon/Tachiyomi backup reader. Fixtures are built here rather than committed as binaries so the
// expectations stay readable, and so a schema change shows up as a parser failure rather than a mystery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'zlib';
import { titlesFromBackup } from '../src/lib/tachibk';

// --- minimal protobuf writer, just enough to build a Backup message ---
const varint = (n: number): Buffer => {
  const out: number[] = [];
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
};
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lenField = (field: number, payload: Buffer) => Buffer.concat([tag(field, 2), varint(payload.length), payload]);
const strField = (field: number, s: string) => lenField(field, Buffer.from(s, 'utf8'));
const varField = (field: number, n: number) => Buffer.concat([tag(field, 0), varint(n)]);

/** A BackupManga carrying the noise a real backup has, so we prove those fields are skipped. */
const manga = (title: string, url = '/manga/x') =>
  Buffer.concat([
    varField(1, 123456789),          // source id
    strField(2, url),                // url
    strField(3, title),              // title  <- the only field we want
    strField(4, 'Some Artist'),      // artist
    strField(6, 'A long description we must ignore'),
    strField(7, 'Action'),           // genre (repeated)
    varField(8, 1),                  // status
    varField(100, 1),                // favorite
  ]);

const backupOf = (...mangas: Buffer[]) =>
  Buffer.concat([...mangas.map((m) => lenField(1, m)), lenField(2, strField(1, 'Reading'))]); // + a category

test('extracts titles from a gzipped backup', () => {
  const file = gzipSync(backupOf(manga('Solo Leveling'), manga('Berserk'), manga('One Piece')));
  assert.deepEqual(titlesFromBackup(file), ['Solo Leveling', 'Berserk', 'One Piece']);
});

test('accepts an un-gzipped protobuf too', () => {
  assert.deepEqual(titlesFromBackup(backupOf(manga('Vinland Saga'))), ['Vinland Saga']);
});

test('skips unknown/future fields instead of failing', () => {
  const withFutureFields = Buffer.concat([
    varField(1, 1), strField(3, 'Chainsaw Man'),
    strField(999, 'a field this parser has never heard of'),
    varField(998, 42),
  ]);
  assert.deepEqual(titlesFromBackup(backupOf(withFutureFields)), ['Chainsaw Man']);
});

test('trims and de-duplicates case-insensitively, preserving order', () => {
  const file = gzipSync(backupOf(manga('  Naruto  '), manga('NARUTO'), manga('Bleach')));
  assert.deepEqual(titlesFromBackup(file), ['Naruto', 'Bleach']);
});

test('handles unicode titles', () => {
  assert.deepEqual(titlesFromBackup(backupOf(manga('鬼滅の刃'), manga('Café Ambré'))), ['鬼滅の刃', 'Café Ambré']);
});

test('rejects files that are not backups', () => {
  assert.throws(() => titlesFromBackup(Buffer.from('not a backup at all')), /backup/i);
  assert.throws(() => titlesFromBackup(gzipSync(Buffer.alloc(0))), /backup/i);
});
