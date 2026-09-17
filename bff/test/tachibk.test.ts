// The Mihon/Tachiyomi backup reader. Fixtures are built here rather than committed as binaries so the
// expectations stay readable, and so a schema change shows up as a parser failure rather than a mystery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'zlib';
import { titlesFromBackup, entriesFromBackup } from '../src/lib/tachibk';

// --- minimal protobuf writer, just enough to build a Backup message ---
const varint = (n: number): Buffer => {
  const out: number[] = [];
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
};
/** BigInt varint writer, for source ids that exceed 2^53 (readVarint's float precision limit). */
const varintBig = (n: bigint): Buffer => {
  const out: number[] = [];
  let v = n < 0n ? BigInt.asUintN(64, n) : n; // protobuf int64 (not sint64): raw two's-complement bit pattern
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return Buffer.from(out);
};
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lenField = (field: number, payload: Buffer) => Buffer.concat([tag(field, 2), varint(payload.length), payload]);
const strField = (field: number, s: string) => lenField(field, Buffer.from(s, 'utf8'));
const varField = (field: number, n: number) => Buffer.concat([tag(field, 0), varint(n)]);
const varFieldBig = (field: number, n: bigint) => Buffer.concat([tag(field, 0), varintBig(n)]);

/** A BackupManga carrying the noise a real backup has, so we prove those fields are skipped. */
const manga = (title: string, url = '/manga/x', sourceId: bigint = 123456789n) =>
  Buffer.concat([
    varFieldBig(1, sourceId),        // source id
    strField(2, url),                // url
    strField(3, title),              // title  <- the only field titlesFromBackup wants
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

test('entriesFromBackup reads the Mihon source id and url alongside the title', () => {
  const entries = entriesFromBackup(backupOf(manga('One Piece', '/manga/one-piece', 2499283573021220255n)));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'One Piece');
  assert.equal(entries[0].url, '/manga/one-piece');
  assert.equal(entries[0].sourceIdUnsigned, '2499283573021220255');
  assert.equal(entries[0].sourceIdSigned, '2499283573021220255'); // positive: signed === unsigned
});

test('entriesFromBackup keeps full precision above 2^53, where float varint math would round', () => {
  // 2^53 = 9007199254740992; pick an id well past it that is NOT a round number in float space.
  const huge = 9007199254740993n; // 2^53 + 1 — the canonical "floats can't represent this exactly" value
  const entries = entriesFromBackup(backupOf(manga('Precision Test', '/x', huge)));
  assert.equal(entries[0].sourceIdUnsigned, huge.toString());
});

test('entriesFromBackup renders a negative (high-bit-set) source id both signed and unsigned', () => {
  // Some Mihon source ids are computed from a hash and land with the top bit set, i.e. negative as a
  // Kotlin Long. The wire form is the same either way; only interpretation differs.
  const negative = -6570644787331134784n;
  const entries = entriesFromBackup(backupOf(manga('Negative Id Test', '/x', negative)));
  assert.equal(entries[0].sourceIdSigned, negative.toString());
  assert.equal(entries[0].sourceIdUnsigned, BigInt.asUintN(64, negative).toString());
});

test('entriesFromBackup returns null title guard: an entry with no title is dropped, not crashed on', () => {
  const noTitle = Buffer.concat([varFieldBig(1, 1n), strField(2, '/x')]); // no field 3
  const entries = entriesFromBackup(backupOf(noTitle, manga('Real Title')));
  assert.deepEqual(entries.map((e) => e.title), ['Real Title']);
});
