import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { beginAccountTransition, getCurrentUser, setCurrentUser } from '../lib/api';
import assert from 'node:assert/strict';
import { NavigationController, type NavigationTransport, type WebNavigationMessage } from '../lib/hostNavigation/controller';
import { actionAllowed, navigationTarget, navigationPresentation, selectedDestination } from '../lib/hostNavigation/model';
import { iosNavigationTransport } from '../lib/hostNavigation/ios';

const state = (auth: 'authed' | 'offline' | 'anon' = 'authed') => navigationPresentation({ path: '/', auth, downloader: true, admin: true });
class Transport implements NavigationTransport {
  messages: WebNavigationMessage[] = [];
  receive?: (message: unknown) => void;
  send(message: WebNavigationMessage) { this.messages.push(message); }
  subscribe(receive: (message: unknown) => void) { this.receive = receive; return () => { this.receive = undefined; }; }
  host(value: object) { this.receive?.({ version: 2, session: 'test-session', ...value }); }
}
function fixture(timeout = 1000) {
  const transport = new Transport(), ownership: boolean[] = [], actions: string[] = [];
  const controller = new NavigationController(transport, 'test-session', state(), a => actions.push(a), a => ownership.push(a), timeout);
  controller.start();
  return { controller, transport, ownership, actions };
}

test('web navigation stays until native acknowledges the current themed presentation', () => {
  const f = fixture();
  try {
    assert.equal(f.transport.messages[0].kind, 'hello');
    f.transport.host({ kind: 'ready' });
    assert.deepEqual(f.ownership, []);
    assert.equal(f.transport.messages.at(-1)?.kind, 'state');
    f.controller.update(state('offline'));
    f.transport.host({ kind: 'mounted', revision: 1 });
    assert.deepEqual(f.ownership, []);
    f.transport.host({ kind: 'mounted', revision: 2 });
    assert.deepEqual(f.ownership, [true]);
  } finally { f.controller.dispose(); }
  assert.deepEqual(f.ownership, [true, false]);
});

test('unavailable native renderer times out to the web, including after ready', async () => {
  const f = fixture(10);
  f.transport.host({ kind: 'ready' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.ownership, [false]);
  assert.equal(f.transport.receive, undefined);
});

test('native actions use committed revisions, permissions, dialog state and offline restrictions', () => {
  const f = fixture();
  try {
    f.transport.host({ kind: 'ready' }); f.transport.host({ kind: 'mounted', revision: 1 });
    f.transport.host({ kind: 'action', action: 'library', revision: 1, request: 'one' });
    f.transport.host({ kind: 'action', action: 'library', revision: 1, request: 'one' });
    f.transport.host({ kind: 'action', action: 'https://example.com', revision: 1, request: 'url' });
    f.controller.update({ ...state(), blocked: true });
    f.transport.host({ kind: 'action', action: 'home', revision: 2, request: 'dialog' });
    f.controller.update(state('offline'));
    f.transport.host({ kind: 'action', action: 'home', revision: 1, request: 'stale' });
    f.transport.host({ kind: 'action', action: 'home', revision: 3, request: 'offline-home' });
    f.transport.host({ kind: 'action', action: 'offline', revision: 3, request: 'offline' });
    assert.deepEqual(f.actions, ['library', 'offline']);
    f.controller.update({ ...state(), immersive: true });
    f.transport.host({ kind: 'action', action: 'home', revision: 4, request: 'reader' });
    assert.deepEqual(f.actions, ['library', 'offline']);
  } finally { f.controller.dispose(); }
});

test('presentation keeps permissions, downloads status and secondary routes', () => {
  const guest = navigationPresentation({ path: '/discover/', auth: 'authed', downloader: false, admin: false });
  assert.equal(guest.items.some(i => i.id === 'discover'), false);
  assert.equal(guest.secondary.some(i => i.id === 'admin'), false);
  assert.equal(guest.selected, 'profile');
  assert.deepEqual(state('offline').items.filter(i => i.enabled).map(i => i.id), ['offline']);
  assert.equal(state('offline').secondary.some(i => i.enabled), false);
  assert.deepEqual(state('anon').items, []);
  assert.equal(selectedDestination('/series/'), 'library');
  assert.equal(selectedDestination('/library-other/'), 'profile');
  const downloading = navigationPresentation({ path: '/', auth: 'authed', downloader: true, admin: true,
    ring: { show: true, count: 7, progress: .5, attention: false, slow: false, label: '7 downloads' } });
  assert.equal(downloading.items.find(i => i.id === 'library')?.badge, '7');
});

test('the adapter requires the themed capability without changing the cache protocol', () => {
  const capability = { version: 2, send() {}, subscribe() { return () => {}; } };
  assert.ok(iosNavigationTransport({ uchiyomiNative: { platform: 'ios', protocolVersion: 2, navigation: capability } }));
  for (const navigation of [undefined, { ...capability, version: 1 }, { ...capability, send: null }]) {
    assert.equal(iosNavigationTransport({ uchiyomiNative: { platform: 'ios', protocolVersion: 2, navigation } }), null);
  }
});

test('reset, failed delivery and stale sessions never leave web controls hidden', () => {
  const f = fixture();
  f.transport.host({ kind: 'ready' }); f.transport.host({ kind: 'mounted', revision: 1, session: 'retired' });
  assert.deepEqual(f.ownership, []);
  f.transport.host({ kind: 'mounted', revision: 1 }); f.transport.host({ kind: 'reset' });
  assert.deepEqual(f.ownership, [true, false]);
  const g = fixture();
  g.transport.send = () => { throw new Error('closed'); };
  g.transport.host({ kind: 'ready' });
  assert.deepEqual(g.ownership, [false]);
});

// Exercise the production hook with the same isolated-hook approach as the
// profile-switcher portal suite. The account fence and controller are real.
test('native actions respect the synchronous account fence before React rerenders', () => {
  const transport = new Transport(), effects: (() => void | (() => void))[] = [];
  const actions: string[] = [], cleanups: (() => void)[] = [];
  const modules: Record<string, unknown> = {
    react: { useRef: (current: unknown) => ({ current }), useEffect: (effect: () => void) => effects.push(effect) },
    '../api': { getCurrentUser },
    './controller': { NavigationController },
    './ios': { navigationTransport: () => transport },
    './model': { actionAllowed, navigationTarget },
    './chrome': { useHostNavigationActive: () => false, setHostNavigationActive() {} },
  };
  const module = { exports: {} as any };
  const code = transformSync(readFileSync(new URL('../lib/hostNavigation/useHostNavigation.ts', import.meta.url), 'utf8'),
    { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  vm.runInNewContext(code, { module, exports: module.exports, crypto, require: (name: string) => {
    assert.ok(name in modules, `unexpected dependency ${name}`); return modules[name];
  } });
  const previousOwner = getCurrentUser();
  let release: (() => void) | undefined;
  try {
    setCurrentUser('owner-a');
    module.exports.useHostNavigation({ ...state(), appearance: {} }, { account: 'owner-a', path: '/',
      navigate: (href: string) => actions.push(href) });
    for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    const session = transport.messages[0].session;
    transport.host({ kind: 'ready', session });
    transport.host({ kind: 'mounted', revision: 1, session });
    const request = (id: string, action: string) => transport.host({ kind: 'action', session, revision: 1, request: id, action });
    request('before', 'library');
    assert.deepEqual(actions, ['/library/']);
    release = beginAccountTransition();
    request('transition', 'history');
    assert.equal((transport.messages.at(-1) as any).accepted, false);
    release(); release = undefined;
    setCurrentUser('owner-b');
    request('replacement', 'search');
    assert.equal((transport.messages.at(-1) as any).accepted, false);
    assert.deepEqual(actions, ['/library/'], 'retained callbacks must not navigate or open settings for another account');
  } finally {
    release?.(); for (const cleanup of cleanups.reverse()) cleanup(); setCurrentUser(previousOwner);
  }
});
