#!/usr/bin/env node
// Dependency-free fake extension engine for the browser walks: Suwayomi-Server v2.3.2243's GraphQL and image
// paths, strict about its schema, with a switch for the states the app has to survive.
//
//   node web/test/e2e/fakeEngine.mjs --port 18190 [--mode up] [--host 0.0.0.0]
//
// In the rig it runs like the fake sources, with the repository mounted (the engine itself is
// bff/test/fixtures/fakeSuwayomiEngine.mjs, shared with the bff tests), and the app gets
// SUWAYOMI_URL=http://<container>:<port>:
//   docker run -d --name "$NET-engine" --network "$NET" -p "127.0.0.1:$PORT:$PORT" -v "$REPO:/repo:ro" -w /repo \
//     node:24-alpine node web/test/e2e/fakeEngine.mjs --port "$PORT"
//
// Control (never part of the engine's own API):
//   POST /__mode {"mode":"up"}                                    answer normally
//   POST /__mode {"mode":"down"}                                  drop every engine request unanswered ("fetch failed")
//   POST /__mode {"mode":"slow","ms":20000}                       hold every engine answer for ms (default 15 000)
//   POST /__mode {"mode":"extension_error","source":"<id>","stage":"search","message":"java.lang.Exception"}
//        the engine answers, and the extension throws: every source and stage unless narrowed; stages are
//        search | manga | chapters | pages | images
//   POST /__catalogue {"extensions":1300,"set":{"<pkgName>":{"hasUpdate":true}}}
//        a repository the size of a real one (made-up names, catalogueExtensions in the fixture) in place of the last
//        one added, and changes to any extension: an update waiting, installed from the engine's own page, obsolete;
//        {"empty":true} first takes every extension away (an engine no repository was added to); {"failFetch":true}
//        fails re-reading the repositories as an unreachable one does, {"failList":true} the catalogue's listing
//   GET  /__mode, GET /__log (every request with its outcome), GET /__state, POST /__reset (fresh seed, mode up)
// A bad /__mode body is a 400 that names the modes and stages.
//
// The seed: the Local source, Webtoons.com (EN) with every preference kind, an Istrevelia-shaped series and a
// clean one, Manga Ball (EN) -- #115's source -- and an adult source. Ids and titles: SOURCE_IDS and
// defaultSeed() in fakeSuwayomiEngine.mjs.
//
// --extra v55 (up.sh passes E2E_FAKE_EXTRA): one more extension in the repository, NOT installed -- Gap Scans, in two
// languages, whose English source carries Gap Only with all twelve chapters (the fake sources leave out 6 and 7):
// what Health's Fix everything installs by itself to fill a gap nobody else has (autofixWalk.mjs). Its sources come
// first in the engine's order, so that under a source limit of one (E2E_MAX_SOURCES) a series on Webtoons.com is the
// one left over the limit -- Free a slot's case -- and Gap Scans keeps its place. Other extras are the fake sources'.
import { startFakeEngine, autofixSeed, MODES, SOURCE_IDS } from '../../../bff/test/fixtures/fakeSuwayomiEngine.mjs';

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 2) argv.set(process.argv[i], process.argv[i + 1]);
const port = Number(argv.get('--port') ?? 18190);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port ${argv.get('--port')}`);
const host = argv.get('--host') ?? '0.0.0.0';
const mode = argv.get('--mode') ?? 'up';
if (!MODES.includes(mode)) throw new Error(`bad --mode ${mode}; one of ${MODES.join(', ')}`);
const extra = new Set(String(argv.get('--extra') ?? '').split(',').map((e) => e.trim()).filter(Boolean));

const fake = await startFakeEngine({ port, host, ...(extra.has('v55') ? { seed: autofixSeed() } : {}) });
fake.engine.setMode(mode);
// The harness waits for this line (and a port-0 caller reads the port from it).
console.log(`[fake-engine] listening on ${fake.port} (mode ${mode}; Manga Ball is ${SOURCE_IDS.mangaBall})`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void fake.close().then(() => process.exit(0)); });
