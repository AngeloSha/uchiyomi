// The packaged app's headless --smoke on a fresh profile, with the extension engine installed from the pack
// engine-fixture.mjs prepared (served on loopback): postgres + solver + bff, the sign-in handshake and each of
// its refusals, the bff's own backup, a direct pg_dump, the engine download -> verify -> unpack -> start -> bff
// restart -> the bff reaching it, then the ordered stop (bff, engine, solver, postgres).
import { join } from 'node:path';
import { OUT, appExe, record, tmpRoot, smoke, smokeDigest, readJson, serveFile } from './lib.mjs';

const fixture = readJson(join(OUT, 'engine-fixture.json'));
const served = fixture ? await serveFile(fixture.file) : null;
const root = tmpRoot('smoke');
try {
  const s = await smoke(appExe(), root, [`--library-dir=${root}-library`, ...(served ? [`--engine-pack-url=${served.url}`, `--engine-pack-sha256=${fixture.sha256}`] : [])], { timeoutMs: 10 * 60_000 });
  const d = smokeDigest(s);
  const e = d.engine || {};
  const ok = d.ok && !!served && e.pass === true;
  record('D-smoke', ok ? 'PASS' : 'FAIL',
    `healthz ${d.healthz}, desktop mode ${d.desktop}; sign-in: no header ${d.signIn?.noHeader}, wrong secret ${d.signIn?.wrongSecret}, foreign Origin ${d.signIn?.foreignOrigin}, the shell's secret ${d.signIn?.ok} (cookies ${d.signIn?.cookies?.join('+')}), password login ${d.signIn?.passwordLogin}; solver "${d.solver}"; bff backup ${d.bffBackup?.pass ? 'ok' : 'FAILED'} (${JSON.stringify(d.bffBackup?.files || {})}); restored through the shell: ${d.restore?.pass ? `ok in ${d.restore.ms} ms` : `FAILED ${d.restore?.error || ''}`}; engine ${served ? `${(e.states || []).join(' -> ')} in ${e.installMs} ms (pack: ${fixture.source}), engine basic auth ${e.engineAuthed}/${e.engineAnonymous}, bff sees it: ${e.extensionsStatus?.reachable} ${e.extensionsStatus?.version || ''}` : 'NO FIXTURE'}; stop ${JSON.stringify(d.stop)}${d.error ? `; error: ${d.error.slice(0, 400)}` : ''}`,
    { smoke: d, fixture });
} finally {
  served?.close();
}
