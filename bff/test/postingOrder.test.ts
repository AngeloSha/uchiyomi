// Posting-order numbering (#116), the pure half: the detector, the sequence, the stable numbers and the plan
// that moves files already on disk.
//
// The two series from the issue are REAL: test/fixtures/webtoons-posts.json holds their titles as the public
// Webtoons API lists them, and the numbers are derived here with the fake engine's port of the extension's
// own rule (webtoonsNumbers: the leftmost e/ep/episode/ch token, else the previous number + 0.01f in float32),
// so every figure below is what an unpatched server sees. The shapes the detector must NOT fire on --
// MangaDex's multi-group copies, uncredited re-uploads, mirrors -- are built here beside them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { webtoonsNumbers } from './fixtures/fakeSuwayomi';
import {
  SHARED_NUMBERING, numKey, displayTitle, nameKey, detectSharedNumbering, postingSequence, assignPostingNumbers,
  planRenumber, renumberedFile, EXTRA_PREFIX, type PlanBook, type PlanPost, type PostNumber,
} from '../src/lib/postingOrder';
import { chapterName, numFromName } from '../src/lib/naming';
import type { SourceChapter } from '../src/lib/sources/types';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'webtoons-posts.json'), 'utf8')) as Record<string, {
  title: string; posts: Array<{ order: number; episodeNo: number; title: string }>;
}>;
const DAY = 86_400_000;
const EPOCH = Date.UTC(2019, 9, 1);

/**
 * A real series as the Suwayomi adapter hands it over: the extension's number and name, the engine's id and
 * sourceOrder, and ascending by number (stable), which is how listChapters returns it. The fixture carries no
 * dates, so each post gets one a day after the last -- the list is oldest first, as the API gives it.
 */
function webtoons(key: 'istrevelia' | 'apocalypticHorseplay'): SourceChapter[] {
  const posts = FIXTURE[key].posts;
  const numbered = webtoonsNumbers(posts.map((p) => ({ name: p.title })), false);
  return posts
    .map((p, i): SourceChapter => ({
      sourceId: String(10_000 + p.order),
      number: numbered[i].chapterNumber,
      title: numbered[i].name.trim(),
      order: p.order,
      url: `/episode?titleNo=${key}&episodeNo=${p.episodeNo}`,
      publishedAt: new Date(EPOCH + p.order * DAY).toISOString(),
    }))
    .sort((a, b) => a.number - b.number);
}

const histogram = (list: SourceChapter[]) => {
  const h: Record<string, number> = {};
  for (const c of list) h[String(numKey(c.number))] = (h[String(numKey(c.number))] ?? 0) + 1;
  return h;
};
const byTitle = (list: SourceChapter[], title: string) => {
  const c = list.find((x) => displayTitle(x.title) === title);
  assert.ok(c, `no post titled "${title}"`);
  return c;
};

test('the fixture is the issue\'s two series, numbered the way the extension numbers them', () => {
  const ist = webtoons('istrevelia');
  const ah = webtoons('apocalypticHorseplay');
  assert.equal(ist.length, 226);
  assert.equal(ah.length, 211);
  // The skeptic's measured histograms (research, issue-116), float32 noise folded to a thousandth.
  assert.deepEqual(histogram(ist), { 1: 19, 1.01: 1, 2: 21, 3: 20, 3.01: 1, 4: 21, 4.01: 1, 5: 24, 5.01: 1, 6: 28, 7: 73, 7.01: 1, 8: 15 });
  assert.deepEqual(histogram(ah), {
    1: 15, 1.01: 2, 2: 32, 2.01: 5, 3: 15, 3.01: 1, 4: 32, 4.01: 4, 4.02: 1, 5: 15, 5.01: 2, 6: 31, 6.01: 4, 6.02: 1,
    7: 42, 7.01: 5, 7.02: 2, 7.03: 1, 7.04: 1,
  });
  // The raw values really are float32 chains, which is why numKey exists.
  assert.ok(ah.some((c) => c.number === 7.0200005), 'the Epilogue chain reaches 7.0200005');
  // The titles the issue quotes, verbatim.
  for (const t of ['Episode 1 - Page1', 'Episode 1 - Page 5-7 [Blood Warning!]', 'EP 1 - 29-31', 'E2 - 54-56', 'E2  -  102-104', 'E& - 335-336', 'Ee7 - 443-444', 'E7 - 476 - 480', 'QnA Intermission - Part 1']) byTitle(ist, t);
  for (const t of ['CH1-EP1: Bible Study', 'CH1-Ep2: Student Journalist', 'Intermission', 'Intermission #2', 'Epilogue - Part 1 of 4', 'CH7-EP41 - Words Matter (Series Finale)']) byTitle(ah, t);
});

test('Istrevelia\'s 226 posts and Apocalyptic Horseplay\'s 211 posts fire the shared-numbering detector', () => {
  // Reintroduce the v0.48 reading -- one number is one chapter, whatever the posts are called -- by making
  // nameKey return '' for every post: no stack then has three names, and both verdicts read 'none'.
  const ist = detectSharedNumbering(webtoons('istrevelia'));
  assert.equal(ist.verdict, 'strong');
  assert.equal(ist.ordered, true);
  assert.deepEqual({ posts: ist.posts, numbers: ist.numbers, stacks: ist.stacks, extras: ist.extras }, { posts: 226, numbers: 13, stacks: 13, extras: 213 });
  assert.deepEqual(ist.biggest, { number: 7, posts: 73 });
  assert.deepEqual(ist.examples, ['E7 - 323-324', 'E7 - 325-326', 'E7 - 327-328'], 'the oldest three, without the extension\'s (ch. 7)');

  const ah = detectSharedNumbering(webtoons('apocalypticHorseplay'));
  assert.equal(ah.verdict, 'strong');
  assert.deepEqual({ posts: ah.posts, numbers: ah.numbers, stacks: ah.stacks, extras: ah.extras }, { posts: 211, numbers: 19, stacks: 19, extras: 192 });
  // The arc number, not an episode: 42 complete, separately titled episodes all read 7.
  assert.deepEqual(ah.biggest, { number: 7, posts: 42 });
});

/** A MangaDex-shaped listing: `groups` release every number, each under its own spelling, on its own day. */
function multiGroup(numbers: number, groups: string[]): SourceChapter[] {
  const out: SourceChapter[] = [];
  const spell = [(n: number) => `Chapter ${n}: Start`, (n: number) => `Ch. ${n} - The Road`, (n: number) => `Vol.1 Chapter ${n}: Road`];
  for (let n = 1; n <= numbers; n++) {
    groups.forEach((g, gi) => out.push({
      sourceId: `${g}-${n}`, number: n, title: spell[gi % spell.length](n), scanlator: g,
      publishedAt: new Date(EPOCH + (n * 7 + gi) * DAY).toISOString(),
    }));
  }
  return out;
}

test('MangaDex-style multi-group copies never fire', () => {
  const list = multiGroup(300, ['Alpha Scans', 'Beta Team', 'Gamma']);
  // Five same-group re-uploads on top: the same group, the same name, a day later.
  for (const n of [10, 20, 30, 40, 50]) list.push({ sourceId: `Alpha Scans-${n}-re`, number: n, title: `Chapter ${n}: Start`, scanlator: 'Alpha Scans', publishedAt: new Date(EPOCH + (n * 7 + 1) * DAY).toISOString() });
  const d = detectSharedNumbering(list);
  // Reintroduce by dropping groupKey from the stack key (detectSharedNumbering): the three groups' copies
  // then stack by number, 605 of 905 posts become extras, the spellings differ and the days differ, and the
  // verdict reads 'hint' -- a warning on every MangaDex series with more than one group.
  assert.equal(d.verdict, 'none', 'groupKey keeps multi-group copies apart');
  // Each group's copy is its own stack, so the only extras are the five re-uploads.
  assert.equal(d.stacks, 900);
  assert.equal(d.extras, 5);
  // A joint release is one group key whichever way round it is written.
  assert.equal(detectSharedNumbering([{ sourceId: 'a', number: 1, scanlator: 'A & B' }, { sourceId: 'b', number: 1, scanlator: 'B & A' }]).stacks, 1);
});

test('uncredited copies that differ only by a title, and same-day mirrors, are not split', () => {
  const pairs = (second: (n: number) => string, secondDay: number) => {
    const out: SourceChapter[] = [];
    for (let n = 1; n <= 100; n++) {
      out.push({ sourceId: `${n}a`, number: n, title: `Chapter ${n}`, publishedAt: new Date(EPOCH + n * 7 * DAY).toISOString() });
      out.push({ sourceId: `${n}b`, number: n, title: second(n), publishedAt: new Date(EPOCH + (n * 7 + secondDay) * DAY).toISOString() });
    }
    return out;
  };
  // 'Chapter 5' and 'Chapter 5: The Return' on the same day: one named post and one that only said the
  // number again. Splitting them would download every chapter twice.
  const sameDay = detectSharedNumbering(pairs((n) => `Chapter ${n}: The Return`, 0));
  assert.equal(sameDay.extras, 100);
  assert.notEqual(sameDay.verdict, 'strong');
  assert.equal(sameDay.verdict, 'none');
  // The titled copy a day LATER: only the "an empty name is never a distinct post" rule holds it now.
  // Reintroduce by counting '' as a name (drop `.filter(Boolean)` in detectSharedNumbering's `names`): 'hint'.
  assert.equal(detectSharedNumbering(pairs((n) => `Chapter ${n}: The Return`, 1)).verdict, 'none', 'an unnamed copy never proves itself a different post');
  // '[Server 1]' / '[Server 2]' mirrors: named apart, but posted together.
  // Reintroduce by dropping the days condition from `spread`: 'hint'.
  const mirrors: SourceChapter[] = [];
  for (let n = 1; n <= 100; n++) {
    for (const s of [1, 2]) mirrors.push({ sourceId: `${n}-${s}`, number: n, title: `Chapter ${n} [Server ${s}]`, publishedAt: new Date(EPOCH + n * 7 * DAY + s * 60_000).toISOString() });
  }
  assert.equal(detectSharedNumbering(mirrors).verdict, 'none', 'mirrors posted the same day are one chapter');
  // What a HINT is for: numbering that restarts each season, named apart and posted apart. Warned, not renumbered.
  const seasons: SourceChapter[] = [];
  for (const s of [1, 2]) for (let n = 1; n <= 40; n++) seasons.push({ sourceId: `s${s}-${n}`, number: n, title: `S${s} Chapter ${n}`, publishedAt: new Date(EPOCH + ((s - 1) * 400 + n * 7) * DAY).toISOString() });
  assert.equal(detectSharedNumbering(seasons).verdict, 'hint');
  // Too short a listing is never judged.
  assert.equal(detectSharedNumbering(webtoons('istrevelia').slice(0, SHARED_NUMBERING.MIN_POSTS - 1)).verdict, 'none');
});

test('a listing without posting order only warns', () => {
  // Reintroduce by dropping the `ordered` condition from the strong verdict: 'strong', and a series would be
  // renamed on an order the source never stated.
  const list = webtoons('istrevelia').map(({ order: _order, ...c }) => c);
  const d = detectSharedNumbering(list);
  assert.equal(d.ordered, false);
  assert.equal(d.verdict, 'hint');
  assert.equal(d.reason, 'no_order');
  // One post without an order is enough to lose it.
  const one = webtoons('istrevelia');
  delete one[100].order;
  assert.equal(detectSharedNumbering(one).verdict, 'hint');
});

test('posting order runs oldest first even when the engine\'s order is reversed', () => {
  // Reintroduce by removing the direction guard in postingSequence: the reversed case numbers the NEWEST
  // post 1 ('E8 - 527 -530') and the second assertion fails.
  const list = webtoons('istrevelia');
  assert.equal(displayTitle(postingSequence(list)[0].title), 'Episode 1 - Page1');
  const reversed = list.map((c) => ({ ...c, order: 227 - c.order! }));
  assert.equal(displayTitle(postingSequence(reversed)[0].title), 'Episode 1 - Page1', 'counted from the newest, turned round by the dates');
  assert.equal(displayTitle(postingSequence(reversed)[225].title), 'E8 - 527 -530');
  // No order at all: by date.
  const undated = list.map(({ order: _order, ...c }) => c);
  assert.equal(displayTitle(postingSequence(undated)[0].title), 'Episode 1 - Page1');
});

test('AH\'s Intermission posted after CH1-EP3 is chapter 4 and Istrevelia\'s E2 - 102-104 is chapter 39', () => {
  // Reintroduce the sub-numbering design by sorting postingSequence by the SOURCE number, then order: the
  // Intermission follows all fifteen CH1 posts and reads 16, and 'E2 - 102-104' is not 39.
  const ah = assignPostingNumbers(postingSequence(webtoons('apocalypticHorseplay'))).numbered;
  assert.equal(byTitle(ah, 'Intermission').number, 4);
  assert.equal(byTitle(ah, 'Intermission #2').number, 17);
  assert.equal(byTitle(ah, 'CH1- Ep4: Mystery Paper').number, 5);
  assert.equal(byTitle(ah, 'Epilogue - Part 1 of 4').number, 208);
  const ist = assignPostingNumbers(postingSequence(webtoons('istrevelia'))).numbered;
  assert.equal(byTitle(ist, 'E2  -  102-104').number, 39);
  for (const [list, k] of [[ah, 211], [ist, 226]] as const) {
    assert.deepEqual(list.map((c) => c.number), Array.from({ length: k }, (_, i) => i + 1), 'contiguous, whole, ascending');
  }
  // Each keeps what the source called it, and its title loses the suffix that would contradict the number.
  const blood = byTitle(ist, 'Episode 1 - Page 5-7 [Blood Warning!]');
  assert.equal(blood.number, 5);
  assert.equal(blood.sourceNumber, 1);
  assert.equal(blood.title, 'Episode 1 - Page 5-7 [Blood Warning!]');
  assert.equal(byTitle(ah, 'Epilogue - Part 2 of 4').sourceNumber, 7.0200005, 'the raw number is kept raw');
});

test('posting numbers are stable: a deleted post is a hole, a new one goes at the end, an inserted one between', () => {
  const first = assignPostingNumbers(postingSequence(webtoons('istrevelia')));
  const numberOf = (a: { rows: PostNumber[] }, id: string) => a.rows.find((r) => r.postId === id)?.number;
  const idAt = (n: number) => first.rows.find((r) => r.number === n)!.postId;

  // The creator deletes post 50.
  const deleted = webtoons('istrevelia').filter((c) => c.sourceId !== idAt(50)).map((c) => ({ ...c, order: c.order! > 50 ? c.order! - 1 : c.order }));
  const second = assignPostingNumbers(postingSequence(deleted), first.rows);
  // Reintroduce by recomputing from scratch (ignore `stored`): post 51 becomes 50 and this fails.
  assert.equal(numberOf(second, idAt(51)), 51, 'nothing after the deleted post moves');
  assert.equal(numberOf(second, idAt(49)), 49);
  assert.deepEqual(second.gone.map((r) => [r.postId, r.number]), [[idAt(50), 50]]);
  assert.equal(second.rows.find((r) => r.postId === idAt(50))?.gone, true, 'the hole is kept, reserved');
  assert.deepEqual(second.added, []);
  assert.equal(second.numbered.length, 225);
  assert.ok(!second.numbered.some((c) => c.number === 50), '50 is a hole, not handed on');

  // A new post at the end: max + 1, above the hole.
  const tail: SourceChapter = { sourceId: 'new-tail', number: 8, title: 'E8 - 531-532 (ch. 8)', order: 226, publishedAt: new Date(EPOCH + 400 * DAY).toISOString() };
  const third = assignPostingNumbers(postingSequence([...deleted, tail]), second.rows);
  assert.equal(numberOf(third, 'new-tail'), 227);
  assert.deepEqual(third.gone, [], 'an old hole is not reported gone again');

  // A post inserted between 41 and 42: 41.5, and a second one after it 41.75; nothing else moves.
  const shifted = [...deleted, tail].map((c) => ({ ...c, order: c.order! >= 42 ? c.order! + 2 : c.order }));
  const between = (id: string, order: number): SourceChapter => ({ sourceId: id, number: 2, title: `E2 - inserted ${id} (ch. 2)`, order, publishedAt: new Date(EPOCH + 41 * DAY + order).toISOString() });
  const fourth = assignPostingNumbers(postingSequence([...shifted, between('ins-a', 42), between('ins-b', 43)]), third.rows);
  assert.equal(numberOf(fourth, 'ins-a'), 41.5);
  assert.equal(numberOf(fourth, 'ins-b'), 41.75);
  assert.equal(numberOf(fourth, idAt(42)), 42);
  assert.equal(numberOf(fourth, 'new-tail'), 227);
  assert.equal(fourth.conflict, undefined);

  // The engine re-creates its rows (new ids, same urls): every post is found by its url and keeps its number.
  const renamed = webtoons('istrevelia').map((c) => ({ ...c, sourceId: `v2-${c.sourceId}` }));
  const fifth = assignPostingNumbers(postingSequence(renamed), first.rows);
  assert.equal(numberOf(fifth, `v2-${idAt(77)}`), 77);
  assert.equal(fifth.rekeyed.length, 226);
  assert.deepEqual(fifth.added, []);
  // No url and a new id: the same title on the same day still finds it, when that pairs exactly one of each.
  const bare = webtoons('istrevelia').map(({ url: _url, ...c }) => ({ ...c, sourceId: `v3-${c.sourceId}` }));
  assert.equal(numberOf(assignPostingNumbers(postingSequence(bare), first.rows), `v3-${idAt(100)}`), 100);
});

test('float32 noise does not split a number', () => {
  assert.equal(numKey(7.0200005), numKey(7.02));
  assert.equal(numKey(100.020004), 100.02);
  assert.equal(numKey(7.0300007), 7.03);
  // Reintroduce by keying the detector's stacks on the raw number (`${c.number}|...` in detectSharedNumbering):
  // 7.02 and 7.0200005 make two stacks here, and the stacks assertion fails.
  const list: SourceChapter[] = Array.from({ length: 14 }, (_, i) => ({ sourceId: `p${i}`, number: i < 7 ? 7.02 : 7.0200005, title: `Part ${i + 1}`, order: i + 1 }));
  const d = detectSharedNumbering(list);
  assert.equal(d.stacks, 1);
  assert.equal(d.numbers, 1);
  assert.deepEqual(d.biggest, { number: 7.02, posts: 14 });
});

test('copies of one post from two groups share a posting number', () => {
  // Reintroduce by numbering every row as its own post (skip the slot join in assignPostingNumbers): the
  // Beta copy gets 3 and the first assertion fails.
  const at = (d: number) => new Date(EPOCH + d * DAY).toISOString();
  const seq = postingSequence<SourceChapter>([
    { sourceId: 'a1', number: 1, title: 'Chapter 1: Start', scanlator: 'Alpha', order: 1, publishedAt: at(1) },
    { sourceId: 'a2', number: 1, title: 'Chapter 1: Later', scanlator: 'Alpha', order: 2, publishedAt: at(2) },
    { sourceId: 'b1', number: 1, title: 'Ch. 1 - Start', scanlator: 'Beta', order: 3, publishedAt: at(3) },
    { sourceId: 'a3', number: 1, title: 'Chapter 1: Start', scanlator: 'Alpha', order: 4, publishedAt: at(4) },
  ]);
  const { rows } = assignPostingNumbers(seq);
  const n = (id: string) => rows.find((r) => r.postId === id)!.number;
  assert.equal(n('b1'), n('a1'), 'Beta\'s copy of "Start" is a version of Alpha\'s post, not a new post');
  assert.equal(n('a2'), 2, 'the same group under another name is another post');
  assert.equal(n('a3'), 3, 'the same group under the SAME name is still another post: on one source, every post is one');
  assert.equal(nameKey({ title: 'Ch. 1 - Start', number: 1 }), nameKey({ title: 'Chapter 1: Start', number: 1 }));
});

test('the extension\'s suffix and music note are not part of a title', () => {
  assert.equal(displayTitle('Episode 1 - Page 2 (ch. 1)'), 'Episode 1 - Page 2');
  assert.equal(displayTitle('Epilogue - Part 2 of 4 (ch. 7.0200005)'), 'Epilogue - Part 2 of 4');
  assert.equal(displayTitle('CH1-EP1: Bible Study (ch. 1) ♫'), 'CH1-EP1: Bible Study');
  assert.equal(displayTitle('CH1-EP1: Bible Study ♫ (ch. 1)'), 'CH1-EP1: Bible Study');
  assert.equal(displayTitle('Episode 1 - Page1  (ch. 1)'), 'Episode 1 - Page1');
  assert.equal(displayTitle(undefined), '');
  // The residue that names a post apart from the others on its number.
  assert.equal(nameKey({ title: 'Episode 1 - Page 5-7 [Blood Warning!] (ch. 1)', number: 1 }), 'page 5-7 [blood warning!]');
  assert.equal(nameKey({ title: 'CH7-EP32: Something (ch. 7)', number: 7 }), 'ep32: something');
  assert.equal(nameKey({ title: 'Chapter 5', number: 5 }), '', 'the number said again is no name');
});

// ---- planRenumber --------------------------------------------------------------------------------------------

/** The posting assignment as the plan reads it: the SOURCE number is where each post's file sits today. */
function postingTarget(list: SourceChapter[]): PlanPost[] {
  return assignPostingNumbers(postingSequence(list)).rows.map((r) => ({
    postId: r.postId, number: r.number, from: r.sourceNumber, title: r.title, publishedAt: r.publishedAt,
  }));
}
/** The old series_listing: each number's chosen copy is its earliest post (releases.ts: earliest date wins). */
function oldListing(list: SourceChapter[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const c of postingSequence(list)) if (!m.has(numKey(c.number))) m.set(numKey(c.number), c.sourceId);
  return m;
}
/** A file the v0.48 downloader wrote for number n: the chosen copy's pages, its name as setBookMeta stamped it. */
function landed(list: SourceChapter[], n: number, root = '/dl', over: Partial<PlanBook> = {}): PlanBook {
  const chosen = list.find((c) => c.sourceId === oldListing(list).get(numKey(n)))!;
  return {
    id: `${root}#${n}`, root, file: `Istrevelia/Chapter ${n}.cbz`, number: n, title: `Chapter ${n}`,
    chapterName: chapterName(chosen.title, n), publishedAt: chosen.publishedAt, ...over,
  };
}

test('planRenumber: existing Istrevelia files match their own post', () => {
  const ist = webtoons('istrevelia');
  const posts = postingTarget(ist);
  const numberOf = (title: string) => posts.find((p) => p.title === title)!.number;
  // A file that is NOT the earliest post: its name says which post it is.
  // Reintroduce by matching on the number alone (skip the 'name' pass): it falls to its date and the
  // listing, which both say the earliest post, and lands on post 1.
  const blood = planRenumber([landed(ist, 1, '/dl', { chapterName: chapterName('Episode 1 - Page 5-7 [Blood Warning!] (ch. 1)', 1) })], { mode: 'posting_order', posts }, { listing: oldListing(ist) });
  assert.equal(blood.moves[0].to, numberOf('Episode 1 - Page 5-7 [Blood Warning!]'));
  assert.equal(blood.moves[0].to, 5);
  assert.equal(blood.moves[0].how, 'name');

  // Apocalyptic Horseplay: the file at 1.01 is the SECOND Intermission, not the first.
  const ah = webtoons('apocalypticHorseplay');
  const ahPosts = postingTarget(ah);
  const inter = planRenumber([{ id: 'x', root: '/dl', file: 'AH/Chapter 1.01.cbz', number: 1.01, chapterName: 'Intermission #2 (ch. 1.01)' }], { mode: 'posting_order', posts: ahPosts }, { listing: oldListing(ah) });
  assert.deepEqual([inter.moves[0].to, inter.moves[0].how], [17, 'name']);
  assert.equal(inter.moves[0].file, 'AH/Chapter 17.cbz');

  // The plain case: every file is the earliest post of its number, found by the chapter name it carries.
  const books = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => landed(ist, n));
  const plan = planRenumber(books, { mode: 'posting_order', posts }, { listing: oldListing(ist), floor: null });
  assert.deepEqual(plan.moves.map((m) => [m.from, m.to, m.how]), [[1, 1, 'name'], [2, 21, 'name'], [3, 42, 'name'], [4, 63, 'name'], [5, 85, 'name'], [6, 110, 'name'], [7, 138, 'name'], [8, 212, 'name']]);
  assert.equal(plan.moves[1].file, 'Istrevelia/Chapter 21.cbz');
  assert.equal(plan.moves[1].via, 'rename');
  assert.equal(plan.moves[0].via, 'none', 'chapter 1 is post 1: nothing to do');
  assert.equal(plan.clean, true, plan.reasons.join());
  assert.deepEqual(plan.parked, []);

  // A Replace… with its audit row: the pick is the post, whatever the (wrong, row-stamped) name says.
  const picked = landed(ist, 3, '/dl', { pickedAt: '2026-01-01T00:00:00Z' });
  const pick = planRenumber([picked], { mode: 'posting_order', posts }, { listing: oldListing(ist), picks: new Map([[picked.id, String(10_000 + 46)]]) });
  assert.deepEqual([pick.moves[0].to, pick.moves[0].how], [46, 'pick']);
  // ...and its stamp, once landings carry one, beats everything.
  const stamped = planRenumber([landed(ist, 3, '/dl', { sourceChapterId: String(10_000 + 44) })], { mode: 'posting_order', posts }, {});
  assert.deepEqual([stamped.moves[0].to, stamped.moves[0].how], [44, 'id']);

  // A book at 9, which the source does not list: parked just after the book below it, and never unattended.
  const nine = planRenumber([...books, { id: 'nine', root: '/dl', file: 'Istrevelia/Chapter 9.cbz', number: 9, title: 'Chapter 9' }], { mode: 'posting_order', posts }, { listing: oldListing(ist) });
  assert.deepEqual(nine.parked.map((m) => [m.bookId, m.to, m.file]), [['nine', 212.5, 'Istrevelia/Chapter 212.5.cbz']]);
  assert.equal(nine.clean, false);
  assert.deepEqual(nine.reasons, ['unmatched']);
  assert.deepEqual(nine.extras.map((e) => [e.postId, e.number, e.sourceNumber]), [[`${EXTRA_PREFIX}nine`, 212.5, 9]], 'its slot is reserved');
});

test('planRenumber: a book matched only by the old listing waits for an admin', () => {
  // A Replace… with no audit row: its name and date are the row's, not its pages', so neither is evidence.
  // Reintroduce by counting 'listing' as exact (add it to EXACT): the plan reads clean and would apply itself.
  const ist = webtoons('istrevelia');
  const posts = postingTarget(ist);
  const plan = planRenumber([landed(ist, 3, '/dl', { pickedAt: '2026-01-01T00:00:00Z' })], { mode: 'posting_order', posts }, { listing: oldListing(ist) });
  assert.deepEqual([plan.moves[0].to, plan.moves[0].how], [42, 'listing']);
  assert.equal(plan.clean, false);
  assert.deepEqual(plan.reasons, ['listing_only']);
  // A tracker link or a running download holds any plan.
  const quiet = planRenumber([landed(ist, 2)], { mode: 'posting_order', posts }, { listing: oldListing(ist), tracker: true, busy: true });
  assert.deepEqual(quiet.reasons, ['tracker', 'busy']);
  // A root the server cannot write is renumbered by an override; the file stays where it is.
  const ro = planRenumber([landed(ist, 2, '/library')], { mode: 'posting_order', posts }, { writable: (r) => r !== '/library' });
  assert.deepEqual([ro.moves[0].via, ro.moves[0].to, ro.moves[0].file], ['override', 21, 'Istrevelia/Chapter 2.cbz']);
  // A tombstone moves its row (and its read history) with nothing to rename.
  const gone = planRenumber([landed(ist, 2, '/dl', { pruned: true })], { mode: 'posting_order', posts }, {});
  assert.deepEqual([gone.moves[0].via, gone.moves[0].file], ['row', 'Istrevelia/Chapter 21.cbz']);
});

test('planRenumber: the undo keeps every file', () => {
  // Three posts that all go back to raw 7: the chooser's keeps `Chapter 7.cbz`, the others `(2)`, `(3)`.
  const posts: PlanPost[] = [
    { postId: 'p138', number: 7, from: 138, title: 'E7 - 323-324' },
    { postId: 'p139', number: 7, from: 139, title: 'E7 - 325-326' },
    { postId: 'p140', number: 7, from: 140, title: 'E7 - 327-328' },
    { postId: 'p212', number: 8, from: 212, title: 'E8 - 501-502' },
  ];
  const book = (n: number): PlanBook => ({ id: `b${n}`, root: '/dl', file: `Istrevelia/Chapter ${n}.cbz`, number: n });
  const plan = planRenumber([book(140), book(138), book(139), book(212)], { mode: 'source', posts }, {});
  const files = new Map(plan.moves.map((m) => [m.bookId, m.file]));
  assert.deepEqual(plan.moves.map((m) => m.how), ['stored', 'stored', 'stored', 'stored']);
  assert.equal(files.get('b138'), 'Istrevelia/Chapter 7.cbz', 'the earliest post keeps the plain name');
  assert.equal(files.get('b139'), 'Istrevelia/Chapter 7 (2).cbz');
  assert.equal(files.get('b140'), 'Istrevelia/Chapter 7 (3).cbz');
  assert.equal(files.get('b212'), 'Istrevelia/Chapter 8.cbz');
  // Reintroduce by naming every book renumberedFile(file, n) (drop the (k)): three books on one path.
  assert.equal(new Set(files.values()).size, 4, 'every book keeps its own file');
  for (const f of files.values()) assert.equal(numFromName(f.split('/').pop()!), f.includes('Chapter 8') ? 8 : 7, `${f} still reads back as its number`);
  assert.deepEqual(plan.collisions, [{ root: '/dl', number: 7, bookIds: ['b138', 'b139', 'b140'] }]);
  assert.equal(plan.clean, false, 'shared numbers are for an admin to see');
  // The chooser's pick (ctx.keep) takes the plain name when it is not the earliest.
  const kept = planRenumber([book(138), book(139)], { mode: 'source', posts }, { keep: new Map([[7, 'p139']]) });
  assert.deepEqual(kept.moves.map((m) => m.file), ['Istrevelia/Chapter 7 (2).cbz', 'Istrevelia/Chapter 7.cbz']);
  // Marks go back too: posting 139 -> 7.
  assert.ok(plan.markMap.some(([from, to]) => from === 139 && to === 7));
});

test('planRenumber: the floor follows the renumbering', () => {
  // Reintroduce by keeping chapter_floor as it was: floor 7 in posting numbers would make the sweep backfill
  // posts 7..137, which the 'Latest N' add never wanted, and this assertion fails.
  const ist = webtoons('istrevelia');
  const posts = postingTarget(ist);
  const books = [7, 8].map((n) => landed(ist, n));
  // 'Latest N' from episode 7: the floor becomes the first E7 post.
  assert.equal(planRenumber(books, { mode: 'posting_order', posts }, { floor: 7 }).newFloor, 138);
  // 'Nothing yet' (max + 0.001): still above everything.
  assert.equal(planRenumber(books, { mode: 'posting_order', posts }, { floor: 8.001 }).newFloor, 226.001);
  assert.equal(planRenumber(books, { mode: 'posting_order', posts }, {}).newFloor, null);
  // Marks on ghost numbers move with the listing's copy: raw 4 was post 63.
  const plan = planRenumber(books, { mode: 'posting_order', posts }, { listing: oldListing(ist) });
  assert.ok(plan.markMap.some(([from, to]) => from === 4 && to === 63));
  assert.ok(plan.markMap.some(([from, to]) => from === 7.01 && to === numKey(posts.find((p) => p.title === 'E& - 335-336')!.number)));
});

test('planRenumber: a numbering preference change is remapped by name, across every post', () => {
  // The extension switched to sequential numbering: every post's number changed under the files.
  const ist = webtoons('istrevelia');
  const sequential = webtoonsNumbers(FIXTURE.istrevelia.posts.map((p) => ({ name: p.title })), true);
  const posts: PlanPost[] = FIXTURE.istrevelia.posts.map((p, i) => ({ postId: String(10_000 + p.order), number: sequential[i].chapterNumber, title: sequential[i].name }));
  const books = [1, 2, 3].map((n) => landed(ist, n));
  const plan = planRenumber(books, { mode: 'remap', posts }, { listing: oldListing(ist), floor: 3 });
  assert.deepEqual(plan.moves.map((m) => [m.from, m.to, m.how]), [[1, 1, 'name'], [2, 21, 'name'], [3, 42, 'name']]);
  assert.equal(plan.newFloor, 42, 'the old floor 3 was the first E3 post');
  assert.equal(plan.clean, true, plan.reasons.join());
});

test('renumberedFile keeps the folder and the kind of file', () => {
  assert.equal(renumberedFile('Istrevelia/Chapter 2.cbz', 21), 'Istrevelia/Chapter 21.cbz');
  assert.equal(renumberedFile('Istrevelia/Chapter 2.cbr', 21.5), 'Istrevelia/Chapter 21.5.cbr');
  assert.equal(renumberedFile('Chapter 7.cbz', 7, 2), 'Chapter 7 (2).cbz');
  assert.equal(renumberedFile('Istrevelia/Chapter 3', 42), 'Istrevelia/Chapter 42', 'a folder of images stays a folder name');
  assert.equal(numFromName('Chapter 7 (2).cbz'), 7);
});

test('the numbering logic is pure: nothing it imports reaches the database', () => {
  // The listing layer calls it inside request handlers and the updater, and its tests run without a
  // database; one import of db.ts (or of library.ts, which chapterName used to live in) would change both.
  // Reintroduce by importing chapterName from './library' in postingOrder.ts: this file then does not even
  // load (env.ts demands DATABASE_URL). An import that does load -- `import sharp from 'sharp'` -- is named by
  // the first assertion below.
  const src = join(__dirname, '..', 'src', 'lib');
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*import\s+(?!type\b)[^'"]*from\s+'([^']+)'/gm)) {
      const spec = m[1];
      assert.ok(spec.startsWith('.'), `${file} imports the package ${spec}`);
      walk(join(dirname(file), spec) + '.ts');
    }
  };
  walk(join(src, 'postingOrder.ts'));
  const names = [...seen].map((f) => f.slice(src.length + 1));
  assert.deepEqual(names.sort(), ['naming.ts', 'postingOrder.ts', 'releases.ts']);
});
