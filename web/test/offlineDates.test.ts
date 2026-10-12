// Reading done offline is dated when it was read (v0.61.0): the server stores the replayed event's own time, so both
// ways the queue is flushed must keep sending it. Reintroduce by dropping `at: ev.ts` from either flush: this fails,
// and the flight's reading lands on the day the phone came back online.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

test('both outbox flushes send when the reading happened', () => {
  assert.match(src('lib/downloads.ts'), /\/progress`[\s\S]{0,200}json: \{[^}]*\bat: ev\.ts\b/, 'the page flush (lib/downloads.ts flushOutbox)');
  assert.match(src('public/sw.js'), /JSON\.stringify\(\{[^}]*\bat: ev\.ts\b/, "the service worker's background flush");
});
