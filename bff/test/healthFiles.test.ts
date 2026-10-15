// The pure parts of the Chapter files and Disk checks: what a file looks like, which roots are a share that is not
// there, and when free space is worth a word. The checks themselves need Postgres and run in health.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

// A zip holding one stored file: local header, data, central directory, end record.
function tinyZip(): Buffer {
  const name = Buffer.from('a.txt');
  const data = Buffer.from('hi');
  const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(4), Buffer.from([2, 0, 0, 0, 2, 0, 0, 0]), Buffer.from([name.length, 0, 0, 0]), name, data]);
  const central = Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), Buffer.alloc(42), name]);
  const end = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  return Buffer.concat([local, central, end]);
}

test('inspectFile: present, empty, cut short, missing and not a file', async () => {
  const { inspectFile } = await import('../src/lib/healthFiles');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hf-'));
  try {
    const zip = tinyZip();
    await writeFile(path.join(dir, 'good.cbz'), zip);
    await writeFile(path.join(dir, 'cut.cbz'), zip.subarray(0, zip.length - 30));
    await writeFile(path.join(dir, 'empty.cbz'), '');
    await writeFile(path.join(dir, 'page.jpg'), 'not a zip and need not be');
    await mkdir(path.join(dir, 'folder.cbz'));
    assert.equal(await inspectFile(path.join(dir, 'good.cbz')), 'ok');
    assert.equal(await inspectFile(path.join(dir, 'cut.cbz')), 'broken', 'a zip without its end record is a download cut short');
    assert.equal(await inspectFile(path.join(dir, 'empty.cbz')), 'empty');
    assert.equal(await inspectFile(path.join(dir, 'page.jpg')), 'ok', 'only zips are looked into');
    assert.equal(await inspectFile(path.join(dir, 'gone.cbz')), 'missing');
    assert.equal(await inspectFile(path.join(dir, 'gone', 'x.cbz')), 'missing');
    assert.equal(await inspectFile(path.join(dir, 'folder.cbz')), 'unchecked', 'a folder is not a chapter file and not a finding');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hasZipEnd needs a whole record', async () => {
  const { hasZipEnd } = await import('../src/lib/healthFiles');
  assert.equal(hasZipEnd(tinyZip()), true);
  assert.equal(hasZipEnd(Buffer.from([0x50, 0x4b, 0x05, 0x06])), false, 'fewer than 22 bytes cannot hold one');
  assert.equal(hasZipEnd(Buffer.alloc(100)), false);
});

const row = (id: string, series: string, root: string) => ({ id, series_id: series, title: series.toUpperCase(), root, file: `${id}.cbz`, mtime: '1' });

test('badOf: groups by series, and never counts an unmounted root or a file it could not look at', async () => {
  const { badOf } = await import('../src/lib/healthFiles');
  const rows = [row('1', 'a', '/lib'), row('2', 'a', '/lib'), row('3', 'a', '/lib'), row('4', 'b', '/dl'), row('5', 'c', '/lib')];
  const states = new Map<string, 'ok' | 'missing' | 'empty' | 'broken' | 'unchecked'>([
    ['1', 'missing'], ['2', 'broken'], ['3', 'ok'], ['4', 'empty'], ['5', 'unchecked'],
  ]);
  const by = badOf(rows, states, new Set());
  assert.deepEqual([...by.keys()], ['a', 'b']);
  assert.deepEqual(by.get('a')!.counts, { missing: 1, empty: 0, broken: 1 });
  assert.deepEqual(by.get('a')!.ids, ['1', '2']);
  assert.deepEqual([...badOf(rows, states, new Set(['/dl'])).keys()], ['a'], 'a root that is not there is skipped whole');
});

test('goneRoots: a root with every file gone is a share that is not mounted, a few gone are deleted chapters', async () => {
  const { goneRoots } = await import('../src/lib/healthFiles');
  const mk = (n: number, root: string, off = 0) => Array.from({ length: n }, (_, i) => row(`${root}${i + off}`, 's', root));
  const rows = [...mk(3, '/lib'), ...mk(3, '/dl'), ...mk(40, '/big')];
  const states = new Map<string, 'ok' | 'missing' | 'unchecked'>();
  for (const r of rows.filter((r) => r.root === '/lib')) states.set(r.id, 'missing');
  rows.filter((r) => r.root === '/dl').forEach((r, i) => states.set(r.id, i === 0 ? 'missing' : 'ok'));
  rows.filter((r) => r.root === '/big').forEach((r, i) => states.set(r.id, i < 39 ? 'missing' : 'ok'));
  const skip = goneRoots(rows, states, ['/lib', '/dl', '/big', '/none']);
  assert.deepEqual([...skip].sort(), ['/big', '/lib'], 'all gone, or over nine in ten of a large root, is the share; one gone is not');
  states.set('/lib0', 'unchecked');
  assert.equal(goneRoots(rows, states, ['/lib']).has('/lib'), true, 'files not looked at do not count as present');
});
