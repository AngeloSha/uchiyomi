// A stand-in for Suwayomi behind the shim, for test/shell.engine.test.mjs: started by a fake `jre/bin/java`
// with the real launch's arguments and environment. It answers GET /api/v1/settings/about like the engine
// (401 without the basic-auth pair from UCHIYOMI_ENGINE_AUTH_*, 200 with it), writes what it was given to
// $FAKE_ENGINE_REPORT, and -- like the shim's lifeline -- exits 0 when stdin closes.
//   FAKE_ENGINE_MODE=hang   never listens (the ClassGraph trap: alive, never answering)
//   FAKE_ENGINE_MODE=die    exits 1 at once
//   FAKE_ENGINE_MODE=crash-once  answers, then exits 3 after 300 ms, but only the first time ($FAKE_ENGINE_REPORT.crashed marks it)
import http from 'node:http';
import fs from 'node:fs';

const mode = process.env.FAKE_ENGINE_MODE || 'ok';
const port = Number((process.argv.find((a) => a.startsWith('-Dsuwayomi.tachidesk.config.server.port=')) || '').split('=')[1]);
const report = process.env.FAKE_ENGINE_REPORT;
if (report) {
  fs.writeFileSync(report, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(UCHIYOMI_|TEMP$|TMP$|TMPDIR$|JAVA_TOOL_OPTIONS$|PG)/.test(k))) }));
}
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
if (mode === 'die') process.exit(1);
if (mode !== 'hang') {
  const want = `Basic ${Buffer.from(`${process.env.UCHIYOMI_ENGINE_AUTH_USERNAME}:${process.env.UCHIYOMI_ENGINE_AUTH_PASSWORD}`).toString('base64')}`;
  http.createServer((req, res) => {
    res.writeHead(req.headers.authorization === want ? 200 : 401, { 'content-type': 'application/json' });
    res.end('{}');
  }).listen(port, '127.0.0.1');
  if (mode === 'crash-once' && report && !fs.existsSync(`${report}.crashed`)) {
    setTimeout(() => { fs.writeFileSync(`${report}.crashed`, '1'); process.exit(3); }, 300);
  }
}
