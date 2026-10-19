// Chapter comments and reactions (v0.87.0, routes/comments.ts, lib/comments.ts).
//
// The routes are mounted for real (the route-testing gap: a correct function behind a wrongly wired route goes unseen
// from the lib alone). What this file holds to:
// - talk about a series is seen only by those who may open it: a member without the library, or under an age cap the
//   series is over, gets the 404 a missing chapter gets, on every route, and nothing they send is written;
// - one reaction a member a chapter, from the six;
// - only its author edits a comment; its author or an admin deletes it, and an admin's removal is audited;
// - Incognito reading reads the talk but cannot add to it;
// - a server with one member has nobody to talk to (`on`);
// - a new comment reaches only the members already in that chapter's conversation.
//
// Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const MAIN_LIB = 'lib_cmt_main';
const OTHER_LIB = 'lib_cmt_other';
const OPEN = 's_cmt_open';
const ADULT = 's_cmt_adult';
const QUIET = 's_cmt_quiet';
const SERIES = [OPEN, ADULT, QUIET];
const BOOK = `b_${OPEN}_1`;
const BOOK2 = `b_${OPEN}_2`;
const ADULT_BOOK = `b_${ADULT}_1`;
const USERS = ['cmt-alice', 'cmt-bob', 'cmt-carol', 'cmt-dave', 'cmt-admin'];

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const commentRoutes = (await import('../src/routes/comments')).default;
  const comments = await import('../src/lib/comments');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;

  await migrate();
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[MAIN_LIB, OTHER_LIB]]).catch(() => {});
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'Main', '/main'), ($2, 'Other', '/other')`, [MAIN_LIB, OTHER_LIB]);

  for (const [id, rating] of [[OPEN, null], [ADULT, 18], [QUIET, null]] as const) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, age_rating) VALUES ($1,'T!cmt',$1,$2,2,$3,$4)`,
      [id, `T!cmt/${id}`, MAIN_LIB, rating]);
    for (const n of [1, 2]) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1,$2,'T!cmt',$3,$4,$5,20)`,
        [`b_${id}_${n}`, id, `T!cmt/${id}/ch${n}.cbz`, n, `Chapter ${n}`]);
    }
  }
  const ids: Record<string, string> = {};
  for (const u of USERS) {
    const row = await one<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, auth_kind, avatar)
       VALUES ($1, $2, 'x', $3, 'password', $4) RETURNING id`,
      [u, u.replace('cmt-', '').replace(/^./, (c) => c.toUpperCase()), u === 'cmt-admin' ? 'admin' : 'user', JSON.stringify({ emoji: '🦊', color: '#7c5cff' })]);
    ids[u] = row!.id;
  }
  // Carol may open the other library only; Dave is capped at 13.
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [ids['cmt-carol'], OTHER_LIB]);
  await q('UPDATE users SET max_age_rating = 13 WHERE id = $1', [ids['cmt-dave']]);
  comments.resetTalkOn();

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(commentRoutes);
  await app.ready();
  const as = (u: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: ids[u], role: u === 'cmt-admin' ? 'admin' : 'user' })}` });
  return { app, q, one, ids, as, comments };
}

test('chapter comments and reactions', { skip }, async (t) => {
  const { app, q, one, ids, as, comments } = await setup();
  const post = (u: string, book: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/books/${book}/comments`, headers: as(u), payload: payload as any });
  const talk = (u: string, book: string) => app.inject({ method: 'GET', url: `/api/books/${book}/comments`, headers: as(u) });
  const react = (u: string, book: string, emoji: unknown) =>
    app.inject({ method: 'PUT', url: `/api/books/${book}/reaction`, headers: as(u), payload: { emoji } as any });
  const commentsOf = async (book: string) => (await q<{ n: number }>('SELECT count(*)::int AS n FROM chapter_comments WHERE book_id = $1', [book]))[0].n;

  try {
    await t.test('a comment round-trips, named and marked as whose', async () => {
      const r = await post('cmt-alice', BOOK, { body: '  that ending!!  ', page: 12 });
      assert.equal(r.statusCode, 201, r.body);
      const made = r.json();
      assert.equal(made.body, 'that ending!!', 'trimmed');
      assert.equal(made.page, 12);
      assert.equal(made.mine, true);
      const seen = (await talk('cmt-bob', BOOK)).json();
      assert.equal(seen.comments.length, 1);
      assert.equal(seen.comments[0].body, 'that ending!!');
      assert.equal(seen.comments[0].mine, false, 'Bob did not write it');
      assert.equal(seen.comments[0].user.name, 'Alice');
      assert.deepEqual(seen.comments[0].user.avatar, { emoji: '🦊', color: '#7c5cff' });
      assert.equal(seen.comments[0].page, 12);
      assert.equal(seen.comments[0].editedAt, null);
    });

    await t.test('a comment is plain text of 1 to 2000 characters', async () => {
      const before = await commentsOf(BOOK);
      for (const body of ['', '   ', 'x'.repeat(2001), '😂'.repeat(2001), 42]) {
        assert.equal((await post('cmt-alice', BOOK, { body })).statusCode, 400, `body ${JSON.stringify(body).slice(0, 20)}`);
      }
      assert.equal((await post('cmt-alice', BOOK, { body: 'ok', page: 0 })).statusCode, 400, 'a page is from 1');
      assert.equal(await commentsOf(BOOK), before, 'nothing refused was written');
      // An emoji is one character: two thousand of them fit.
      const r = await post('cmt-alice', BOOK2, { body: '😂'.repeat(2000) });
      assert.equal(r.statusCode, 201, r.body);
      await q('DELETE FROM chapter_comments WHERE id = $1', [r.json().id]);
    });

    await t.test('one reaction a member a chapter: another one replaces it, and it can be taken back', async () => {
      assert.equal((await react('cmt-bob', BOOK, '😂')).statusCode, 200);
      assert.equal((await react('cmt-bob', BOOK, '🔥')).statusCode, 200);
      const rows = await q<{ emoji: string }>('SELECT emoji FROM chapter_reactions WHERE book_id = $1 AND user_id = $2', [BOOK, ids['cmt-bob']]);
      assert.deepEqual(rows.map((r) => r.emoji), ['🔥'], 'one row, the newer emoji');
      assert.equal((await react('cmt-bob', BOOK, '👎')).statusCode, 400, 'only the six');
      assert.equal((await react('cmt-bob', BOOK, '❤')).statusCode, 400, 'the heart without its emoji presentation is not the heart offered');
      const seen = (await talk('cmt-alice', BOOK)).json();
      assert.deepEqual(seen.reactions.map((r: any) => [r.user.name, r.emoji, r.mine]), [['Bob', '🔥', false]]);
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/books/${BOOK}/reaction`, headers: as('cmt-bob') })).statusCode, 200);
      assert.equal((await talk('cmt-alice', BOOK)).json().reactions.length, 0);
      await react('cmt-bob', BOOK, '😂');
    });

    await t.test('only its author edits a comment', async () => {
      const id = (await talk('cmt-alice', BOOK)).json().comments[0].id;
      const theirs = await app.inject({ method: 'PATCH', url: `/api/comments/${id}`, headers: as('cmt-bob'), payload: { body: 'hijacked' } });
      assert.equal(theirs.statusCode, 404, "someone else's comment reads as none at all");
      // Not even an admin: words under someone's name stay theirs.
      assert.equal((await app.inject({ method: 'PATCH', url: `/api/comments/${id}`, headers: as('cmt-admin'), payload: { body: 'moderated' } })).statusCode, 404);
      assert.equal((await one<{ body: string }>('SELECT body FROM chapter_comments WHERE id = $1', [id]))!.body, 'that ending!!');
      const mine = await app.inject({ method: 'PATCH', url: `/api/comments/${id}`, headers: as('cmt-alice'), payload: { body: 'that ending!!! (edited)' } });
      assert.equal(mine.statusCode, 200, mine.body);
      const seen = (await talk('cmt-bob', BOOK)).json().comments[0];
      assert.equal(seen.body, 'that ending!!! (edited)');
      assert.ok(seen.editedAt, 'it says it was edited');
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/comments/not-a-uuid', headers: as('cmt-alice'), payload: { body: 'x' } })).statusCode, 404);
    });

    await t.test("a member cannot delete someone else's comment; an admin removes it, and it is audited", async () => {
      const made = (await post('cmt-bob', BOOK, { body: 'bob was here' })).json();
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${made.id}`, headers: as('cmt-alice') })).statusCode, 404);
      assert.ok(await one('SELECT 1 FROM chapter_comments WHERE id = $1', [made.id]), 'still there');
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${made.id}`, headers: as('cmt-admin') })).statusCode, 200);
      assert.equal(await one('SELECT 1 FROM chapter_comments WHERE id = $1', [made.id]), null, 'removed');
      const audit = await one<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'comment.remove' AND detail->>'comment' = $1`, [made.id]);
      assert.ok(audit, 'the removal is in the audit log');
      assert.equal(audit!.detail.author, ids['cmt-bob']);
      // Its author deletes their own, unaudited.
      const own = (await post('cmt-bob', BOOK, { body: 'never mind' })).json();
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${own.id}`, headers: as('cmt-bob') })).statusCode, 200);
      assert.equal(await one(`SELECT 1 FROM audit_log WHERE event = 'comment.remove' AND detail->>'comment' = $1`, [own.id]), null);
    });

    await t.test('THE RULE: a member without the library gets a 404 everywhere, and nothing is written', async () => {
      // Reintroduce by resolving the chapter under SYSTEM_CTX instead of the caller's view (chapterOf in
      // routes/comments.ts): Carol reads Alice's comment and writes her own.
      const before = await commentsOf(BOOK);
      assert.equal((await talk('cmt-carol', BOOK)).statusCode, 404);
      assert.equal((await post('cmt-carol', BOOK, { body: 'peek' })).statusCode, 404);
      assert.equal((await react('cmt-carol', BOOK, '😂')).statusCode, 404);
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/books/${BOOK}/reaction`, headers: as('cmt-carol') })).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: `/api/series/${OPEN}/comments`, headers: as('cmt-carol') })).statusCode, 404);
      const id = (await talk('cmt-alice', BOOK)).json().comments[0].id;
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${id}`, headers: as('cmt-carol') })).statusCode, 404);
      assert.equal(await commentsOf(BOOK), before);
      assert.equal(await one('SELECT 1 FROM chapter_reactions WHERE user_id = $1', [ids['cmt-carol']]), null);
      // The same 404 as a chapter that does not exist.
      assert.equal((await talk('cmt-alice', 'b_cmt_nope')).statusCode, 404);
    });

    await t.test("THE RULE: an age cap hides an 18+ series' talk", async () => {
      assert.equal((await post('cmt-alice', ADULT_BOOK, { body: 'grown-up talk' })).statusCode, 201);
      assert.equal((await talk('cmt-dave', ADULT_BOOK)).statusCode, 404);
      assert.equal((await post('cmt-dave', ADULT_BOOK, { body: 'me too' })).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: `/api/series/${ADULT}/comments`, headers: as('cmt-dave') })).statusCode, 404);
      // The same member reads the talk of a series under the cap.
      assert.equal((await talk('cmt-dave', BOOK)).statusCode, 200);
    });

    await t.test('Incognito reading reads the talk but cannot add to it', async () => {
      await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{"incognito": true}'::jsonb)
               ON CONFLICT (user_id) DO UPDATE SET data = app_settings.data || '{"incognito": true}'::jsonb`, [ids['cmt-bob']]);
      try {
        const before = await commentsOf(BOOK);
        const r = await post('cmt-bob', BOOK, { body: 'read it on the sly' });
        assert.equal(r.statusCode, 403);
        assert.equal(r.json().error, 'incognito');
        assert.equal(await commentsOf(BOOK), before, 'nothing written');
        const x = await react('cmt-bob', BOOK, '🤯');
        assert.equal(x.statusCode, 403);
        assert.equal((await one<{ emoji: string }>('SELECT emoji FROM chapter_reactions WHERE book_id = $1 AND user_id = $2', [BOOK, ids['cmt-bob']]))!.emoji, '😂', 'the reaction is unchanged');
        assert.equal((await talk('cmt-bob', BOOK)).statusCode, 200, 'reading the talk records nothing, and is open');
        // Taking a reaction back reveals nothing new.
        assert.equal((await app.inject({ method: 'DELETE', url: `/api/books/${BOOK}/reaction`, headers: as('cmt-bob') })).statusCode, 200);
      } finally {
        await q(`UPDATE app_settings SET data = data - 'incognito' WHERE user_id = $1`, [ids['cmt-bob']]);
      }
      assert.equal((await react('cmt-bob', BOOK, '😂')).statusCode, 200, 'and once it is off, reacting works again');
    });

    await t.test("the series page's counts", async () => {
      await react('cmt-alice', BOOK, '😂');
      await react('cmt-dave', BOOK, '❤️');
      await post('cmt-dave', BOOK2, { body: 'second chapter' });
      const r = await app.inject({ method: 'GET', url: `/api/series/${OPEN}/comments`, headers: as('cmt-bob') });
      assert.equal(r.statusCode, 200);
      const byBook = new Map(r.json().content.map((x: any) => [x.bookId, x]));
      assert.deepEqual(byBook.get(BOOK), { bookId: BOOK, comments: 1, reactions: 3, top: ['😂', '❤️'] }, 'two 😂 lead, then ❤️');
      assert.deepEqual(byBook.get(BOOK2), { bookId: BOOK2, comments: 1, reactions: 0, top: [] });
      assert.equal(r.json().content.length, 2, 'only chapters with talk');
      const quiet = await app.inject({ method: 'GET', url: `/api/series/${QUIET}/comments`, headers: as('cmt-bob') });
      assert.deepEqual(quiet.json().content, []);
    });

    await t.test('a server with one member has nobody to talk to', async () => {
      comments.resetTalkOn();
      assert.equal((await talk('cmt-alice', BOOK)).json().on, true, 'five members here');
      const others = await q<{ id: string; disabled: boolean }>('SELECT id, disabled FROM users WHERE id <> $1', [ids['cmt-alice']]);
      await q('UPDATE users SET disabled = true WHERE id <> $1', [ids['cmt-alice']]);
      try {
        comments.resetTalkOn();
        assert.equal((await talk('cmt-alice', BOOK)).json().on, false, 'the others are switched off: nobody to talk to');
      } finally {
        for (const o of others) await q('UPDATE users SET disabled = $2 WHERE id = $1', [o.id, o.disabled]);
        comments.resetTalkOn();
      }
      assert.equal((await talk('cmt-alice', BOOK)).json().on, true);
    });

    await t.test('a new comment reaches only the conversation', async () => {
      // Carol commented while she could still open the library, and has since lost it; Dave never commented here.
      await q('DELETE FROM user_libraries WHERE user_id = $1', [ids['cmt-carol']]);
      assert.equal((await post('cmt-carol', BOOK, { body: 'carol was here' })).statusCode, 201);
      await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [ids['cmt-carol'], OTHER_LIB]);
      await post('cmt-bob', BOOK, { body: 'agreed' });
      const to = await comments.conversationRecipients(BOOK, ids['cmt-alice']);
      assert.deepEqual(to, [ids['cmt-bob']], 'Bob only: not the author, not Carol who lost the library, not Dave who never spoke');
      // A disabled member hears nothing either.
      await q('UPDATE users SET disabled = true WHERE id = $1', [ids['cmt-bob']]);
      try {
        assert.deepEqual(await comments.conversationRecipients(BOOK, ids['cmt-alice']), []);
      } finally {
        await q('UPDATE users SET disabled = false WHERE id = $1', [ids['cmt-bob']]);
      }
      const push = comments.conversationPush({ seriesId: OPEN, seriesTitle: 'Solo', chapter: '11', bookId: BOOK, author: 'Alice', body: 'a\n\nb ' + 'x'.repeat(300) });
      assert.equal(push.title, 'Solo · Chapter 11');
      assert.ok(push.body.startsWith('Alice: a b '), 'one line');
      assert.ok(push.body.length <= 'Alice: '.length + 140, 'cut to fit a notification');
      assert.equal(push.url, `/series/?id=${OPEN}&comments=${BOOK}`);
    });

    await t.test("a member's words go with their account", async () => {
      assert.ok((await commentsOf(BOOK)) > 0);
      await q('DELETE FROM users WHERE id = $1', [ids['cmt-bob']]);
      assert.equal(await one('SELECT 1 FROM chapter_comments WHERE user_id = $1', [ids['cmt-bob']]), null);
      assert.equal(await one('SELECT 1 FROM chapter_reactions WHERE user_id = $1', [ids['cmt-bob']]), null);
    });
  } finally {
    await app.close();
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = ANY($1)', [[MAIN_LIB, OTHER_LIB]]).catch(() => {});
  }
});
