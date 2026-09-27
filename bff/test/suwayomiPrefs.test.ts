// An extension's own settings (#116, lib/sources/suwayomi/prefs.ts), against the fake v2.3.2243 engine.
//
// The fake answers the product's own query strings with the pinned schema's validation, and models the one
// behaviour this module exists to get right: updateSourcePreference addresses a POSITION on the screen the last
// read built (Source.setSourcePreference). Its prefWrites log names the key each write actually landed on.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSuwayomi, suwayomiQueryErrors, SOURCE_IDS, SEQUENTIAL_KEY, type FakeSuwayomi } from './fixtures/fakeSuwayomi';

process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';

const load = () => import('../src/lib/sources/suwayomi/prefs');
const WT = SOURCE_IDS.webtoons;

let fake: FakeSuwayomi;
/** The product's transport, in process: what `gql` does with an `errors` answer. */
const run = (async (query: string, variables: Record<string, unknown> = {}) => {
  const r = await fake.query(query, variables);
  if (r.errors?.length) throw new Error(`suwayomi: ${r.errors[0].message}`);
  return r.data;
}) as never;

before(async () => { fake = await startFakeSuwayomi(); });
after(async () => { await fake?.close(); });

test('the read and every kind of write are queries the pinned engine accepts', async () => {
  const { SOURCE_PREFS_Q, updatePrefMutation } = await load();
  // Reintroduce by selecting a field the schema does not have (`preferences { key }` on the union): the engine
  // refuses the whole read and the settings sheet is empty.
  assert.deepEqual(suwayomiQueryErrors(SOURCE_PREFS_Q), []);
  for (const t of ['switch', 'checkbox', 'list', 'multiselect', 'text'] as const) {
    assert.deepEqual(suwayomiQueryErrors(updatePrefMutation(t)), [], `the ${t} write`);
  }
  // Only the one state field of the kind is sent: the engine reads the field of the preference's class.
  assert.match(updatePrefMutation('list'), /change:\{position:\$position,listState:\$value\}/);
  assert.doesNotMatch(updatePrefMutation('list'), /switchState|multiSelectState/);
});

test('all five kinds of preference come back in one shape, in screen order', async () => {
  fake.reset();
  const { readSourcePrefs } = await load();
  const r = await readSourcePrefs(WT, run);
  assert.equal(r.source.id, WT);
  assert.equal(r.source.pkgName, 'eu.kanade.tachiyomi.extension.all.webtoons');
  assert.deepEqual(r.siblings.map((s) => s.id), [WT], 'the extension\'s sources, for the language select');
  const byKey = new Map(r.preferences.map((p) => [p.key, p]));
  assert.deepEqual(r.preferences.map((p) => [p.key, p.type, p.position]), [
    [SEQUENTIAL_KEY, 'switch', 0], ['showAuthorsNotes', 'checkbox', 1], ['imageQuality', 'list', 2],
    ['hiddenGenres', 'multiselect', 3], ['customUserAgent', 'text', 4], ['legacyViewer', 'switch', 5],
  ]);
  assert.deepEqual([byKey.get(SEQUENTIAL_KEY)!.value, byKey.get(SEQUENTIAL_KEY)!.default], [false, false]);
  assert.equal(byKey.get('imageQuality')!.value, 'high');
  assert.deepEqual(byKey.get('imageQuality')!.entryValues, ['high', 'medium', 'low']);
  assert.deepEqual(byKey.get('hiddenGenres')!.value, []);
  assert.equal(byKey.get('customUserAgent')!.value, '');
  assert.equal(byKey.get('customUserAgent')!.dialogTitle, 'User agent');
  assert.equal(byKey.get('legacyViewer')!.enabled, false);
  // Reintroduce by computing `numbering` as false in toPrefs (never calling isNumberingPref): "the numbering
  // switch is recognised" fails, and the sheet shows no warning before a change that renumbers a library.
  assert.equal(byKey.get(SEQUENTIAL_KEY)!.numbering, true, 'the numbering switch is recognised');
  assert.deepEqual(r.preferences.filter((p) => p.numbering).map((p) => p.key), [SEQUENTIAL_KEY], 'and nothing else is');
});

test('a write addressed by key lands on that key after the extension changes its screen', async () => {
  fake.reset();
  const { readSourcePrefs, writeSourcePref } = await load();
  // What a browser saw when it opened the sheet: the sequential switch first.
  const seen = await readSourcePrefs(WT, run);
  assert.equal(seen.preferences[0].key, SEQUENTIAL_KEY);
  // An extension update adds a switch at the top of its screen before the sequential one is flipped, and
  // something else -- the engine's own web UI, Mihon -- opens the source's settings, which rebuilds the screen
  // the engine resolves positions on.
  const src = fake.source(WT);
  src.preferences.unshift({ kind: 'switch', key: 'blurCovers', title: 'Blur covers', default: false });
  assert.deepEqual((await fake.query(`{ source(id:"${WT}") { preferences { __typename } } }`)).errors, undefined);
  // Reintroduce by writing at a position remembered from the earlier read (keep a per-source copy of the last
  // screen in readSourcePrefs and resolve the key on it here instead of reading again): the write lands, without
  // a word from the engine, on the new switch at position 0 -- "the write landed on another preference".
  const w = await writeSourcePref(WT, SEQUENTIAL_KEY, true, run);
  assert.deepEqual(fake.prefWrites.map((x) => [x.position, x.key, x.value]), [[1, SEQUENTIAL_KEY, true]], 'the write landed on another preference');
  assert.equal(src.prefValues[SEQUENTIAL_KEY], true);
  assert.deepEqual([w.changed, w.applied, w.before.value, w.after?.value], [true, true, false, true]);
  assert.equal(src.prefValues.blurCovers, undefined, 'the switch that took its old place is untouched');
});

test('positions count the whole screen, including what the sheet does not offer', async () => {
  fake.reset();
  const { readSourcePrefs, writeSourcePref } = await load();
  // A preference with no key (a heading-like entry the extension never persists) at the top, and a second list
  // right after "Image quality".
  const src = fake.source(WT);
  src.preferences.unshift({ kind: 'switch', key: undefined as unknown as string, title: 'Advanced', default: false });
  src.preferences.splice(4, 0, { kind: 'list', key: 'readingMode', title: 'Reading mode', entries: ['Vertical', 'Paged'], entryValues: ['vertical', 'paged'], default: 'paged' });
  const r = await readSourcePrefs(WT, run);
  assert.equal(r.preferences.some((p) => p.title === 'Advanced'), false, 'a keyless preference cannot be addressed, so it is not offered');
  // Reintroduce by addressing the index in the offered list (`preferences.indexOf(before)`) instead of the
  // screen position: the write goes one place too early, onto "Image quality", which takes 'vertical' without
  // a word -- the engine checks no list value.
  await writeSourcePref(WT, 'readingMode', 'vertical', run);
  assert.deepEqual(fake.prefWrites.map((x) => [x.position, x.key]), [[4, 'readingMode']], 'the write landed on the preference it names');
  assert.equal(src.prefValues.readingMode, 'vertical');
  assert.equal(src.prefValues.imageQuality, undefined);
});

test('a value is checked against the preference it is for, before anything is sent', async () => {
  fake.reset();
  const { writeSourcePref, PrefError } = await load();
  const refused = async (key: string, value: unknown, code: string) => {
    await assert.rejects(writeSourcePref(WT, key, value, run), (e: unknown) => e instanceof PrefError && e.code === code, `${key} = ${JSON.stringify(value)}`);
  };
  // Reintroduce by dropping the entryValues check in validatePrefValue: the engine stores 'ultra' as readily as
  // 'high' (measured), and the extension reads back a quality it never offered.
  await refused('imageQuality', 'ultra', 'bad_value');
  await refused('imageQuality', true, 'bad_value');
  await refused(SEQUENTIAL_KEY, 'yes', 'bad_value');
  await refused('hiddenGenres', ['romance', 'westerns'], 'bad_value');
  await refused('customUserAgent', 'x'.repeat(2001), 'bad_value');
  await refused('noSuchKey', true, 'unknown_pref');
  // The engine leaves a disabled preference alone without a word; here it is a reason.
  await refused('legacyViewer', true, 'disabled');
  assert.deepEqual(fake.prefWrites, [], 'nothing refused reached the engine');

  const w = await writeSourcePref(WT, 'hiddenGenres', ['horror', 'romance', 'horror'], run);
  assert.deepEqual(fake.source(WT).prefValues.hiddenGenres, ['horror', 'romance'], 'a multi-select is a set');
  assert.equal(w.changed, true);
  const again = await writeSourcePref(WT, 'hiddenGenres', ['romance', 'horror'], run);
  assert.equal(again.changed, false, 'the same choices in another order are no change');
});

test('two preferences under one key are neither of them', async () => {
  fake.reset();
  const { writeSourcePref, PrefError } = await load();
  const src = fake.source(WT);
  src.preferences.push({ ...src.preferences[0], title: 'Sequential (again)' });
  await assert.rejects(writeSourcePref(WT, SEQUENTIAL_KEY, true, run), (e: unknown) => e instanceof PrefError && e.code === 'ambiguous_pref');
  assert.deepEqual(fake.prefWrites, []);
});

test('isNumberingPref reads the key and the title', async () => {
  // Reintroduce by reading the title alone: the first, key-only case fails.
  const { isNumberingPref } = await load();
  assert.equal(isNumberingPref({ key: 'useSequentialChapterNumbering', title: null }), true);
  assert.equal(isNumberingPref({ key: 'pref_x', title: 'Use sequential chapter numbering' }), true);
  assert.equal(isNumberingPref({ key: 'chapterNumberParsing', title: 'Parse' }), true);
  assert.equal(isNumberingPref({ key: 'x', title: 'Episode number from title' }), true);
  assert.equal(isNumberingPref({ key: 'imageQuality', title: 'Image quality' }), false);
  assert.equal(isNumberingPref({ key: 'showAuthorsNotes', title: "Show author's notes" }), false);
});
