// @ts-nocheck
'use strict';
// Dependency-free archive helpers: the app unpacks the extension-engine pack and restores a backup's config
// archive with them; engine/pack.mjs builds the pack with them. No dependencies on purpose: this runs in the
// shell's main process, and a zip library is a large attack surface for three functions.
//
// - readZip / extractZip: central-directory reader (zip64 too: Suwayomi-Server.jar has ~79k entries), stored +
//   deflate, streams each entry (a 174 MB jar never sits in memory), checks CRC-32, restores unix modes.
// - writeZip: stored/deflate writer that records unix modes (so jre/bin/java and jre/lib/jspawnhelper stay
//   executable on macOS). No zip64: the pack is ~200 MB and ~300 entries, far from either limit; it refuses
//   rather than write a broken archive if that ever changes.
// - extractTarGz: a streaming ustar/pax/GNU reader over gunzip, for Suwayomi's macOS/Linux tarballs and a
//   server backup's config.tar.gz.
//
// ⚠️ Symlink entries are REFUSED unless the caller opts in (only the pack build does, and it then refuses them
// itself). A zip can carry `a -> /etc` followed by `a/passwd`, and the second write would land through the
// link, outside the destination -- safeJoin only sees the names.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const S_IFMT = 0o170000, S_IFLNK = 0o120000, S_IFDIR = 0o040000;

// ---------------------------------------------------------------- zip reading

async function readZip(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error(`${file}: not a zip (no end of central directory)`);
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // zip64 (Suwayomi-Server.jar has ~79k entries): the locator sits right before the classic EOCD.
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error(`${file}: zip64 locator missing`);
      const recOffset = Number(tail.readBigUInt64LE(loc + 8));
      const rec = Buffer.alloc(56);
      await fh.read(rec, 0, 56, recOffset);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error(`${file}: bad zip64 end record`);
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: bad central directory entry ${n}`);
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      const ext = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      if (usize === 0xffffffff || csize === 0xffffffff || localOffset === 0xffffffff) {
        // zip64 extended information extra field (0x0001): only the saturated values are present, in order.
        let x = p + 46 + nlen;
        const xend = x + xlen;
        while (x + 4 <= xend) {
          const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
          if (id === 0x0001) {
            let q = x + 4;
            if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          x += 4 + len;
        }
      }
      const rawName = cd.subarray(p + 46, p + 46 + nlen);
      const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/');
      const unixMode = (madeBy >> 8) === 3 ? (ext >>> 16) & 0xffff : 0;
      entries.push({ name, method, crc, csize, usize, localOffset, unixMode,
        isDir: name.endsWith('/') || (unixMode & S_IFMT) === S_IFDIR,
        isSymlink: (unixMode & S_IFMT) === S_IFLNK });
      p += 46 + nlen + xlen + clen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

async function dataOffset(fh, e) {
  const h = Buffer.alloc(30);
  await fh.read(h, 0, 30, e.localOffset);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${e.name}`);
  return e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

function crcCheck(expected, name) {
  let crc = 0;
  return new Transform({
    transform(chunk, _enc, cb) { crc = zlib.crc32(chunk, crc); cb(null, chunk); },
    flush(cb) { cb(crc >>> 0 === expected >>> 0 ? null : new Error(`CRC mismatch in ${name}`)); },
  });
}

/** Refuse absolute paths and `..` so an archive can never write outside dest. */
function safeJoin(dest, name) {
  const norm = path.posix.normalize(name);
  if (norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) {
    throw new Error(`unsafe archive path: ${name}`);
  }
  const out = path.join(dest, ...norm.split('/'));
  const rel = path.relative(dest, out);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`unsafe archive path: ${name}`);
  return out;
}

/**
 * Extract entries. `map(name)` returns the destination-relative name (posix) or null to skip.
 * Returns { files, bytes }.
 */
async function extractZip(file, dest, map = (n) => n, { allowSymlinks = false } = {}) {
  const entries = await readZip(file);
  const fh = await fsp.open(file, 'r');
  let files = 0, bytes = 0;
  try {
    for (const e of entries) {
      const rel = map(e.name);
      if (rel == null || rel === '' || rel === '/') continue;
      const out = safeJoin(dest, rel);
      if (e.isDir) { await fsp.mkdir(out, { recursive: true }); continue; }
      await fsp.mkdir(path.dirname(out), { recursive: true });
      const start = await dataOffset(fh, e);
      if (e.isSymlink) {
        if (!allowSymlinks) throw new Error(`symlink in archive refused: ${e.name}`);
        const target = Buffer.alloc(e.csize);
        await fh.read(target, 0, e.csize, start);
        const t = e.method === 8 ? zlib.inflateRawSync(target).toString('utf8') : target.toString('utf8');
        await fsp.rm(out, { force: true });
        await fsp.symlink(t, out);
        continue;
      }
      const src = fs.createReadStream(null, { fd: fh.fd, start, end: start + e.csize - 1, autoClose: false });
      const stages = [src];
      if (e.method === 8) stages.push(zlib.createInflateRaw());
      else if (e.method !== 0) throw new Error(`${e.name}: unsupported zip method ${e.method}`);
      stages.push(crcCheck(e.crc, e.name), fs.createWriteStream(out));
      await pipeline(stages);
      if (process.platform !== 'win32' && e.unixMode & 0o777) await fsp.chmod(out, e.unixMode & 0o777);
      files++; bytes += e.usize;
    }
  } finally {
    await fh.close();
  }
  return { files, bytes };
}

/** One small entry's bytes (e.g. META-INF/MANIFEST.MF of a jar). */
async function readZipEntry(file, name) {
  const e = (await readZip(file)).find((x) => x.name === name);
  if (!e) return null;
  const fh = await fsp.open(file, 'r');
  try {
    const start = await dataOffset(fh, e);
    const data = Buffer.alloc(e.csize);
    await fh.read(data, 0, e.csize, start);
    return e.method === 8 ? zlib.inflateRawSync(data) : data;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- zip writing

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Write a zip from a directory tree. Every file is deflated unless deflate saves < 2 % (jars are already
 * compressed), in which case it is stored. Entries are sorted and timestamped `mtime` for reproducibility.
 */
async function writeZip(srcDir, outFile, { mtime = new Date(2026, 0, 1) } = {}) {
  const list = [];
  const walk = async (dir, rel) => {
    const items = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const it of items) {
      const abs = path.join(dir, it.name), r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) { list.push({ r: `${r}/`, abs, dir: true }); await walk(abs, r); }
      else if (it.isSymbolicLink()) throw new Error(`symlink in pack source: ${r} (resolve it first)`);
      else list.push({ r, abs, dir: false });
    }
  };
  await walk(srcDir, '');
  if (list.length >= 0xffff) throw new Error('too many entries for a non-zip64 archive');

  const { time, date } = dosDateTime(mtime);
  const out = await fsp.open(outFile, 'w');
  const central = [];
  let offset = 0;
  const write = async (buf) => { await out.write(buf, 0, buf.length, offset); offset += buf.length; };
  try {
    for (const f of list) {
      const name = Buffer.from(f.r, 'utf8');
      let mode, data = Buffer.alloc(0), method = 0, crc = 0, usize = 0;
      if (f.dir) {
        mode = S_IFDIR | 0o755;
      } else {
        const st = await fsp.stat(f.abs);
        // Windows has no exec bit; keep 0755 for anything under bin/ or named jspawnhelper so a pack built on
        // Windows would still be runnable elsewhere (we build per platform, but be safe).
        const exec = process.platform === 'win32' ? /(^|\/)bin\/|jspawnhelper$/.test(f.r) : (st.mode & 0o111) !== 0;
        mode = 0o100000 | (exec ? 0o755 : 0o644);
        const raw = await fsp.readFile(f.abs);
        usize = raw.length;
        crc = zlib.crc32(raw) >>> 0;
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        if (deflated.length < raw.length * 0.98) { data = deflated; method = 8; } else { data = raw; }
      }
      if (offset > 0xffffffff - data.length - 1024 || usize > 0xffffffff) throw new Error('pack too large for non-zip64');
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
      lh.writeUInt16LE(method, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(usize, 22);
      lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
      const localOffset = offset;
      await write(lh); await write(name); if (data.length) await write(data);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(usize, 24);
      ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
      ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(((mode << 16) | (f.dir ? 0x10 : 0)) >>> 0, 38);
      ch.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([ch, name]));
    }
    const cdStart = offset;
    for (const c of central) await write(c);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(list.length, 8); eocd.writeUInt16LE(list.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
    await write(eocd);
  } finally {
    await out.close();
  }
  return { entries: list.length, bytes: offset };
}

// ---------------------------------------------------------------- tar.gz reading

function tarString(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}
function tarNumber(buf, start, len) {
  if (buf[start] & 0x80) { // base-256
    let v = 0;
    for (let i = start + 1; i < start + len; i++) v = v * 256 + buf[i];
    return v;
  }
  const s = tarString(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}
function parsePax(data) {
  const out = {};
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp < 0) break;
    const len = parseInt(data.subarray(p, sp).toString(), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, p + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

/**
 * Stream a .tar.gz. For every entry, `onEntry({name, type, mode, size, linkname})` returns either null (skip)
 * or a destination path; regular files are then streamed there. Returns { files, bytes }.
 */
async function extractTarGz(file, onEntry) {
  let buf = Buffer.alloc(0);
  let state = { kind: 'header' };
  let pending = {}; // pax / GNU long name for the next entry
  let files = 0, bytes = 0;
  const gunzip = fs.createReadStream(file).pipe(zlib.createGunzip());
  let writer = null, remaining = 0, pad = 0, dataChunks = null, entry = null;

  const finishEntry = async () => {
    if (writer) { await new Promise((res, rej) => writer.end((e) => (e ? rej(e) : res()))); writer = null; }
    if (entry && entry.dest && entry.type === '0' && process.platform !== 'win32') await fsp.chmod(entry.dest, entry.mode & 0o777);
    if (dataChunks) {
      const data = Buffer.concat(dataChunks); dataChunks = null;
      if (entry.type === 'x') Object.assign(pending, parsePax(data));
      else if (entry.type === 'L') pending.path = tarString(data, 0, data.length);
      else if (entry.type === 'K') pending.linkpath = tarString(data, 0, data.length);
    }
    entry = null;
  };

  for await (const chunk of gunzip) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (true) {
      if (state.kind === 'header') {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((b) => b === 0)) continue; // end-of-archive blocks
        const type = String.fromCharCode(h[156] || 0x30);
        let name = tarString(h, 0, 100);
        const prefix = tarString(h, 345, 155);
        if (prefix && h.subarray(257, 262).toString() === 'ustar') name = `${prefix}/${name}`;
        const size = tarNumber(h, 124, 12);
        const mode = tarNumber(h, 100, 8);
        let linkname = tarString(h, 157, 100);
        entry = { type, size, mode };
        if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
          dataChunks = type === 'g' ? null : [];
        } else {
          if (pending.path) name = pending.path;
          if (pending.linkpath) linkname = pending.linkpath;
          pending = {};
          Object.assign(entry, { name, linkname });
          const kind = type === '5' ? 'dir' : type === '2' ? 'symlink' : type === '0' || type === '\0' || type === '7' ? 'file' : 'other';
          if (kind === 'file') entry.type = '0';
          const dest = onEntry({ name, type: kind, mode, size, linkname });
          entry.dest = dest;
          if (dest && kind === 'dir') await fsp.mkdir(dest, { recursive: true });
          else if (dest && kind === 'symlink') { await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.rm(dest, { force: true }); await fsp.symlink(linkname, dest); }
          else if (dest && kind === 'file') { await fsp.mkdir(path.dirname(dest), { recursive: true }); writer = fs.createWriteStream(dest); files++; bytes += size; }
        }
        remaining = size;
        pad = (512 - (size % 512)) % 512;
        state = { kind: 'data' };
        if (remaining === 0) { await finishEntry(); state = { kind: 'pad' }; }
      } else if (state.kind === 'data') {
        if (!buf.length) break;
        const take = Math.min(remaining, buf.length);
        const part = buf.subarray(0, take);
        buf = buf.subarray(take);
        remaining -= take;
        if (writer) { if (!writer.write(part)) await new Promise((r) => writer.once('drain', r)); }
        else if (dataChunks) dataChunks.push(Buffer.from(part));
        if (remaining === 0) { await finishEntry(); state = { kind: 'pad' }; }
      } else if (state.kind === 'pad') {
        if (buf.length < pad) { pad -= buf.length; buf = Buffer.alloc(0); break; }
        buf = buf.subarray(pad); pad = 0; state = { kind: 'header' };
      }
    }
  }
  await finishEntry();
  return { files, bytes };
}

// ---------------------------------------------------------------- misc

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = async (d) => {
    for (const it of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.isFile()) { bytes += (await fsp.stat(p)).size; files++; }
    }
  };
  await walk(dir);
  return { bytes, files };
}

module.exports = { readZip, safeJoin, extractZip, readZipEntry, writeZip, extractTarGz, sha256File, dirSize };
