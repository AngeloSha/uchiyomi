// The server's "is this the chapter the reader would read next?" (bff lib/nextUpRule.ts, behind the account setting "Only tell me
// about my next chapter") must pick the chapter the series page's reading button opens. Held to each other on every combination
// of read / part-read / unread / deleted-from-the-server over small series, plus a seeded random sweep of larger ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { continueChoice, type ContinueBook } from '../lib/continueLabel';
import { notifyOnlyNextOn } from '../lib/notifyOnlyNext';
import { existsSync } from 'fs';
import { join } from 'path';

// The server's file is loaded at run time, never imported: the release image builds web/ alone (adminNotifications.test.ts).
interface NextUpRow { number: number; done: boolean; page: number; pruned?: boolean }
const RULE = join(__dirname, '../../bff/src/lib/nextUpRule.ts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextUpNumber: (rows: NextUpRow[]) => { kind: string; number: number } | null = existsSync(RULE) ? require(RULE).nextUpNumber : () => null;
const skip = existsSync(RULE) ? false : 'bff/ is not beside web/';

type State = 'unread' | 'part' | 'done';
const STATES: State[] = ['unread', 'part', 'done'];

function agree(rows: Array<{ state: State; pruned: boolean }>) {
  const books: ContinueBook[] = rows.map((r, i) => ({
    id: `b${i + 1}`, number: i + 1, pruned: r.pruned,
    readProgress: r.state === 'unread' ? null : { completed: r.state === 'done', page: r.state === 'part' ? 3 : 0 },
  }));
  const choice = continueChoice(books, (b) => !b.pruned);
  const mine: NextUpRow[] = rows.map((r, i) => ({ number: i + 1, done: r.state === 'done', page: r.state === 'part' ? 3 : 0, pruned: r.pruned }));
  const n = nextUpNumber(mine);
  const label = JSON.stringify(rows);
  // `again` ("Read again") and `none` open a chapter the reader has already read or none: nothing is next.
  if (choice.kind === 'none' || choice.kind === 'again') return assert.equal(n, null, label);
  assert.ok(n, label);
  assert.equal(n!.number, choice.book!.number, label);
  assert.equal(n!.kind, choice.kind, label);
}

test('every state of up to four chapters, deleted or not, agrees with the reading button', { skip }, () => {
  const cells = STATES.flatMap((state) => [false, true].map((pruned) => ({ state, pruned })));
  const walk = (acc: typeof cells, depth: number) => {
    if (acc.length) agree(acc);
    if (depth === 0) return;
    for (const c of cells) walk([...acc, c], depth - 1);
  };
  walk([], 4);
});

test('a seeded sweep of longer series agrees too', { skip }, () => {
  let seed = 20261022;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 2000; i++) {
    const n = 5 + Math.floor(rnd() * 12);
    agree(Array.from({ length: n }, () => ({ state: STATES[Math.floor(rnd() * 3)], pruned: rnd() < 0.2 })));
  }
});

test('the web reads the account setting only as a real true', () => {
  assert.equal(notifyOnlyNextOn({ notifyOnlyNext: true }), true);
  for (const s of [undefined, null, {}, { notifyOnlyNext: 'true' }, { notifyOnlyNext: 1 }, { notifyOnlyNext: false }]) {
    assert.equal(notifyOnlyNextOn(s as any), false, JSON.stringify(s));
  }
});
