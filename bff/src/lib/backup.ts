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

const run = promisify(execFile);

/** pg_dump → gzip → file. Plain SQL (not -Fc) on purpose: the bundled client is a newer major than the
 *  server, and a newer custom-format archive can't be read by the older pg_restore. Plain SQL restores with
 *  any psql (including the db container's own), which is what you actually want at 3am in a crisis. */
function dumpSql(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pg = spawn('pg_dump', ['--no-owner', '--no-acl', '--clean', '--if-exists', env.DATABASE_URL]);
    const gz = createGzip();
    const out = createWriteStream(target);
    let stderr = '';
    pg.stderr.on('data', (d) => { stderr += String(d); });
    pg.on('error', reject);
    out.on('error', reject);
    gz.on('error', reject);
    pg.on('close', (code) => { if (code !== 0) reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`)); });
    out.on('finish', () => resolve());
    pg.stdout.pipe(gz).pipe(out);
  });
}

export interface BackupResult {
  dir: string;
  bytes: number;
  ms: number;
  /** true when the config archive was skipped because CONFIG_DIR held nothing */
  configEmpty?: boolean;
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

/** Dump the database + config into BACKUP_DIR/<stamp>/, then prune old runs. Throws on dump failure. */
export async function runBackup(): Promise<BackupResult> {
  const started = Date.now();
  const dir = path.join(env.BACKUP_DIR, stamp());
  await fs.mkdir(dir, { recursive: true });

  await dumpSql(path.join(dir, 'db.sql.gz'));

  // config: jwt.secret, sites.json, series-art/ overrides. Small; tar keeps permissions/layout intact.
  let configEmpty = false;
  try {
    const items = await fs.readdir(env.CONFIG_DIR);
    if (items.length) {
      await run('tar', ['-czf', path.join(dir, 'config.tar.gz'), '-C', env.CONFIG_DIR, '.'], { timeout: 5 * 60 * 1000 });
    } else configEmpty = true;
  } catch {
    configEmpty = true; // no config dir mounted — the dump alone is still worth keeping
  }

  const bytes = await dirSize(dir).catch(() => 0);
  await pruneBackups().catch(() => {});
  const res: BackupResult = { dir, bytes, ms: Date.now() - started, configEmpty };

  // persist last-run so the admin UI still reports it after a container restart (runtime.* is in-memory)
  await q(
    `UPDATE server_settings SET backup_last_run = now(), backup_last_result = $1 WHERE id = 1`,
    [JSON.stringify({ bytes: res.bytes, ms: res.ms, dir: path.basename(dir) })],
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
