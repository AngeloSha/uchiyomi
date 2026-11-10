import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dsn=process.env.TEST_DATABASE_URL;
const dir=mkdtempSync(join(tmpdir(),'uchi-external-'));
if(dsn){process.env.DATABASE_URL=dsn;process.env.JWT_SECRET='external-readers-private-test-key';process.env.CONFIG_DIR=join(dir,'config');process.env.CACHE_DIR=join(dir,'cache');process.env.LIBRARY_BACKEND='owned';}

test('external readers preserve explicit identity, private bookmarks and count-only completions',{skip:!dsn},async t=>{
  const {migrate}=await import('../src/lib/migrate');
  const {q,pool}=await import('../src/lib/db');
  const auth=await import('../src/lib/auth');
  const {partialMd5,rememberKoreaderHash}=await import('../src/lib/koreaderHash');
  const {markReadUpTo}=await import('../src/lib/komgaProgress');
  const {loadTimeline,summarize}=await import('../src/lib/readingTime');
  const {finishedDays,earnedFrames}=await import('../src/lib/badges');
  const Fastify=(await import('fastify')).default;
  await migrate();
  await q("UPDATE lib_series SET is_private=false,owner_user_id=NULL WHERE id LIKE 's_external_test_%'");
  await q("DELETE FROM users WHERE username LIKE 'external_test_%'");
  await q("DELETE FROM lib_series WHERE id LIKE 's_external_test_%'");
  await q("DELETE FROM libraries WHERE id='lib_external_test'");
  const people=await q<{id:string;username:string}>(`INSERT INTO users(username,password_hash,role) VALUES('external_test_a','x','user'),('external_test_b','x','user') RETURNING id,username`);
  const uid=people.find(x=>x.username==='external_test_a')!.id,other=people.find(x=>x.username==='external_test_b')!.id;
  await q("INSERT INTO libraries(id,name,path) VALUES('lib_external_test','External test',$1)",[dir]);
  await q(`INSERT INTO lib_series(id,source,title,folder,library_id,books_count) VALUES('s_external_test_a','T!external','External test','external-a','lib_external_test',8),('s_external_test_private','T!external','Secret external','external-private','lib_external_test',1)`);
  await q("UPDATE lib_series SET owner_user_id=$1,is_private=true WHERE id='s_external_test_private'",[uid]);
  for(let i=1;i<=8;i++){
    writeFileSync(join(dir,`${i}.cbz`),Buffer.from(`PK synthetic identity for chapter ${i} ${'x'.repeat(3000)}`));
    await q(`INSERT INTO lib_books(id,series_id,source,file,root,number,pages,title) VALUES($1,'s_external_test_a','T!external',$2,$3,$4,10,$1)`,[`b_external_test_${i}`,`${i}.cbz`,dir,i]);
  }
  const sharp=(await import('sharp')).default;
  const Zip=require('adm-zip');
  const privateArchive=new Zip();
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#123456'}}).png().toBuffer();
  for(let i=1;i<=10;i++)privateArchive.addFile(String(i).padStart(3,'0')+'.png',image);
  writeFileSync(join(dir,'private.cbz'),privateArchive.toBuffer());
  await q(`INSERT INTO lib_books(id,series_id,source,file,root,number,pages,title) VALUES('b_external_test_private','s_external_test_private','T!external','private.cbz',$1,1,10,'Private')`,[dir]);
  const token=(await auth.issueApiToken(uid,'external-test',['read','write'],null)).token;
  const readonly=(await auth.issueApiToken(uid,'external-read',['read'],null)).token;
  const tokenB=(await auth.issueApiToken(other,'external-other',['read','write'],null)).token;
  const headers={'x-auth-user':token,'x-auth-key':'not-a-password'};
  const app=Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('../src/routes/opds')).default);
  await app.register((await import('../src/routes/komgaCompat')).default);
  await app.register((await import('../src/routes/kosync')).default);
  await app.register((await import('../src/routes/externalReaders')).default);
  const base='/api/v1/kosync';
  const apiHeaders={authorization:`Bearer ${token}`};
  const hash=await partialMd5(join(dir,'1.cbz'));
  await rememberKoreaderHash('b_external_test_1',hash.signature,hash.digest);
  const push=(page:number,h=headers,doc=hash.digest)=>app.inject({method:'PUT',url:base+'/syncs/progress',headers:h,payload:{document:doc,progress:String(page),percentage:page/10,device:'Test e-ink',device_id:'device-a'}});
  try{
    await t.test('official wire auth works with token username, scopes and private cache headers',async()=>{
      const yes=await app.inject({url:base+'/users/auth',headers});assert.equal(yes.statusCode,200);assert.deepEqual(yes.json(),{authorized:'OK'});assert.equal(yes.headers['cache-control'],'private, no-store');
      assert.equal((await app.inject({url:base+'/users/auth'})).statusCode,401);
      assert.equal((await push(1,{'x-auth-user':readonly,'x-auth-key':'dummy'})).statusCode,403);
      assert.equal((await app.inject({url:base+'/syncs/progress/'+'a'.repeat(32),headers})).body,'{}');
      assert.equal((await app.inject({method:'POST',url:base+'/users/create',payload:{username:'new',password:'x'}})).statusCode,403);
    });
    await t.test('settings are opt-in, reject coercion and a readonly token cannot change them',async()=>{
      const start=await app.inject({url:'/api/external-readers',headers:apiHeaders});assert.equal(start.json().externalReadingStats,false);assert.equal(start.json().opdsEstimatedBookmarks,false);
      assert.equal((await app.inject({method:'PUT',url:'/api/external-readers',headers:{authorization:`Bearer ${readonly}`},payload:{externalReadingStats:true}})).statusCode,403);
      assert.equal((await app.inject({method:'PUT',url:'/api/external-readers',headers:apiHeaders,payload:{externalReadingStats:'true'}})).statusCode,400);
      assert.equal((await app.inject({method:'PUT',url:'/api/external-readers',headers:apiHeaders,payload:{externalReadingStats:true}})).statusCode,200);
    });
    await t.test('explicit pages advance, concurrent completion retries count once and backwards sync cannot rewind',async()=>{
      assert.equal((await push(1)).statusCode,200);
      const results=await Promise.all(Array.from({length:4},()=>push(10)));assert.ok(results.every(r=>r.statusCode===200));
      await push(2);
      const rp=(await q('SELECT page,completed FROM read_progress WHERE user_id=$1 AND book_id=$2',[uid,'b_external_test_1']))[0];assert.deepEqual(rp,{page:10,completed:true});
      assert.equal((await q('SELECT * FROM reading_events WHERE user_id=$1',[uid])).length,1);
      const pulled=await app.inject({url:base+'/syncs/progress/'+hash.digest,headers});assert.equal(pulled.json().progress,'10');assert.equal(typeof pulled.json().timestamp,'number');
    });
    await t.test('first Komga binding and bulk catch-up stay silent; only real small transitions count',async()=>{
      await markReadUpTo(uid,'s_external_test_a',2); // first binding is silent
      await markReadUpTo(uid,'s_external_test_a',3); // one real completion
      await markReadUpTo(uid,'s_external_test_a',8); // bulk catch-up is silent
      await markReadUpTo(uid,'s_external_test_a',8); // replay is silent
      const events=await q('SELECT book_id,origin FROM reading_events WHERE user_id=$1 ORDER BY book_id',[uid]);
      assert.deepEqual(events,[{book_id:'b_external_test_1',origin:'koreader'},{book_id:'b_external_test_3',origin:'komga'}]);
    });
    await t.test('external completions add no time, sitting openings, streaks or earned badges',async()=>{
      const now=Date.now(),tl=await loadTimeline(uid,now-60000,now+1000);
      const summary=summarize(tl,now-60000,now+1000,()=>0);assert.equal(summary.ms,0);assert.equal(tl.pieces.length,0);assert.equal(summary.perChapterMs,null);
      assert.deepEqual(await finishedDays(uid),[]);assert.equal((await earnedFrames(uid)).size,0);
      const counts=(await app.inject({url:'/api/external-readers',headers:apiHeaders})).json().byReader;
      assert.equal(counts.reduce((n:number,r:any)=>n+r.chapters,0),2);
    });
    await t.test('EPUB pointers round-trip without invented pages and only an explicit end completes the archive',async()=>{
      writeFileSync(join(dir,'book.epub'),'epub binary identity');
      await q(`INSERT INTO lib_books(id,series_id,source,file,root,number,pages,title) VALUES('b_external_test_epub','s_external_test_a','T!external','book.epub',$1,99,3,'EPUB')`,[dir]);
      const h=await partialMd5(join(dir,'book.epub'));await rememberKoreaderHash('b_external_test_epub',h.signature,h.digest);
      const send=(percentage:number)=>app.inject({method:'PUT',url:base+'/syncs/progress',headers,payload:{document:h.digest,progress:'/body/DocFragment[2]/p[1]',percentage,device:'Test e-ink'}});
      assert.equal((await send(0.5)).statusCode,200);
      assert.equal((await q("SELECT * FROM read_progress WHERE user_id=$1 AND book_id='b_external_test_epub'",[uid])).length,0);
      const saved=(await app.inject({url:base+'/syncs/progress/'+h.digest,headers})).json();assert.equal(saved.progress,'/body/DocFragment[2]/p[1]');assert.equal(saved.percentage,0.5);
      assert.equal((await send(1)).statusCode,200);
      assert.equal((await q("SELECT completed FROM read_progress WHERE user_id=$1 AND book_id='b_external_test_epub'",[uid]))[0].completed,true);
      assert.equal((await q("SELECT * FROM reading_events WHERE user_id=$1 AND book_id='b_external_test_epub'",[uid])).length,1);
    });
    await t.test('private identity, changed files and duplicate hashes never resolve to the wrong book',async()=>{
      const priv=await partialMd5(join(dir,'private.cbz'));await rememberKoreaderHash('b_external_test_private',priv.signature,priv.digest);
      assert.equal((await push(1,{'x-auth-user':tokenB,'x-auth-key':'dummy'},priv.digest)).statusCode,404);
      const opdsA=await auth.issueOpdsToken(uid),opdsB=await auth.issueOpdsToken(other);
      const basic=(value:string)=>({authorization:'Basic '+Buffer.from('reader:'+value).toString('base64')});
      for(const url of ['/opds/series/s_external_test_private','/opds/book/b_external_test_private/file','/opds/book/b_external_test_private/page/0']){
        assert.equal((await app.inject({url,headers:basic(opdsA)})).statusCode,200,url+' owner');
        assert.equal((await app.inject({url,headers:basic(opdsB)})).statusCode,404,url+' other');
      }
      for(const url of ['/api/v1/books/b_external_test_private','/api/v1/books/b_external_test_private/pages','/api/v1/books/b_external_test_private/pages/1']){
        assert.equal((await app.inject({url,headers:{'x-api-key':token}})).statusCode,200,url+' owner');
        assert.equal((await app.inject({url,headers:{'x-api-key':tokenB}})).statusCode,404,url+' other');
      }
      const forged=await app.inject({method:'PUT',url:base+'/syncs/progress',headers:{'x-auth-user':tokenB,'x-auth-key':'dummy'},payload:{document:priv.digest,progress:'/forged/private/pointer',percentage:1,device:'other'}});
      assert.equal(forged.statusCode,404);

      assert.equal((await push(1,headers,priv.digest)).statusCode,200);assert.equal((await push(10,headers,priv.digest)).statusCode,200);
      const event=(await q("SELECT is_private FROM reading_events WHERE user_id=$1 AND book_id='b_external_test_private'",[uid]))[0];assert.equal(event.is_private,true);
      assert.equal((await q("SELECT is_private FROM read_progress WHERE user_id=$1 AND book_id='b_external_test_private'",[uid]))[0].is_private,true);
      await q("UPDATE lib_series SET is_private=false WHERE id='s_external_test_private'");
      assert.equal((await q("SELECT is_private FROM read_progress WHERE user_id=$1 AND book_id='b_external_test_private'",[uid]))[0].is_private,true,'publication never erases private reading provenance');
      await rememberKoreaderHash('b_external_test_2',hash.signature,hash.digest);
      assert.equal((await push(5)).statusCode,404);
      await q("DELETE FROM koreader_hashes WHERE book_id='b_external_test_2'");
      writeFileSync(join(dir,'1.cbz'),'changed');assert.equal((await push(5)).statusCode,404);
      assert.equal((await app.inject({url:base+'/syncs/progress/'+hash.digest,headers})).body,'{}');
    });
    await t.test('default-off completions stay silent and a zero Komga binding allows a later real step',async()=>{
      const h=await partialMd5(join(dir,'6.cbz'));await rememberKoreaderHash('b_external_test_6',h.signature,h.digest);
      const hh={'x-auth-user':tokenB,'x-auth-key':'dummy'};
      await push(1,hh,h.digest);await push(10,hh,h.digest);
      assert.equal((await q('SELECT * FROM reading_events WHERE user_id=$1',[other])).length,0);
      await q(`INSERT INTO app_settings(user_id,data) VALUES($1,'{"externalReadingStats":true}') ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data`,[other]);
      await markReadUpTo(other,'s_external_test_a',0);
      await markReadUpTo(other,'s_external_test_a',1);
      const events=await q('SELECT book_id FROM reading_events WHERE user_id=$1',[other]);
      assert.deepEqual(events,[{book_id:'b_external_test_1'}]);
    });
    await t.test('incognito keeps the place but produces no completion event',async()=>{
      await q(`INSERT INTO app_settings(user_id,data) VALUES($1,'{"incognito":true,"externalReadingStats":true}') ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data`,[other]);
      const h=await partialMd5(join(dir,'4.cbz'));await rememberKoreaderHash('b_external_test_4',h.signature,h.digest);
      const before=(await q('SELECT count(*)::int AS n FROM reading_events WHERE user_id=$1',[other]))[0].n;
      const hh={'x-auth-user':tokenB,'x-auth-key':'dummy'};await push(1,hh,h.digest);await push(10,hh,h.digest);
      assert.equal((await q("SELECT page FROM read_progress WHERE user_id=$1 AND book_id='b_external_test_4'",[other]))[0].page,10);
      assert.equal((await q('SELECT * FROM reading_events WHERE user_id=$1',[other])).length,before);
    });
  }finally{
    await app.close();await q("UPDATE lib_series SET is_private=false,owner_user_id=NULL WHERE id LIKE 's_external_test_%'");await q('DELETE FROM users WHERE id=ANY($1)',[[uid,other]]);await q("DELETE FROM lib_series WHERE id LIKE 's_external_test_%'");await q("DELETE FROM libraries WHERE id='lib_external_test'");await pool.end();rmSync(dir,{recursive:true,force:true});
  }
});
