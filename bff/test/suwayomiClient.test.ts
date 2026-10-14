// Who failed, in the words the Suwayomi client throws (#115).
//
// A transport failure used to surface as undici's bare "fetch failed", and an abort as "The operation was aborted
// due to timeout": neither said it was the ENGINE that did not answer, so the diagnosis had to guess, and it
// guessed with a catch-all that also swallowed the opposite case -- the engine answering with the extension's own
// exception, which is what #115's reporter saw blamed on the container. Driven through the real client against the
// shared fake engine (test/fixtures/fakeSuwayomi.ts), over real HTTP on loopback.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSuwayomi, SOURCE_IDS, type FakeSuwayomi } from './fixtures/fakeSuwayomi';

process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

let fake: FakeSuwayomi;
before(async () => {
  fake = await startFakeSuwayomi();
  process.env.SUWAYOMI_URL = fake.url; // ⚠️ before any src module loads: env.ts parses it once
});
after(async () => { await fake.close(); });

const client = () => import('../src/lib/sources/suwayomi/client');
const ABOUT = '{ aboutServer { name } }';
const SEARCH = `mutation($source:LongString!,$query:String){ fetchSourceManga(input:{source:$source,type:SEARCH,query:$query,page:1}){ mangas { id title } } }`;

test('an engine that is not there is "unreachable", with its code, and still classifies as down', async () => {
  // Reintroduce by removing the try/catch around fetch in gql(): the message is the bare "fetch failed" and
  // diagnose() reads 'unknown' -- or, with the old catch-all, blames nothing it can name.
  const { gql } = await client();
  const { classify } = await import('../src/lib/sourceHealth');
  const { diagnose } = await import('../src/lib/sourceDiagnosis');
  await fake.stop();
  try {
    let msg = '';
    let cause: any;
    // The first call after stop() can land on a kept-alive socket and fail as "other side closed"; the refusal
    // is what a stopped engine answers once the socket is gone (fakeSuwayomi.test.ts does the same).
    for (let i = 0; i < 3 && !/ECONNREFUSED/.test(msg); i++) {
      await gql(ABOUT).catch((e: any) => { msg = e.message; cause = e.cause; });
    }
    assert.equal(msg, 'suwayomi unreachable: fetch failed (ECONNREFUSED)');
    assert.equal(cause?.code, 'ECONNREFUSED', 'the cause is kept for callers that read it');
    assert.equal(classify(new Error(msg)), 'down', 'the cooldown machinery reads it exactly as before');
    const d = diagnose({ status: 'down', lastError: msg, consecutive: 1, lastOkAt: null, emptyStreak: 0, blockedUntil: null, disabled: false });
    assert.equal(d.code, 'upstream_down');
  } finally {
    await fake.start();
  }
});

test('an engine that does not answer in time says so, in our words', async () => {
  const { gql } = await client();
  const { classify } = await import('../src/lib/sourceHealth');
  fake.setMode({ mode: 'slow', ms: 400 });
  try {
    await assert.rejects(gql(ABOUT, {}, 100), (e: Error) => e.message === 'suwayomi timeout after 100ms');
    assert.equal(classify(new Error('suwayomi timeout after 100ms')), 'down');
  } finally {
    fake.setMode('up');
  }
});

test("the engine answering with the extension's error keeps its own shape", async () => {
  const { gql } = await client();
  fake.setMode({ mode: 'extension_error', source: SOURCE_IDS.mangaBall, stage: 'search' });
  try {
    await assert.rejects(gql(SEARCH, { source: SOURCE_IDS.mangaBall, query: 'ball' }),
      (e: Error) => e.message.startsWith('suwayomi: Exception while fetching data (/fetchSourceManga) : java.lang.Exception'));
  } finally {
    fake.setMode('up');
  }
  assert.equal((await gql<any>(ABOUT)).aboutServer.name, 'Suwayomi-Server');
});

// ---- the engine refusing the query (the engine upgrade) ----------------------------------------------------------

test('a refusal is an EngineRefusedError, recorded by its operation until that operation answers again', async () => {
  // An engine without a member Uchiyomi asks for (an older or newer one) answers 200 with no data and graphql-java's
  // "Validation error (". Reintroduce by throwing a plain Error for it in gql(): the instanceof assertion fails, and
  // register.ts and Health read the incompatible engine as one that is down.
  const { gql, EngineRefusedError, engineRefusals, forgetEngineRefusals } = await client();
  const { listRemoteSources } = await import('../src/lib/sources/suwayomi/sources');
  forgetEngineRefusals();
  fake.reset();
  fake.withoutMembers(['SourceType.contentWarning']);
  try {
    let err: any;
    await listRemoteSources().catch((e) => { err = e; });
    assert.ok(err instanceof EngineRefusedError, `not an EngineRefusedError: ${err}`);
    assert.equal(err.op, 'sources');
    assert.match(err.message, /^suwayomi: Validation error \(FieldUndefined@\[sources\/nodes\/contentWarning\]\) : Field 'contentWarning' in type 'SourceType' is undefined$/,
      'the engine\'s own words, after our prefix');
    assert.deepEqual(engineRefusals().map((r) => [r.op, r.message.slice(0, 32)]), [['sources', 'Validation error (FieldUndefined']]);
    // A query no registry holds (a test's own) is refused the same way and never recorded.
    await assert.rejects(gql('{ aboutServer { codename } }'), (e) => e instanceof EngineRefusedError && e.op === undefined);
    assert.equal(engineRefusals().length, 1);
  } finally {
    fake.withoutMembers([]);
  }
  // The engine takes it again (updated, or put back): the record goes. Reintroduce by never deleting it: Health would
  // say "Not compatible" about an engine that answers everything.
  assert.ok((await listRemoteSources()).length > 0);
  assert.deepEqual(engineRefusals(), []);
});

test('an engine without the Cloudflare setting is unsupported, in its own words, and not an incompatible engine', async () => {
  // graphql-java words it "Validation error (FieldUndefined@[settings/flareSolverrEnabled])"; the matcher used to
  // know only graphql-js's "Cannot query field", so the answer was thrown and the row said "could not be read just
  // now" for good. Reintroduce /Cannot query field/ alone in engineSolver.ts: getEngineSolver rejects. The read is
  // optional (operations.ts): reintroduce recording optional operations in gql() and engineRefusals() lists it.
  const { engineRefusals, forgetEngineRefusals } = await client();
  const { getEngineSolver } = await import('../src/lib/sources/suwayomi/engineSolver');
  forgetEngineRefusals();
  fake.reset();
  fake.withoutMembers(['SettingsType.flareSolverrEnabled']);
  try {
    assert.deepEqual(await getEngineSolver(), { supported: false });
    assert.deepEqual(engineRefusals(), [], 'an engine without the setting was recorded as incompatible');
  } finally {
    fake.withoutMembers([]);
  }
  assert.equal((await getEngineSolver()).supported, true);
});

test("an extension's error is never a refusal, even when it quotes the engine's words", async () => {
  // Two shapes: a failed fetcher (`data` with the field null, "Exception while fetching data …"), and
  // fetchMangaAndChapters' stored rows with the bare message beside them -- which here OPENS with "Validation error (".
  // Only the missing `data` key tells them apart. Reintroduce by dropping the `data` check in client.ts refused(): the
  // chapters' error is an EngineRefusedError and an extension failing would read as an incompatible engine.
  const { gql, EngineRefusedError, engineRefusals, forgetEngineRefusals } = await client();
  const { OPS } = await import('../src/lib/sources/suwayomi/operations');
  forgetEngineRefusals();
  fake.reset();
  const words = "Validation error (FieldUndefined@[x]) : Field 'x' in type 'Y' is undefined";
  fake.setMode({ mode: 'extension_error', source: SOURCE_IDS.mangaBall, message: words });
  try {
    let search: any;
    await gql(SEARCH, { source: SOURCE_IDS.mangaBall, query: 'ball' }).catch((e) => { search = e; });
    assert.ok(search && !(search instanceof EngineRefusedError));
    assert.ok(search.message.startsWith('suwayomi: Exception while fetching data (/fetchSourceManga) : Validation error ('));
    let chapters: any;
    await gql(OPS.fetchChapters.doc, { id: fake.manga('Ball Runner').id }).catch((e) => { chapters = e; });
    assert.ok(chapters && !(chapters instanceof EngineRefusedError), `the extension's words were read as a refusal: ${chapters}`);
    assert.equal(chapters.message, `suwayomi: ${words}`);
    assert.deepEqual(engineRefusals(), []);
  } finally {
    fake.setMode('up');
  }
});
