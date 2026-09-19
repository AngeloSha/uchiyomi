// We never EXTRACT a zip with adm-zip — and this test is what keeps that true.
//
// Dependabot has reported adm-zip twice. First the symlink advisory: extraction follows destination
// symlinks, so an archive containing a symlink entry can overwrite files outside the target directory; at the
// time there was no patched version, so the alert stayed open and the only honest response was "the
// vulnerable code path is not used". Then CVE-2026-77301 (fixed in 0.6.1, Dependabot PR #57): reading an
// UNTRUSTED archive's entries -- `getEntries`/`getData` -- allocates whatever uncompressed size the header
// declares. Both dismissals rest on the same premise, and it is narrower than "no extraction".
//
// ⚠️ THAT PREMISE IS A CLAIM, AND A CLAIM IN A SECURITY DISMISSAL HAS TO BE ENFORCED OR IT ROTS. We only
// ever CREATE archives: `new AdmZip()` constructed EMPTY, then `addFile`, `addLocalFile`, `toBuffer` when
// building a CBZ for download or an OPDS response. adm-zip never sees bytes it did not write. Reading
// untrusted archives (chapters fetched from the internet) goes through `node-stream-zip` in library.ts,
// which is a different package and a different code path.
//
// The day somebody adds an extraction, or hands adm-zip a downloaded buffer, the dismissals stop being true
// and this test says so instead of a silence that lasts until the next audit.
// Reintroduce by calling `zip.extractAllTo(dir)` anywhere under bff/src: this fails and names the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;

/** Every .ts file under bff/src. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('nothing in bff/src extracts a zip to disk', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const body = readFileSync(file, 'utf8');
    // The two adm-zip methods that follow symlinks in the destination.
    if (/\.extractAllTo\s*\(|\.extractEntryTo\s*\(/.test(body)) {
      offenders.push(file.slice(SRC.length + 1));
    }
  }
  assert.deepEqual(offenders, [],
    'adm-zip extraction follows destination symlinks and has no patched release. If this is now needed, '
    + 'extract to a fresh temp directory with a path check per entry, and re-assess the Dependabot dismissal.');
});

test('adm-zip is only ever used to build archives', () => {
  // The narrower statement the dismissal actually rests on: every adm-zip call we make is a write.
  const WRITES = /\.(addFile|addLocalFile|addLocalFolder|writeZip|toBuffer)\s*\(/;
  const users = walk(SRC).filter((f) => /require\(['"]adm-zip['"]\)|from ['"]adm-zip['"]/.test(readFileSync(f, 'utf8')));
  assert.ok(users.length > 0, 'if adm-zip is gone entirely, delete this test with it');
  for (const file of users) {
    const body = readFileSync(file, 'utf8');
    assert.ok(WRITES.test(body), `${file.slice(SRC.length + 1)} imports adm-zip but never writes with it — what is it doing?`);
  }
});

test('adm-zip is constructed empty and never reads an archive', () => {
  // The exact premise the CVE-2026-77301 dismissal rests on, not a proxy for it. "Every user also writes"
  // (above) is true of a file that builds one archive and ALSO opens a downloaded one; this is what catches
  // that file. Reintroduce by reading a downloaded chapter with `new AdmZip(buf).getEntries()` anywhere
  // under bff/src: the declared-size allocation becomes reachable from the internet and this names the file.
  const CONSTRUCTED_WITH_INPUT = /new AdmZip\s*\(\s*[^)\s]/;
  // `fs.readFile` is not adm-zip's `readFile`; the lookbehind keeps the ordinary file reads out of it.
  const READS = /(?<!\bfs)\.(getEntries|getEntry|getData|readAsText|readFile)\s*\(/;
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const body = readFileSync(file, 'utf8');
    const rel = file.slice(SRC.length + 1);
    if (CONSTRUCTED_WITH_INPUT.test(body)) offenders.push(`${rel}: new AdmZip(<something>) opens an existing archive`);
    if (/require\(['"]adm-zip['"]\)|from ['"]adm-zip['"]/.test(body) && READS.test(body)) offenders.push(`${rel}: reads entries out of an adm-zip archive`);
  }
  assert.deepEqual(offenders, [],
    'adm-zip must only ever build archives from bytes we produced. If an archive has to be READ, use '
    + 'node-stream-zip (library.ts) and re-assess the Dependabot dismissals.');
});
