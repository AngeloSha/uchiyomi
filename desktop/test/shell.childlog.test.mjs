// childlog.js: a child's stdout + stderr into its log file (bff.log, engine.log), closed when the output ends -- never
// on 'exit'. Ending it on 'exit' turned a child's last line into an uncaught exception, which Electron answers with a
// modal error box: the shell froze mid-stop and the desktop CI's S2-ii smoke hung for its full 10 minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { logChildOutput } = require('../src/childlog.js');

/** A child as the supervisor and the engine see one: an emitter with piped stdout and stderr. */
const fakeChild = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
const closed = (s) => new Promise((r) => (s.closed ? r() : s.once('close', r)));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-childlog-'));

test('the hazard: a log line written after end() is an error event -- with no listener, an uncaught exception', async () => {
  // What supervisor.js and engine.js did: 'exit' ended the file while the previous line was still being written, and
  // the child's last line came after. If this ever stops being an error, the tests below no longer prove anything.
  const tmp = tmpDir();
  try {
    const out = fs.createWriteStream(path.join(tmp, 'bff.log'), { flags: 'a' });
    out.write('SIGTERM: finishing the current chapter, then stopping\n');
    out.end();
    out.write('request completed\n');
    const err = await new Promise((r) => out.once('error', r));
    assert.equal(/** @type {any} */ (err).code, 'ERR_STREAM_WRITE_AFTER_END');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a child's last lines after 'exit' reach the log, and the file closes once stdout and stderr have ended", async () => {
  // Electron 44.5.1's utilityProcess and Node's child_process both deliver output after 'exit'. Reintroduce by ending
  // the file on 'exit' (the old supervisor/engine code): the late lines are a write after end -- an uncaught
  // ERR_STREAM_WRITE_AFTER_END here, Electron's modal error box in the app -- and "the late line was lost" fails.
  const tmp = tmpDir();
  try {
    const file = path.join(tmp, 'engine.log');
    const child = fakeChild();
    const out = logChildOutput(file, child, { graceMs: 60_000 });
    child.stderr.write('[uchiyomi-shim] stdin closed; exiting so shutdown hooks close the database\n');
    child.emit('exit', 0);
    child.stdout.end('[Thread-22] INFO io.javalin.Javalin -- Stopping Javalin ...\n');
    assert.equal(out.writableEnded, false, 'closed while stderr was still open');
    child.stderr.end('[Thread-22] INFO io.javalin.Javalin -- Javalin has stopped\n');
    await closed(out);
    const log = fs.readFileSync(file, 'utf8');
    assert.match(log, /stdin closed/);
    assert.match(log, /Stopping Javalin/, 'the late line was lost');
    assert.match(log, /Javalin has stopped/, 'the late stderr line was lost');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("output that never ends does not hold the file open: closed graceMs after 'exit', later chunks dropped quietly", async () => {
  // Electron 44.4.5 removed the stream listeners on 'exit', so its streams never ended; another process holding the
  // pipe does the same. Reintroduce by dropping the 'exit' timer: the file never closes and the test times out.
  const tmp = tmpDir();
  try {
    const file = path.join(tmp, 'bff.log');
    const child = fakeChild();
    const out = logChildOutput(file, child, { graceMs: 30 });
    child.stdout.write('before the exit\n');
    child.emit('exit', 0);
    await closed(out);
    child.stdout.write('long after the exit\n');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.readFileSync(file, 'utf8'), 'before the exit\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a log that cannot be written never throws, and the output is still drained', async () => {
  // Reintroduce by dropping out.on('error'): a log in a folder that is gone is an uncaught ENOENT.
  const tmp = tmpDir();
  try {
    const child = fakeChild();
    const out = logChildOutput(path.join(tmp, 'gone', 'bff.log'), child, { graceMs: 30 });
    child.stdout.write('x'.repeat(256 * 1024));
    child.stdout.end();
    child.stderr.end();
    await closed(out);
    assert.equal(child.stdout.readableLength, 0, 'the output was not drained');
    assert.equal(fs.existsSync(path.join(tmp, 'gone')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
