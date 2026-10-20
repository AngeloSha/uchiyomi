// A release must not invalidate the npm installs in Dockerfile.aio.
//
// Every release bumps "version" in web/ and bff/ package.json and package-lock.json and changes nothing
// else in them. When the npm ci steps started from those files directly, that bump alone changed their
// input, so each release re-ran all three installs from nothing and left another full node_modules in the
// build cache. The `pkgs` stage hands the installs copies with the root version pinned, so the installs
// stay cached until a dependency really changes.
//
// What has to hold, and how it quietly stops holding:
//   * every npm ci starts from the pinned copies -- a stage that goes back to `COPY web/package.json ...`
//     builds fine and is simply slow and large again;
//   * pinning touches only the root version -- two releases with the same dependencies must produce
//     byte-identical copies, or the cache key still moves;
//   * the runtime still carries the REAL bff/package.json after its install, because lib/appVersion.ts
//     reads the running version from it (appVersion.test.ts).
//
// No Docker here: the stage's own script is run with this node against copies of the real package files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
const dockerfile = readFileSync(join(REPO, 'Dockerfile.aio'), 'utf8');

// What docker executes: comments dropped, `\` continuations joined, split into stages at each FROM.
const instructions = dockerfile
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')
  .replace(/\\\n/g, ' ')
  .split('\n')
  .filter((l) => l.trim() !== '');
const stages: { name: string; lines: string[] }[] = [];
for (const line of instructions) {
  const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
  if (from) stages.push({ name: from[1] ?? '', lines: [] });
  else stages[stages.length - 1]?.lines.push(line);
}

test('every npm install starts from the version-pinned package files', () => {
  const installing = stages.filter((s) => s.lines.some((l) => /RUN npm ci\b/.test(l)));
  assert.deepEqual(installing.map((s) => s.name).sort(), ['api', 'runtime', 'web']);
  for (const stage of installing) {
    const at = stage.lines.findIndex((l) => /RUN npm ci\b/.test(l));
    const copies = stage.lines.slice(0, at).filter((l) => /^COPY\b/.test(l));
    assert.ok(copies.length > 0, `${stage.name}: nothing is copied before npm ci`);
    assert.match(copies[copies.length - 1], /^COPY --from=pkgs\b/,
      `${stage.name}: npm ci starts from the real package files, so every release re-runs it`);
  }
});

test('two releases with the same dependencies give the installs identical files', () => {
  const pkgs = stages.find((s) => s.name === 'pkgs');
  assert.ok(pkgs, 'there is no pkgs stage');
  const run = pkgs!.lines.find((l) => /^RUN node -e /.test(l));
  assert.ok(run, 'the pkgs stage no longer pins the version with node -e');
  const script = /node -e '([^']+)'/.exec(run!)![1];
  const files = ['web/package.json', 'web/package-lock.json', 'bff/package.json', 'bff/package-lock.json'];

  // The real files as they are, and the same files as the next release would have them.
  const pinned = (bump: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'uchiyomi-pkgs-'));
    try {
      for (const f of files) {
        if (!existsSync(join(REPO, f))) continue;
        mkdirSync(join(dir, f, '..'), { recursive: true });
        const j = JSON.parse(readFileSync(join(REPO, f), 'utf8'));
        if (bump) {
          j.version = '999.0.0';
          if (j.packages?.['']) j.packages[''].version = '999.0.0';
        }
        writeFileSync(join(dir, f), JSON.stringify(j, null, 2) + '\n');
      }
      execFileSync(process.execPath, ['-e', script, ...files], { cwd: dir });
      return Object.fromEntries(files.filter((f) => existsSync(join(dir, f))).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const now = pinned(false);
  const next = pinned(true);
  assert.deepEqual(Object.keys(now).sort(), Object.keys(next).sort());
  for (const f of Object.keys(now)) assert.equal(next[f], now[f], `${f} still differs between two releases`);

  // Only the root version moved: the dependencies npm installs are untouched.
  for (const f of Object.keys(now)) {
    const real = JSON.parse(readFileSync(join(REPO, f), 'utf8'));
    const out = JSON.parse(now[f]);
    assert.equal(out.version, '0.0.0', `${f}: version not pinned`);
    assert.deepEqual(out.dependencies, real.dependencies, `${f}: dependencies changed`);
    if (real.packages) {
      for (const key of Object.keys(real.packages).filter((k) => k !== '')) {
        assert.deepEqual(out.packages[key], real.packages[key], `${f}: ${key} changed`);
      }
    }
  }
});

test('the runtime still ships the real bff/package.json after its install', () => {
  const runtime = stages.find((s) => s.name === 'runtime');
  assert.ok(runtime, 'there is no runtime stage');
  const install = runtime!.lines.findIndex((l) => /RUN npm ci\b/.test(l));
  const real = runtime!.lines.findIndex((l, i) => i > install && /^COPY bff\/package\.json\b/.test(l));
  assert.ok(real > install, 'the runtime keeps the pinned package.json, so the app reports version 0.0.0');
});
