import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { limitParts } from '../lib/politeness';
import { isBlocked, sheetKeys, type OverviewSource } from '../lib/sourcesPanel';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('limits are said in seconds and gigabytes, never milliseconds or bytes', () => {
  assert.deepEqual(limitParts({ value: 8000, unit: 'ms' }), { kind: 's', n: '8' });
  assert.deepEqual(limitParts({ value: 1500, unit: 'ms' }), { kind: 's', n: '1.5' });
  assert.deepEqual(limitParts({ value: 5 * 2 ** 30, unit: 'bytes' }), { kind: 'gb', n: '5' });
  assert.deepEqual(limitParts({ value: 4, unit: 'count' }), { kind: 'plain', n: '4' });
  assert.deepEqual(limitParts({ value: 14, unit: 'files' }), { kind: 'plain', n: '14' });
});

test('a source is blocked when it is cooling or its state says so, and then its sheet offers Unblock', () => {
  assert.equal(isBlocked({ standing: 'cooling', state: 'ok' } as never), true);
  assert.equal(isBlocked({ standing: 'usable', state: 'blocked' } as never), true);
  assert.equal(isBlocked({ standing: 'usable', state: 'ok' } as never), false);
  assert.ok(sheetKeys({ standing: 'cooling', state: 'ok', main: 0 } as unknown as OverviewSource).includes('unblock'));
  assert.ok(!sheetKeys({ standing: 'usable', state: 'ok', main: 0 } as unknown as OverviewSource).includes('unblock'));
});

test('the Downloads settings mount Downloads & politeness', () => {
  assert.match(code(read('components/AdminSettings.tsx')), /<PolitenessRow \/>/);
});

test('Downloads & politeness shows the limits read-only and unblocks through the source route', () => {
  const src = code(read('components/PolitenessSettings.tsx'));
  const section = src.slice(src.indexOf('export function PolitenessRow('));
  assert.match(section, /api<\{ limits: Limit\[\]; note: string \}>\('\/api\/admin\/limits'\)/);
  assert.match(section, /\/unblock`, \{ method: 'POST' \}/);
  assert.match(section, /tr\('No sources are blocked right now\.'\)/);
  assert.doesNotMatch(section, /<input|<NumberRow|<SwitchRow/, 'a read-only list grew a control for a variable the server reads at boot');
});
