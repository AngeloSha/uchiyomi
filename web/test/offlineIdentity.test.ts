// Opening the app with no network, without opening it to the next person who picks up the tablet.
//
// The installed PWA used to show its sign-in screen in airplane mode even with chapters downloaded, because
// two facts were destroyed on every cold boot:
//   (a) `refreshSession` returned a boolean, so "the server rejected us" and "there was no server" were the
//       same answer, and both meant sign-in;
//   (b) the signed-in user id lived only in memory, and `downloads.ts` keys every offline record
//       `${userId}:${bookId}` -- so even with the sign-in screen out of the way, `owner()` would be 'anon'
//       and every lookup would miss. An empty reader is a WORSE failure than a sign-in screen: it reads as
//       "your downloads are gone".
//
// These tests pin both, and pin the sign-out behaviour that keeps the first one from becoming a leak.
import 'fake-indexeddb/auto';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

process.env.NEXT_PUBLIC_API_BASE = '';

// A localStorage stub, installed BEFORE the modules load: `api.ts` seeds the current user from this at
// module scope, which is the whole point -- it has to be answerable before React exists.
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};

type Reply = { status: number; body?: any } | { throws: true };
let reply: Reply = { throws: true };
globalThis.fetch = (async () => {
  if ('throws' in reply) throw new TypeError('Failed to fetch'); // what a dead network actually looks like
  return new Response(reply.body === undefined ? '{}' : JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json' },
  });
}) as any;

let ident: typeof import('../lib/offlineIdentity');
let apiMod: typeof import('../lib/api');
let downloads: typeof import('../lib/downloads');

const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

before(async () => {
  ident = await import('../lib/offlineIdentity');
  apiMod = await import('../lib/api');
  downloads = await import('../lib/downloads');
});

const USER = { id: 'u1', username: 'ann', displayName: 'Ann', role: 'user', settings: { accent: '#7c5cff' } };
const HOUR = 3600_000;

// ---- (a) the restored distinction -------------------------------------------------------------------

test('a dead network is not a rejection', async () => {
  reply = { throws: true };
  assert.equal((await apiMod.refreshSession()).kind, 'unreachable');
});

test('only an explicit auth refusal signs the device out', async () => {
  for (const status of [401, 403]) {
    reply = { status };
    assert.equal((await apiMod.refreshSession()).kind, 'rejected', `${status} must reject`);
  }
  // ⚠️ Everything else is transport trouble, not a verdict. A 502 while the backend restarts would
  // otherwise sign out every installed app in the house at once.
  // Reintroduce by folding these back into the rejected branch (`if (!r.ok) return rejected`).
  for (const status of [500, 502, 504, 429]) {
    reply = { status };
    assert.equal((await apiMod.refreshSession()).kind, 'unreachable', `${status} must not sign anyone out`);
  }
});

test('a good answer carries the user and the expiry back', async () => {
  const exp = Date.now() + 30 * 24 * HOUR;
  reply = { status: 200, body: { accessToken: 'a.b.c', user: USER, refreshExpiresAt: exp } };
  const r = await apiMod.refreshSession();
  assert.equal(r.kind, 'authed');
  assert.equal((r as any).user.id, 'u1');
  assert.equal((r as any).refreshExpiresAt, exp);
  // and the offline store is addressable straight away, without waiting for React
  assert.equal(apiMod.getCurrentUser(), 'u1');
});

// ---- (b) the persisted identity ----------------------------------------------------------------------

test('an identity round-trips, and carries only what the offline UI needs', () => {
  mem.clear();
  ident.writeOfflineIdentity(USER, Date.now() + HOUR);
  const got = ident.readOfflineIdentity()!;
  assert.equal(got.id, 'u1');
  assert.equal(got.displayName, 'Ann');
  assert.equal(got.accent, '#7c5cff');
});

test('settings are whitelisted to the accent, not mirrored wholesale', () => {
  mem.clear();
  // `app_settings.data` is free-form JSONB and this record sits in cleartext on the device.
  // Reintroduce by copying `settings` across and anything the server ever stores there leaks to disk.
  ident.writeOfflineIdentity(
    { ...USER, settings: { accent: '#123456', apiKey: 'super-secret', smartOffline: { enabled: true } } },
    Date.now() + HOUR,
  );
  const raw = mem.get('uchiyomi.offlineUser')!;
  assert.match(raw, /#123456/);
  assert.doesNotMatch(raw, /super-secret/, 'an unrelated settings field reached the device');
  assert.doesNotMatch(raw, /smartOffline/);
});

test('an expired identity is refused AND deleted, not merely refused', () => {
  mem.clear();
  ident.writeOfflineIdentity(USER, Date.now() + HOUR);
  const rec = JSON.parse(mem.get('uchiyomi.offlineUser')!);
  mem.set('uchiyomi.offlineUser', JSON.stringify({ ...rec, exp: Date.now() - 1 }));
  assert.equal(ident.readOfflineIdentity(), null);
  // Deleted on the way past, so a clock change cannot bring the grace back.
  assert.equal(mem.has('uchiyomi.offlineUser'), false);
});

test('an unrecognised or corrupt record is discarded rather than guessed at', () => {
  for (const bad of [JSON.stringify({ v: 2, id: 'u1', exp: Date.now() + HOUR }), '{not json', JSON.stringify({ v: 1 })]) {
    mem.clear();
    mem.set('uchiyomi.offlineUser', bad);
    assert.equal(ident.readOfflineIdentity(), null);
    assert.equal(mem.has('uchiyomi.offlineUser'), false);
  }
});

test('no expiry from the server means no offline grace at all', () => {
  mem.clear();
  // The client must never invent one. An older server that does not send the field simply keeps the old
  // behaviour: online works, and a cold boot with no network asks you to sign in.
  ident.writeOfflineIdentity(USER, undefined);
  assert.equal(ident.readOfflineIdentity(), null);
  ident.writeOfflineIdentity(USER, Date.now() - 1);
  assert.equal(ident.readOfflineIdentity(), null);
});

test('clearing is synchronous — sign-out cannot afford to await it', () => {
  ident.writeOfflineIdentity(USER, Date.now() + HOUR);
  const r = ident.clearOfflineIdentity();
  assert.equal(r, undefined, 'clearOfflineIdentity returned a promise; sign-out would race it');
  assert.equal(ident.readOfflineIdentity(), null);
});

// ---- the write hazard --------------------------------------------------------------------------------

test('progress is dropped rather than queued under nobody', async () => {
  const before = apiMod.getCurrentUser();
  apiMod.setCurrentUser(null);
  await downloads.queueProgress({ bookId: 'b1', seriesId: 's1', page: 3, completed: false } as any);
  apiMod.setCurrentUser('u1');
  const pending = await downloads.flushOutbox().catch(() => 0);
  assert.equal(pending, 0, 'an owner-less event was stored; both flushes skip it, so it is lost forever');
  apiMod.setCurrentUser(before);
});

// ---- source pins: the rules no unit test can see, because they live in React ---------------------------

test('signing out ends the offline grace', () => {
  const s = src('lib/auth.tsx');
  // Reintroduce by clearing the session without the identity: the next person to pick up the tablet
  // inherits the previous person's id, and with it the key to their downloaded chapters.
  assert.match(s, /clearOfflineIdentity\(\)/, 'nothing clears the saved identity');
  const clear = s.slice(s.indexOf('const clearLocalSession'));
  assert.match(clear.slice(0, 600), /clearOfflineIdentity\(\)/, 'clearLocalSession does not drop the identity');
  assert.match(s, /const logout[\s\S]{0,900}clearLocalSession\(\)/, 'logout does not go through clearLocalSession');
});

test('a rejected session goes to sign-in, and cannot reach the reader', () => {
  const s = src('components/AppShell.tsx');
  const anon = s.indexOf("status === 'anon'");
  const reader = s.indexOf("path.startsWith('/reader')", anon);
  assert.ok(anon > 0 && reader > anon,
    // Reintroduce by moving the reader hatch above the anon branch: an unauthenticated visitor gets a
    // chrome-less reader, and since owner() is 'anon' it is an empty black screen.
    'the reader escape hatch must stay BELOW the anon gate');
});

test('the offline path tells the service worker who is reading', () => {
  const s = src('lib/auth.tsx');
  const adopt = s.slice(s.indexOf('const adoptOffline'), s.indexOf('const clearLocalSession'));
  // Reintroduce by dropping this: the worker keeps `ownerHint = null`, and the background flush that runs
  // after the app is closed skips every event the offline session queued.
  assert.match(adopt, /tellWorkerUser\(/, 'adoptOffline does not tell the worker who is signed in');
});

test('the service worker precaches the offline surface', () => {
  const s = src('public/sw.js');
  // Reintroduce by deleting the precache: SHELL is only written by HARD navigations, and every in-app route
  // to the reader is a <Link>, so /reader/ would be in the cache only by luck.
  for (const p of ['/downloads/', '/reader/']) {
    assert.ok(s.includes(`'${p}'`), `${p} is not precached, so a cold boot cannot open it`);
  }
  // v11: the admin console went network-only, and the admin answers a v10 worker stored have to be dropped.
  assert.match(s, /const VERSION = 'v11'/, 'the cache keys changed shape; VERSION must move with them');
});
