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
