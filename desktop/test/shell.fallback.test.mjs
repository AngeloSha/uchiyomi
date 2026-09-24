// The Windows non-ASCII fallback folder in %ProgramData%: never one this app did not make, never one that is not
// private, and never a binary copy that is not the bundle.
//
// ⚠️ Why this is security, not tidiness: %ProgramData% is writable by every local account, and the folder holds
// the postgres binaries and the engine's JRE this user RUNS, and the database with tracker tokens in it. Until
// v0.44.0's review the folder was `%ProgramData%\Uchiyomi\<sha256 of a predictable path>`, created with mkdir -p
// (a folder someone else made first was quietly adopted), a failed icacls only logged "continuing", and the copy
// was refreshed only when PG_BUNDLE.json changed -- so a second account on a shared PC could plant pg/bin/*.exe
// for this user to run. The icacls/Get-Acl calls themselves need Windows (desktop.yml S2-ii exercises them on
// windows-latest, including a refusal); everything that DECIDES is here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sddlPrivate, isFallbackName, newFallbackName, claimFallback, sameTree, syncCopy } = require('../src/postgres.js');
const { Supervisor } = require('../src/supervisor.js');
const { layout } = require('../src/paths.js');

const quiet = { info() {}, warn() {}, error() {} };
const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readState = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

test('the ACL read back: only this user, SYSTEM and Administrators, protected from inheritance', () => {
  // Reintroduce by returning { ok: true } once the owner is trusted: every "not private" case below passes.
  // What icacls /inheritance:r /grant:r leaves, as Get-Acl prints it; and the same made by an elevated admin.
  const mine = `D:PAI(A;OICI;FA;;;${ME})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
  assert.deepEqual(sddlPrivate(`O:${ME}G:${ME.replace(/1001$/, '513')}${mine}`, ME), { ok: true });
  assert.deepEqual(sddlPrivate(`O:BAG:SY${mine}`, ME), { ok: true });
  // A deny entry for someone else takes nothing from us.
  assert.equal(sddlPrivate(`O:${ME}${mine.replace('D:PAI', `D:PAI(D;OICI;FA;;;${OTHER})`)}`, ME).ok, true);
  // The built-in Administrator account prints as LA.
  const admin = 'S-1-5-21-1-2-3-500';
  assert.equal(sddlPrivate(`O:LAG:LAD:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)`, admin).ok, true);
  assert.equal(sddlPrivate(`O:LAG:LAD:PAI(A;OICI;FA;;;LA)`, ME).ok, false, 'LA is only this user when this user IS the -500 account');

  const not = (sddl, why) => {
    const v = sddlPrivate(sddl, ME);
    assert.equal(v.ok, false, `accepted: ${sddl}`);
    assert.match(String(v.why), why, `${sddl}: ${v.why}`);
  };
  // A fresh %ProgramData% child before the lock: inherited, Users may read and create folders, CREATOR OWNER.
  not(`O:${ME}G:${ME}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIIOID;GA;;;CO)(A;OICIID;0x1200a9;;;BU)(A;CIID;DCLCRPCR;;;BU)`, /inherits/);
  // Another account made it, kept itself on the ACL (icacls /grant:r replaces only the SIDs it names), or owns it.
  not(`O:${ME}${mine.replace('D:PAI', `D:PAI(A;OICI;FA;;;${OTHER})`)}`, new RegExp(OTHER));
  not(`O:${OTHER}${mine}`, /owned by/);
  not(`O:${ME}${mine}(A;OICI;0x1200a9;;;BU)`, /S-1-5-32-545|BU has access/);
  not(`O:${ME}${mine}(A;OICIIO;FA;;;CO)`, /CO has access/);
  not(`O:${ME}${mine}(A;;FA;;;WD)`, /WD has access/);
  // What it cannot read is a no: a null DACL, a conditional entry, nothing at all.
  not(`O:${ME}D:NO_ACCESS_CONTROL`, /null DACL/);
  not(`O:${ME}${mine}(XA;OICI;FA;;;${ME};(WIN://SYSAPPID Contains "x"))`, /unreadable/);
  not(`O:${ME}G:${ME}`, /no DACL/);
  not('', /owned by/);
  not('Get-Acl : Cannot find path', /owned by/);
  // The read-back runs Windows' own PowerShell by absolute path (a PATH can put another one first), with the
  // folder in the environment rather than on the command line.
  const src = fs.readFileSync(new URL('../src/postgres.js', import.meta.url), 'utf8');
  assert.match(src, /'System32', 'WindowsPowerShell', 'v1\.0', 'powershell\.exe'\)/);
  assert.match(src, /\(Get-Acl -LiteralPath \$env:UCHIYOMI_ACL_DIR\)\.Sddl/);
  assert.doesNotMatch(src, /run\('powershell/);
});

test('the folder name: random, directly under %ProgramData%, and state.json cannot point it anywhere else', () => {
  // Reintroduce by going back to a hash of the data path: the two names below are equal.
  const pd = path.join(os.tmpdir(), 'ProgramData');
  const a = newFallbackName(pd);
  const b = newFallbackName(pd);
  assert.notEqual(a, b, 'the fallback name is predictable');
  assert.match(path.basename(a), /^Uchiyomi-[0-9a-f]{16}$/);
  assert.equal(path.dirname(a), pd, 'not directly under %ProgramData% (a shared parent can be made and owned by someone else)');
  assert.equal(isFallbackName(a, pd), true);
  assert.equal(isFallbackName(path.join(pd, 'Uchiyomi', '0123456789ab'), pd), false, 'the pre-review predictable layout is accepted');
  assert.equal(isFallbackName(path.join(os.tmpdir(), 'elsewhere', path.basename(a)), pd), false, 'state.json can point the database outside %ProgramData%');
  assert.equal(isFallbackName(path.join(pd, 'Uchiyomi-XYZ'), pd), false);
  assert.equal(isFallbackName(undefined, pd), false);
  assert.equal(isFallbackName(42, pd), false);
});

test('claiming the folder: made here, locked, read back, empty -- never adopted, never used after a failure', async () => {
  const pd = tmp('uchi-pd-');
  const calls = [];
  const lock = async (d) => { calls.push(['lock', d]); };
  const verify = async (d) => { calls.push(['verify', d]); };
  const o = (extra = {}) => ({ recorded: false, log: quiet, lock, verify, ...extra });
  try {
    // Fresh: made, then locked, then read back.
    const dir = newFallbackName(pd);
    assert.deepEqual(await claimFallback(dir, o()), { dir, created: true });
    assert.deepEqual(calls, [['lock', dir], ['verify', dir]]);
    assert.ok(fs.statSync(dir).isDirectory());

    // ⚠️ The attack: another account made the folder first (with a way back in). Refused, untouched, and neither
    // locked (which would keep their ACE) nor read. Reintroduce by `fs.mkdirSync(dir, { recursive: true })`:
    // this claim then succeeds.
    calls.length = 0;
    const theirs = newFallbackName(pd);
    fs.mkdirSync(path.join(theirs, 'pg', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(theirs, 'pg', 'bin', 'postgres.exe'), 'not postgres');
    await assert.rejects(claimFallback(theirs, o()), (e) => e.code === 'FALLBACK_TAKEN' && /did not create it/.test(e.message));
    assert.deepEqual(calls, [], 'a folder someone else made was locked or verified, i.e. adopted');
    assert.equal(fs.readFileSync(path.join(theirs, 'pg', 'bin', 'postgres.exe'), 'utf8'), 'not postgres');

    // The lock failed: the claim fails (it used to log "continuing"), and the empty folder is removed so the next
    // start makes a clean one. Reintroduce by catching the lock's error: this claim resolves.
    const unlocked = newFallbackName(pd);
    await assert.rejects(claimFallback(unlocked, o({ lock: async () => { throw Object.assign(new Error('icacls exit 5'), { code: 'FALLBACK_LOCK_FAILED' }); } })), /icacls exit 5/);
    assert.equal(fs.existsSync(unlocked), false);
    // Locked but the read-back says it is not private: same.
    const leaky = newFallbackName(pd);
    await assert.rejects(claimFallback(leaky, o({ verify: async () => { throw Object.assign(new Error('BU has access'), { code: 'FALLBACK_NOT_PRIVATE' }); } })), /BU has access/);
    assert.equal(fs.existsSync(leaky), false);

    // Someone got a file in between the mkdir and the lock: refused, and what they put there is left alone.
    const raced = newFallbackName(pd);
    await assert.rejects(
      claimFallback(raced, o({ lock: async (d) => { fs.mkdirSync(path.join(d, 'engine-runtime')); } })),
      (e) => e.code === 'FALLBACK_TAMPERED' && /engine-runtime/.test(e.message),
    );
    assert.ok(fs.existsSync(path.join(raced, 'engine-runtime')), 'something someone else put there was deleted');

    // Recorded in state.json and still there: read back again on every start, not re-locked, not re-made.
    calls.length = 0;
    assert.deepEqual(await claimFallback(dir, o({ recorded: true })), { dir, created: false });
    assert.deepEqual(calls, [['verify', dir]]);
    await assert.rejects(claimFallback(dir, o({ recorded: true, verify: async () => { throw new Error('owned by S-1-5-21-9'); } })), /owned by/);
    assert.ok(fs.existsSync(dir), 'a recorded folder that failed its check was deleted (the cluster lives there)');

    // Recorded but gone (someone cleaned %ProgramData%): made again, the same careful way.
    calls.length = 0;
    const gone = newFallbackName(pd);
    const warned = [];
    assert.deepEqual(await claimFallback(gone, o({ recorded: true, log: { info() {}, warn: (m) => warned.push(m) } })), { dir: gone, created: true });
    assert.deepEqual(calls, [['lock', gone], ['verify', gone]]);
    assert.match(warned.join('\n'), /is gone/);
  } finally {
    fs.rmSync(pd, { recursive: true, force: true });
  }
});

test('the binary copy is the bundle, file for file, and is swapped in whole', () => {
  // Reintroduce by trusting the PG_BUNDLE.json stamp alone (drop `&& sameTree(src, copy)`): the planted DLL and
  // the half-finished copy below are both kept.
  const d = tmp('uchi-pgcopy-');
  try {
    const src = path.join(d, 'resources', 'pg');
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_BUNDLE.json'), '{"major":"16","edb":"16.15-4"}');
    fs.writeFileSync(path.join(src, 'bin', 'postgres.exe'), 'postgres');
    fs.writeFileSync(path.join(src, 'bin', 'pg_ctl.exe'), 'pg_ctl');
    fs.writeFileSync(path.join(src, 'lib', 'libpq.dll'), 'libpq');
    const base = path.join(d, 'ProgramData', 'Uchiyomi-0123456789abcdef');
    fs.mkdirSync(base, { recursive: true });
    const copy = path.join(base, 'pg');

    assert.deepEqual(syncCopy(src, copy, quiet), { copied: true });
    assert.equal(sameTree(src, copy), true);
    assert.deepEqual(syncCopy(src, copy, quiet), { copied: false }, 'an unchanged copy is copied again on every start');

    // A DLL beside postgres.exe is loaded before the system's: an extra file means the copy is not ours.
    fs.writeFileSync(path.join(copy, 'bin', 'version.dll'), 'planted');
    assert.equal(sameTree(src, copy), false);
    assert.deepEqual(syncCopy(src, copy, quiet), { copied: true });
    assert.equal(fs.existsSync(path.join(copy, 'bin', 'version.dll')), false, 'a planted DLL survived the refresh');
    // A binary of another size.
    fs.writeFileSync(path.join(copy, 'bin', 'postgres.exe'), 'something else entirely');
    assert.deepEqual(syncCopy(src, copy, quiet), { copied: true });
    assert.equal(fs.readFileSync(path.join(copy, 'bin', 'postgres.exe'), 'utf8'), 'postgres');
    // A copy a crash cut short: cpSync writes PG_BUNDLE.json first, so its stamp matched and it had no bin/.
    fs.rmSync(path.join(copy, 'bin'), { recursive: true });
    assert.deepEqual(syncCopy(src, copy, quiet), { copied: true });
    assert.equal(fs.readFileSync(path.join(copy, 'bin', 'pg_ctl.exe'), 'utf8'), 'pg_ctl');
    // An app update (new stamp).
    fs.writeFileSync(path.join(src, 'PG_BUNDLE.json'), '{"major":"16","edb":"16.16-1"}');
    assert.deepEqual(syncCopy(src, copy, quiet), { copied: true });
    assert.deepEqual(fs.readdirSync(base), ['pg'], 'a .partial copy was left behind');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A supervisor on a non-ASCII data root "on Windows", stopped right after it hands postgres its folder. */
function winSupervisor(root, claims, prepared, engines) {
  const pg = {
    port: 0, password: '', binDir: '/pg/bin', pgdata: '/pg/data',
    fallbackReasons: () => ['data: non-ASCII'],
    prepare: async (o) => { prepared.push(o); throw new Error('STOP after prepare'); },
    recoverStale: async () => 'clean', running: () => false, stop: async () => 'not-running', pidFromFile: () => 0,
  };
  return new Supervisor({
    L: layout(root), resources: '/app/resources', log: quiet, version: '0.44.0',
    utilityProcess: { fork() { throw new Error('no bff in this test'); } },
    libraryDir: path.join(root, '..', 'Library'), secret: 'x'.repeat(43), osUser: 'Jösé',
    startSolver: async () => { throw new Error('no solver in this test'); },
    enginePack: { version: 'v', key: 'k', url: null, sha256: null, bytes: null, file: '' },
    platform: 'win32',
    makePostgres: () => pg,
    makeEngine: (o) => { engines.push(o); return Object.assign(new EventEmitter(), { installed: () => false, status: () => ({ state: 'absent' }), stop: async () => 'not-running' }); },
    claimFallback: async (dir, o) => { claims.push({ dir, recorded: o.recorded }); if (claims.fail) throw claims.fail; return { dir, created: !o.recorded }; },
  });
}

test('the supervisor claims the folder before postgres or the engine touch it, and records it only once claimed', async () => {
  // Reintroduce by calling pg.prepare() before the claim (or without the base): the order below differs.
  const d = tmp('uchi-supfb-');
  try {
    const root = path.join(d, 'Jösé 名前', 'data');
    fs.mkdirSync(root, { recursive: true });
    const L = layout(root);

    // A claim that fails: postgres is never prepared and nothing is recorded, so the next start makes a new one.
    const c0 = []; const p0 = []; const e0 = [];
    c0.fail = Object.assign(new Error('not private'), { code: 'FALLBACK_NOT_PRIVATE' });
    await assert.rejects(winSupervisor(root, c0, p0, e0).start(), /not private/);
    assert.equal(p0.length, 0, 'postgres was prepared in a folder that failed its check');
    assert.equal(readState(L.state).asciiBase, undefined, 'a folder that failed its claim was recorded');

    const c1 = []; const p1 = []; const e1 = [];
    const s1 = winSupervisor(root, c1, p1, e1);
    await assert.rejects(s1.start(), /STOP after prepare/);
    assert.equal(c1.length, 1);
    assert.equal(c1[0].recorded, false);
    assert.equal(isFallbackName(c1[0].dir), true, `not a fresh random name: ${c1[0].dir}`);
    assert.notEqual(c1[0].dir, c0[0].dir, 'a failed name was tried again');
    assert.deepEqual(p1, [{ base: c1[0].dir }], 'postgres did not get the claimed folder');
    assert.equal(e1[0].asciiBase, c1[0].dir, 'the engine runtime is not in the same claimed folder');
    assert.equal(readState(L.state).asciiBase, c1[0].dir, 'the claimed folder is not recorded');

    // The next start re-checks the recorded folder rather than making another.
    const c2 = []; const p2 = []; const e2 = [];
    await assert.rejects(winSupervisor(root, c2, p2, e2).start(), /STOP after prepare/);
    assert.deepEqual(c2, [{ dir: c1[0].dir, recorded: true }]);

    // A hand-edited state.json cannot aim the cluster at a folder of someone else's choosing.
    fs.writeFileSync(L.state, JSON.stringify({ asciiBase: 'C:\\Users\\Public\\Uchiyomi-0123456789abcdef' }));
    const c3 = []; const p3 = []; const e3 = [];
    await assert.rejects(winSupervisor(root, c3, p3, e3).start(), /STOP after prepare/);
    assert.equal(c3[0].recorded, false);
    assert.notEqual(c3[0].dir, 'C:\\Users\\Public\\Uchiyomi-0123456789abcdef');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
