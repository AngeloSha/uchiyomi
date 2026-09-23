// The DLLs a Windows PE file imports (normal + delay-load), read straight from the file. pg-dist uses it to keep
// exactly the DLLs the kept executables need, and to list what they expect the SYSTEM to provide (the VC++
// runtime is the one that matters: EDB's installer ships it, EDB's zip does not).
import { readFileSync } from 'node:fs';

export function peImports(file) {
  const b = readFileSync(file);
  if (b.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: not MZ`);
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) throw new Error(`${file}: not PE`);
  const coff = pe + 4;
  const nsec = b.readUInt16LE(coff + 2);
  const optSize = b.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const pe32plus = b.readUInt16LE(opt) === 0x20b;
  const dd = opt + (pe32plus ? 112 : 96);
  const importRva = b.readUInt32LE(dd + 8 * 1);
  const delayRva = b.readUInt32LE(dd + 8 * 13);
  const secs = [];
  for (let i = 0, s = opt + optSize; i < nsec; i++, s += 40) {
    secs.push({ va: b.readUInt32LE(s + 12), vsize: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20), rawSize: b.readUInt32LE(s + 16) });
  }
  const off = (rva) => {
    const s = secs.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize));
    if (!s) throw new Error(`${file}: rva ${rva} in no section`);
    return rva - s.va + s.raw;
  };
  const cstr = (o) => { let e = o; while (b[e]) e++; return b.toString('latin1', o, e); };
  const names = new Set();
  if (importRva) {
    for (let p = off(importRva); ; p += 20) {
      const name = b.readUInt32LE(p + 12);
      if (!name) break;
      names.add(cstr(off(name)));
    }
  }
  if (delayRva) {
    for (let p = off(delayRva); ; p += 32) {
      const name = b.readUInt32LE(p + 4);
      if (!name) break;
      names.add(cstr(off(name)));
    }
  }
  return [...names];
}
