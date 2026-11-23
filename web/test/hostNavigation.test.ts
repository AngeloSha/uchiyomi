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
  isAvailable = true;
  availabilityChanged?: () => void;
  available() { return this.isAvailable; }
  observeAvailability(changed: () => void) { this.availabilityChanged = changed; return () => { this.availabilityChanged = undefined; }; }
  setAvailable(available: boolean) { this.isAvailable = available; this.availabilityChanged?.(); }
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
  const scope = { uchiyomiNative: { platform: 'ios', protocolVersion: 2, navigation: capability } };
  let layout: string | null = null;
  const root = { getAttribute: () => layout } as unknown as HTMLElement;
  const adapter = iosNavigationTransport(scope, root)!;
  assert.equal(adapter.available(), false);
  layout = 'bottom'; assert.equal(adapter.available(), false);
  layout = 'side'; assert.equal(adapter.available(), true);
  layout = null; assert.equal(adapter.available(), false);
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
test('the production hook keeps phone web controls, handles rail availability, and fences accounts', () => {
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
  let currentURL = '/';
  const options = { account: 'owner-a', navigate: (href: string) => { actions.push(href); currentURL = href; } };
  let release: (() => void) | undefined;
  try {
    setCurrentUser('owner-a');
    module.exports.useHostNavigation({ ...state(), appearance: {} }, options);
    transport.isAvailable = false;
    for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    assert.equal(transport.messages.length, 0, 'A regular phone never requests native ownership');
    transport.setAvailable(true);
    // The same live document can move between the Duo rail and ordinary phone navigation.
    transport.setAvailable(false);
    assert.equal(transport.messages.at(-1)?.kind, 'stop');
    const stopped = transport.messages.length;
    transport.setAvailable(false);
    assert.equal(transport.messages.length, stopped);
    transport.setAvailable(true);
    const session = transport.messages.at(-1)!.session;
    assert.notEqual(session, transport.messages[0].session);
    assert.equal(transport.messages.at(-1)?.kind, 'hello');
    transport.host({ kind: 'ready', session });
    transport.host({ kind: 'mounted', revision: 1, session });
    const request = (id: string, action: string) => transport.host({ kind: 'action', session, revision: 1, request: id, action });
    request('before', 'library');
    assert.deepEqual(actions, ['/library/']);
    // Query-backed Library views share usePathname()'s /library/ value. Selecting
    // the native destination must still push its canonical URL, like the web link.
    currentURL = '/library/?view=downloads&folder=queued';
    request('leave-downloads', 'library');
    assert.equal(currentURL, '/library/', 'Library must leave the downloads/folder view');
    currentURL = '/library/?q=title#results';
    request('clear-filter', 'library');
    assert.equal(currentURL, '/library/', 'Library must clear route parameters even when already selected');
    release = beginAccountTransition();
    request('transition', 'history');
    assert.equal((transport.messages.at(-1) as any).accepted, false);
    release(); release = undefined;
    setCurrentUser('owner-b');
    request('replacement', 'search');
    assert.equal((transport.messages.at(-1) as any).accepted, false);
    assert.deepEqual(actions, ['/library/', '/library/', '/library/'], 'retained callbacks must not navigate or open settings for another account');
  } finally {
    release?.(); for (const cleanup of cleanups.reverse()) cleanup(); setCurrentUser(previousOwner);
  }
});
