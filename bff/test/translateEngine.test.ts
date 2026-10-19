// Translated pages (v0.85.0), the engine's download (lib/translate/engine.ts): every file is checked against its pinned
// SHA-256 as it streams and thrown away when it differs; a stopped download resumes where it stopped, and a server that
// cannot resume is refused rather than appended to; and nothing is written or started until an admin presses Download.
// A local HTTP server stands in for GitHub and Hugging Face. No database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { acquireEngine, engineStatus, fetchPinned, removeEngine } from '../src/lib/translate/engine';
import type { PinnedFile } from '../src/lib/translate/pin';

const BODY = crypto.randomBytes(256 * 1024);
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');
let TMP = '';
let server: http.Server;
let base = '';
/** What the server saw, and whether it honours Range. */
const seen: { range?: string }[] = [];
let honourRange = true;

before(async () => {
  TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'uchi-translate-'));
  server = http.createServer((req, res) => {
    const range = req.headers.range;
    seen.push({ range });
    const m = /^bytes=(\d+)-$/.exec(range ?? '');
    if (m && honourRange) {
      const from = Number(m[1]);
      res.writeHead(206, { 'content-range': `bytes ${from}-${BODY.length - 1}/${BODY.length}`, 'content-length': BODY.length - from });
      res.end(BODY.subarray(from));
      return;
    }
    res.writeHead(200, { 'content-length': BODY.length });
    res.end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

const pin = (sha256 = SHA): PinnedFile => ({ name: 'model.gguf', url: `${base}/model.gguf`, sha256, bytes: BODY.length });

test('a file whose checksum matches is kept, and one that does not is thrown away', async () => {
  const dest = path.join(TMP, 'ok', 'model.gguf');
  let counted = 0;
  await fetchPinned(pin(), dest, new AbortController().signal, (n) => { counted += n; });
  assert.ok((await fs.readFile(dest)).equals(BODY));
  assert.equal(counted, BODY.length, 'progress counts every byte once');
  assert.equal(existsSync(`${dest}.part`), false);

  const bad = path.join(TMP, 'bad', 'model.gguf');
  // Reintroduce by renaming the part file before the hash is compared: the tampered file is installed.
  await assert.rejects(fetchPinned(pin('0'.repeat(64)), bad, new AbortController().signal, () => {}), /did not match its checksum/);
  assert.equal(existsSync(bad), false, 'not kept');
  assert.equal(existsSync(`${bad}.part`), false, 'and not left to resume from');
});

test('a stopped download resumes where it stopped, and the whole file is still checked', async () => {
  const dest = path.join(TMP, 'resume', 'model.gguf');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const half = BODY.length / 2;
  await fs.writeFile(`${dest}.part`, BODY.subarray(0, half));
  seen.length = 0;
  let counted = 0;
  await fetchPinned(pin(), dest, new AbortController().signal, (n) => { counted += n; });
  // Reintroduce by always starting over: the request carries no Range and 18 GB are fetched again after a restart.
  assert.deepEqual(seen.map((s) => s.range), [`bytes=${half}-`]);
  assert.ok((await fs.readFile(dest)).equals(BODY));
  assert.equal(counted, BODY.length, 'the part already here counts toward the progress');
});

test('a server that cannot resume is refused, never appended to', async () => {
  const dest = path.join(TMP, 'norange', 'model.gguf');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(`${dest}.part`, BODY.subarray(0, 1000));
  honourRange = false;
  try {
    // Reintroduce by appending whatever comes back: the whole file lands after the first 1,000 bytes, and only the
    // checksum stands between that and the engine.
    await assert.rejects(fetchPinned(pin(), dest, new AbortController().signal, () => {}), /cannot resume/);
  } finally {
    honourRange = true;
  }
  assert.equal(existsSync(dest), false);
});

test('until Download is pressed, nothing is written and nothing starts', async () => {
  const dir = path.join(TMP, 'never-downloaded', 'translate');
  process.env.TRANSLATE_DIR = dir;
  try {
    const st = await engineStatus();
    if (st.state === 'unsupported') return; // a platform with no pack: nothing to download at all
    assert.equal(st.state, 'missing');
    assert.ok(st.need > 0, 'Settings can say what Download costs');
    // Reintroduce the mkdir in engineStatus: opening Admin -> Settings makes a folder in every install's config.
    assert.equal(existsSync(dir), false, 'not even its folder');
    await assert.rejects(acquireEngine(), /not installed/);
  } finally {
    delete process.env.TRANSLATE_DIR;
  }
});

test('Remove deletes the engine\'s files and keeps its folder', async () => {
  const dir = path.join(TMP, 'installed', 'translate');
  process.env.TRANSLATE_DIR = dir;
  try {
    await fs.mkdir(path.join(dir, 'pack', 'bin'), { recursive: true });
    await fs.mkdir(path.join(dir, 'models', 'small'), { recursive: true });
    await fs.writeFile(path.join(dir, 'models', 'small', 'model.gguf'), 'x');
    await fs.writeFile(path.join(dir, 'installed.json'), '{}');
    await removeEngine();
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    delete process.env.TRANSLATE_DIR;
  }
});
