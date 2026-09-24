// @ts-check
'use strict';
/**
 * "Restore a backup" (design-inapp.md §6): the shell's job, because the server cannot replace the database
 * it is running on.
 *
 *   1. a safety copy of what is there now: `<backups>/before-restore-<stamp>/` with db.sql.gz and config.zip,
 *      in the same shape as the bff's own backups, so it can itself be restored the same way
 *   2. stop the bff (its graceful path: the chapter in flight finishes)
 *   3. replay db.sql.gz with the bundled psql, in ONE transaction -- a failure leaves the database as it was
 *   4. unpack the backup's config archive (config.zip; a server's backup, with config.tar.gz, is refused up
 *      front by inspectBackup) into a fresh folder beside config/, then swap it in; the old one is removed only
 *      after the swap
 *   5. start the bff again
 *
 * The window then finds its refresh cookie unknown (the restored database has other refresh tokens, and a
 * restored config/ another JWT secret) and signs in again by itself through /auth/desktop.
 *
 * ⚠️ The safety folder name does not match the bff's `YYYYMMDD-HHMMSS` pattern on purpose: pruneBackups()
 * only deletes folders of that shape, so a safety copy is never rotated away by the next nightly backup.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const archive = require('./archive');

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * When the backup was made: its folder's `YYYYMMDD-HHMMSS` (UTC, the bff's naming) or the file's own time.
 * @param {string} gzFile
 * @returns {Date}
 */
function backupDate(gzFile) {
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(path.basename(path.dirname(gzFile)));
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  try { return fs.statSync(gzFile).mtime; } catch { return new Date(); }
}

/**
 * What a picked file restores: the dump, and the config archive beside it if there is one.
 *
 * ⚠️ A SERVER's backup (config.tar.gz beside the dump, as the Docker image writes it; the desktop app writes
 * config.zip) is refused with code SERVER_BACKUP. Moving a library from a server is not in v1, and restoring one
 * anyway replaced this library with one whose series all point at the server's folders (/library-dl): every
 * series missing, behind a restore that reported success.
 * @param {string} gzFile
 */
function inspectBackup(gzFile) {
  if (!/\.sql\.gz$/i.test(gzFile)) throw new Error('Choose the db.sql.gz file inside a backup folder.');
  if (!fs.existsSync(gzFile)) throw new Error('That backup file is gone.');
  const dir = path.dirname(gzFile);
  const config = ['config.zip', 'config.tar.gz'].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f)) || null;
  if (config && /\.tar\.gz$/i.test(config)) {
    const e = new Error('This backup comes from an Uchiyomi server. The desktop app cannot restore server backups yet.');
    /** @type {any} */ (e).code = 'SERVER_BACKUP';
    throw e;
  }
  return { dump: gzFile, config, date: backupDate(gzFile) };
}

/**
 * Unpack a config archive into `dest` (which must not exist yet). Symlinks and paths that climb out are refused
 * (archive.safeJoin); a server's tar.gz has entries like `./sites.json`.
 * @param {string} file
 * @param {string} dest
 */
async function unpackConfig(file, dest) {
  await fsp.mkdir(dest, { recursive: true });
  if (/\.zip$/i.test(file)) return archive.extractZip(file, dest);
  return archive.extractTarGz(file, ({ name, type }) => {
    if (type !== 'file' && type !== 'dir') return null;
    return archive.safeJoin(dest, name);
  });
}

/**
 * @param {{
 *   dump: string, config: string | null,
 *   configDir: string, backupsDir: string,
 *   pg: { dump(file: string, o?: { clean?: boolean }): Promise<any>, restoreSqlGz(file: string): Promise<any> },
 *   stopBff: () => Promise<any>, startBff: () => Promise<any>,
 *   log: { info: Function, warn: Function, error: Function },
 * }} o
 * @returns {Promise<{ safety: string, configRestored: boolean, ms: number }>}
 */
async function restore(o) {
  const t0 = Date.now();
  const safety = path.join(o.backupsDir, `before-restore-${stamp()}`);
  await fsp.mkdir(safety, { recursive: true });
  // 1. The safety copy, while the bff still runs (pg_dump takes a consistent snapshot).
  const sql = path.join(safety, 'db.sql');
  await o.pg.dump(sql, { clean: true });
  await pipeline(fs.createReadStream(sql), zlib.createGzip(), fs.createWriteStream(path.join(safety, 'db.sql.gz')));
  await fsp.rm(sql, { force: true });
  if (fs.existsSync(o.configDir)) await archive.writeZip(o.configDir, path.join(safety, 'config.zip'));
  o.log.info('restore: safety copy written', { safety });

  // 2-3. The database, with the server stopped.
  await o.stopBff();
  let configRestored = false;
  try {
    await o.pg.restoreSqlGz(o.dump);
    o.log.info('restore: database restored', { from: o.dump });
    // 4. The settings files. The database is already restored at this point, so a config archive that will not
    // unpack is reported, not rolled back: the old config/ stays in place, and the only effect of the mismatch
    // is that the window signs in again.
    if (o.config) {
      const incoming = `${o.configDir}.restoring-${crypto.randomBytes(4).toString('hex')}`;
      const old = `${o.configDir}.old-${crypto.randomBytes(4).toString('hex')}`;
      try {
        await unpackConfig(o.config, incoming);
        if (fs.existsSync(o.configDir)) await fsp.rename(o.configDir, old);
        await fsp.rename(incoming, o.configDir);
        await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
        configRestored = true;
      } catch (e) {
        await fsp.rm(incoming, { recursive: true, force: true }).catch(() => {});
        if (!fs.existsSync(o.configDir) && fs.existsSync(old)) await fsp.rename(old, o.configDir).catch(() => {});
        throw new Error(`The database was restored, but the settings files could not be: ${String(/** @type {any} */ (e)?.message || e)}`);
      }
    }
  } finally {
    // 5. Whatever happened, the app comes back.
    await o.startBff();
  }
  return { safety, configRestored, ms: Date.now() - t0 };
}

module.exports = { restore, inspectBackup, backupDate, unpackConfig, stamp };
