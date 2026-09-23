// S1(a) verdict: the suite's counts under Electron's Node equal plain Node's, on the same runner type, and no test
// fails under one runtime that passes under the other.
//   node s1-compare.mjs <dir with suite-*.json> [--id S1a-suite-ubuntu]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { record } from './lib.mjs';

const dir = process.argv[2];
const id = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : 'S1a-suite';
const rows = readdirSync(dir, { recursive: true }).filter((f) => /suite-.*\.json$/.test(String(f))).map((f) => JSON.parse(readFileSync(join(dir, String(f)), 'utf8')));
const by = {};
for (const r of rows) {
  const k = r.runtime;
  by[k] = by[k] || { shards: 0, tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, ms: 0, glib: 0, failing: [] };
  const b = by[k];
  b.shards++;
  for (const f of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) b[f] += Number.isFinite(r[f]) ? r[f] : NaN;
  b.ms += r.ms;
  b.glib += r.glibCriticalLines || 0;
  b.failing.push(...r.failing);
  b.os = r.os;
  b.node = b.node || r.node;
}
const n = by.node;
const e = by.electron;
if (!n || !e) {
  record(id, 'FAIL', `missing a runtime: have ${Object.keys(by).join(', ')}`, { by });
  process.exit(0);
}
const onlyE = e.failing.filter((x) => !n.failing.includes(x));
const onlyN = n.failing.filter((x) => !e.failing.includes(x));
const same = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every((f) => n[f] === e[f]) && !onlyE.length && !onlyN.length && n.shards === e.shards;
record(id, same ? 'PASS' : 'FAIL',
  `node ${n.pass}/${n.tests} pass (${n.fail} fail) vs electron-as-node ${e.pass}/${e.tests} pass (${e.fail} fail); failing only under electron: ${onlyE.length}, only under node: ${onlyN.length}; wall ${Math.round(n.ms / 60000)} vs ${Math.round(e.ms / 60000)} min across ${n.shards} shard(s)${e.glib ? `; ${e.glib} GLib-GObject-CRITICAL lines under electron (Linux-only GLib clash, sharp warns)` : ''}`,
  { node: { ...n, failing: n.failing.slice(0, 50) }, electron: { ...e, failing: e.failing.slice(0, 50) }, onlyElectron: onlyE, onlyNode: onlyN });
