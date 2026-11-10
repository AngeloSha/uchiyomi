// What backend runs when nobody says.
//
// `OWNED = LIBRARY_BACKEND === 'owned'` meant an unset or misspelled variable chose Komga, whose visibility
// model is "Komga enforces it" -- so viewCtxFor() returned an unrestricted context to every account, on the
// path that governs page bytes and OPDS downloads. Every compose file sets the variable, which is exactly
// why nobody noticed: the env var was the only thing between a typo and a library-wide fail-open.
//
// Reintroduce by restoring `=== 'owned'` in backend.ts and `!== 'owned'` in visibility.ts: both fail.
delete process.env.LIBRARY_BACKEND; // the case under test: nothing set at all
const DSN=process.env.TEST_DATABASE_URL;
if (DSN) process.env.DATABASE_URL=DSN;
else process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=DSN?mkdtempSync(join(tmpdir(),'uchiyomi-backend-default-')):null;
if(root)process.env.CONFIG_DIR=root;
after(async()=>{
  await (await import('../src/lib/db')).pool.end();
  if(root)rmSync(root,{recursive:true,force:true});
});

test('with LIBRARY_BACKEND unset, the owned backend is selected', async () => {
  const { OWNED } = await import('../src/lib/backend');
  assert.equal(OWNED, true);
});

test('with LIBRARY_BACKEND unset, the visibility model is enforced rather than skipped', {skip:DSN?false:'set TEST_DATABASE_URL to run'}, async () => {
  const {migrate}=await import('../src/lib/migrate');
  const {q}=await import('../src/lib/db');
  const {viewCtxFor,seriesVisible}=await import('../src/lib/visibility');
  await migrate();
  const admin=randomUUID(),owner=randomUUID(),series='s_backend_default_'+randomUUID();
  try{
    await q(`INSERT INTO users(id,username,display_name,password_hash,role,auth_kind)
      VALUES($1,$2,'Default admin','x','admin','password'),($3,$4,'Private owner','x','user','password')`,
      [admin,'backend-admin-'+admin,owner,'backend-owner-'+owner]);
    await q(`INSERT INTO lib_series(id,source,title,folder,owner_user_id,is_private)
      VALUES($1,'Fixture','Private default-backend fixture',$1,$2,true)`,[series,owner]);
    // Owned mode honors the preference, and even an admin remains an actual
    // enabled account subject to private ownership. Komga skips that model.
    const ctx=await viewCtxFor(admin,'admin',{hideAdult:true});
    assert.equal(ctx.hideAdultLibraries,true,'the owned model answered, not the "Komga enforces it" branch');
    assert.equal(ctx.userId,admin);
    assert.notEqual(ctx.system,true);
    assert.equal(await seriesVisible(series,ctx),false,'admin status never grants another account private content');
    assert.equal(await seriesVisible(series,await viewCtxFor(owner,'user')),true);
    await q('UPDATE users SET disabled=true WHERE id=$1',[admin]);
    const disabled=await viewCtxFor(admin,'admin',{hideAdult:true});
    assert.deepEqual(disabled.libraryIds,[],'disabled authority stays denied even when an old token says admin');
    assert.equal(disabled.maxAgeRating,0);
  }finally{
    await q('DELETE FROM lib_series WHERE id=$1',[series]);
    await q('DELETE FROM private_resource_owners WHERE owner_user_id=ANY($1::uuid[])',[[admin,owner]]);
    await q('DELETE FROM users WHERE id=ANY($1::uuid[])',[[admin,owner]]);
  }
});
