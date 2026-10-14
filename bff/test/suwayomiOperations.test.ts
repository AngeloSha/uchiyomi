// Every GraphQL document Uchiyomi sends the extension engine, held to the engines it has to work with.
//
// lib/sources/suwayomi/operations.ts is the one registry of them. Here:
//   * each one validates against the schema of every engine from OLDEST_ENGINE up -- the captures in
//     test/fixtures/suwayomi-v*-schema.json, and SUWAYOMI_EXTRA_SCHEMA when it is set, which is how the weekly canary
//     (.github/workflows/engine-canary.yml) holds them to a NEW engine before anyone runs it -- with not one deprecated
//     member, field, argument, input field or enum value;
//   * every adapter function is driven through a recording transport, and what it sends is the registry exactly:
//     nothing it sends is missing from it, and nothing in it is never sent;
//   * no file that talks to the engine writes a document of its own.
//
// Validation is the strict fake engine's (fixtures/fakeSuwayomiEngine.mjs), which answers graphql-java's rules in its
// words and was held to real v2.3.2243 and v2.4.2366 engines case by case (conformFakeSuwayomi.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Schema, parse, validate } from './fixtures/fakeSuwayomiEngine.mjs';

process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const FIXTURES = join(__dirname, 'fixtures');
const SRC = join(__dirname, '..', 'src');

type SchemaFile = { file: string; schema: InstanceType<typeof Schema>; version: string };

/** The captures this Uchiyomi must work with: every engine from OLDEST_ENGINE up, and the canary's candidate. */
async function schemas(): Promise<SchemaFile[]> {
  const { OLDEST_ENGINE } = await import('../src/lib/sources/suwayomi/enginePin');
  const { isBehind } = await import('../src/lib/githubRelease');
  const files = readdirSync(FIXTURES).filter((f) => /^suwayomi-v\d+\.\d+\.\d+-schema\.json$/.test(f)).map((f) => join(FIXTURES, f));
  if (process.env.SUWAYOMI_EXTRA_SCHEMA) files.push(resolve(process.env.SUWAYOMI_EXTRA_SCHEMA));
  return files
    .map((file) => {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      return { file: relative(join(__dirname, '..', '..'), file), schema: new Schema(json), version: String(json.engine?.version ?? '') };
    })
    .filter((s) => !isBehind(s.version, OLDEST_ENGINE));
}

test('every document is valid on every engine from the oldest supported up, with no deprecated member', async () => {
  // Reintroduce by selecting a deprecated member again (`isNsfw` beside `contentWarning` in OPS.sources): "uses
  // deprecated SourceType.isNsfw" fails. Select one an engine does not have (`codename` in aboutServer): its
  // FieldUndefined fails, naming the engine.
  const { ALL_OPS } = await import('../src/lib/sources/suwayomi/operations');
  const list = await schemas();
  assert.ok(list.length >= 2, `PREMISE: the v2.3.2243 and v2.4.2366 captures are both here (${list.map((s) => s.file).join(', ')})`);
  if (process.env.SUWAYOMI_EXTRA_SCHEMA) assert.ok(list.some((s) => s.file.endsWith(process.env.SUWAYOMI_EXTRA_SCHEMA!.split('/').pop()!)), 'SUWAYOMI_EXTRA_SCHEMA was not read');
  assert.ok(ALL_OPS.length >= 20, `PREMISE: the registry holds every document (${ALL_OPS.length})`);
  for (const { file, schema, version } of list) {
    for (const op of ALL_OPS) {
      const deprecated: string[] = [];
      const errors = validate(schema, parse(op.doc), deprecated).map((e: { message: string }) => e.message);
      assert.deepEqual(errors, [], `${op.name} is refused by ${version} (${file})`);
      assert.deepEqual([...new Set(deprecated)], [], `${op.name} uses deprecated ${deprecated.join(', ')} on ${version}`);
    }
  }
});

test('the registry is one document per name, and the names are unique', async () => {
  // A refusal is recorded and reported under its operation's name (client.ts engineRefusals), so two operations under
  // one name, or one document under two, would make Health quote the wrong one. Reintroduce by naming setTextPreference
  // 'setListPreference': "two operations share a name" fails. Mark another read optional: the last assertion names it --
  // an optional refusal is never reported, so that has to be a decision, not a slip.
  const { ALL_OPS, OPS, opOf } = await import('../src/lib/sources/suwayomi/operations');
  assert.equal(new Set(ALL_OPS.map((o) => o.name)).size, ALL_OPS.length, 'two operations share a name');
  assert.equal(new Set(ALL_OPS.map((o) => o.doc)).size, ALL_OPS.length, 'two operations share a document');
  for (const [key, op] of Object.entries(OPS)) assert.equal(op.name, key, `OPS.${key} is named ${op.name}`);
  for (const op of ALL_OPS) assert.equal(opOf(op.doc), op);
  // The two reads that may be missing on an engine, and only those (a refusal of either is an answer).
  assert.deepEqual(ALL_OPS.filter((o) => o.optional).map((o) => o.name).sort(), ['extensionFacts', 'solverSettings']);
});

/** A transport that records every document it is sent and answers each with a plausible shape for its operation. */
async function recorder() {
  const { opOf } = await import('../src/lib/sources/suwayomi/operations');
  const sent: string[] = [];
  const pref = (typename: string, key: string, extra: Record<string, unknown>) => ({ __typename: typename, key, title: key, summary: null, visible: true, enabled: true, ...extra });
  const prefs = [
    pref('SwitchPreference', 'sw', { bool: false, boolDefault: false }),
    pref('CheckBoxPreference', 'cb', { bool: false, boolDefault: false }),
    pref('EditTextPreference', 'tx', { str: '', strDefault: '' }),
    pref('ListPreference', 'ls', { str: 'a', strDefault: 'a', entries: ['A', 'B'], entryValues: ['a', 'b'] }),
    pref('MultiSelectListPreference', 'ms', { strs: [], strsDefault: [], entries: ['A'], entryValues: ['a'] }),
  ];
  const manga = { id: 1, title: 'T', thumbnailUrl: '/t', realUrl: null, url: '/t', description: null, author: null, artist: null, genre: [], status: 'ONGOING' };
  const answers: Record<string, unknown> = {
    aboutServer: { aboutServer: { name: 'Suwayomi-Server', version: 'v2.3.2243', buildType: 'Stable' } },
    sources: { sources: { nodes: [{ id: '1', name: 'S', lang: 'en', contentWarning: 'SAFE', supportsLatest: true }] } },
    fetchSourceManga: { fetchSourceManga: { mangas: [manga] } },
    fetchManga: { fetchMangaAndChapters: { manga } },
    fetchChapters: { fetchMangaAndChapters: { chapters: [{ id: 1, chapterNumber: 1, name: 'One', uploadDate: '1704067200000', sourceOrder: 1, url: '/1' }] } },
    fetchChapterPages: { fetchChapterPages: { pages: ['/p/0'] } },
    extensions: { extensions: { nodes: [{ pkgName: 'p', name: 'P', contentWarning: 'SAFE' }] } },
    extensionFacts: { extensions: { nodes: [{ pkgName: 'p', versionCodeLong: '1' }] } },
    fetchExtensions: { fetchExtensions: { extensions: [{ pkgName: 'p' }] } },
    updateExtension: { updateExtension: { extension: { pkgName: 'p', isInstalled: true } } },
    sourcesOfExtension: { extensions: { nodes: [{ pkgName: 'p', source: { nodes: [{ id: '1', name: 'S', lang: 'en', contentWarning: 'SAFE' }] } }] } },
    extensionStores: { extensionStores: { nodes: [{ indexUrl: 'https://r/repo.json', name: 'R' }] } },
    addExtensionStore: { addExtensionStore: { extensionStore: { indexUrl: 'https://r/repo.json', name: 'R' } } },
    removeExtensionStore: { removeExtensionStore: { extensionStore: { indexUrl: 'https://r/repo.json' } } },
    solverSettings: { settings: { flareSolverrEnabled: false, flareSolverrUrl: '' } },
    setSolverSettings: { setSettings: { settings: { flareSolverrEnabled: true, flareSolverrUrl: 'http://s' } } },
    clearCachedImages: { clearCachedImages: { cachedPages: true } },
    sourcePreferences: { source: { id: '1', name: 'S', lang: 'en', extension: { pkgName: 'p', name: 'P', source: { nodes: [] } }, preferences: prefs } },
  };
  const run = (async (query: string) => {
    sent.push(query);
    const op = opOf(query);
    if (op?.name.startsWith('set') && op.name.endsWith('Preference')) return { updateSourcePreference: { preferences: prefs } };
    if (!op || !(op.name in answers)) throw new Error(`the recorder has no answer for ${op?.name ?? query.slice(0, 60)}`);
    return answers[op.name];
  }) as never;
  return { run, sent };
}

test('every adapter function sends documents from the registry, and every document in it is sent by one', async () => {
  // Reintroduce by writing a query inline in an adapter (say listExtensions' document as a literal with one more field):
  // "sent but not registered" names it. Leave a document in the registry nothing sends: "registered and never sent".
  const { ALL_OPS } = await import('../src/lib/sources/suwayomi/operations');
  const { aboutServer } = await import('../src/lib/sources/suwayomi/client');
  const sources = await import('../src/lib/sources/suwayomi/sources');
  const ext = await import('../src/lib/sources/suwayomi/extensions');
  const solver = await import('../src/lib/sources/suwayomi/engineSolver');
  const { clearEnginePageCache } = await import('../src/lib/sources/suwayomi/cache');
  const prefs = await import('../src/lib/sources/suwayomi/prefs');
  const { run, sent } = await recorder();

  await aboutServer(run);
  const [remote] = await sources.listRemoteSources(run);
  const a = sources.makeSuwayomiAdapter(remote, run);
  await a.search('t');
  await a.latest!(1);
  await a.popular!(1);
  await a.getSeries('1');
  await a.listChapters('1');
  await a.getPageUrls('1');
  await ext.listExtensions(run);
  await ext.extensionFacts(run);
  await ext.refreshExtensions(run);
  for (const action of ['install', 'uninstall', 'update'] as const) await ext.setExtensionState('p', action, run);
  await ext.sourcesOfExtension('p', run);
  await ext.getRepos(run);
  await ext.addRepo('https://r/index.min.json', run);
  await ext.removeRepo('https://r/repo.json', run);
  await solver.getEngineSolver(run);
  await solver.setEngineSolver('http://s', run);
  await clearEnginePageCache(run);
  await prefs.readSourcePrefs('1', run);
  for (const [key, value] of [['sw', true], ['cb', true], ['tx', 'x'], ['ls', 'b'], ['ms', ['a']]] as const) {
    await prefs.writeSourcePref('1', key, value, run);
  }

  const registered = new Set(ALL_OPS.map((o) => o.doc));
  const unregistered = [...new Set(sent)].filter((q) => !registered.has(q));
  assert.deepEqual(unregistered, [], 'sent but not registered in operations.ts');
  const never = ALL_OPS.filter((o) => !sent.includes(o.doc)).map((o) => o.name);
  assert.deepEqual(never, [], 'registered and never sent by any adapter function');
});

/** Every file under bff/src that talks to the engine: the adapter's own folder, and anything importing its client. */
function engineFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(SRC);
  return out.filter((f) => {
    if (f.endsWith(join('suwayomi', 'operations.ts'))) return false;
    if (f.includes(join('sources', 'suwayomi') + '/')) return true;
    return /from '[./]*(?:sources\/)?suwayomi\/client'/.test(readFileSync(f, 'utf8'));
  });
}

test('no file that talks to the engine writes a GraphQL document of its own', () => {
  // Reintroduce by putting `'{ aboutServer { name version buildType } }'` back in client.ts: the scan names client.ts.
  const DOC = /['"`]\s*(?:(?:query|mutation|subscription)\s*[({$]|\{\s*[a-zA-Z_]\w*\s*[({])/;
  const files = engineFiles();
  assert.ok(files.length >= 8, `PREMISE: the scan reads the engine's files (${files.length})`);
  const found = files.flatMap((f) => readFileSync(f, 'utf8').split('\n')
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => !/^\s*(?:\/\/|\*)/.test(line) && DOC.test(line))
    .map(({ i }) => `${relative(SRC, f)}:${i + 1}`));
  assert.deepEqual(found, [], 'a document outside operations.ts');
  // The scan sees a literal document when there is one.
  assert.ok(DOC.test("const Q = '{ aboutServer { name } }';") && DOC.test('`mutation($id:Int!){ x }`'), 'PREMISE: the pattern matches a document');
});
