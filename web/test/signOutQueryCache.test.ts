// Signing out empties the tab's query cache, and so does every sign-in, read from source.
//
// The query cache lives in the page (app/providers.tsx), and signing out neither reloads nor cleared it: with a 30 s
// staleTime and five minutes' keep for unused queries, the next person on a shared device was shown the last one's
// Wrapped, history, stats and picks -- 18+ titles to an age-capped account included -- until each query refetched.
// lib/auth.tsx forgetAccountData now clears it with the service worker's caches, at sign-out (clearLocalSession, which
// a rejected session runs too), sign-in and sign-up. Every guard names the edit that breaks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { QueryClient } from '@tanstack/react-query';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- comments here quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

const auth = code(read('lib/auth.tsx'));

test('forgetAccountData clears the query cache and the worker caches', () => {
  // Reintroduce by dropping qc.clear(): the next account reads the last one's answers.
  const forget = slice(auth, 'const forgetAccountData = async', '};');
  assert.match(forget, /qc\?\.clear\(\);/, 'the query cache is kept across accounts');
  assert.match(forget, /await purgeAccountCaches\(\);/, 'the service worker caches are kept across accounts');
  assert.match(auth, /const qc = useContext\(QueryClientContext\);/, 'AuthProvider does not hold the page\'s query client');
});

test('sign-out, sign-in and sign-up all forget the last account', () => {
  // Reintroduce by calling purgeAccountCaches() alone in any of them: that path keeps the query cache.
  assert.match(slice(auth, 'const clearLocalSession = async', 'useEffect('), /await forgetAccountData\(\);/, 'sign-out keeps the cache');
  assert.match(slice(auth, 'const login = async', 'const firstRunSetup'), /await forgetAccountData\(\);[^\n]*\n\s*setAccessToken/, 'sign-in keeps the cache');
  assert.match(slice(auth, 'const register = async', 'const logout'), /await forgetAccountData\(\);\s*setAccessToken/, 'sign-up keeps the cache');
});

test('clear() is what empties it: a cached answer is gone, not just stale', () => {
  const qc = new QueryClient();
  qc.setQueryData(['wrapped'], { minutes: 999 });
  assert.deepEqual(qc.getQueryData(['wrapped']), { minutes: 999 }, 'PREMISE');
  qc.clear();
  assert.equal(qc.getQueryData(['wrapped']), undefined);
  // invalidateQueries would only mark it stale: the old answer stays on screen until the refetch lands.
  qc.setQueryData(['wrapped'], { minutes: 999 });
  void qc.invalidateQueries();
  assert.deepEqual(qc.getQueryData(['wrapped']), { minutes: 999 }, 'PREMISE: invalidation keeps the data');
});
