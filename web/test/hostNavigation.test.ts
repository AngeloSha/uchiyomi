import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { beginAccountTransition, getCurrentUser, setCurrentUser } from '../lib/api';
import { NavigationController, type NavigationTransport, type WebNavigationMessage } from '../lib/hostNavigation/controller';
import { actionAllowed, navigationTarget, navigationPresentation, selectedDestination } from '../lib/hostNavigation/model';
import { iosNavigationTransport, navigationTransport } from '../lib/hostNavigation/ios';
import { usesNativeCache, publicServerURL } from '../lib/native';

const state = (auth: 'authed' | 'offline' | 'anon' | 'loading' = 'authed') => navigationPresentation({ path: '/', auth, downloader: true, admin: true });
class MemoryTransport implements NavigationTransport {
  messages: WebNavigationMessage[] = [];
  receive?: (message: unknown) => void;
  fail = false;
  send(message: WebNavigationMessage) {
    if (this.fail) throw new Error('transport closed');
    this.messages.push(message);
  }
  subscribe(receive: (message: unknown) => void) { this.receive = receive; return () => { this.receive = undefined; }; }
  host(message: object) { this.receive?.({ version: 1, session: 'session-one', ...message }); }
}
function fixture(timeout = 1000) {
  const transport = new MemoryTransport();
  const actions: string[] = [], ownership: boolean[] = [];
  const controller = new NavigationController(transport, 'session-one', state(), a => actions.push(a), a => ownership.push(a), timeout);
  controller.start();
  return { transport, controller, actions, ownership };
}

test('navigation presentation preserves routes, permissions, offline gating and bounded download status', () => {
  for (const path of ['/library/', '/series/?id=one']) assert.equal(selectedDestination(path), 'library');
  for (const path of ['/collection/', '/history/', '/moments/', '/updates/', '/settings/', '/wrapped/']) assert.equal(selectedDestination(path), 'profile');
  assert.equal(selectedDestination('/downloads/'), 'offline');
  assert.equal(selectedDestination('/library-other/'), 'profile');
  const allowed = navigationPresentation({ path: '/discover/', auth: 'authed', downloader: false, admin: false });
  assert.equal(allowed.items.some(i => i.id === 'discover'), false);
  assert.equal(allowed.secondary.some(i => i.id === 'admin'), false);
  assert.equal(allowed.selected, 'profile');
  assert.deepEqual(state('offline').items.filter(i => i.enabled).map(i => i.id), ['offline']);
  assert.deepEqual(state('offline').secondary.filter(i => i.enabled).map(i => i.id), ['quick-settings']);
  assert.deepEqual(state('anon').items, []);
  assert.deepEqual(state('loading').secondary, []);
  const ring = { show: true, count: 23, attention: false, progress: .5, slow: false, label: '23 active downloads' };
  const downloading = navigationPresentation({ path: '/reader/', auth: 'authed', downloader: true, admin: true, ring });
  assert.equal(downloading.immersive, true);
  assert.equal(downloading.items.find(i => i.id === 'library')?.badge, '23');
  const failed = navigationPresentation({ path: '/', auth: 'authed', downloader: true, admin: true, ring: { ...ring, attention: true } });
  assert.equal(failed.items.find(i => i.id === 'library')?.badge, '!');
});

test('alternate transport negotiates and routes without iOS globals or native cache ownership', () => {
  const f = fixture();
  try {
    assert.equal(navigationTransport(), null);
    assert.equal(usesNativeCache(), false);
    assert.equal(publicServerURL('/series/?id=one', 'https://books.example'), 'https://books.example/series/?id=one');
    assert.equal(f.transport.messages[0].kind, 'hello');
    assert.deepEqual(f.ownership, []);
    f.transport.host({ kind: 'ready' });
    assert.deepEqual(f.ownership, [true]);
    assert.equal(f.transport.messages.at(-1)?.kind, 'state');
    f.transport.host({ kind: 'action', request: 'request-one', revision: 1, action: 'library' });
    assert.deepEqual(f.actions, ['library']);
    // State publications do not themselves route and identical states are deduplicated.
    const count = f.transport.messages.length;
    f.controller.update(state());
    assert.equal(f.transport.messages.length, count);
    f.controller.update(navigationPresentation({ path: '/series/', auth: 'authed', downloader: true, admin: true }));
    assert.equal(f.transport.messages.at(-1)?.revision, 2);
    assert.deepEqual(f.actions, ['library']);
  } finally { f.controller.dispose(); }
  assert.equal(f.transport.receive, undefined);
  assert.deepEqual(f.ownership, [true, false]);
});

test('actions are validated against current state, deduplicated, and cannot survive disposal', () => {
  const f = fixture();
  f.transport.host({ kind: 'ready' });
  const late = f.transport.receive!;
  f.transport.host({ kind: 'action', request: 'one', revision: 1, action: 'quick-settings' });
  f.transport.host({ kind: 'action', request: 'one', revision: 1, action: 'quick-settings' });
  f.transport.host({ kind: 'action', request: 'two', revision: 1, action: 'https://evil.example' });
  f.transport.host({ kind: 'action', request: 'three', revision: 1, action: 'library', session: 'old-session' });
  f.controller.update(state('offline'));
  f.transport.host({ kind: 'action', request: 'four', revision: 1, action: 'library' });
  f.transport.host({ kind: 'action', request: 'five', revision: 2, action: 'library' });
  f.transport.host({ kind: 'action', request: 'six', revision: 2, action: 'offline' });
  assert.deepEqual(f.actions, ['quick-settings', 'offline']);
  f.controller.update(state('anon'));
  f.transport.host({ kind: 'action', request: 'seven', revision: 3, action: 'offline' });
  f.controller.dispose();
  late({ version: 1, session: 'session-one', kind: 'action', request: 'eight', revision: 3, action: 'home' });
  assert.deepEqual(f.actions, ['quick-settings', 'offline']);
});

test('missing/invalid acknowledgement and failed transport keep web navigation', async () => {
  const f = fixture(10);
  f.transport.receive?.(null);
  f.transport.host({ kind: 'ready', version: 2 });
  f.transport.host({ kind: 'ready', session: 'wrong' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.ownership, [false]);
  assert.equal(f.transport.receive, undefined);
  const g = fixture();
  g.transport.fail = true;
  g.transport.host({ kind: 'ready' });
  assert.deepEqual(g.ownership, [false]);
  assert.equal(g.transport.receive, undefined);
});

test('iOS adapter requires protocol 2 and an explicit supported navigation capability', () => {
  const transport = new MemoryTransport();
  const marker = { platform: 'ios', protocolVersion: 2 };
  assert.equal(iosNavigationTransport(undefined), null);
  assert.equal(iosNavigationTransport({ uchiyomiNative: marker }), null);
  assert.equal(iosNavigationTransport({ uchiyomiNative: { ...marker, navigation: { version: 2 } } }), null);
  const adapter = iosNavigationTransport({ uchiyomiNative: { ...marker, navigation: {
    version: 1, send: transport.send.bind(transport), subscribe: transport.subscribe.bind(transport),
  } } });
  assert.ok(adapter);
  const controller = new NavigationController(adapter, 'session-one', state(), () => {}, () => {});
  controller.start();
  assert.equal(transport.messages[0].kind, 'hello');
  transport.host({ kind: 'ready' });
  assert.equal(transport.messages.at(-1)?.kind, 'state');
  controller.dispose();
});

test('a navigation capability does not admit protocol-1 or unknown wrappers', () => {
  const navigation = { version: 1, send() {}, subscribe() { return () => {}; } };
  for (const protocolVersion of [undefined, 1, 3]) {
    assert.equal(iosNavigationTransport({ uchiyomiNative: { platform: 'ios', protocolVersion, navigation } }), null);
  }
});

test('adapter cleanup failures and synchronous reset still release navigation ownership', () => {
  for (const immediate of [false, true]) {
    let cleanups = 0;
    const ownership: boolean[] = [];
    const transport: NavigationTransport = {
      send() {},
      subscribe(receive) {
        receive({ kind: immediate ? 'reset' : 'ready', version: 1, session: 'cleanup' });
        return () => { cleanups++; throw new Error('disconnected'); };
      },
    };
    const controller = new NavigationController(transport, 'cleanup', state(), () => {}, value => ownership.push(value));
    assert.doesNotThrow(() => controller.start());
    assert.doesNotThrow(() => controller.dispose());
    assert.equal(cleanups, 1);
    assert.equal(ownership.at(-1), false);
  }
});

test('a reset while confirming the handshake cannot reclaim navigation ownership', () => {
  const transport = new MemoryTransport();
  const ownership: boolean[] = [];
  transport.send = message => {
    if (message.kind === 'state') transport.host({ kind: 'reset' });
  };
  const controller = new NavigationController(transport, 'session-one', state(), () => {}, value => ownership.push(value));
  controller.start();
  transport.host({ kind: 'ready' });
  assert.deepEqual(ownership, [false]);
  assert.equal(transport.receive, undefined);
});

// Exercise the production hook with the same isolated-hook approach as the
// profile-switcher portal suite. The account fence and controller are real.
test('native actions respect the synchronous account fence before React rerenders', () => {
  const transport = new MemoryTransport(), effects: (() => void | (() => void))[] = [];
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
    module.exports.useHostNavigation(state(), { account: 'owner-a', path: '/',
      navigate: (href: string) => actions.push(href), quickSettings: () => actions.push('quick-settings') });
    for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    const session = transport.messages[0].session;
    transport.host({ kind: 'ready', session });
    const request = (id: string, action: string) => transport.host({ kind: 'action', session, revision: 1, request: id, action });
    request('before', 'library');
    assert.deepEqual(actions, ['/library/']);
    release = beginAccountTransition();
    request('transition', 'quick-settings');
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
