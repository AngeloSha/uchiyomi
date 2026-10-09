// Asking the server again about Discover's unplaced names (v0.56.0, lib/useLiveWorks.ts).
//
// The wall and search name each row's work at once; a name the server has not placed is `n:…`, looked up in the
// background, and GET /api/discover/works says what each such key is now. The page asks after a load, then every 20 s
// while the server is still looking -- ten rounds a load at most, in requests of 200 keys, nothing while the page is
// hidden. The poller takes its timers as parameters (lib/ticker.ts does the same), so its clock runs here by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createWorksPoller, worksChunks, worksUrl, WORKS_CHUNK, WORKS_MAX_ROUNDS, WORKS_POLL_MS, WORKS_SETTLE_MS, WORKS_URL_MAX,
  type WorksAnswer,
} from '../lib/useLiveWorks';
import type { WorkNow } from '../lib/wall';

const ROOT = join(__dirname, '..');
const flush = () => new Promise<void>((r) => setImmediate(r));

/** A clock run by hand: timers fire only when `advance` passes them. */
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setT: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearT: (id: number) => { timers.delete(id); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    get armed() { return timers.size; },
  };
}

/** A server: answers each key with `place(key, call)`, and says how many it is still looking up. `call` counts from 1. */
function server(place: (key: string, call: number) => WorkNow | undefined, pending: (keys: string[], call: number) => number) {
  const asked: string[][] = [];
  return {
    asked,
    ask: async (keys: string[]): Promise<WorksAnswer> => {
      asked.push(keys);
      const call = asked.length;
      const works: Record<string, WorkNow> = {};
      for (const k of keys) { const w = place(k, call); if (w) works[k] = w; }
      return { works, pending: pending(keys, call) };
    },
  };
}

const keysOf = (n: number, p = 'n:') => Array.from({ length: n }, (_, i) => `${p}${i}`);

test('a load waits for its burst, then asks every key in requests of 200 at most', async () => {
  // The wall's sources land one by one within seconds: the first round waits WORKS_SETTLE_MS for the rest of the
  // burst, then asks for all of them, 200 keys a request (the route's limit). Reintroduce by asking at once in
  // set(): "a load asked before its burst landed" fails; by one request for every key: "more than 200 keys" fails.
  const c = clock();
  const s = server(() => undefined, () => 0);
  const got: Array<Record<string, WorkNow>> = [];
  const p = createWorksPoller(s.ask, (w) => got.push(w), { hidden: () => false, setT: c.setT, clearT: c.clearT });
  p.set(keysOf(300));
  p.set(keysOf(450));
  await c.advance(WORKS_SETTLE_MS - 1);
  assert.equal(s.asked.length, 0, 'a load asked before its burst landed');
  await c.advance(1);
  assert.deepEqual(s.asked.map((k) => k.length), [200, 200, 50], 'more than 200 keys in a request, or a key left out');
  assert.equal(got.length, 1, 'one round is not one answer');
  assert.equal(c.armed, 0, 'a round was scheduled although nothing is pending');
});

test('a request line stays short enough for a proxy, whatever the script', () => {
  // 200 Korean titles encode to ~18 KB of URL; nginx answers 414 past 8 KB. Reintroduce by chunking on the count
  // alone: "a request runs past the URL budget" fails.
  const korean = Array.from({ length: 200 }, (_, i) => `n:나혼자만레벨업${i}`);
  const chunks = worksChunks(korean);
  for (const c of chunks) assert.ok(c.map(encodeURIComponent).join(',').length <= WORKS_URL_MAX, 'a request runs past the URL budget');
  assert.ok(chunks.length > 1, 'the URL budget split nothing: the case above proved nothing');
  assert.deepEqual(chunks.flat(), korean, 'a key was lost or reordered');
  assert.equal(worksChunks(keysOf(WORKS_CHUNK)).length, 1);
  assert.equal(worksUrl(['n:a b', 'al:1']), '/api/discover/works?keys=n%3Aa%20b,al%3A1');
});

test('it asks again every 20 s while the server is still looking, ten rounds a load at most', async () => {
  // A name no service knows is never placed, and `pending` would stay above zero for as long as the server keeps
  // it queued. Reintroduce by dropping `rounds < WORKS_MAX_ROUNDS`: "a load asks more than ten times" fails; by
  // scheduling the next round at WORKS_SETTLE_MS: "it asks again sooner than every 20 s" fails.
  const c = clock();
  const s = server((k) => ({ work: k, owned: false }), () => 1);
  const p = createWorksPoller(s.ask, () => {}, { hidden: () => false, setT: c.setT, clearT: c.clearT });
  p.set(['n:nobody']);
  await c.advance(WORKS_SETTLE_MS);
  assert.equal(s.asked.length, 1);
  await c.advance(WORKS_POLL_MS - 1);
  assert.equal(s.asked.length, 1, 'it asks again sooner than every 20 s');
  await c.advance(1);
  assert.equal(s.asked.length, 2);
  await c.advance(WORKS_POLL_MS * 30);
  assert.equal(s.asked.length, WORKS_MAX_ROUNDS, 'a load asks more than ten times');
  assert.equal(c.armed, 0);
});

test('it asks only what is still open, and stops when nothing is pending', async () => {
  // A key answered with another work is placed for good; one answered as itself is still being looked up (or never
  // will be). Reintroduce by asking every key every round: "a placed key is asked again" fails; by ignoring
  // `pending`: "it asks after the server said it was done" fails.
  const c = clock();
  const s = server(
    (k, call) => (k === 'n:a' ? { work: 'al:1', owned: false } : call >= 2 ? { work: 'lib:s9', owned: true } : { work: k, owned: false }),
    (_keys, call) => (call >= 2 ? 0 : 1),
  );
  const got: Array<Record<string, WorkNow>> = [];
  const p = createWorksPoller(s.ask, (w) => got.push(w), { hidden: () => false, setT: c.setT, clearT: c.clearT });
  p.set(['n:a', 'n:b']);
  await c.advance(WORKS_SETTLE_MS);
  await c.advance(WORKS_POLL_MS);
  assert.deepEqual(s.asked, [['n:a', 'n:b'], ['n:b']], 'a placed key is asked again');
  assert.deepEqual(got[1], { 'n:b': { work: 'lib:s9', owned: true } });
  await c.advance(WORKS_POLL_MS * 5);
  assert.equal(s.asked.length, 2, 'it asks after the server said it was done');
});

test('nothing while the page is hidden; the round that came due runs when it shows, and spends no round', async () => {
  // Reintroduce by dropping the `hidden()` check in round(): "a hidden page asked" fails; by dropping wake():
  // "the page came back and nothing was asked" fails.
  const c = clock();
  let hidden = false;
  const s = server((k) => ({ work: k, owned: false }), () => 1);
  const p = createWorksPoller(s.ask, () => {}, { hidden: () => hidden, setT: c.setT, clearT: c.clearT });
  p.set(['n:a']);
  await c.advance(WORKS_SETTLE_MS);
  assert.equal(s.asked.length, 1);
  hidden = true;
  await c.advance(WORKS_POLL_MS * 3);
  assert.equal(s.asked.length, 1, 'a hidden page asked');
  assert.equal(c.armed, 0, 'a hidden page keeps a timer going');
  p.wake();
  await flush();
  assert.equal(s.asked.length, 1, 'a hidden page asked on wake');
  hidden = false;
  p.wake();
  await flush();
  assert.equal(s.asked.length, 2, 'the page came back and nothing was asked');
  // The skipped rounds were not spent: the load still gets its ten.
  await c.advance(WORKS_POLL_MS * 30);
  assert.equal(s.asked.length, WORKS_MAX_ROUNDS, 'a round skipped while hidden was counted');
});

test('new keys start a new load with rounds of its own; the same keys again start nothing', async () => {
  // A page of infinite scroll is a load: its names get their own ten rounds, and the request asks every key still
  // open, old and new. Reintroduce by never resetting `rounds`: the new load's first round still goes, but "a new load
  // had no rounds of its own" fails at the second, since the first load spent all ten.
  const c = clock();
  const s = server((k) => ({ work: k, owned: false }), () => 1);
  const p = createWorksPoller(s.ask, () => {}, { hidden: () => false, setT: c.setT, clearT: c.clearT });
  p.set(['n:a']);
  await c.advance(WORKS_SETTLE_MS + WORKS_POLL_MS * 30);
  assert.equal(s.asked.length, WORKS_MAX_ROUNDS);
  p.set(['n:a']);
  await c.advance(WORKS_SETTLE_MS + WORKS_POLL_MS);
  assert.equal(s.asked.length, WORKS_MAX_ROUNDS, 'the same keys started a new load');
  p.set(['n:a', 'n:b']);
  await c.advance(WORKS_SETTLE_MS);
  assert.equal(s.asked.length, WORKS_MAX_ROUNDS + 1, 'a page of infinite scroll was never asked about');
  assert.deepEqual(s.asked.at(-1), ['n:a', 'n:b']);
  await c.advance(WORKS_POLL_MS);
  assert.equal(s.asked.length, WORKS_MAX_ROUNDS + 2, 'a new load had no rounds of its own');
  await c.advance(WORKS_POLL_MS * 30);
  assert.equal(s.asked.length, WORKS_MAX_ROUNDS * 2, 'a new load did not stop at ten rounds');
});

test('leaving the view pauses the asking, and coming back resumes it', async () => {
  // Search and the wall each ask about their own names while they are on screen, and `set([])` otherwise. A round that
  // comes due off screen asks nothing and marks itself due, so coming back runs it at once. Reintroduce by keeping the
  // last keys through `set([])` (`if (next.length) keys = next;`): "a view off screen was asked about" fails; by
  // dropping `!keys.length` from round()'s skip: the off-screen round finds nothing open, returns without marking
  // itself due, and "coming back did not resume the load" fails.
  const c = clock();
  const s = server((k) => ({ work: k, owned: false }), () => 1);
  const p = createWorksPoller(s.ask, () => {}, { hidden: () => false, setT: c.setT, clearT: c.clearT });
  p.set(['n:a']);
  await c.advance(WORKS_SETTLE_MS);
  p.set([]);
  await c.advance(WORKS_POLL_MS * 3);
  assert.equal(s.asked.length, 1, 'a view off screen was asked about');
  p.set(['n:a']);
  await flush();
  assert.equal(s.asked.length, 2, 'coming back did not resume the load');
});

test('a failed request ends the load quietly, and an unmount drops the answer in flight', async () => {
  // An older server has no such route (404): one request a load, never one every 20 s. Reintroduce by scheduling the
  // next round in the catch: "a failing route is asked again" fails. And a page that is gone must not set state:
  // reintroduce by dropping the `stopped` check after the await: "an answer landed after stop()" fails.
  const c = clock();
  let calls = 0;
  const p = createWorksPoller(async () => { calls++; throw new Error('404'); }, () => assert.fail('a failed round reported works'),
    { hidden: () => false, setT: c.setT, clearT: c.clearT });
  p.set(['n:a']);
  await c.advance(WORKS_SETTLE_MS + WORKS_POLL_MS * 5);
  assert.equal(calls, 1, 'a failing route is asked again');

  let release!: (a: WorksAnswer) => void;
  let signal: AbortSignal | undefined;
  const late: Array<Record<string, WorkNow>> = [];
  const q = createWorksPoller((_k, sig) => { signal = sig; return new Promise((r) => { release = r; }); }, (w) => late.push(w),
    { hidden: () => false, setT: c.setT, clearT: c.clearT });
  q.set(['n:a']);
  await c.advance(WORKS_SETTLE_MS);
  q.stop();
  assert.equal(signal?.aborted, true, 'stop() did not abort the request in flight');
  release({ works: { 'n:a': { work: 'al:1', owned: false } }, pending: 1 });
  await flush();
  assert.deepEqual(late, [], 'an answer landed after stop()');
  assert.equal(c.armed, 0);
});

test('the hook asks the route by its contract, wakes on visibility and stops on unmount', () => {
  // Read from source: the hook is the poller plus the browser. Reintroduce by dropping the visibilitychange listener:
  // "the page coming back never wakes the poller" fails; by dropping p.stop() from the cleanup: "an unmounted page
  // keeps asking" fails.
  const src = readFileSync(join(ROOT, 'lib/useLiveWorks.ts'), 'utf8');
  assert.match(src, /\(chunk, signal\) => api<WorksAnswer>\(worksUrl\(chunk\), \{ signal \}\)/, 'the request ignores the signal or the URL');
  assert.match(src, /document\.addEventListener\('visibilitychange', onVisible\);/, 'the page coming back never wakes the poller');
  assert.match(src, /document\.removeEventListener\('visibilitychange', onVisible\);\s*p\.stop\(\);/, 'an unmounted page keeps asking');
  assert.match(src, /hidden = \(\) => typeof document !== 'undefined' && document\.visibilityState === 'hidden'/);
  // Only the view on screen is asked about: the page hands each hook `active`, and an inactive one sets no keys.
  // Reintroduce `const sig = keys.join(',');`: "a view off screen is still asked about" fails.
  assert.match(src, /const sig = active \? keys\.join\(','\) : '';/, 'a view off screen is still asked about');
  assert.equal(WORKS_POLL_MS, 20_000);
  assert.equal(WORKS_MAX_ROUNDS, 10);
  assert.equal(WORKS_CHUNK, 200);
});

test('Admin → Settings switches the lookups, on unless the server says off', () => {
  // GET /api/admin/settings `discover_lookups`, PATCH `{ discoverLookups }`. On by default, so the row reads `!== false`:
  // a server that does not send the key yet is one that looks names up. Reintroduce `on={!!data.discover_lookups}`:
  // "the switch is not on by default" fails.
  const src = readFileSync(join(ROOT, 'components/AdminSettings.tsx'), 'utf8');
  assert.match(src, /<SwitchRow label=\{tr\('Match Discover titles online'\)\}\s*help=\{tr\('On by default\. Titles shown in Discover are looked up on AniList, MangaDex and MangaUpdates, once each and in the background, so that a series several sources name differently shows as one card and one you already have stays hidden\. Off, only the names themselves are compared and nothing is sent anywhere\.'\)\}\s*on=\{data\.discover_lookups !== false\} onChange=\{\(next\) => save\(\{ discoverLookups: next \}\)\} \/>/,
    'the switch is not on by default, or saves the wrong key');
  // Beside the other row that sends titles off the server.
  assert.ok(src.indexOf("tr('Match Discover titles online')") > src.indexOf("tr('Borrow chapter names from other sources')"));
});
