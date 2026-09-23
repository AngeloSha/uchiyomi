// S2: the bundled Postgres through the packaged app's --smoke path (initdb -> pg_ctl start -> bff migrations ->
// the bff's own backup task [pg_dump found on PATH + tar] and a direct pg_dump -> ordered stop), in the situations
// a real PC produces:
//   i    the runner's own account (on Windows: an elevated administrator, which postgres.exe refuses unless pg_ctl
//        drops the rights itself)
//   ii   a user profile with a non-ASCII name (Windows): initdb under "Jösé 名前" with the fallback OFF must fail
//        (PostgreSQL BUG #16926); with the fallback ON the same install must work
//   iii  after a hard kill of everything (stale postmaster.pid), and after a crash of the shell alone (postgres
//        orphaned and still running): the next start recovers
// (iv, the standard user, is s2-standard-user.ps1.)
import { cpSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WIN, appExe, record, smoke, smokeDigest, tmpRoot, launch, waitHealthy, snapshot, hardKill, isAlive, runSync, sleep, OUT, APP_EXTRA } from './lib.mjs';

const exe = appExe();
const only = process.env.S2_ONLY ? process.env.S2_ONLY.split(',') : null;
const want = (k) => !only || only.includes(k);

function pgLogTail(root, n = 1500) {
  for (const f of [join(root, 'logs', 'postgres.log')]) {
    try { return readFileSync(f, 'utf8').slice(-n); } catch { /* none */ }
  }
  return '';
}

// ---------------------------------------------------------------- i: this account
if (want('i')) {
  const root = tmpRoot('s2-i');
  const s = smoke(exe, root);
  const d = smokeDigest(s);
  let who = {};
  if (WIN) {
    const groups = runSync('whoami', ['/groups']).out;
    const lua = runSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', '/v', 'EnableLUA']).out;
    who = {
      user: runSync('whoami', []).out.trim(),
      elevated: /S-1-16-12288/.test(groups),
      administratorsGroup: /S-1-5-32-544/.test(groups),
      enableLUA: (/EnableLUA\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(lua) || [])[1] || lua.trim().slice(0, 200),
      groupLines: groups.split(/\r?\n/).filter((l) => /Administrators|Mandatory Label|S-1-5-32-544|S-1-16-/i.test(l)).map((l) => l.replace(/\s+/g, ' ').trim()),
    };
  } else {
    who = { user: runSync('id', []).out.trim() };
  }
  const ok = d.ok && d.healthz === 200 && d.bffBackup?.pass && d.shellDump?.usersTable;
  record(WIN ? 'S2-i-admin' : 'S2-lifecycle', ok ? 'PASS' : 'FAIL',
    `initdb+start+backup+stop as ${who.user}${WIN ? ` (elevated=${who.elevated}, UAC EnableLUA=${who.enableLUA})` : ''}: healthz ${d.healthz}, bff backup db.sql.gz ${d.bffBackup?.files?.['db.sql.gz']} B / ${d.bffBackup?.tables} tables incl. users, config.tar.gz ${d.bffBackup?.files?.['config.tar.gz']} B, shell pg_dump ${d.shellDump?.bytes} B; stop ${d.stop?.bff}/${d.stop?.postgres}; initdb ${d.timeline ? d.timeline.initdbDone - d.timeline.initdbStart : '?'} ms, boot->healthy ${d.timeline?.bffHealthy} ms`,
    { who, smoke: d });
}

// ---------------------------------------------------------------- ii: non-ASCII profile (Windows)
if (WIN && want('ii')) {
  const local = process.env.LOCALAPPDATA;
  const name = 'Jösé 名前';
  const base = join(local, name, 'Uchiyomi');
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  const t0 = Date.now();
  cpSync(dirname(exe), join(base, 'app'), { recursive: true });
  const exe2 = join(base, 'app', 'Uchiyomi.exe');
  const copyMs = Date.now() - t0;
  const acp = runSync('powershell.exe', ['-NoProfile', '-Command', '[System.Text.Encoding]::Default.CodePage; (Get-Culture).Name']).out.trim().replace(/\r?\n/g, ' ');
  // The 8.3 short name is the other mitigation the design names; record whether this volume even has them.
  const shortName = runSync('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:P).ShortPath'], { env: { ...process.env, P: base } }).out.trim();
  const eightDot3 = runSync('fsutil', ['8dot3name', 'query', 'C:']).out.trim().split(/\r?\n/).slice(-2).join(' ');

  // a) fallback OFF, binaries AND data under the non-ASCII path: expect initdb to fail.
  const a = smokeDigest(smoke(exe2, join(base, 'data-nofallback'), ['--no-ascii-fallback']));
  const initdbFailed = /initdb failed|PG_INITDB_FAILED/.test(a.error || '');
  record('S2-ii-nonascii-nofallback', initdbFailed ? 'EXPECTED' : a.ok ? 'INFO' : 'FAIL',
    initdbFailed ? `reproduced: initdb fails under "${base}" (ANSI code page ${acp}): ${(a.error || '').split('\n').find((l) => /initdb|could not|invalid|error/i.test(l))?.slice(0, 300)}`
      : a.ok ? `NOT reproduced: initdb worked under "${base}" with the fallback off (ANSI code page ${acp})` : `failed, but not in initdb: ${(a.error || '').slice(0, 400)}`,
    { base, acp, smoke: a });

  // b) fallback ON, same install, fresh data dir.
  const bRoot = join(base, 'data');
  const b = smokeDigest(smoke(exe2, bRoot));
  const bOk = b.ok && b.bffBackup?.pass;
  let acl = '';
  if (b.fallback?.base) acl = runSync('icacls', [b.fallback.base]).out.trim().slice(0, 600);
  record('S2-ii-nonascii-fallback', bOk ? 'PASS' : 'FAIL',
    `binaries+data under "${base}", fallback ON: ${bOk ? 'works' : 'FAILS'}; cluster at ${b.fallback?.base || '(no fallback used)'} (binaries copied: ${b.fallback?.copied}); bff backup ${b.bffBackup?.files?.['db.sql.gz']} B into the non-ASCII BACKUP_DIR; 8.3 short path "${shortName}" (${eightDot3}); app copy ${copyMs} ms`,
    { base, shortName, eightDot3, acl, smoke: b });

  // c) which part of the path matters: ASCII binaries, non-ASCII DATA only, fallback off -- once with characters
  //    the Windows-1252 code page has (Jösé) and once with ones it does not (名前).
  for (const [tag, seg] of [['cp1252', 'Jösé'], ['cjk', '名前']]) {
    const root = join(local, `uchi-s2c-${seg}`, 'data');
    rmSync(dirname(root), { recursive: true, force: true });
    const c = smokeDigest(smoke(exe, root, ['--no-ascii-fallback']));
    record(`S2-ii-dataonly-${tag}`, 'INFO',
      `binaries ASCII, data under "${root}", fallback off: ${c.ok ? 'works' : `fails: ${(c.error || '').split('\n').find((l) => /initdb|failed|error/i.test(l))?.slice(0, 240)}`}`,
      { root, smoke: c });
    rmSync(dirname(root), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- iii: power-off (everything killed) and shell crash (postgres orphaned)
async function bootAndKill(tag, killPostgres) {
  const root = tmpRoot(`s2-${tag}`);
  const child = launch(exe, [...APP_EXTRA, `--data-dir=${root}`], { log: join(OUT, `s2-${tag}-app.log`) });
  let port;
  try {
    port = await waitHealthy(root, 240_000);
  } catch (e) {
    hardKill([child.pid]);
    return { root, error: String(e) };
  }
  const snap = snapshot(root);
  const pgdata = snap.pgdata;
  const pgPid = snap.pgPid;
  const tree = new Set(snap.appPids);
  const pgTree = new Set(snap.pgPids);
  const before = { app: [...tree], postgres: [...pgTree], roles: snap.list.map((p) => `${p.role}:${p.pid}`) };
  if (killPostgres) hardKill([...pgTree]);
  hardKill([...tree]);
  await sleep(3000);
  const survivors = { app: [...tree].filter(isAlive), postgres: [...pgTree].filter(isAlive) };
  return { root, port, pgdata, pgPid, before, survivors, pidFileLeft: existsSync(join(pgdata, 'postmaster.pid')) };
}

if (want('iii')) {
  // Power-off: postgres and the whole app killed at once. postmaster.pid is left behind, its pid dead.
  const k = await bootAndKill('poweroff', true);
  if (k.error) record('S2-iii-poweroff', 'FAIL', `could not boot the app to kill it: ${k.error}`, k);
  else {
    const s = smokeDigest(smoke(exe, k.root));
    const log = pgLogTail(k.root, 4000);
    const recovered = /not properly shut down|automatic recovery|was interrupted/.test(log);
    const ok = s.ok && s.bffBackup?.pass;
    record('S2-iii-poweroff', ok ? 'PASS' : 'FAIL',
      `killed postgres (${k.before.postgres.length} procs) + app (${k.before.app.length} procs) hard; postmaster.pid left: ${k.pidFileLeft}; survivors ${JSON.stringify(k.survivors)}; next start: ${ok ? 'recovered' : 'FAILED'} (lock: ${s.staleRecovery}, WAL crash recovery logged: ${recovered})`,
      { kill: k, smoke: s, postgresLogTail: log.slice(-1500) });
  }
  // Shell crash: only the app is killed. Does postgres outlive it (Windows job objects, macOS reparenting), and
  // does the next launch find and stop the orphan instead of fighting it for the data directory?
  const o = await bootAndKill('orphan', false);
  if (o.error) record('S2-iii-orphan', 'FAIL', `could not boot the app to kill it: ${o.error}`, o);
  else {
    const orphaned = o.survivors.postgres.length > 0;
    const s = smokeDigest(smoke(exe, o.root));
    const ok = s.ok;
    record('S2-iii-orphan', ok ? 'PASS' : 'FAIL',
      `killed the app only; postgres ${orphaned ? `SURVIVED as an orphan (${o.survivors.postgres.length} procs)` : 'died with it'}; next start: ${ok ? 'ok' : 'FAILED'} (lock: ${s.staleRecovery})`,
      { kill: o, smoke: s });
  }
}
