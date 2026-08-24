// One react-query key must mean one endpoint.
//
// `['trending']` was used by three pages: the home page and the admin dashboard fetched `/api/trending`,
// which is what the household is reading and comes back as `Series[]`, while Discover fetched
// `/api/discover/trending`, which is AniList and comes back with `genres`, `banner` and `score`.
//
// react-query hands a cached entry to the next subscriber of the same key SYNCHRONOUSLY, before its own
// refetch lands. So arriving at Discover from the home page -- which is the landing page, so nearly always
// -- rendered the hero against a Series DTO, `cur.genres` was undefined, and `.slice(0, 3)` threw. The whole
// page became "Application error: a client-side exception has occurred".
//
// What made it hard to see is that loading /discover/ directly was fine: no cache, so the right shape
// arrived first. Only clicking the tab from inside the app broke, which is the one path a person actually
// takes and the one an end-to-end test that navigates by URL never exercises.
//
// A static check, because the failure is a pairing between two files that nothing else compares.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'out' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every `queryKey: [...]` and the first `/api/...` path that follows it.
 *
 * Keys built from a variable (`['series', id]`) are skipped: their identity is the variable, and comparing
 * the literal prefix would flag correct code. The bug this catches is a CONSTANT key reused for two
 * different endpoints.
 */
function pairs(): Map<string, Map<string, string>> {
  const found = new Map<string, Map<string, string>>();
  for (const file of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')), walk(join(ROOT, 'lib')))) {
    const rel = file.slice(ROOT.length + 1);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const k = /queryKey:\s*(\[[^\]]*\])/.exec(lines[i]);
      if (!k) continue;
      // `invalidateQueries({ queryKey: [...] })` names a key, it does not define one. Treating it as a
      // definition made the scan walk forward into the NEXT query's queryFn and report a clash that is
      // really two neighbouring one-liners.
      if (/(?:invalidate|remove|cancel|refetch|prefetch)Queries|[gs]etQueryData/.test(lines[i])) continue;
      const key = k[1];
      // A key with any interpolation, variable or spread is scoped by that value, not by the literal.
      if (/\$\{|\.\.\.|[A-Za-z_$][\w$]*\s*(?:[,\]])/.test(key.replace(/'[^']*'/g, ''))) continue;

      // The URL has to come from this query's OWN queryFn. Reading "the next /api/ path" instead picks up
      // the mutation defined on the following line and reports it as a clash with itself.
      for (let j = i; j < Math.min(i + 8, lines.length); j++) {
        // Walking past another queryKey means this one had no queryFn of its own and we are now reading
        // somebody else's.
        if (j > i && /queryKey:/.test(lines[j])) break;
        if (!/queryFn:/.test(lines[j])) continue;
        for (let m = j; m < Math.min(j + 3, lines.length); m++) {
          const u = /['"`](\/api\/[A-Za-z0-9/_-]*)/.exec(lines[m]);
          if (!u) continue;
          // `/api/x` and `/api/x/` are the same endpoint written two ways.
          const url = u[1].replace(/\/+$/, '');
          if (!found.has(key)) found.set(key, new Map());
          found.get(key)!.set(url, `${rel}:${m + 1}`);
          break;
        }
        break;
      }
    }
  }
  return found;
}

test('THE REGRESSION: no constant query key is used for two different endpoints', () => {
  const clashes: string[] = [];
  for (const [key, urls] of pairs()) {
    if (urls.size > 1) {
      clashes.push(`${key} -> ${[...urls.entries()].map(([u, where]) => `${u} (${where})`).join('  vs  ')}`);
    }
  }
  assert.deepEqual(
    clashes,
    [],
    'These keys mean two different things, so whichever page loads first decides what the other one renders.\n' +
      'Give each endpoint its own key.\n  ' + clashes.join('\n  '),
  );
});

test('the scan actually finds the keys it is meant to police', () => {
  // A regex that silently matched nothing would make the test above pass forever. Two known-good pairings.
  const found = pairs();
  assert.ok(found.size > 8, `expected the app's query keys to be found, got ${found.size}`);
  assert.deepEqual([...(found.get("['discover-trending']") ?? new Map()).keys()], ['/api/discover/trending']);
  assert.deepEqual([...(found.get("['libraries']") ?? new Map()).keys()], ['/api/libraries']);
});
