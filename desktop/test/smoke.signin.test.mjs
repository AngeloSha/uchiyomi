// The server-mode product smoke's reading of the window (scripts/ci/signinState.mjs, v0.52.0): it decides on ONE
// read of the document that stays, never on a wait that spans the PWA's one reload -- the P-server-mode flake of the
// v0.50.0 release (mac-x64) and PR #138 (win-x64). A fake page plays a fresh profile's first visit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signInState } from '../scripts/ci/signinState.mjs';

/** A page whose reads are these, in turn: a state, or the Error a reload throws mid-read. The last one repeats. */
function fakePage(reads) {
  let n = 0;
  return {
    evaluate: async () => {
      const r = reads[Math.min(n++, reads.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    get reads() { return n; },
  };
}
const signIn = (served) => ({ desktop: 'undefined', shell: '{"mode":"server","version":"0.52.0"}', reconnect: false, password: true, served, url: 'http://127.0.0.1:9/' });

test('the sign-in page is read in the document that stays, through a read the reload cuts off', async () => {
  // The first visit: the form shows before the service worker takes over, the reload cuts reads off, then the document
  // the worker served. Reintroduce by deciding on any document with the form (dropping `s.served`): the state is the
  // one about to go, and the sign-in typed next goes with it.
  const page = fakePage([
    { ...signIn(false), password: false },
    signIn(false),
    new Error('Protocol error (DOM.describeNode): Cannot find context with specified id'),
    new Error('Execution context was destroyed, most likely because of a navigation.'),
    signIn(true),
  ]);
  const s = await signInState(page, { intervalMs: 1 });
  assert.equal(s.served, true, 'decided in the document the reload replaces');
  assert.equal(s.password, true);
  assert.equal(page.reads, 5, 'read on after the document that stays');
  // A page that never shows it is a timeout that says what it showed instead.
  const lib = fakePage([{ ...signIn(true), password: false, url: 'http://127.0.0.1:9/library' }]);
  await assert.rejects(signInState(lib, { timeoutMs: 30, intervalMs: 5 }), /in the document that stays \(last: .*"password":false.*\/library/);
});

test('the server-mode check takes its verdict from that read, never from a selector wait', () => {
  // The flake: `form && seen.password && …`, `form` a waitForSelector that rejected when the reload fell between its
  // match and its hand-over to the page, with the form on screen. Reintroduce it: both assertions fail.
  const src = readFileSync(join(import.meta.dirname, '..', 'scripts', 'ci', 'product-smoke.mjs'), 'utf8');
  const leg = src.slice(src.indexOf('async function serverMode()'), src.indexOf('async function redirectStubs'));
  assert.match(leg, /const seen = await signInState\(page\)/, 'the check does not read the document that stays');
  assert.doesNotMatch(leg, /waitForSelector\('input\[type=password\]'/, 'a selector wait decides the server-mode check again');
});
