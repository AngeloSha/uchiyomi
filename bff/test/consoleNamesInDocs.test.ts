// Every "Profile → X" / "Admin → X" the docs tell a reader to open must be a place the app actually has.
//
// The profile's "Security" section became the "Account" tab on 2026-08-24 and the docs kept saying
// "Profile → Security" for three weeks; the wording was then copied into the Mihon extension's own settings
// screen and a GitHub reply, and the first person to follow it could not find where to create a token.
// Nothing had failed, because nothing compared the docs against the UI. This does: it collects the tab,
// group and card names from the console pages and checks each documented path segment against them.
//
// Reintroduce by writing `**Profile → Security**` anywhere in docs/USAGE.md: the test names the line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

/**
 * Lower-case, `&` as "and", no parenthetical, no glyph prefix or trailing colon -- so "External readers"
 * matches "External readers (OPDS)", "Backup database & config" matches its task name, and "↻ Reload sources"
 * is just "reload sources".
 */
const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/\s*\(.*?\)\s*/g, ' ')
  .replace(/^[^a-z0-9]+/, '').replace(/[:…]+$/, '').replace(/\s+/g, ' ').trim();

/**
 * Names a person can see on the two consoles: tabs (`keys('A', 'B')`), groups (`label: 'X'`), card titles and
 * any other translated string (`tr('X')`), static button/heading text (`>Run now<`), the untranslated ternary
 * labels the admin console still has (`? 'Reloading…' : '↻ Reload sources'`), and the task names the server
 * hands the Tasks tab (`name: '…'` in routes/admin.ts).
 */
function consoleNames(): Set<string> {
  const files = [
    'web/app/profile/page.tsx',
    'web/app/admin/page.tsx',
    'bff/src/routes/admin.ts',
    ...readdirSync(join(REPO, 'web/components')).filter((f) => f.endsWith('.tsx')).map((f) => `web/components/${f}`),
  ];
  const names = new Set<string>();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/keys\(([^)]*)\)/g)) for (const s of m[1].matchAll(/'([^']+)'/g)) names.add(norm(s[1]));
    for (const m of src.matchAll(/\b(?:label|name): '([^']+)'/g)) names.add(norm(m[1]));
    for (const m of src.matchAll(/tr\('([^']+)'\)/g)) names.add(norm(m[1]));
    for (const m of src.matchAll(/>\s*([A-Z][^<>{}]{1,60}?)\s*</g)) names.add(norm(m[1]));
    for (const m of src.matchAll(/\?\s*'[^']*'\s*:\s*'([^']+)'/g)) names.add(norm(m[1]));
  }
  return names;
}

/** `**Profile → Account → API tokens**` → ['profile', 'account', 'api tokens']; both arrow spellings. */
function documentedPaths(): Array<{ file: string; line: number; text: string; segments: string[] }> {
  const out: Array<{ file: string; line: number; text: string; segments: string[] }> = [];
  const files = ['README.md', 'CHANGELOG.md', 'bff/openapi.yaml', ...readdirSync(join(REPO, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\*\*((?:Profile|Admin)(?:\s*(?:→|->)\s*[^*→>]+)+)\*\*/g)) {
        out.push({ file: f, line: i + 1, text: m[1], segments: m[1].split(/\s*(?:→|->)\s*/).map(norm) });
      }
    });
  }
  return out;
}

test('every console path the docs name exists in the UI', () => {
  const names = consoleNames();
  assert.ok(names.has('account') && names.has('api tokens') && names.has('providers'), 'the name scan lost the console itself');
  assert.ok(!names.has('security'), 'the profile has no Security tab; if it grew one, the docs may say so again');

  const paths = documentedPaths();
  assert.ok(paths.length >= 10, `expected the docs to name console paths, found ${paths.length}`);

  const bad: string[] = [];
  for (const p of paths) {
    // the first segment is the console; every later one must be (a prefix of) something on screen
    for (const seg of p.segments.slice(1)) {
      const found = [...names].some((n) => n === seg || n.startsWith(seg + ' ') || n.startsWith(seg));
      if (!found) bad.push(`${p.file}:${p.line}: "${p.text}" -- no tab, group or card called "${seg}"`);
    }
  }
  assert.deepEqual(bad, [], `documented paths that lead nowhere:\n${bad.join('\n')}`);
});
