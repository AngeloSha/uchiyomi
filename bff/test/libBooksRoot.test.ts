// Every chapter row records the root it was found under -- nothing relies on the column's '/library' default.
//
// `lib_books.root` was added with `DEFAULT '/library'` (lib/migrate.ts) so the rows that already existed got
// the only root there was then. That default is a POSIX path: on a Windows desktop it means `C:\library`, a
// folder that is not there, and a row that took it would point every reader, thumbnail and cleanup at nothing.
// It is harmless for exactly one reason -- the scanner's insert (lib/library.ts persistScan) always passes the
// root -- so a fresh desktop database never uses it. Leaving the migration alone is right (changing a column
// default rewrites nothing and would only differ between old and new installs); pinning the reason is this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

test('every INSERT INTO lib_books names the root column', () => {
  // Reintroduce by dropping `root` from the column list in persistScan (and its placeholder): the row gets
  // '/library', and on a desktop install every chapter the scanner finds points at a folder that is not there.
  const inserts: Array<{ file: string; cols: string[] }> = [];
  for (const file of sources()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/INSERT INTO lib_books\s*\(([^)]*)\)/g)) {
      inserts.push({ file: relative(SRC, file), cols: m[1].split(',').map((c) => c.trim()) });
    }
  }
  assert.ok(inserts.length >= 1, 'no INSERT INTO lib_books found -- the scan no longer reads this tree');
  for (const i of inserts) assert.ok(i.cols.includes('root'), `${i.file} inserts lib_books without a root: (${i.cols.join(', ')})`);
  // Nothing writes lib_books by a bare INSERT without a column list, which would silently take every default.
  for (const file of sources()) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /INSERT INTO lib_books\s+(?:VALUES|SELECT)/i, `${relative(SRC, file)}: INSERT INTO lib_books without columns`);
  }
});

test("the scanner's insert passes the root it walked, in the column's position", () => {
  // The column list and the values must agree: `root` is the 8th column and the 8th pushed value.
  const lib = readFileSync(join(SRC, 'lib', 'library.ts'), 'utf8');
  const cols = lib.match(/INSERT INTO lib_books \(([^)]*)\)/)![1].split(',').map((c) => c.trim());
  const push = lib.match(/params\.push\(newBookId\(\), ([^;]*)\);/)![1];
  const pushed = ['newBookId()', ...push.split(/,\s*(?![^(]*\))/).map((v) => v.trim())];
  assert.equal(pushed.length, cols.length, 'as many values as columns');
  assert.equal(pushed[cols.indexOf('root')], 'root', 'the value in the root column is the root being walked');
});
