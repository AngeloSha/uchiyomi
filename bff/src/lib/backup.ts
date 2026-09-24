// Built-in backup task: dumps the Postgres database and archives CONFIG_DIR, keeping the newest N runs.
//
// Deliberately NOT backed up: CACHE_DIR (content-addressed image cache — regenerated on demand and already
// size-swept) and the downloaded-chapter dir (tens of GB of re-downloadable CBZs). What lives here is the
// irreplaceable part: accounts, reading progress/history, favorites, collections, ratings, the catalog, and
// the admin's art overrides + custom sites.
//
// pg_dump talks to the database over the network using DATABASE_URL — the container has no docker socket, so
// it cannot exec into the db container. `postgresql-client` is installed in the runtime image for this.
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createWriteStream } from 'fs';
import { createGzip } from 'zlib';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../env';
import { q } from './db';
import { isDesktop, forDesktop, DESKTOP_FLOORS } from './desktop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const run = promisify(execFile);

/**
 * A database URL without its password, and the password. Anything `new URL` cannot parse (the embedded
 * image's socket DSN is one) comes back untouched with no password.
 */
export function splitPassword(url: string): { url: string; password: string | null } {
  try {
    const u = new URL(url);
    if (!u.password) return { url, password: null };
    const password = decodeURIComponent(u.password);
    u.password = '';
    return { url: u.toString(), password };
  } catch {
    return { url, password: null };
  }
}

/**
 * pg_dump as the desktop app runs it: the binary the shell bundles (PG_DUMP_PATH), and the password in the
 * child's environment rather than on its command line.
 *
 * ⚠️ macOS `ps` shows every user's command lines, so a password inside the URL argument is readable by any
 * other account on the Mac for as long as the dump runs. The shell already passes it as PGPASSWORD with a
 * password-free URL; a URL that carries one anyway is split here so it still never reaches argv.
 * Reintroduce by passing the URL through unsplit: backupSchedule.test.ts "the desktop dump keeps the password
 * off the command line" and desktopBackup.test.ts find it in the arguments.
 */
export function desktopDumpCommand(args: string[], url: string, parent: NodeJS.ProcessEnv): {
  bin: string; args: string[]; env: NodeJS.ProcessEnv;
} {
  const { url: bare, password } = splitPassword(url);
  return {
    bin: parent.PG_DUMP_PATH || 'pg_dump',
    args: [...args, bare],
    env: password ? { ...parent, PGPASSWORD: password } : { ...parent },
  };
}

function desktopDump(args: string[]) {
  const c = desktopDumpCommand(args, env.DATABASE_URL, process.env);
  return spawn(c.bin, c.args, { env: c.env, windowsHide: true });
}

/** pg_dump → gzip → file. Plain SQL (not -Fc) on purpose: the bundled client is a newer major than the
 *  server, and a newer custom-format archive can't be read by the older pg_restore. Plain SQL restores with
 *  any psql (including the db container's own), which is what you actually want at 3am in a crisis. */
function dumpSql(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pg = isDesktop()
      ? desktopDump(['--no-owner', '--no-acl', '--clean', '--if-exists'])
      : spawn('pg_dump', ['--no-owner', '--no-acl', '--clean', '--if-exists', env.DATABASE_URL]);
    const gz = createGzip();
    const out = createWriteStream(target);
    let stderr = '';
    let exited: number | null = null;
    // The write stream still finishes when pg_dump never ran at all -- an empty pipe closes cleanly and gzip
    // emits its 20-byte header/trailer. Resolving on `finish` alone therefore called an absent pg_dump a
    // success, which is how the all-in-one image shipped two releases writing empty archives. Both halves
    // now have to agree: the process exited 0 AND the file closed.
    const settle = () => { if (exited === 0 && out.closed) resolve(); };
    pg.stderr.on('data', (d) => { stderr += String(d); });
    pg.on('error', (e: NodeJS.ErrnoException) =>
      reject(e?.code === 'ENOENT'
        // Say which binary and where it comes from: the failure is a missing package in the image, not
        // anything the operator did, and the message is the only thing they will have to go on.
        ? new Error(forDesktop(
          'pg_dump not found in the image — the backup task needs the postgresql client installed',
          'The bundled database tools are missing; reinstall Uchiyomi.',
        ))
        : e));
    out.on('error', reject);
    gz.on('error', reject);
    pg.on('close', (code) => {
      exited = code;
      if (code !== 0) reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`));
      else settle();
    });
    out.on('close', settle);
    pg.stdout.pipe(gz).pipe(out);
  });
}

/**
 * CONFIG_DIR as a zip, for the desktop app. The server keeps `tar`.
 *
 * ⚠️ Not `tar` on the desktop: Windows has one (bsdtar in System32), but a `tar` found first on PATH is
 * often Git for Windows' GNU tar, which reads `C:\…` as a remote host and fails. adm-zip is already here,
 * is pure JavaScript, and the shell's "Restore backup…" unpacks .zip (and a server's .tar.gz).
 * Written as `.part` and renamed, the same rule as the dump: a half-written archive must never look like one.
 */
export async function zipConfig(from: string, to: string): Promise<void> {
  const part = `${to}.part`;
  try {
    // Walked by hand rather than addLocalFolder: that stores directory entries with the platform separator
    // (`series-art\` on Windows), and its async twin strips every non-ASCII character from the names. Here
    // every entry is a file, named with `/`, spelled exactly as on disk.
    const zip = new AdmZip();
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const name = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), name);
        else if (e.isFile()) zip.addFile(name, await fs.readFile(path.join(dir, e.name)));
      }
    };
    await walk(from, '');
    await fs.writeFile(part, zip.toBuffer());
    await fs.rename(part, to);
  } catch (e) {
    await fs.rm(part, { force: true }).catch(() => {});
    throw e;
  }
}

export interface BackupResult {
  dir: string;
  bytes: number;
  ms: number;
  /** true when the config archive was skipped because CONFIG_DIR held nothing */
  configEmpty?: boolean;
  /** dirSize could not measure the folder. Distinct from a genuinely empty one, which is a failure. */
  sizeUnknown?: boolean;
}

/** UTC timestamp folder name, matching the host's existing <name>-<YYYYMMDD-HHMMSS> convention. */
function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else total += (await fs.stat(full)).size.valueOf();
  }
  return total;
}

/** Delete all but the newest `keep` backup folders. Only touches dirs this task created. */
export async function pruneBackups(keep = env.BACKUP_KEEP): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(env.BACKUP_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
      .map((e) => e.name)
      .sort(); // lexicographic == chronological for this format
  } catch {
    return [];
  }
  const doomed = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of doomed) {
    await fs.rm(path.join(env.BACKUP_DIR, name), { recursive: true, force: true }).catch(() => {});
  }
  return doomed;
}

/** Persist a failed run where the admin UI reads it. Without this the Tasks panel keeps showing the last
 *  SUCCESSFUL backup, so an install whose backups have been broken for weeks still reports a healthy one --
 *  which is exactly how a missing pg_dump went unnoticed across two releases. */
async function recordFailure(e: unknown): Promise<void> {
  const error = e instanceof Error ? e.message : String(e);
  await q(
    `UPDATE server_settings SET backup_last_run = now(), backup_last_result = $1 WHERE id = 1`,
    [JSON.stringify({ error: error.slice(0, 500), failed: true })],
  ).catch(() => {});
}

/** Dump the database + config into BACKUP_DIR/<stamp>/, then prune old runs. Throws on dump failure. */
export async function runBackup(): Promise<BackupResult> {
  const started = Date.now();
  const dir = path.join(env.BACKUP_DIR, stamp());
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // The usual cause is a host directory bind-mounted at BACKUP_DIR that the app's user can't write.
    // This runs unattended overnight, so say exactly how to fix it rather than leaving a bare errno.
    if ((e as NodeJS.ErrnoException)?.code === 'EACCES' || (e as NodeJS.ErrnoException)?.code === 'EPERM') {
      throw new Error(forDesktop(
        `cannot write to ${env.BACKUP_DIR} — the backup directory must be writable by uid 10002. ` +
          `If it is a host folder, run:  docker run --rm -v <that folder>:/b alpine chown 10002:10002 /b`,
        `Can't write to ${env.BACKUP_DIR}; check your account can write to it.`,
      ));
    }
    throw e;
  }

  try {
    // Written as .part and renamed once pg_dump has exited 0 and the file has closed. A SIGKILL or OOM in the
    // middle used to leave a partial db.sql.gz that `ls` and pruneBackups() both counted as a run.
    await dumpSql(path.join(dir, 'db.sql.gz.part'));
    await fs.rename(path.join(dir, 'db.sql.gz.part'), path.join(dir, 'db.sql.gz'));
  } catch (e) {
    // Leave nothing that looks like a backup. A directory holding a 20-byte archive reads as a successful
    // run in `ls`, and rotation counts it, so a week of failures can push the last good dump out of KEEP.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await recordFailure(e);
    throw e;
  }

  // config: jwt.secret, sites.json, series-art/ overrides. Small; tar keeps permissions/layout intact.
  let configEmpty = false;
  try {
    const items = await fs.readdir(env.CONFIG_DIR);
    if (items.length) {
      if (isDesktop()) await zipConfig(env.CONFIG_DIR, path.join(dir, 'config.zip'));
      else await run('tar', ['-czf', path.join(dir, 'config.tar.gz'), '-C', env.CONFIG_DIR, '.'], { timeout: 5 * 60 * 1000 });
    } else configEmpty = true;
  } catch {
    configEmpty = true; // no config dir mounted — the dump alone is still worth keeping
  }

  // `bytes` is the ONLY health signal this task has ever shown, so it must never be able to report the
  // failure value on a good run. `.catch(() => 0)` did exactly that: a readdir or stat hiccup inside dirSize
  // rendered a complete backup as '0 B' -- the identical signal to the empty-archive bug this file was
  // rewritten to prevent. `null` says "not measured", which is a different sentence from "nothing here".
  const bytes = await dirSize(dir).catch(() => null);
  await pruneBackups().catch(() => {});
  const res: BackupResult = { dir, bytes: bytes ?? 0, sizeUnknown: bytes === null, ms: Date.now() - started, configEmpty };

  // persist last-run so the admin UI still reports it after a container restart (runtime.* is in-memory)
  //
  // configEmpty and sizeUnknown are carried through here on purpose. Both were computed and then dropped at
  // this line, so a backup that had silently lost jwt.secret, sites.json and every series-art override was
  // stored as, and displayed as, a clean run.
  await q(
    `UPDATE server_settings SET backup_last_run = now(), backup_last_result = $1 WHERE id = 1`,
    [JSON.stringify({ bytes: res.bytes, ms: res.ms, dir: path.basename(dir), configEmpty: res.configEmpty, sizeUnknown: res.sizeUnknown })],
  ).catch(() => {});
  return res;
}

/** ms until the next occurrence of `hour` (local time), used to line nightly runs up with a wall clock. */
export function msUntilHour(hour: number, now = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * How long until the next backup should start.
 *
 * The server backs up at `hour` every night and nothing else: it is always on, so the hour always comes.
 * A PC is not. One that is off at three in the morning, every night, would never back up at all -- so on
 * the desktop, when the last run (or the last attempt this process made) is more than a day old, the backup
 * runs shortly after the app starts instead of waiting for an hour it may sleep through again.
 *
 * `lastAttempt` is the in-memory stamp server.ts sets as each run starts. A failed run stamps the database
 * too (recordFailure), so there is no retry loop -- but when the database is the thing that is down it
 * cannot be stamped, and without the in-memory one every re-arm would try again in five minutes.
 * With `desktop` off this is exactly `msUntilHour(hour)`, whatever the stamps say.
 * Reintroduce by dropping the `o.desktop &&`: backupSchedule.test.ts "the server ignores a month-old stamp"
 * gets five minutes.
 */
export function backupDelay(o: { hour: number; lastRun: number | null; lastAttempt: number; now: number; desktop: boolean }): number {
  if (o.desktop && o.now - Math.max(o.lastRun ?? 0, o.lastAttempt) > DAY) return DESKTOP_FLOORS.backupCatchUp;
  return msUntilHour(o.hour, new Date(o.now));
}

/**
 * The first run of a job that should happen every `interval`, counted from its last stamp: whatever is left
 * of the interval, never sooner than `floor`. No stamp (`last` 0) means now, at the floor.
 */
export const stampDelay = (o: { last: number; interval: number; floor: number; now: number }): number =>
  Math.max(o.floor, o.last + o.interval - o.now);
