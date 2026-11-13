// The Mihon/Tachiyomi backup reader. Fixtures are built here rather than committed as binaries so the
// expectations stay readable, and so a schema change shows up as a parser failure rather than a mystery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'zlib';
import { titlesFromBackup, entriesFromBackup, READ_NUMBERS_MAX } from '../src/lib/tachibk';

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
  // Reintroduce by dropping the gzip-magic branch in entriesFromBackup (reading every file as raw protobuf).
  const file = gzipSync(backupOf(manga('Solo Leveling'), manga('Berserk'), manga('One Piece')));
  assert.deepEqual(titlesFromBackup(file), ['Solo Leveling', 'Berserk', 'One Piece']);
});

test('accepts an un-gzipped protobuf too', () => {
  // Reintroduce by gunzipping unconditionally in entriesFromBackup: a raw protobuf is not a gzip stream.
  assert.deepEqual(titlesFromBackup(backupOf(manga('Vinland Saga'))), ['Vinland Saga']);
});

test('skips unknown/future fields instead of failing', () => {
  // Reintroduce by throwing in entryOfManga for a field number it does not know, instead of skip()ping it.
  const withFutureFields = Buffer.concat([
    varField(1, 1), strField(3, 'Chainsaw Man'),
    strField(999, 'a field this parser has never heard of'),
    varField(998, 42),
  ]);
  assert.deepEqual(titlesFromBackup(backupOf(withFutureFields)), ['Chainsaw Man']);
});

test('trims and de-duplicates case-insensitively, preserving order', () => {
  // Reintroduce by keying `seen` on the raw title instead of its trimmed lower-case form.
  const file = gzipSync(backupOf(manga('  Naruto  '), manga('NARUTO'), manga('Bleach')));
  assert.deepEqual(titlesFromBackup(file), ['Naruto', 'Bleach']);
});

test('handles unicode titles', () => {
  // Reintroduce by decoding the title bytes as 'latin1' instead of 'utf8'.
  assert.deepEqual(titlesFromBackup(backupOf(manga('鬼滅の刃'), manga('Café Ambré'))), ['鬼滅の刃', 'Café Ambré']);
});

const floatField=(field:number,n:number)=>{const b=Buffer.alloc(4);b.writeFloatLE(n);return Buffer.concat([tag(field,5),b]);};
const tracking=(provider:number,id:bigint,progress:number,privateEntry=false)=>lenField(18,Buffer.concat([
  varField(1,provider),varFieldBig(2,999999n),varFieldBig(100,id),strField(5,'Alternative tracker title'),floatField(6,progress),varField(12,privateEntry ? 1 : 0),
]));
test('reads multiple official Mihon tracker identities, progress and privacy without using account library IDs',()=> {
  const raw=Buffer.concat([manga('Tracked manga'),tracking(1,17n,14.75),tracking(2,42n,150,true),tracking(3,14916n,5),tracking(7,1234n,0),tracking(6,999n,999)]);
  const [entry]=entriesFromBackup(backupOf(raw));
  assert.deepEqual(entry.trackerLinks?.map(t=>[t.provider,t.externalId,t.progress,t.private]),[
    ['myanimelist','17',14,false],['anilist','42',150,true],['kitsu','14916',5,false],['mangaupdates','1234',0,false],
  ]);
  assert.equal(entry.trackerLinks?.[0].title,'Alternative tracker title');
});
test('legacy mediaIdInt takes Mihon precedence; malformed progress and unsafe tracker identities cannot seed progress',()=> {
  const raw=Buffer.concat([manga('Legacy tracker'),lenField(18,Buffer.concat([varField(1,2),varFieldBig(2,99n),varField(3,17),varFieldBig(100,42n),floatField(6,NaN)])),tracking(1,9007199254740993n,10)]);
  assert.deepEqual(entriesFromBackup(backupOf(raw))[0].trackerLinks?.map(t=>[t.externalId,t.progress]),[['17',0]]);
});
test('duplicate manga rows preserve supported tracker links and the strongest privacy requirement',()=> {
  const raw=backupOf(Buffer.concat([manga('Repeated'),tracking(2,42n,10)]),Buffer.concat([manga('REPEATED'),tracking(2,42n,20,true),tracking(1,17n,18)]));
  const entries=entriesFromBackup(raw);assert.equal(entries.length,1);
  assert.deepEqual(entries[0].trackerLinks?.map(t=>[t.provider,t.progress,t.private]),[['anilist',20,true],['myanimelist',18,false]]);
});
/**
 * A BackupChapter as Mihon writes one: `read` (4) and `chapterNumber` (9) only when they are not their default, and a
 * page (6) on a chapter left partway, which the parser must not mistake for a read.
 */
const chapter = (number: number, read: boolean, lastPageRead = 0) => lenField(16, Buffer.concat([
  strField(1, `/chapter/${number}`), strField(2, `Chapter ${number}`),
  ...(read ? [varField(4, 1)] : []), ...(lastPageRead ? [varField(6, lastPageRead)] : []),
  ...(number !== 0 ? [floatField(9, number)] : []),
]));
test('reads the numbers of the chapters marked read, and nothing else about a chapter (#433)', () => {
  // Reintroduce by dropping the field-16 branch in entryOfManga: readNumbers is undefined. By keeping a chapter whatever
  // its read flag: 3, left on page 12, comes through. By dropping `number >= 0`: Mihon's -1, "not recognised", does.
  const raw = Buffer.concat([manga('Read manga'), chapter(1, true), chapter(2.5, true), chapter(3, false, 12), chapter(-1, true), chapter(1, true)]);
  assert.deepEqual(entriesFromBackup(backupOf(raw))[0].readNumbers, [1, 2.5]);
  // A number Mihon left out is its default, chapter 0. Reintroduce by starting readNumberOf's number at -1: 0 is lost.
  assert.deepEqual(entriesFromBackup(backupOf(Buffer.concat([manga('Prologue'), chapter(0, true)])))[0].readNumbers, [0]);
  assert.equal(entriesFromBackup(backupOf(Buffer.concat([manga('Unread'), chapter(1, false)])))[0].readNumbers, undefined, 'nothing read, no list');
});
test('the same title twice reads as the chapters read on either, and a long series stops at the cap (#433)', () => {
  // Reintroduce by keeping only the first occurrence's numbers in entriesFromBackup: [1] instead of [1, 2]. Drop the
  // cap in entryOfManga and one entry asks to mark 5,001 numbers.
  const twice = backupOf(Buffer.concat([manga('Twice'), chapter(1, true)]), Buffer.concat([manga('TWICE'), chapter(2, true), chapter(1, true)]));
  assert.deepEqual(entriesFromBackup(twice)[0].readNumbers, [1, 2]);
  const long = Buffer.concat([manga('Long'), ...Array.from({ length: READ_NUMBERS_MAX + 1 }, (_, i) => chapter(i + 1, true))]);
  const [entry] = entriesFromBackup(backupOf(long));
  assert.equal(entry.readNumbers?.length, READ_NUMBERS_MAX);
  assert.equal(entry.readNumbers?.[0], 1);
});

test('truncated nested metadata is rejected instead of reading bytes outside its message',()=> {
  const broken=Buffer.concat([manga('Broken'),tag(18,2),varint(999),Buffer.from([1])]);
  assert.throws(()=>entriesFromBackup(backupOf(broken)),/could not read/);
});

test('rejects files that are not backups', () => {
  // Reintroduce by returning [] from entriesFromBackup when no entry was found, instead of throwing.
  assert.throws(() => titlesFromBackup(Buffer.from('not a backup at all')), /backup/i);
  assert.throws(() => titlesFromBackup(gzipSync(Buffer.alloc(0))), /backup/i);
});

test('entriesFromBackup reads the Mihon source id and url alongside the title', () => {
  // Reintroduce by skip()ping field 1 or field 2 in entryOfManga the way every other field is skipped.
  const entries = entriesFromBackup(backupOf(manga('One Piece', '/manga/one-piece', 2499283573021220255n)));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'One Piece');
  assert.equal(entries[0].url, '/manga/one-piece');
  assert.equal(entries[0].sourceIdUnsigned, '2499283573021220255');
  assert.equal(entries[0].sourceIdSigned, '2499283573021220255'); // positive: signed === unsigned
});

test('entriesFromBackup keeps full precision above 2^53, where float varint math would round', () => {
  // Reintroduce by reading field 1 with readVarint (float) instead of readVarintBig.
  // 2^53 = 9007199254740992; pick an id well past it that is NOT a round number in float space.
  const huge = 9007199254740993n; // 2^53 + 1 — the canonical "floats can't represent this exactly" value
  const entries = entriesFromBackup(backupOf(manga('Precision Test', '/x', huge)));
  assert.equal(entries[0].sourceIdUnsigned, huge.toString());
});

test('entriesFromBackup renders a negative (high-bit-set) source id both signed and unsigned', () => {
  // Reintroduce by rendering sourceIdSigned from the raw unsigned value (dropping BigInt.asIntN(64, …)).
  // Some Mihon source ids are computed from a hash and land with the top bit set, i.e. negative as a
  // Kotlin Long. The wire form is the same either way; only interpretation differs.
  const negative = -6570644787331134784n;
  const entries = entriesFromBackup(backupOf(manga('Negative Id Test', '/x', negative)));
  assert.equal(entries[0].sourceIdSigned, negative.toString());
  assert.equal(entries[0].sourceIdUnsigned, BigInt.asUintN(64, negative).toString());
});

test('entriesFromBackup returns null title guard: an entry with no title is dropped, not crashed on', () => {
  // Reintroduce by pushing every entry in entriesFromBackup without its `entry && clean` check: the
  // titleless one comes through as a crash (undefined title), not as a dropped row.
  const noTitle = Buffer.concat([varFieldBig(1, 1n), strField(2, '/x')]); // no field 3
  const entries = entriesFromBackup(backupOf(noTitle, manga('Real Title')));
  assert.deepEqual(entries.map((e) => e.title), ['Real Title']);
});

test('a gzipped file that inflates past the cap is refused with a sentence about the file, not a Buffer', () => {
  // Reintroduce by calling gunzipSync(file) with no `maxOutputLength` in entriesFromBackup: the 12 MB body
  // limit is then no limit at all (gzip packs zeros ~1000:1), and the small-cap call below parses instead
  // of throwing. Reintroduce the second assertion alone by rethrowing zlib's RangeError untouched: the
  // admin then reads "Cannot create a Buffer larger than 16 bytes" as the reason their backup was refused.
  const file = gzipSync(backupOf(manga('Solo Leveling'), manga('Berserk')));
  assert.ok(file.length > 16, 'PREMISE: the fixture is bigger than the cap it is tested against');
  assert.throws(() => entriesFromBackup(file, 16), /inflates to more than 0 MB, which no Mihon\/Tachiyomi backup does/);
  // The cap is a ceiling, not a guess at the size: a file that fits exactly still parses, and the default
  // cap (256 MB) is far above any real backup, so ordinary files never see it.
  const raw = backupOf(manga('Solo Leveling'), manga('Berserk'));
  assert.deepEqual(entriesFromBackup(gzipSync(raw), raw.length).map((e) => e.title), ['Solo Leveling', 'Berserk']);
  assert.deepEqual(entriesFromBackup(file).map((e) => e.title), ['Solo Leveling', 'Berserk']);
});
