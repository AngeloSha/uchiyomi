#!/usr/bin/env node
// seedLocal.mjs <engine data dir>: one manga for the engine's built-in Local source, so the weekly canary can drive a
// source end to end -- popular, the series, its chapters, a page and a cover -- with no extension and no network.
//
// <dir>/local/Canary Manga/Chapter 1 and Chapter 2, two pages each. Chapter 1's folder is dated the epoch, which the
// Local source reports as "no date": the engine then stamps one itself, and v2.3.2243 stamped it in SECONDS (the 1970
// dates the adapter now reads right; bff/test/engineLive.test.ts checks what arrives). The canary chowns the folder to
// 1000, the user the engine runs as.
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const dir = process.argv[2];
if (!dir) { console.error('usage: seedLocal.mjs <engine data dir>'); process.exit(2); }

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** A small valid PNG, different per seed. */
function png(seed) {
  const w = 16, h = 16;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0, at = 0; y < h; y++) { raw[at++] = 0; for (let x = 0; x < w * 3; x++) raw[at++] = (x * 7 + y * 13 + seed * 31) & 0xff; }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); Buffer.from(type).copy(out, 4); data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const manga = join(dir, 'local', 'Canary Manga');
for (const [n, chapter] of ['Chapter 1', 'Chapter 2'].entries()) {
  const at = join(manga, chapter);
  mkdirSync(at, { recursive: true });
  for (let p = 1; p <= 2; p++) writeFileSync(join(at, `${String(p).padStart(2, '0')}.png`), png(n * 10 + p));
}
writeFileSync(join(manga, 'cover.png'), png(99));
utimesSync(join(manga, 'Chapter 1'), 0, 0);
const jan2024 = Date.UTC(2024, 0, 1) / 1000;
utimesSync(join(manga, 'Chapter 2'), jan2024, jan2024);
console.log(`seeded ${manga}`);
