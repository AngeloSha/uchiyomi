import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeNavigationLayout, observeNativeNavigationLayout, usesSideNavigation, NATIVE_LAYOUT_ATTRIBUTE, NATIVE_SIDEBAR_ATTRIBUTE } from '../lib/nativeLayout';

function environment(host: unknown, initial: string | null) {
  const globals = globalThis as any;
  const previous = new Map(['window', 'document', 'MutationObserver'].map((name) => [name, Object.getOwnPropertyDescriptor(globals, name)]));
  const attributes = new Map<string, string>();
  if (initial !== null) attributes.set(NATIVE_LAYOUT_ATTRIBUTE, initial);
  const root = { getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    removeAttribute: (name: string) => { attributes.delete(name); } };
  const observers: FakeObserver[] = [];
  class FakeObserver {
    disconnected = false;
    target?: unknown;
    options?: MutationObserverInit;
    constructor(readonly callback: () => void) { observers.push(this); }
    observe(target: unknown, options: MutationObserverInit) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  Object.defineProperty(globals, 'window', { configurable: true, writable: true, value: { uchiyomiNative: host } });
  Object.defineProperty(globals, 'document', { configurable: true, writable: true, value: { documentElement: root } });
  Object.defineProperty(globals, 'MutationObserver', { configurable: true, writable: true, value: FakeObserver });
  return { root, attributes, observers, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globals, name, descriptor);
      else delete globals[name];
    }
  } };
}
const supported = { platform: 'ios', protocolVersion: 2, serverOrigin: 'https://books.example' };

test('browser and older hosts cannot activate the native rail through a DOM hint', () => {
  for (const host of [undefined, { platform: 'desktop', protocolVersion: 2 }, { platform: 'ios', protocolVersion: 1 }]) {
    const fixture = environment(host, 'side');
    try {
      assert.equal(nativeNavigationLayout(), null);
      const changes: unknown[] = [];
      const stop = observeNativeNavigationLayout(true, (layout) => changes.push(layout));
      assert.deepEqual(changes, [null]);
      assert.equal(fixture.attributes.has(NATIVE_SIDEBAR_ATTRIBUTE), false);
      assert.equal(fixture.observers.length, 0);
      stop();
    } finally { fixture.restore(); }
  }
});

test('native layout accepts only the two bounded presentation values', () => {
  const fixture = environment(supported, null);
  try {
    for (const value of ['', 'SIDE', ' side', 'vertical', '<script>', 'side bottom']) {
      fixture.root.setAttribute(NATIVE_LAYOUT_ATTRIBUTE, value);
      assert.equal(nativeNavigationLayout(), null, value);
    }
    for (const value of ['side', 'bottom'] as const) {
      fixture.root.setAttribute(NATIVE_LAYOUT_ATTRIBUTE, value);
      assert.equal(nativeNavigationLayout(), value);
    }
  } finally { fixture.restore(); }
});

test('fold presentation changes update one derived layout and cleanup retires pending callbacks', () => {
  const fixture = environment(supported, 'side');
  try {
    const changes: unknown[] = [];
    const stop = observeNativeNavigationLayout(true, (layout) => changes.push(layout));
    assert.equal(fixture.attributes.has(NATIVE_SIDEBAR_ATTRIBUTE), true);
    assert.equal(fixture.observers.length, 1);
    const observer = fixture.observers[0];
    assert.equal(observer.target, fixture.root);
    assert.deepEqual(observer.options, { attributes: true, attributeFilter: [NATIVE_LAYOUT_ATTRIBUTE] });
    fixture.root.setAttribute(NATIVE_LAYOUT_ATTRIBUTE, 'bottom'); observer.callback();
    assert.equal(fixture.attributes.has(NATIVE_SIDEBAR_ATTRIBUTE), false);
    fixture.root.removeAttribute(NATIVE_LAYOUT_ATTRIBUTE); observer.callback();
    fixture.root.setAttribute(NATIVE_LAYOUT_ATTRIBUTE, 'side'); observer.callback();
    assert.equal(fixture.attributes.has(NATIVE_SIDEBAR_ATTRIBUTE), true);
    assert.deepEqual(changes, ['side', 'bottom', null, 'side']);
    stop();
    assert.equal(observer.disconnected, true);
    assert.equal(fixture.attributes.has(NATIVE_SIDEBAR_ATTRIBUTE), false);
    observer.callback();
    assert.deepEqual(changes, ['side', 'bottom', null, 'side']);
  } finally { fixture.restore(); }
});

test('reader and anonymous presentations do not reserve a side-rail inset', () => {
  const fixture = environment(supported, 'side');
  try {
    const stop = observeNativeNavigationLayout(false, () => {});
    assert.equal(fixture.attributes.has(NATIVE_SIDEBAR_ATTRIBUTE), false);
    fixture.observers[0].callback();
    assert.equal(fixture.attributes.has(NATIVE_SIDEBAR_ATTRIBUTE), false);
    stop();
  } finally { fixture.restore(); }
});

test('native side layout preserves the existing wide-viewport rail and normal phone fallback', () => {
  for (const layout of [null, 'bottom', 'side'] as const) assert.equal(usesSideNavigation(true, layout), true);
  assert.equal(usesSideNavigation(false, null), false);
  assert.equal(usesSideNavigation(false, 'bottom'), false);
  assert.equal(usesSideNavigation(false, 'side'), true);
});
