import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { OcrWorker } from '../src/lib/translate/ocr';

class FakeChild extends EventEmitter {
  connected = true; exitCode: number | null = null; stderr = null; pid = undefined;
  messages: Array<{ type: string; id?: number }> = []; kills = 0;
  send(message: { type: string; id?: number }) { this.messages.push(message); return true; }
  kill() { this.kills++; this.connected = false; return true; }
  ready() { this.emit('message', { type: 'ready' }); }
  result() {
    const request = this.messages.findLast((m) => m.type === 'ocr');
    assert.ok(request); this.emit('message', { type: 'result', id: request.id, lines: [], width: 10, height: 20, ms: 1 });
  }
}
const child = (fake: FakeChild) => fake as unknown as ChildProcess;
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test('stop during stalled initialization kills the starting child and rejects every waiting read', async () => {
  const fake = new FakeChild(); const worker = new OcrWorker('/test', 1, { spawn: () => child(fake), initTimeoutMs: 1000 });
  const first = worker.read(Buffer.from('a'), 'en'); const second = worker.read(Buffer.from('b'), 'en');
  const rejected = Promise.all([assert.rejects(first, /OCR stopped/), assert.rejects(second, /OCR stopped/)]);
  assert.equal(fake.messages[0].type, 'init');
  worker.stop(); await rejected;
  assert.equal(fake.kills, 1); assert.equal(worker.running, false);
  fake.ready(); assert.equal(worker.running, false, 'late ready cannot resurrect a stopped child');
});

test('initialization has its own deadline before a page timeout can start', async () => {
  const fake = new FakeChild(); const worker = new OcrWorker('/test', 1, { spawn: () => child(fake), initTimeoutMs: 5 });
  await assert.rejects(worker.read(Buffer.from('a'), 'en', 10_000), /initialization took too long/);
  assert.equal(fake.kills, 1); assert.equal(fake.messages.length, 1);
  fake.ready(); assert.equal(worker.running, false);
});

test('late ready, exit, error and result events from a cancelled generation cannot clear its replacement', async () => {
  const old = new FakeChild(), next = new FakeChild(), queue = [old, next];
  const worker = new OcrWorker('/test', 1, { spawn: () => child(queue.shift()!), initTimeoutMs: 1000 });
  const cancelled = worker.read(Buffer.from('a'), 'en'); const rejection = assert.rejects(cancelled, /stopped/);
  worker.stop(); await rejection;
  const pending = worker.read(Buffer.from('b'), 'en'); next.ready(); await tick();
  assert.equal(worker.running, true);
  old.ready(); old.emit('exit', 1, null); old.emit('error', new Error('old failure'));
  old.emit('message', { type: 'result', id: 1, lines: [{ text: 'wrong' }] });
  assert.equal(worker.running, true); assert.equal(next.kills, 0);
  next.result(); assert.deepEqual(await pending, { lines: [], width: 10, height: 20, ms: 1 });
  worker.stop(); assert.equal(next.kills, 1);
});

test('stop after ready rejects an in-flight page and its old timeout cannot kill a later generation', async () => {
  const old = new FakeChild(), next = new FakeChild(), queue = [old, next];
  const worker = new OcrWorker('/test', 1, { spawn: () => child(queue.shift()!), initTimeoutMs: 1000 });
  const pending = worker.read(Buffer.from('a'), 'en', 10); old.ready(); await tick();
  const rejection = assert.rejects(pending, /stopped/); worker.stop(); await rejection;
  const replacement = worker.read(Buffer.from('b'), 'en', 1000); next.ready(); await tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(next.kills, 0); next.result(); await replacement; worker.stop();
});
