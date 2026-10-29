// Real PostgreSQL/API/filesystem lifecycle checks; deterministic local model outputs do not claim extraction accuracy.
import test,{before,after,beforeEach}from'node:test';
import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{mkdir,writeFile,rm,readdir}from'node:fs/promises';
import type{CoverTitleQualityResult}from'../src/lib/coverTitleQuality';
const DSN=process.env.TEST_DATABASE_URL,ROOT=join(tmpdir(),'uchiyomi-cover-batch-'+process.pid),LIB='cover-batch-int';
if(DSN){Object.assign(process.env,{DATABASE_URL:DSN,CONFIG_DIR:ROOT,CACHE_DIR:join(ROOT,'cache'),LIBRARY_ROOT:join(ROOT,'library'),DL_ROOT:join(ROOT,'dl'),JWT_SECRET:'cover-batch-test-secret-longer-than16',LIBRARY_BACKEND:'owned',UCHIYOMI_PING_URL:'',TITLE_EXTRACTOR_URL:''});}
const skip=DSN?false:'set TEST_DATABASE_URL',SID=(n=0)=>'s_cover_batch_'+n,BASE='/api/admin/title-extraction/batch';
let q:any,pool:any,app:any,core:typeof import('../src/lib/titleExtraction'),batch:typeof import('../src/lib/titleExtractionBatch'),art:typeof import('../src/lib/titleArt');
let sharp:typeof import('sharp').default,artFile:typeof import('../src/lib/seriesArt').artFile,cover:Buffer,candidate:Buffer,admin:string,member:string,adminId:string,calls=0,externalCalls=0;
const originalFetch=globalThis.fetch;
const quality=(available=false):CoverTitleQualityResult=>({policyVersion:'strict-v1',safeToApply:false,availableChecksPassed:available,manualApplyAllowed:true,needsReview:true,
 reasons:[{code:'automatic_verification_unvalidated',severity:'warning'}],sourceTitleMatched:available,candidateTitleMatched:available,matchedAlias:available?'Fixture title':null});
const request=(method:string,url:string,payload?:any,token=admin)=>app.inject({method,url,headers:{authorization:'Bearer '+token},...(payload===undefined?{}:{payload})});
const status=async()=>(await request('GET',BASE+'/status')).json();
const root=(n=0)=>`/api/admin/series/${SID(n)}/title-extraction`;
const worker=async(bytes:Buffer,selection:any)=>{calls++;const meta=await sharp(bytes).metadata();return{bytes:candidate,sourceSha256:createHash('sha256').update(bytes).digest('hex'),width:100,height:30,sourceWidth:meta.width!,sourceHeight:meta.height!,
 region:selection.region??{left:0,top:.3,width:1,height:.5},candidateRegion:{left:.2,top:.5,width:.5,height:30/280},ms:1,modelFingerprint:'a'.repeat(64),evidence:{maskScore:.9,foregroundFraction:.2,edgeInkFraction:0,maskRetainedFraction:1,foregroundChangedFraction:0}};};
async function series(count:number){
 const ids=Array.from({length:count},(_,n)=>SID(n));
 await q(`INSERT INTO lib_series(id,source,title,folder,books_count,library_id)SELECT id,'T!batch','Fixture title',id,0,$2 FROM unnest($1::text[]) id ON CONFLICT(id)DO NOTHING`,[ids,LIB]);
 await q(`INSERT INTO series_overrides(series_id,cover)SELECT id,'upload' FROM unnest($1::text[])id ON CONFLICT(series_id)DO NOTHING`,[ids]);
 await Promise.all(ids.map(id=>writeFile(artFile(id,'cover'),cover)));
}
async function run(body:any={}){const r=await request('POST',BASE+'/run',body);assert.equal(r.statusCode,202,r.body);return r.json().run.id as string;}
async function settle(){await batch.titleExtractionBatchSettled();await core.titleExtractionsSettled();}
async function startedWithin(p:Promise<void>){let timer:ReturnType<typeof setTimeout>;try{await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('worker did not enter')),5000);timer.unref();})]);}finally{clearTimeout(timer!);}}
before(async()=>{
 if(!DSN)return;globalThis.fetch=(async()=>{externalCalls++;throw Error('No external lookup allowed in batch tests');})as typeof fetch;
 sharp=(await import('sharp')).default;({q,pool}=await import('../src/lib/db'));await(await import('../src/lib/migrate')).migrate();
 core=await import('../src/lib/titleExtraction');batch=await import('../src/lib/titleExtractionBatch');art=await import('../src/lib/titleArt');({artFile}=await import('../src/lib/seriesArt'));
 await mkdir(join(ROOT,'series-art'),{recursive:true});cover=await sharp({create:{width:200,height:280,channels:3,background:'#58456c'}}).png().toBuffer();
 const stroke=await sharp({create:{width:25,height:15,channels:4,background:'#fff9'}}).png().toBuffer();candidate=await sharp({create:{width:100,height:30,channels:4,background:'#00000000'}}).composite([{input:stroke,left:5,top:5},{input:stroke,left:65,top:5}]).png().toBuffer();
 // Make actual alpha include fully opaque source pixels, as required by the worker output contract.
 candidate=await sharp({create:{width:100,height:30,channels:4,background:'#00000000'}}).composite([{input:await sharp({create:{width:25,height:15,channels:4,background:'#ffdd88ff'}}).png().toBuffer(),left:5,top:5},{input:await sharp({create:{width:25,height:15,channels:4,background:'#ffdd88ff'}}).png().toBuffer(),left:65,top:5}]).png().toBuffer();
 await q(`INSERT INTO libraries(id,name,path,anilist_lookup)VALUES($1,'Batch fixtures',$1,true)ON CONFLICT(id)DO NOTHING`,[LIB]);
 const F=(await import('fastify')).default;app=F();await app.register((await import('@fastify/cookie')).default);await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
 await q("DELETE FROM users WHERE username LIKE 'cover-batch-%'");
 for(const[name,role]of[['admin','admin'],['member','user']]){const[u]=await q("INSERT INTO users(username,display_name,password_hash,role)VALUES($1,$1,'x',$2)RETURNING id",['cover-batch-'+name,role]);const token=app.jwt.sign({sub:u.id,role});if(role==='admin'){admin=token;adminId=u.id;}else member=token;}
 await app.register((await import('../src/routes/admin')).default);await app.ready();
});
beforeEach(async()=>{
 if(!DSN)return;batch.stopTitleExtractionBatch();core.stopTitleExtractions();await settle();
 await q('DELETE FROM title_extraction_runs');
 const old=await q('SELECT id FROM lib_series WHERE library_id=$1',[LIB]);for(const{id}of old)await core.dropTitleExtractions(id);
 await q('DELETE FROM lib_series WHERE library_id=$1',[LIB]);
 await q('UPDATE server_settings SET automatic_cover_title_generation=false,automatic_cover_title_apply=false,automatic_cover_titles=false,automatic_title_logos=false,cover_title_next_run_at=NULL WHERE id=1');
 await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1',[LIB]);
 await series(1);await q("INSERT INTO series_trackers(series_id,provider,external_id,checked_at)VALUES($1,'anilist','87216',now())",[SID()]);
 await q("INSERT INTO series_other_titles(series_id,anilist_id,english,romaji)VALUES($1,'87216','Fixture title','Fixture title')",[SID()]);
 core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async()=>quality(),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)})});
 batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64)});await core.initializeTitleExtractions();await batch.initializeTitleExtractionBatch();calls=0;externalCalls=0;
});
after(async()=>{
 if(DSN){batch.stopTitleExtractionBatch();core.stopTitleExtractions();await settle();await app.close();await q('DELETE FROM title_extraction_runs');await q('DELETE FROM lib_series WHERE library_id=$1',[LIB]);await q('DELETE FROM libraries WHERE id=$1',[LIB]);await q("DELETE FROM users WHERE username LIKE 'cover-batch-%'");await q('UPDATE server_settings SET automatic_cover_title_generation=false,automatic_cover_title_apply=false,cover_title_next_run_at=NULL WHERE id=1');batch.setTitleExtractionBatchForTests();core.setTitleExtractionForTests();await pool.end();}
 globalThis.fetch=originalFetch;await rm(ROOT,{recursive:true,force:true});
});

test('status is read-only/admin-only and switches are default-off with distinct checked capability',{skip},async()=>{
 assert.equal((await app.inject({method:'GET',url:BASE+'/status'})).statusCode,401);assert.equal((await request('GET',BASE+'/status',undefined,member)).statusCode,403);
 const before=await q('SELECT count(*)::int n FROM title_extraction_runs'),s=await status();assert.equal(s.enabled,false);assert.equal(s.applyEnabled,false);assert.equal(s.running,false);assert.equal(s.schedule.hour,3);assert.equal(s.schedule.nextRunAt,null);assert.equal(s.run,null);
 assert.deepEqual(await q('SELECT count(*)::int n FROM title_extraction_runs'),before);assert.equal(calls,0);assert.equal(externalCalls,0);
 const cap=(await request('GET','/api/admin/title-extraction/capabilities')).json();assert.equal(cap.checkedApplyAvailable,true);assert.equal(cap.automaticApplyAvailable,false);
 assert.equal((await request('POST',BASE+'/run',{anything:true})).statusCode,400);assert.equal((await request('POST',BASE+'/cancel',{runId:'bad'})).statusCode,400);
 assert.equal((await request('POST',BASE+'/run',{},member)).statusCode,403);
});

test('a persisted run covers more than32 series with immediate refill and manual extraction priority',{skip},async()=>{
 await series(41);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});const order:string[]=[];
 core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)}),worker:async(bytes,selection)=>{
  order.push(selection.region?'manual':'batch');if(order.length===1){entered();await gate;}return worker(bytes,selection);
 }});
 try{
  await run();await startedWithin(started);await series(42);const manual=await request('POST',root(41),{region:{left:0,top:0,width:1,height:1}});assert.equal(manual.statusCode,202,manual.body);
 }finally{release();}await settle();
 const s=await status();assert.equal(s.run.status,'completed');assert.equal(s.run.counts.total,41);assert.equal(s.run.counts.ready,41);assert.equal(calls,42);assert.deepEqual(order.slice(0,2),['batch','manual']);
 assert.equal(s.reviewCount,41);assert.equal(s.reviewSeries.length,10);assert.equal(externalCalls,0);
 const[retained]=await q("SELECT count(*)::int n,min(expires_at-created_at)>interval '13 days' long_lived FROM series_title_extractions WHERE batch_item_id IS NOT NULL");assert.equal(retained.n,41);assert.equal(retained.long_lived,true);
});

test('unchanged expired previews do not loop; nightly catches new series and changed cover bytes',{skip},async()=>{
 await run();await settle();assert.equal(calls,1);await q("UPDATE series_title_extractions SET expires_at=now()-interval '1 second'");await core.cleanupTitleExtractions();
 await run();await settle();assert.equal(calls,1);assert.equal((await status()).run.counts.skipped,1);
 await series(2);await q("UPDATE server_settings SET automatic_cover_title_generation=true,cover_title_next_run_at=now()-interval '1 minute' WHERE id=1");
 await batch.titleExtractionBatchTick();await settle();let s=await status();assert.equal(s.run.origin,'nightly');assert.equal(s.run.counts.total,2);assert.equal(s.run.counts.ready,1);assert.equal(s.run.counts.skipped,1);assert.equal(calls,2);assert.ok(new Date(s.schedule.nextRunAt).getTime()>Date.now());
 const changed=await sharp({create:{width:200,height:280,channels:3,background:'#ccbbaa'}}).png().toBuffer();await writeFile(artFile(SID(),'cover'),changed);
 await run();await settle();assert.equal(calls,3,'same database selection with changed actual bytes must be processed');s=await status();assert.equal(s.run.counts.ready,1);assert.equal(s.run.counts.skipped,1);
});

test('restart resumes pending work and recovers committed ready drafts without duplicate inference',{skip},async()=>{
 batch.stopTitleExtractionBatch();const runId=await run();assert.equal(calls,0);assert.equal((await status()).run.counts.pending,1);
 await batch.initializeTitleExtractionBatch();batch.wakeTitleExtractionBatch();await settle();assert.equal(calls,1);let s=await status();assert.equal(s.run.status,'completed');
 await q("UPDATE title_extraction_runs SET status='running',finished_at=NULL WHERE id=$1",[runId]);await q("UPDATE title_extraction_items SET status='processing' WHERE run_id=$1",[runId]);await q('DELETE FROM series_title_extraction_history');
 await batch.initializeTitleExtractionBatch();batch.wakeTitleExtractionBatch();await settle();s=await status();assert.equal(s.run.status,'completed');assert.equal(s.run.counts.ready,1);assert.equal(calls,1);assert.equal((await q('SELECT count(*)::int n FROM series_title_extraction_history'))[0].n,1);
});

test('cancelling a run aborts only its active system job and retains existing manual previews',{skip},async()=>{
 const manual=await request('POST',root(),{});assert.equal(manual.statusCode,202);await core.titleExtractionsSettled();const manualId=manual.json().job.id;await series(3);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),worker:async(bytes,selection)=>{entered();await gate;return worker(bytes,selection);}});
 try{const id=await run();await startedWithin(started);assert.equal((await request('POST',BASE+'/cancel',{runId:id})).statusCode,200);}
 finally{release();}await settle();const s=await status();assert.equal(s.run.status,'cancelled');assert.equal(s.run.counts.skipped,1);assert.equal(s.run.counts.cancelled,2);
 assert.equal((await request('GET',root()+'/'+manualId)).json().job.status,'ready');assert.equal((await art.titleArtsFor([SID()])).get(SID())!.logoUrl,null);
});

test('local generation ignores external-lookup opt-out, never warms aliases and preserves manual/first-page/provider choices',{skip},async()=>{
 await series(6);await q('UPDATE libraries SET anilist_lookup=false WHERE id=$1',[LIB]);await q('DELETE FROM series_other_titles');
 await request('PUT',`/api/admin/series/${SID(1)}/art`,{kind:'logo',mode:'upload',dataUrl:'data:image/png;base64,'+candidate.toString('base64')});await request('PUT',`/api/admin/series/${SID(2)}/art`,{kind:'logo',mode:'text'});
 await request('PUT',`/api/admin/series/${SID(3)}/art`,{kind:'cover',mode:'first_page'});
 await q("INSERT INTO series_trackers(series_id,provider,external_id,checked_at)VALUES($1,'anilist','12345',now())",[SID(4)]);
 art.setTitleLogoLookupForTests(async()=>({kind:'found',candidate:{bytes:candidate,language:'en',showReadableTitle:false,attribution:{provider:'wikimedia',pageUrl:'https://commons.wikimedia.org/wiki/File:Fixture.png',fileName:'Fixture.png',author:null,license:'Public domain',licenseUrl:null}}}));art.setTitleLogoQueuePaceForTests(0);
 try{await art.queueTitleLogos([SID(4)],'manual');await art.titleLogoQueueSettled();}finally{art.setTitleLogoLookupForTests();art.setTitleLogoQueuePaceForTests();}
 const original=await art.titleArtsFor([SID(1),SID(2),SID(4)]);await run();await settle();const s=await status();assert.equal(s.run.counts.total,6);assert.equal(s.run.counts.skipped,4);assert.equal(s.run.counts.ready,2);assert.equal(calls,2);assert.equal(externalCalls,0);
 const after=await art.titleArtsFor([SID(1),SID(2),SID(4)]);for(const id of original.keys())assert.deepEqual(after.get(id),original.get(id));
});

test('a batch outcome survives applied-row cleanup while an unrelated manual job still holds the worker',{skip},async()=>{
 await q('UPDATE server_settings SET automatic_cover_title_generation=true,automatic_cover_title_apply=true WHERE id=1');
 let firstEntered!:()=>void,releaseFirst!:()=>void,manualEntered!:()=>void,releaseManual!:()=>void;
 const first=new Promise<void>(r=>{firstEntered=r;}),firstGate=new Promise<void>(r=>{releaseFirst=r;}),manual=new Promise<void>(r=>{manualEntered=r;}),manualGate=new Promise<void>(r=>{releaseManual=r;});let index=0;
 core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(true),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)}),worker:async(bytes,selection)=>{
  if(index++===0){firstEntered();await firstGate;}else if(selection.region){manualEntered();await manualGate;}return worker(bytes,selection);
 }});
 try{
  await run();await startedWithin(first);await series(2);const own=await request('POST',root(1),{region:{left:0,top:0,width:1,height:1}});assert.equal(own.statusCode,202,own.body);
  releaseFirst();await startedWithin(manual);await core.cleanupTitleExtractions();
  const s=await status();assert.equal(s.run.status,'completed');assert.equal(s.run.counts.applied,1);assert.equal((await q('SELECT count(*)::int n FROM series_title_extraction_history'))[0].n,1);
  assert.equal((await q("SELECT count(*)::int n FROM series_title_extractions WHERE batch_item_id IS NOT NULL AND status='applied'"))[0].n,0,'cleaned row cannot erase durable outcome');
 }finally{releaseFirst();releaseManual();}await settle();assert.equal(calls,2);assert.equal((await status()).run.counts.applied,1);
});

test('manual preview intent on the same series wins over an in-flight automatic publication',{skip},async()=>{
 await q('UPDATE server_settings SET automatic_cover_title_generation=true,automatic_cover_title_apply=true WHERE id=1');let entered!:()=>void,release!:()=>void;
 const first=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let index=0;
 core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(true),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)}),worker:async(bytes,selection)=>{if(index++===0){entered();await gate;}return worker(bytes,selection);}});
 let manualId='';try{await run();await startedWithin(first);const response=await request('POST',root(),{region:{left:0,top:0,width:1,height:1}});assert.equal(response.statusCode,202,response.body);manualId=response.json().job.id;}
 finally{release();}await settle();assert.equal((await request('GET',root()+'/'+manualId)).json().job.status,'ready');assert.equal((await art.titleArtsFor([SID()])).get(SID())!.logoUrl,null);assert.equal((await status()).run.counts.ready,1);assert.equal((await status()).run.counts.applied,0);
});

test('new checked publication opt-in reevaluates a prior preview-only fingerprint once, even after expiry',{skip},async()=>{
 core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async()=>quality(true),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)})});
 await run();await settle();assert.equal(calls,1);assert.equal((await status()).run.counts.ready,1);
 await q("UPDATE series_title_extractions SET expires_at=now()-interval '1 second'");await core.cleanupTitleExtractions();
 await q('UPDATE server_settings SET automatic_cover_title_generation=true,automatic_cover_title_apply=true WHERE id=1');await run();await settle();assert.equal(calls,2);assert.equal((await status()).run.counts.applied,1);
 await run();await settle();assert.equal(calls,2);assert.equal((await status()).run.counts.skipped,1);
});

test('same-link canonical aliases becoming available invalidates verification once without external lookup',{skip},async()=>{
 await q('UPDATE server_settings SET automatic_cover_title_generation=true,automatic_cover_title_apply=true WHERE id=1');await q('DELETE FROM series_other_titles WHERE series_id=$1',[SID()]);
 core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async input=>quality(input.evidence.aliases.length>0),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)})});
 await run();await settle();assert.equal(calls,1);assert.equal((await status()).run.counts.ready,1);
 await q("INSERT INTO series_other_titles(series_id,anilist_id,english,romaji)VALUES($1,'87216','Fixture title','Fixture title')",[SID()]);
 await run();await settle();assert.equal(calls,2);assert.equal((await status()).run.counts.applied,1);await run();await settle();assert.equal(calls,2);assert.equal(externalCalls,0);
});

test('a temporary database failure after claim resumes on the next tick without restart',{skip},async()=>{
 let entered!:()=>void,release!:()=>void;const first=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let index=0;
 core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),worker:async(bytes,selection)=>{if(index++===0){entered();await gate;}return worker(bytes,selection);}});
 const originalQuery=pool.query;try{
  await run();await startedWithin(first);pool.query=()=>Promise.reject(Error('temporary test database outage'));release();await batch.titleExtractionBatchSettled();await core.titleExtractionsSettled();
 }finally{pool.query=originalQuery;release();}
 assert.equal((await q("SELECT count(*)::int n FROM title_extraction_items WHERE status='processing'"))[0].n,1);
 await batch.titleExtractionBatchTick();await settle();const s=await status();assert.equal(s.run.status,'completed');assert.equal(s.run.counts.ready,1);assert.equal(calls,2);
});

test('generation backpressure pauses unfinished work and saved revision bytes remain accurately counted',{skip},async()=>{
 await run();await settle();const first=await status(),jobId=first.reviewSeries[0].jobId;
 const before=(await q('SELECT asset_bytes FROM series_title_extractions WHERE id=$1',[jobId]))[0].asset_bytes;
 let saved=await request('PATCH',root()+'/'+jobId+'/mask',{expectedRevision:0,strokes:[{mode:'restore',radius:.02,points:[{x:.5,y:.8}]}]});assert.equal(saved.statusCode,200,saved.body);
 const{lstat}=await import('node:fs/promises');async function bytes(){const names=(await readdir(core.EXTRACTION_DIR)).filter(name=>name.startsWith(jobId+'.')&&!name.endsWith('.part'));return(await Promise.all(names.map(name=>lstat(join(core.EXTRACTION_DIR,name))))).reduce((n,s)=>n+s.size,0);}
 let recorded=(await q('SELECT asset_bytes FROM series_title_extractions WHERE id=$1',[jobId]))[0].asset_bytes;assert.ok(recorded>before);assert.equal(recorded,await bytes());
 saved=await request('PATCH',root()+'/'+jobId+'/mask',{expectedRevision:1,strokes:[]});assert.equal(saved.statusCode,200,saved.body);recorded=(await q('SELECT asset_bytes FROM series_title_extractions WHERE id=$1',[jobId]))[0].asset_bytes;assert.equal(recorded,await bytes());
 await q('UPDATE series_title_extractions SET asset_bytes=$2 WHERE id=$1',[jobId,core.BATCH_ASSET_BUDGET]);await series(2);await run();await settle();let s=await status();assert.equal(s.running,true);assert.equal(s.pausedReason,'extraction_storage_full');assert.equal(s.run.counts.pending,1);assert.equal(calls,1);
 await q('UPDATE series_title_extractions SET asset_bytes=$2 WHERE id=$1',[jobId,recorded]);await q("UPDATE title_extraction_items SET retry_at=now()-interval '1 second' WHERE status='pending'");await batch.titleExtractionBatchTick();await settle();s=await status();assert.equal(s.running,false);assert.equal(s.run.counts.ready,1);assert.equal(calls,2);
});
