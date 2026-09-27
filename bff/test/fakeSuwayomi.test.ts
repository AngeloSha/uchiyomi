// The fake extension engine (test/fixtures/fakeSuwayomi.ts) is only worth what it refuses.
//
// Later tests trust it to stand in for Suwayomi-Server v2.3.2243: the engine-down retry, #115's extension
// failure, #116's posting order and extension settings, the Health engine check. A fake that answers whatever
// it is asked proves nothing about queries that the real engine would refuse -- extensionRepos.int.test.ts's
// first fake passed every test while the candidate had three real bugs. So the first thing pinned here is the
// refusal: an unknown field, argument, input field, enum value or type is answered the way the engine answers
// it, in its words, and never executed. Then that it is not TOO strict: every query the shipping adapter sends
// is accepted, deprecated members included. Then the engine behaviours later steps build on.
//
// Everything goes through the product's own transport (`gql`, the adapters), over real HTTP on loopback.
// Every expected message below was read off a disposable v2.3.2243 (conformFakeSuwayomi.mjs holds the fake
// to it case by case).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startFakeSuwayomi, suwayomiQueryErrors, defaultSeed, SOURCE_IDS, PKG, SEQUENTIAL_KEY, type FakeSuwayomi,
} from './fixtures/fakeSuwayomi';

process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

let fake: FakeSuwayomi;
before(async () => {
  fake = await startFakeSuwayomi();
  // ⚠️ Set BEFORE any src module loads: env.ts parses process.env once at import.
  process.env.SUWAYOMI_URL = fake.url;
});
after(async () => { await fake.close(); });

const client = () => import('../src/lib/sources/suwayomi/client');
const adapters = () => import('../src/lib/sources/suwayomi/sources');
const extensions = () => import('../src/lib/sources/suwayomi/extensions');

/** One raw POST, so the status and the exact body shape can be asserted, not just what `gql` makes of them. */
async function raw(query: string, variables: Record<string, unknown> = {}) {
  const r = await fetch(`${fake.url}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return { status: r.status, body: await r.json() as any };
}

const PREFS_Q = `query($id:LongString!){ source(id:$id){ preferences {
  __typename
  ... on SwitchPreference { key title summary visible enabled currentValue default }
  ... on CheckBoxPreference { key title visible enabled currentValue default }
  ... on EditTextPreference { key title currentValue default text dialogTitle dialogMessage }
  ... on ListPreference { key title currentValue default entries entryValues }
  ... on MultiSelectListPreference { key title currentValue default entries entryValues dialogTitle }
} } }`;
const UPDATE_PREF_M = `mutation($source:LongString!,$position:Int!,$switchState:Boolean,$checkBoxState:Boolean,
    $editTextState:String,$listState:String,$multiSelectState:[String!]){
  updateSourcePreference(input:{source:$source,change:{position:$position,switchState:$switchState,
      checkBoxState:$checkBoxState,editTextState:$editTextState,listState:$listState,multiSelectState:$multiSelectState}}){
    preferences {
      __typename
      ... on SwitchPreference { key currentValue } ... on CheckBoxPreference { key currentValue }
      ... on ListPreference { key currentValue } ... on MultiSelectListPreference { key currentValue }
      ... on EditTextPreference { key currentValue text }
    }
    source { id }
  }
}`;
const CHAPTERS_M = `mutation($mangaId:Int!){ fetchChapters(input:{mangaId:$mangaId}){ chapters { id name chapterNumber scanlator uploadDate url sourceOrder pageCount fetchedAt } } }`;
const PAGES_M = `mutation($chapterId:Int!){ fetchChapterPages(input:{chapterId:$chapterId}){ pages chapter { id pageCount } } }`;
const SEARCH_M = `mutation($source:LongString!,$query:String){ fetchSourceManga(input:{source:$source,type:SEARCH,query:$query,page:1}){ mangas { id title } hasNextPage } }`;

test('the schema fixture is a full capture of the pinned engine, shapes only', () => {
  const file = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'suwayomi-v2.3.2243-schema.json'), 'utf8'));
  assert.equal(file.engine.version, 'v2.3.2243');
  const t = file.types;
  // The members later steps build on, as the engine types them.
  assert.equal(t.ChapterType.fields.sourceOrder, 'Int!');
  assert.equal(t.ChapterType.fields.url, 'String!');
  assert.equal(t.ChapterType.fields.uploadDate, 'LongString!');
  assert.equal(t.ChapterType.fields.chapterNumber, 'Float!');
  assert.equal(t.ChapterType.fields.scanlator, 'String');
  assert.deepEqual(t.Preference.possibleTypes, ['CheckBoxPreference', 'EditTextPreference', 'ListPreference', 'MultiSelectListPreference', 'SwitchPreference']);
  assert.deepEqual(Object.keys(t.SourcePreferenceChangeInput.inputFields).sort(),
    ['checkBoxState', 'editTextState', 'listState', 'multiSelectState', 'position', 'switchState']);
  assert.equal(t.SourcePreferenceChangeInput.inputFields.position, 'Int!');
  assert.equal(t.UpdateSourcePreferenceInput.inputFields.source, 'LongString!');
  assert.equal(t.SettingsType.fields.flareSolverrEnabled, 'Boolean!');
  assert.equal(t.SettingsType.fields.flareSolverrUrl, 'String!');
  assert.equal(t.PartialSettingsTypeInput.inputFields.flareSolverrUrl, 'String');
  // ⚠️ Deprecated members are IN, because introspection hides them by default and the adapter uses them today.
  // A capture without them refuses the shipping adapter's own queries ('every query the shipping adapter
  // sends is accepted' below fails on SourceType.isNsfw).
  assert.equal(t.SourceType.fields.isNsfw.deprecated, ', replace with contentWarning');
  assert.match(t.Mutation.fields.fetchChapters.deprecated, /fetchMangaAndChapters/);
  assert.match(t.PartialSettingsTypeInput.inputFields.extensionRepos.deprecated, /addExtensionStore/);
  // Shapes only: a member is a type, arguments and a deprecation -- no values, nothing an engine stores.
  const allowed = new Set(['kind', 'fields', 'inputFields', 'values', 'deprecatedValues', 'possibleTypes', 'interfaces']);
  const member = (where: string, m: any) => {
    if (typeof m === 'string') return;
    for (const k of Object.keys(m)) assert.ok(['type', 'args', 'deprecated'].includes(k), `${where}.${k}`);
    for (const [a, v] of Object.entries(m.args ?? {})) member(`${where}(${a})`, v);
  };
  for (const [name, def] of Object.entries<any>(t)) {
    assert.ok(!name.startsWith('__'), name);
    for (const k of Object.keys(def)) assert.ok(allowed.has(k), `${name}.${k}`);
    for (const [f, m] of Object.entries(def.fields ?? {})) member(`${name}.${f}`, m);
    for (const [f, m] of Object.entries(def.inputFields ?? {})) member(`${name}.${f}`, m);
  }
});

test('AN UNKNOWN FIELD IS REFUSED, in the engine\'s words, and never executed', async () => {
  // Reintroduce by letting the field rule pass unknown fields (fakeSuwayomiEngine.mjs, validate(): `if (!def)`
  // continuing instead of adding FieldUndefined): the query reaches execution, and the errors deepEqual below
  // fails on the fake's own "not implemented" answer instead of the engine's refusal.
  fake.reset();
  const r = await raw('{ sources { nodes { id name bogus } } }');
  assert.equal(r.status, 200, 'graphql-java refuses with 200, not 400');
  assert.ok(!('data' in r.body), 'a refused query has no data key at all');
  assert.deepEqual(r.body.errors, [{
    message: "Validation error (FieldUndefined@[sources/nodes/bogus]) : Field 'bogus' in type 'SourceType' is undefined",
    locations: [{ line: 1, column: 29 }],
    extensions: {},
  }]);

  // Through the product transport it is a thrown error carrying the engine's message.
  const { gql } = await client();
  await assert.rejects(gql('{ aboutServer { name version codename } }'),
    /^Error: suwayomi: Validation error \(FieldUndefined@\[aboutServer\/codename\]\) : Field 'codename' in type 'AboutServerPayload' is undefined$/);

  // Refused means not run: a mutation with one bad field in its answer changes nothing.
  await assert.rejects(gql(`mutation { setSettings(input:{settings:{flareSolverrEnabled:true}}) { settings { flareSolverrEnabled flareSolverUrl } } }`),
    /FieldUndefined@\[setSettings\/settings\/flareSolverUrl\]/);
  assert.equal(fake.settings.flareSolverrEnabled, false, 'the refused mutation did not run');
  assert.equal(fake.graphqlCalls('setSettings').at(-1)?.status, 'rejected');

  // A field inside a union member is checked against THAT member, and the union itself has no fields.
  assert.deepEqual(suwayomiQueryErrors('{ source(id:"0") { preferences { ... on SwitchPreference { key entries } } } }'),
    ["Validation error (FieldUndefined@[source/preferences/entries]) : Field 'entries' in type 'SwitchPreference' is undefined"]);
  assert.deepEqual(suwayomiQueryErrors('{ source(id:"0") { preferences { key } } }'),
    ["Validation error (FieldUndefined@[source/preferences/key]) : Field 'key' in type 'Preference' is undefined"]);
});

test('unknown arguments, input fields, enum values and types, and mismatched variables are refused too', async () => {
  const cases: Array<[string, string]> = [
    ['{ sources(bogusArg: 1) { nodes { id } } }', "Validation error (UnknownArgument@[sources]) : Unknown field argument 'bogusArg'"],
    ['mutation { fetchSourceManga(input:{source:"1",type:SEARCH,page:1,bogus:1}) { mangas { id } } }',
      "Validation error (WrongType@[fetchSourceManga]) : argument 'input' with value 'ObjectValue{objectFields=[ObjectField{name='source', value=StringValue{value='1'}}, ObjectField{name='type', value=EnumValue{name='SEARCH'}}, ObjectField{name='page', value=IntValue{value=1}}, ObjectField{name='bogus', value=IntValue{value=1}}]}' contains a field not in 'FetchSourceMangaInput': 'bogus'"],
    ['mutation { fetchSourceManga(input:{source:"1",type:BOGUS,page:1}) { mangas { id } } }',
      "Validation error (WrongType@[fetchSourceManga]) : argument 'input.type' with value 'EnumValue{name='BOGUS'}' is not a valid 'FetchSourceMangaType' - Literal value not in allowable values for enum 'FetchSourceMangaType' - 'EnumValue{name='BOGUS'}'"],
    ['query($x: NoSuchType){ aboutServer { name } }', "Validation error (UnknownType) : Unknown type 'NoSuchType'"],
    // The engine types source ids LongString; a String-typed variable is refused before anything runs.
    ['mutation($s:String!){ fetchSourceManga(input:{source:$s,type:POPULAR,page:1}) { mangas { id } } }',
      "Validation error (VariableTypeMismatch@[fetchSourceManga]) : Variable 's' of type 'String!' used in position expecting type 'LongString!'"],
    ['{ source(id: 0) { id } }',
      "Validation error (WrongType@[source]) : argument 'id' with value 'IntValue{value=0}' is not a valid 'LongString' - Expected an AST type of 'StringValue' but it was a 'IntValue'"],
    ['mutation { fetchSourceManga(input:{source:"1",type:SEARCH}) { mangas { id } } }',
      "Validation error (WrongType@[fetchSourceManga]) : argument 'input' with value 'ObjectValue{objectFields=[ObjectField{name='source', value=StringValue{value='1'}}, ObjectField{name='type', value=EnumValue{name='SEARCH'}}]}' is missing required fields '[page]'"],
    ['mutation { fetchSourceManga { mangas { id } } }', "Validation error (MissingFieldArgument@[fetchSourceManga]) : Missing field argument 'input'"],
    ['{ sources { nodes } }', "Validation error (SubselectionRequired@[sources/nodes]) : Subselection required for type '[SourceType!]!' of field 'nodes'"],
    ['{ sources { nodes { id ... on ExtensionType { pkgName } } } }',
      "Validation error (InvalidFragmentType@[sources/nodes]) : Fragment cannot be spread here as objects of type 'SourceType' can never be of type 'ExtensionType'"],
    ['{ sources { nodes { id } }', "Invalid syntax with offending token '<EOF>' at line 1 column 27"],
    // A named fragment's fields are checked against its type condition, wherever it is spread. Reintroduce by
    // skipping fragment definitions in validate(): the fake answers "FAKE ENGINE: SourceType.bogus …", which
    // is false -- the engine refuses it.
    ['{ sources { nodes { id ...F } } } fragment F on SourceType { name bogus }',
      "Validation error (FieldUndefined@[F/bogus]) : Field 'bogus' in type 'SourceType' is undefined"],
  ];
  for (const [query, message] of cases) assert.deepEqual(suwayomiQueryErrors(query).slice(0, 1), [message], query);

  // An input object sent as a VARIABLE is checked field by field at coercion, not at validation: a typo in it
  // is refused before anything runs. #116's preference write passes its change this way. Reintroduce by
  // letting coerceInput accept unknown keys: the mutation runs and "a misspelt input field ran" fails.
  fake.reset();
  const typo = await raw('mutation($i:FetchSourceMangaInput!){ fetchSourceManga(input:$i){ mangas { id } } }',
    { i: { source: SOURCE_IDS.mangaBall, type: 'POPULAR', page: 1, extra: 1 } });
  assert.deepEqual(typo.body, { errors: [{
    message: "The variables input contains a field name 'extra' that is not defined for input object type 'FetchSourceMangaInput' ",
  }] }, 'a misspelt input field ran');
  assert.equal(fake.graphqlCalls('fetchSourceManga').at(-1)?.status, 'error');
});

test('variables are coerced the way the engine coerces them', async () => {
  const q = 'mutation($p:Int!,$s:LongString!){ fetchSourceManga(input:{source:$s,type:POPULAR,page:$p}) { mangas { id } } }';
  const bad = async (variables: Record<string, unknown>) => (await raw(q, variables)).body;
  assert.deepEqual((await bad({ s: SOURCE_IDS.mangaBall })).errors[0].message,
    "Variable 'p' has an invalid value: Variable 'p' has coerced Null value for NonNull type 'Int!'");
  assert.deepEqual((await bad({ s: SOURCE_IDS.mangaBall, p: '1' })).errors[0].message,
    "Variable 'p' has an invalid value: Expected a value that can be converted to type 'Int' but it was a 'String'");
  // A 64-bit id sent as a JSON number is refused, not rounded: the engine wants the string.
  assert.deepEqual((await bad({ s: 6716343437498271985, p: 1 })).errors[0].message,
    "Variable 's' has an invalid value: Expected a String input, but it was a 'Integer'");
  // Measured on v2.3.2243 (the review's extra cases): an Int out of range, and a null inside a list, have
  // their own wording.
  assert.deepEqual((await bad({ s: SOURCE_IDS.mangaBall, p: 3000000000 })).errors[0].message,
    "Variable 'p' has an invalid value: Expected value to be in the integer range, but it was a '3000000000'",
    'an out-of-range Int is worded as a type mismatch');
  const repos = await raw('mutation($r:[String!]){ setSettings(input:{settings:{extensionRepos:$r}}) { settings { flareSolverrEnabled } } }', { r: ['a', null] });
  assert.deepEqual(repos.body.errors[0].message, "Variable 'r' has an invalid value: Coerced Null value for NonNull type 'String!'",
    'a null inside a list is worded as a null variable');
  const ok = await bad({ s: SOURCE_IDS.mangaBall, p: 1 });
  assert.equal(ok.errors, undefined);
  assert.equal(ok.data.fetchSourceManga.mangas.length, 1);
});

test('every query the shipping adapter sends is accepted, deprecated members and all', async () => {
  // Reintroduce by capturing the schema WITHOUT deprecated members (drop `"isNsfw"` from SourceType in the
  // fixture): listRemoteSources is refused with FieldUndefined@[sources/nodes/isNsfw], though the real engine
  // answers it.
  fake.reset();
  const { gql, aboutServer } = await client();
  const { listRemoteSources, makeSuwayomiAdapter } = await adapters();
  const ext = await extensions();

  const remote = await listRemoteSources(gql);
  assert.deepEqual(remote.map((s) => s.id), [SOURCE_IDS.local, SOURCE_IDS.webtoons, SOURCE_IDS.mangaBall, SOURCE_IDS.nightShelf]);
  assert.equal(remote.find((s) => s.id === SOURCE_IDS.mangaBall)?.displayName, 'Manga Ball (EN)');
  assert.equal(remote.find((s) => s.id === SOURCE_IDS.nightShelf)?.isNsfw, true);
  assert.equal(remote.find((s) => s.id === SOURCE_IDS.webtoons)?.extension?.pkgName, PKG.webtoons);
  assert.equal((await aboutServer(gql)).version, 'v2.3.2243');

  const ball = makeSuwayomiAdapter(remote.find((s) => s.id === SOURCE_IDS.mangaBall)!, gql);
  const [hit] = await ball.search('ball');
  assert.equal(hit.title, 'Ball Runner');
  assert.equal(hit.coverUrl, `${fake.url}/api/v1/manga/${hit.sourceId}/thumbnail`);
  assert.equal((await ball.getSeries(hit.sourceId))?.title, 'Ball Runner');
  assert.equal((await ball.popular!(1)).length, 1);
  assert.equal((await ball.latest!(1)).length, 1);
  const chapters = await ball.listChapters(hit.sourceId);
  // The engine's -1 ("no number") is dropped by the adapter; both copies of chapter 3 are kept.
  assert.deepEqual(chapters.map((c) => c.number), [1, 2, 3, 3, 4]);
  assert.deepEqual(chapters.map((c) => c.scanlator), ['Ball Team', 'Ball Team', 'Ball Team', 'Other Team', 'Ball Team']);
  const pages = await ball.getPageUrls(chapters[0].sourceId);
  assert.equal(pages.length, 3);
  const img = await fetch(pages[0]);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  assert.equal((await ext.listExtensions(gql)).length, 4);
  assert.equal(await ext.refreshExtensions(gql), 4);
  assert.equal(await ext.setExtensionState(PKG.shelfTwo, 'install', gql), true);
  assert.deepEqual((await ext.sourcesOfExtension(PKG.webtoons, gql)).map((s) => s.id), [SOURCE_IDS.webtoons]);
  assert.deepEqual(await ext.setRepos(['https://repo.example/index.min.json'], gql), ['https://repo.example/index.min.json']);
  assert.deepEqual(await ext.getRepos(gql), ['https://repo.example/index.min.json']);

  const refused = fake.calls.filter((c) => c.status === 'rejected' || c.status === 'unimplemented');
  assert.deepEqual(refused, [], 'the fake refused a query the real engine answers');
  // Recorded, so an engine upgrade that finally removes them is a known list, not a surprise.
  const deprecated = new Set(fake.calls.flatMap((c) => c.deprecated ?? []));
  for (const d of ['SourceType.isNsfw', 'SourceType.baseUrl', 'Mutation.fetchManga', 'Mutation.fetchChapters', 'ExtensionType.repo', 'SettingsType.extensionRepos', 'AboutServerPayload.revision']) {
    assert.ok(deprecated.has(d), d);
  }
});

test('chapters carry sourceOrder, url, uploadDate, scanlator, name and chapterNumber as the engine sends them', async () => {
  fake.reset();
  const ball = fake.manga('Ball Runner');
  const { data } = await raw(CHAPTERS_M, { mangaId: ball.id }).then((r) => r.body);
  const rows = data.fetchChapters.chapters;
  // Ordered by sourceOrder ascending, and 1 is the OLDEST post: the extension lists newest first and the
  // engine numbers that list reversed. Reintroduce by numbering the extension's list as given (syncChapters,
  // `sourceOrder: oldestFirst.length - i`): this first assertion fails, [6, 5, 4, 3, 2, 1].
  assert.deepEqual(rows.map((c: any) => c.sourceOrder), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows.map((c: any) => c.name), ['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 3', 'Chapter 4', 'Oneshot']);
  assert.deepEqual(rows.map((c: any) => c.chapterNumber), [1, 2, 3, 3, 4, -1], 'no number is -1, not null');
  assert.deepEqual(rows.map((c: any) => c.scanlator), ['Ball Team', 'Ball Team', 'Ball Team', 'Other Team', 'Ball Team', null]);
  assert.equal(rows[0].url, '/title/ball-runner/1');
  assert.equal(rows[0].uploadDate, String(Date.UTC(2024, 0, 1)), 'epoch milliseconds, as a string');
  assert.match(rows[0].fetchedAt, /^\d{10}$/, 'epoch SECONDS, as a string');
  assert.equal(rows[0].pageCount, -1, 'unknown until the pages were fetched');

  const pages = (await raw(PAGES_M, { chapterId: rows[1].id })).body.data.fetchChapterPages;
  // The page path names the chapter by its sourceOrder, not its id.
  assert.deepEqual(pages.pages, [0, 1, 2].map((n) => `/api/v1/manga/${ball.id}/chapter/2/page/${n}`));
  assert.equal(pages.chapter.pageCount, 3);

  // A post the site drops is gone, with its id; a new post takes a new id and shifts every sourceOrder above it.
  ball.chapters = ball.chapters.filter((c) => c.name !== 'Chapter 2');
  ball.chapters.unshift({ name: 'Chapter 5', url: '/title/ball-runner/5', chapterNumber: 5, scanlator: 'Ball Team', uploadDate: Date.UTC(2024, 3, 1) });
  const again = (await raw(CHAPTERS_M, { mangaId: ball.id })).body.data.fetchChapters.chapters;
  assert.deepEqual(again.map((c: any) => c.name), ['Chapter 1', 'Chapter 3', 'Chapter 3', 'Chapter 4', 'Oneshot', 'Chapter 5']);
  assert.equal(again[0].id, rows[0].id, 'a post keeps its id while it is listed');
  assert.ok(!again.some((c: any) => c.id === rows[1].id), "the dropped post's id is gone");
  assert.ok(again[5].id > Math.max(...rows.map((c: any) => c.id)), 'the new post has a new id');
  assert.equal(again[1].pageCount, -1);
  const gone = await raw(PAGES_M, { chapterId: rows[1].id });
  assert.equal(gone.body.data.fetchChapterPages, null);
  assert.match(gone.body.errors[0].message, /^Exception while fetching data \(\/fetchChapterPages\) : Collection is empty\.\r\n\r\njava\.util\.NoSuchElementException: Collection is empty\.\n\tat /);
});

test('Istrevelia numbers the way the Webtoons extension does: 226 posts on 13 numbers, 1-226 when switched', async () => {
  fake.reset();
  const ist = fake.manga('Istrevelia');
  const rows = (await raw(CHAPTERS_M, { mangaId: ist.id })).body.data.fetchChapters.chapters;
  assert.equal(rows.length, 226);
  const numbers = rows.map((c: any) => c.chapterNumber);
  assert.equal(new Set(numbers).size, 13);
  const whole = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => numbers.filter((x: number) => x === n).length);
  assert.deepEqual(whole, [19, 21, 20, 21, 24, 28, 73, 15], 'posts per episode, as in the issue');
  assert.deepEqual([...new Set(numbers.filter((n: number) => !Number.isInteger(n)))], [1.01, 3.01, 4.01, 5.01, 7.01]);
  assert.equal(rows[0].name, 'Episode 1 - Page1  (ch. 1)');
  assert.ok(rows.some((c: any) => c.name.startsWith('Ee7 - ')), "the 'Ee7' spelling is in the list");

  // The extension's own switch, written by position, renumbers every post by its place in the list.
  const prefs = (await raw(PREFS_Q, { id: SOURCE_IDS.webtoons })).body.data.source.preferences;
  const position = prefs.findIndex((p: any) => p.key === SEQUENTIAL_KEY);
  const w = await raw(UPDATE_PREF_M, { source: SOURCE_IDS.webtoons, position, switchState: true });
  assert.equal(w.body.errors, undefined);
  const after = (await raw(CHAPTERS_M, { mangaId: ist.id })).body.data.fetchChapters.chapters;
  assert.deepEqual(after.map((c: any) => c.chapterNumber), Array.from({ length: 226 }, (_, i) => i + 1));
  assert.deepEqual(after.map((c: any) => c.id), rows.map((c: any) => c.id), 'same posts, same ids: only the numbers moved');
});

test("extension_error: the engine answers with the extension's own exception, and only there", async () => {
  // Reintroduce by answering extension_error as an unreachable engine (destroying the socket): gql's message
  // becomes "fetch failed" and the first assertion fails. That is #115's blamed container.
  fake.reset();
  const { gql } = await client();
  fake.setMode({ mode: 'extension_error', source: SOURCE_IDS.mangaBall, stage: 'search' });
  await assert.rejects(gql(SEARCH_M, { source: SOURCE_IDS.mangaBall, query: 'ball' }),
    (e: Error) => e.message.startsWith('suwayomi: Exception while fetching data (/fetchSourceManga) : java.lang.Exception\r\n\r\njava.lang.Exception: java.lang.Exception\n\tat eu.kanade.tachiyomi.extension.en.mangaball.'));
  const r = await raw(SEARCH_M, { source: SOURCE_IDS.mangaBall, query: 'ball' });
  assert.equal(r.status, 200, 'the engine answered');
  assert.deepEqual(r.body.data, { fetchSourceManga: null });
  assert.deepEqual(r.body.errors[0].path, ['fetchSourceManga']);
  assert.deepEqual(r.body.errors[0].locations, [{ line: 1, column: SEARCH_M.indexOf('fetchSourceManga') + 1 }]);

  // Only that source, only that stage: the engine itself is fine.
  assert.equal((await gql<any>(SEARCH_M, { source: SOURCE_IDS.webtoons, query: 'walk' })).fetchSourceManga.mangas.length, 1);
  assert.equal((await gql<any>(CHAPTERS_M, { mangaId: fake.manga('Ball Runner').id })).fetchChapters.chapters.length, 6);
  assert.equal((await gql<any>('{ aboutServer { name } }')).aboutServer.name, 'Suwayomi-Server');

  // Every stage when none is named, with the message asked for; images fail at the REST path.
  fake.setMode({ mode: 'extension_error', source: SOURCE_IDS.mangaBall, message: 'HTTP error 500' });
  await assert.rejects(gql(CHAPTERS_M, { mangaId: fake.manga('Ball Runner').id }),
    /^Error: suwayomi: Exception while fetching data \(\/fetchChapters\) : HTTP error 500\r\n/);
  fake.setMode('up');
  const ch = (await gql<any>(CHAPTERS_M, { mangaId: fake.manga('Ball Runner').id })).fetchChapters.chapters[0];
  const page = (await gql<any>(PAGES_M, { chapterId: ch.id })).fetchChapterPages.pages[0];
  fake.setMode({ mode: 'extension_error', stage: 'images' });
  assert.equal((await fetch(fake.url + page)).status, 500);
  fake.setMode('up');
  assert.equal((await fetch(fake.url + page)).status, 200);
  assert.equal((await gql<any>(SEARCH_M, { source: SOURCE_IDS.mangaBall, query: 'ball' })).fetchSourceManga.mangas[0].title, 'Ball Runner');
});

test('preferences: all five kinds, written by position with the state field of their kind', async () => {
  fake.reset();
  const { gql } = await client();
  const write = (vars: Record<string, unknown>) => raw(UPDATE_PREF_M, { source: SOURCE_IDS.webtoons, ...vars });

  // Before any read the engine has no preference screen for the source: a NullPointerException.
  // Reintroduce by building the screen on write instead of on read: this answer succeeds.
  const early = await write({ position: 0, switchState: true });
  assert.deepEqual(early.body.data, { updateSourcePreference: null });
  assert.match(early.body.errors[0].message, /^Exception while fetching data \(\/updateSourcePreference\) : null\r\n\r\njava\.lang\.NullPointerException\n/);
  assert.deepEqual(fake.prefWrites, []);

  const prefs = (await gql<any>(PREFS_Q, { id: SOURCE_IDS.webtoons })).source.preferences;
  assert.deepEqual(prefs.map((p: any) => p.__typename),
    ['SwitchPreference', 'CheckBoxPreference', 'ListPreference', 'MultiSelectListPreference', 'EditTextPreference', 'SwitchPreference']);
  assert.deepEqual(prefs[0], { __typename: 'SwitchPreference', key: SEQUENTIAL_KEY, title: 'Use sequential chapter numbering',
    summary: 'Number chapters by their position in the list instead of the number in their title', visible: true, enabled: true, currentValue: false, default: false });
  assert.deepEqual(prefs[2], { __typename: 'ListPreference', key: 'imageQuality', title: 'Image quality', currentValue: 'high', default: 'high',
    entries: ['High', 'Medium', 'Low'], entryValues: ['high', 'medium', 'low'] });
  assert.equal(prefs[5].enabled, false);

  const ok = await write({ position: 0, switchState: true });
  assert.equal(ok.body.errors, undefined);
  assert.equal(ok.body.data.updateSourcePreference.preferences[0].currentValue, true, 'the answer is the rebuilt screen');
  assert.equal(ok.body.data.updateSourcePreference.source.id, SOURCE_IDS.webtoons);

  // The value comes from the ONE state field matching the preference's class.
  const wrong = await write({ position: 0, listState: 'high' });
  assert.match(wrong.body.errors[0].message, /^Exception while fetching data \(\/updateSourcePreference\) : Expected change to SwitchPreferenceCompat\r\n/);
  const range = await write({ position: 9, switchState: true });
  assert.match(range.body.errors[0].message, / : Index 9 out of bounds for length 6\r\n\r\njava\.lang\.IndexOutOfBoundsException: /);
  // A disabled preference is left alone without a word.
  const disabled = await write({ position: 5, switchState: true });
  assert.equal(disabled.body.errors, undefined);
  assert.equal(disabled.body.data.updateSourcePreference.preferences[5].currentValue, false);
  // The engine does NOT check a list value against entryValues: that is the caller's job.
  assert.equal((await write({ position: 2, listState: 'ultra' })).body.data.updateSourcePreference.preferences[2].currentValue, 'ultra');
  assert.deepEqual((await write({ position: 3, multiSelectState: ['horror', 'horror', 'comedy'] })).body.data.updateSourcePreference.preferences[3].currentValue, ['horror', 'comedy']);
  const text = (await write({ position: 4, editTextState: 'UA/1' })).body.data.updateSourcePreference.preferences[4];
  assert.deepEqual([text.currentValue, text.text], ['UA/1', 'UA/1']);
  assert.equal((await write({ position: 1, checkBoxState: true })).body.data.updateSourcePreference.preferences[1].currentValue, true);
  assert.deepEqual(fake.prefWrites.map((w) => w.key), [SEQUENTIAL_KEY, 'imageQuality', 'hiddenGenres', 'customUserAgent', 'showAuthorsNotes']);
  assert.equal(fake.source(SOURCE_IDS.webtoons).reloads, 5, 'each write made the engine rebuild the source');
});

test('a position means the screen of the LAST READ, so a list that moved under a stale position hits the wrong preference', async () => {
  fake.reset();
  const read = async () => (await raw(PREFS_Q, { id: SOURCE_IDS.webtoons })).body.data.source.preferences.map((p: any) => p.key);
  const before = await read();
  assert.equal(before[0], SEQUENTIAL_KEY);
  // The extension updates and its screen moves: the checkbox is now first.
  const src = fake.source(SOURCE_IDS.webtoons);
  src.preferences = [src.preferences[1], src.preferences[0], ...src.preferences.slice(2)];
  // Still addressed through the screen built at the last read: position 0 is the switch...
  await raw(UPDATE_PREF_M, { source: SOURCE_IDS.webtoons, position: 0, switchState: true });
  assert.equal(fake.prefWrites.at(-1)?.key, SEQUENTIAL_KEY);
  // ...and that write's answer rebuilt the screen, so the same position is now the checkbox, whose kind
  // takes checkBoxState. A caller that resolves a key to a position must read first, then write.
  const stale = await raw(UPDATE_PREF_M, { source: SOURCE_IDS.webtoons, position: 0, switchState: false });
  assert.match(stale.body.errors[0].message, / : Expected change to CheckBoxPreference\r\n/);
  const now = await read();
  assert.equal(now.indexOf(SEQUENTIAL_KEY), 1);
});

test('settings: the fresh engine\'s values, and setSettings changes only what it is given non-null', async () => {
  fake.reset();
  const { gql } = await client();
  const read = async () => (await gql<any>('{ settings { flareSolverrEnabled flareSolverrUrl flareSolverrTimeout extensionRepos } }')).settings;
  assert.deepEqual(await read(), { flareSolverrEnabled: false, flareSolverrUrl: 'http://localhost:8191', flareSolverrTimeout: 60, extensionRepos: [] });
  const SET = 'mutation($on:Boolean,$url:String){ setSettings(input:{settings:{flareSolverrEnabled:$on,flareSolverrUrl:$url}}){ settings { flareSolverrEnabled flareSolverrUrl } } }';
  assert.deepEqual((await gql<any>(SET, { on: true, url: 'http://uchiyomi-flaresolverr:8191' })).setSettings.settings,
    { flareSolverrEnabled: true, flareSolverrUrl: 'http://uchiyomi-flaresolverr:8191' });
  // null leaves a setting alone, and the engine checks no URL.
  assert.deepEqual((await gql<any>(SET, { on: null, url: 'not a url' })).setSettings.settings, { flareSolverrEnabled: true, flareSolverrUrl: 'not a url' });
  assert.equal(fake.graphqlCalls('setSettings').length, 2);
  // Its own validation fails the whole (non-null) answer: errors, and no data at all.
  const bad = await raw('mutation { setSettings(input:{settings:{maxSourcesInParallel: -5}}) { settings { maxSourcesInParallel } } }');
  assert.ok(!('data' in bad.body));
  assert.match(bad.body.errors[0].message, /^Exception while fetching data \(\/setSettings\) : Validation errors: maxSourcesInParallel: Value \(-5\) must be at least 1\r\n/);
  // A setting this fake does not model is refused loudly, never invented.
  await assert.rejects(gql('{ settings { downloadsPath } }'), /FAKE ENGINE: SettingsType\.downloadsPath is valid on Suwayomi-Server v2\.3\.2243 but this fake does not implement it/);
});

test('down drops the connection, slow holds the answer, stop refuses it, and each comes back', async () => {
  fake.reset();
  const { gql } = await client();
  const ABOUT = '{ aboutServer { name } }';
  fake.setMode('down');
  await assert.rejects(gql(ABOUT), /fetch failed/);
  assert.equal(fake.calls.at(-1)?.status, 'dropped');
  fake.setMode('up');
  assert.equal((await gql<any>(ABOUT)).aboutServer.name, 'Suwayomi-Server');

  fake.setMode({ mode: 'slow', ms: 400 });
  const t0 = Date.now();
  await gql(ABOUT);
  assert.ok(Date.now() - t0 >= 350, `answered after ${Date.now() - t0} ms`);
  // A caller that gives up first sees its own timeout; the fake notices and sends nothing.
  await assert.rejects(gql(ABOUT, {}, 100), /TimeoutError|aborted due to timeout/);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(fake.calls.at(-1)?.status, 'abandoned');
  fake.setMode('up');

  // The port itself closed: ECONNREFUSED, as while the engine's JVM is still starting. Same URL afterwards.
  // (The first call after stop() can instead land on a kept-alive socket the client has not yet seen closed,
  // which fails as "other side closed" -- what a real engine restart does too -- so the refusal is awaited.)
  await fake.stop();
  try {
    const codes: string[] = [];
    for (let i = 0; i < 3 && !codes.includes('ECONNREFUSED'); i++) {
      await assert.rejects(gql(ABOUT), (e: any) => { codes.push(e.cause?.code ?? e.cause?.message); return /fetch failed/.test(e.message); });
    }
    assert.ok(codes.includes('ECONNREFUSED'), codes.join());
  } finally {
    await fake.start();
  }
  assert.equal((await gql<any>(ABOUT)).aboutServer.name, 'Suwayomi-Server');
});

test('REST: thumbnails and extension icons are served, anything else is a 404, and basic auth is enforced when set', async () => {
  fake.reset();
  const ball = fake.manga('Ball Runner');
  const thumb = await fetch(`${fake.url}/api/v1/manga/${ball.id}/thumbnail`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${fake.url}/api/v1/extension/icon/${PKG.mangaBall}`)).status, 200);
  assert.equal((await fetch(`${fake.url}/api/v1/manga/9999/thumbnail`)).status, 404);
  assert.equal((await fetch(`${fake.url}/api/v1/extension/list`)).status, 404);
  // The documented path the engine does not serve (client.ts): only /api/graphql answers GraphQL.
  assert.equal((await fetch(`${fake.url}/graphql`, { method: 'POST', body: '{}' })).status, 404);

  const locked = await startFakeSuwayomi({ auth: { username: 'u', password: 'p' } });
  try {
    const body = JSON.stringify({ query: '{ aboutServer { name } }' });
    assert.equal((await fetch(`${locked.url}/api/graphql`, { method: 'POST', body })).status, 401);
    const authorization = 'Basic ' + Buffer.from('u:p').toString('base64');
    const ok = await fetch(`${locked.url}/api/graphql`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`${locked.url}/api/v1/extension/icon/${PKG.mangaBall}`)).status, 401);
  } finally {
    await locked.close();
  }
});

test('a valid field the fake does not serve is refused as the FAKE\'s gap, never answered with a guess', async () => {
  const r = await raw('{ sources { pageInfo { hasNextPage } } }');
  assert.deepEqual(r.body, { errors: [{ message: 'FAKE ENGINE: SourceNodeList.pageInfo is valid on Suwayomi-Server v2.3.2243 but this fake does not implement it; add it to bff/test/fixtures/fakeSuwayomiEngine.mjs' }] });
  assert.equal(fake.calls.at(-1)?.status, 'unimplemented');
  const args = await raw('{ sources(first: 2) { nodes { id } } }');
  assert.match(args.body.errors[0].message, /^FAKE ENGINE: Query\.sources\(first\) is valid/);
  // Introspection is answered by the engine; here it is the fake's gap, never a refusal worded as the
  // engine's. Reintroduce by letting validate() look __schema up on Query: FieldUndefined comes back and this
  // fails.
  for (const q of ['{ __schema { queryType { name } } }', '{ __type(name: "SourceType") { name } }']) {
    const r = await raw(q);
    assert.match(r.body.errors[0].message, /^FAKE ENGINE: introspection \(__(schema|type)\) is valid/, `${q} is refused as the engine would not`);
  }
});

test('a seed chapter the engine would number from its name is refused, not answered -1', async () => {
  // The engine parses "Ch.10 Finale" at -1 into 10 (ChapterRecognition, measured on the Local source); the
  // fake does not model the parser. Reintroduce by dropping the check in buildState: the fake starts, and
  // answers -1 where the engine says 10.
  const seed = defaultSeed();
  seed.sources[2].mangas[0].chapters.push({ name: 'Ch.10 Finale', url: '/title/ball-runner/10', chapterNumber: -1 });
  const started = await startFakeSuwayomi({ seed }).then((f) => f, (e: Error) => e);
  if (!(started instanceof Error)) await started.close(); // an open server would hold the run open
  assert.ok(started instanceof Error, 'a seed the engine would number from its name started, and answers -1 where the engine says 10');
  assert.match(started.message, /"Ch\.10 Finale" has no chapterNumber, and the engine would parse one from its name/);
  // A name with no number stays -1, as on the engine ("Extra Story").
  const plain = defaultSeed();
  plain.sources[2].mangas[0].chapters.push({ name: 'Extra Story', url: '/title/ball-runner/extra' });
  const f = await startFakeSuwayomi({ seed: plain });
  await f.close();
});
