// The page change (components/PageTransition.tsx), 2026-10-15. Since it was written, a click showed the NEXT page at once
// inside the outgoing fade, faded it away and faded it in again -- and built it twice: the router hands a page its route
// through contexts, and the wrapper AnimatePresence keeps for the fade-out read the live ones. The owner chose to have it
// do what it was designed to (the old page fades out, the new one fades in, once). These guards pin the held contexts, and
// that Next still keeps the route where they hold it. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SRC = read('components/PageTransition.tsx');

test('the outgoing page keeps every context it read its route from', () => {
  // All of them, or the page fading away re-renders as itself asked for another route: a series with no id, a Library
  // whose filters just emptied.
  for (const ctx of ['LayoutRouterContext', 'PathnameContext', 'SearchParamsContext', 'PathParamsContext', 'NavigationPromisesContext']) {
    assert.match(SRC, new RegExp(`useContext\\(${ctx}\\)`), `${ctx} is no longer read`);
    assert.match(SRC, new RegExp(`<${ctx}\\.Provider value=\\{h\\.`), `${ctx} is no longer held for the outgoing page`);
  }
  // Held from the last render on which this was the current page, and only then.
  assert.match(SRC, /const held = useRef\(live\);\n\s*const current = live\.pathname === path;\n\s*if \(current\) held\.current = live;/,
    'a page that is still the current one must follow the live route (one series to another is a search-params change)');
  // Around the page, inside the keyed wrapper the fade animates.
  assert.match(SRC, /<motion\.div\s+key=\{path\}[\s\S]*?<FrozenRoute path=\{path\}>\{children\}<\/FrozenRoute>\s*<\/motion\.div>/,
    'the page is no longer inside FrozenRoute: the next page shows inside the outgoing fade again');
});

test('the fade itself is unchanged', () => {
  // The design the owner kept: out up 6 px, in from 10 px below, 260 ms each, one after the other.
  assert.match(SRC, /<AnimatePresence mode=\{reduced \? 'sync' : 'wait'\} initial=\{false\}>/);
  assert.match(SRC, /initial=\{reduced \? false : \{ opacity: 0, y: 10 \}\}/);
  assert.match(SRC, /exit=\{reduced \? undefined : \{ opacity: 0, y: -6 \}\}/);
  assert.match(SRC, /transition=\{reduced \? \{ duration: 0 \} : \{ duration: 0\.26, ease: \[0\.22, 1, 0\.36, 1\] \}\}/);
});

test("Next still keeps a page's route in the contexts held here", () => {
  // ⚠️ They are Next's internals. An upgrade that moves them must fail here, not quietly bring the flicker back.
  const ctx = read('node_modules/next/dist/shared/lib/hooks-client-context.shared-runtime.d.ts');
  for (const name of ['SearchParamsContext', 'PathnameContext', 'PathParamsContext', 'NavigationPromisesContext'])
    assert.match(ctx, new RegExp(`export declare const ${name}:`), `next no longer exports ${name} where PageTransition imports it`);
  assert.match(read('node_modules/next/dist/shared/lib/app-router-context.shared-runtime.d.ts'), /export declare const LayoutRouterContext:/);
  // ...and the hooks every page uses still read them.
  const nav = read('node_modules/next/dist/client/components/navigation.js');
  assert.match(nav, /function useSearchParams\(\)[\s\S]{0,400}useContext\)\(_hooksclientcontextsharedruntime\.SearchParamsContext\)/,
    'useSearchParams reads something else now: a page fading out would see the next route\'s search params');
  assert.match(nav, /function usePathname\(\)[\s\S]{0,400}useContext\)\(_hooksclientcontextsharedruntime\.PathnameContext\)/);
  assert.match(nav, /function useParams\(\)[\s\S]{0,400}useContext\)\(_hooksclientcontextsharedruntime\.PathParamsContext\)/);
});
