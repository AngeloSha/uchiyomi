// S1(b): the packaged app boots the bff in a utilityProcess (checked by the S2 smoke), and sharp's page-hash
// throughput under Electron is at least 75 % of plain Node 24 on the same machine, same pages, same binaries.
//
// Three runtimes, interleaved (node, electron-as-node, packaged utilityProcess) x ROUNDS so a noisy neighbour on a
// shared runner hits all of them rather than one:
//   node               this Node 24 (setup-node)
//   electron-as-node   ELECTRON_RUN_AS_NODE=1 <node_modules electron>   -- the brief's comparison
//   utilityProcess     `Uchiyomi --bench` from the packaged app          -- what production actually runs
//                      (runAsNode is fused OFF in the package, so this is the only Electron-Node it has)
import { join } from 'node:path';
import { OUT, DESKTOP, appExe, devElectron, record, runSync, readJson, tmpRoot, APP_EXTRA } from './lib.mjs';

const ROUNDS = Number(process.env.S1_ROUNDS || 5);
const bff = join(DESKTOP, 'resources', 'bff');
const bench = join(DESKTOP, 'src', 'bench', 'sharp-bench.cjs');
const electron = devElectron();
const exe = appExe();
const runs = { node: [], 'electron-as-node': [], utilityProcess: [] };
const errors = [];

for (let r = 0; r < ROUNDS; r++) {
  for (const leg of Object.keys(runs)) {
    const out = join(OUT, `bench-${leg}-${r}.json`);
    let res;
    if (leg === 'node') res = runSync(process.execPath, [bench, '--bff', bff, '--out', out, '--label', leg]);
    else if (leg === 'electron-as-node') res = runSync(electron, [bench, '--bff', bff, '--out', out, '--label', leg], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    else res = runSync(exe, [...APP_EXTRA, '--bench', `--data-dir=${tmpRoot('bench')}`, `--result=${out}`]);
    const j = readJson(out);
    if (!j) { errors.push({ leg, round: r, code: res.code, out: res.out.slice(-1500) }); continue; }
    runs[leg].push(j);
    console.log(`round ${r} ${leg}: pageHash ${j.results.pageHash.medianPerSec}/s cover ${j.results.cover.medianPerSec}/s rawDecode ${j.results.rawDecode.medianPerSec}/s (${j.runtime.node}${j.runtime.electron ? ` / electron ${j.runtime.electron}` : ''})`);
  }
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
// ⚠️ PAIRED, not pooled. A shared runner's noise is correlated in time (CI run 3 on macos-15-intel: every leg of
// round 2 ran ~35 % slow together, and one utilityProcess leg halved mid-run), so comparing each leg's own median
// compares different minutes of the machine's life. Each round runs the three legs back to back; the ratio is
// taken WITHIN a round, and the verdict is the median of those per-round ratios. Pooled medians are reported
// beside it.
const perSec = (leg, r, w) => runs[leg][r]?.results[w].medianPerSec ?? null;
const table = {};
for (const w of ['pageHash', 'cover', 'rawDecode']) {
  const paired = { electronAsNode: [], utility: [] };
  for (let r = 0; r < ROUNDS; r++) {
    const n = perSec('node', r, w);
    if (!n) continue;
    const e = perSec('electron-as-node', r, w);
    const u = perSec('utilityProcess', r, w);
    if (e) paired.electronAsNode.push(+(e / n).toFixed(3));
    if (u) paired.utility.push(+(u / n).toFixed(3));
  }
  const pooled = (leg) => med(runs[leg].map((j) => j.results[w].medianPerSec));
  table[w] = {
    nodePerSec: pooled('node'), electronAsNodePerSec: pooled('electron-as-node'), utilityPerSec: pooled('utilityProcess'),
    electronAsNodeRatio: med(paired.electronAsNode), utilityRatio: med(paired.utility),
    pairedRatios: paired,
  };
}
const meta = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v[0] ? { runtime: v[0].runtime, sharp: v[0].sharp.versions?.sharp, libvips: v[0].sharp.versions?.vips, concurrency: v[0].sharp.concurrency, images: v[0].images, avgImageBytes: v[0].avgImageBytes, rssMB: v[0].rssMB } : null]));
const ph = table.pageHash;
const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)} %`);
const ok = ph.electronAsNodeRatio !== null && ph.utilityRatio !== null && ph.electronAsNodeRatio >= 0.75 && ph.utilityRatio >= 0.75;
record('S1b-sharp-throughput', ok ? 'PASS' : 'FAIL',
  `pageHash (median of per-round paired ratios): electron-as-node ${pct(ph.electronAsNodeRatio)} ${JSON.stringify(ph.pairedRatios.electronAsNode)}, utilityProcess ${pct(ph.utilityRatio)} ${JSON.stringify(ph.pairedRatios.utility)} of node [pass >= 75 %]; pooled medians node ${ph.nodePerSec}/s, electron ${ph.electronAsNodePerSec}/s, utility ${ph.utilityPerSec}/s; cover ${pct(table.cover.electronAsNodeRatio)}/${pct(table.cover.utilityRatio)}, rawDecode (2.9 MB out) ${pct(table.rawDecode.electronAsNodeRatio)}/${pct(table.rawDecode.utilityRatio)}`,
  { table, meta, rounds: ROUNDS, errors });
