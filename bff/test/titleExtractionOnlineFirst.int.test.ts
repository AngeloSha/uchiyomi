// Real PostgreSQL/API/filesystem lifecycle checks; deterministic local model outputs do not claim extraction accuracy.
import test,{before,after,beforeEach}from'node:test';
import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{mkdir,writeFile,rm}from'node:fs/promises';
import type{CoverTitleQualityResult}from'../src/lib/coverTitleQuality';
const DSN=process.env.TEST_DATABASE_URL,ROOT=join(tmpdir(),'uchiyomi-online-first-'+process.pid),LIB='online-first-int';
if(DSN){Object.assign(process.env,{DATABASE_URL:DSN,CONFIG_DIR:ROOT,CACHE_DIR:join(ROOT,'cache'),LIBRARY_ROOT:join(ROOT,'library'),DL_ROOT:join(ROOT,'dl'),JWT_SECRET:'cover-batch-test-secret-longer-than16',LIBRARY_BACKEND:'owned',UCHIYOMI_PING_URL:'',TITLE_EXTRACTOR_URL:''});}
const skip=DSN?false:'set TEST_DATABASE_URL',SID=(n=0)=>'s_online_first_'+n,BASE='/api/admin/title-extraction/batch';
let q:any,pool:any,app:any,core:typeof import('../src/lib/titleExtraction'),batch:typeof import('../src/lib/titleExtractionBatch'),art:typeof import('../src/lib/titleArt');
let sharp:typeof import('sharp').default,artFile:typeof import('../src/lib/seriesArt').artFile,cover:Buffer,candidate:Buffer,admin:string,calls=0,externalCalls=0,providerCalls=0,warmCalls=0;
const originalFetch=globalThis.fetch;
const quality=(available=false):CoverTitleQualityResult=>({policyVersion:'strict-v1',safeToApply:false,availableChecksPassed:available,manualApplyAllowed:true,needsReview:true,
 reasons:[{code:'automatic_verification_unvalidated',severity:'warning'}],sourceTitleMatched:available,candidateTitleMatched:available,matchedAlias:available?'Fixture title':null});
const request=(method:string,url:string,payload?:any,token=admin)=>app.inject({method,url,headers:{authorization:'Bearer '+token},...(payload===undefined?{}:{payload})});
const status=async()=>(await request('GET',BASE+'/status')).json();
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
before(async()=>{
 if(!DSN)return;globalThis.fetch=(async()=>{externalCalls++;throw Error('No external lookup allowed in batch tests');})as typeof fetch;
 sharp=(await import('sharp')).default;({q,pool}=await import('../src/lib/db'));await(await import('../src/lib/migrate')).migrate();
 core=await import('../src/lib/titleExtraction');batch=await import('../src/lib/titleExtractionBatch');art=await import('../src/lib/titleArt');({artFile}=await import('../src/lib/seriesArt'));
 await mkdir(join(ROOT,'series-art'),{recursive:true});cover=await sharp({create:{width:200,height:280,channels:3,background:'#58456c'}}).png().toBuffer();
 // Make actual alpha include fully opaque source pixels, as required by the worker output contract.
 candidate=await sharp({create:{width:100,height:30,channels:4,background:'#00000000'}}).composite([{input:await sharp({create:{width:25,height:15,channels:4,background:'#ffdd88ff'}}).png().toBuffer(),left:5,top:5},{input:await sharp({create:{width:25,height:15,channels:4,background:'#ffdd88ff'}}).png().toBuffer(),left:65,top:5}]).png().toBuffer();
 await q(`INSERT INTO libraries(id,name,path,anilist_lookup)VALUES($1,'Batch fixtures',$1,true)ON CONFLICT(id)DO NOTHING`,[LIB]);
 const F=(await import('fastify')).default;app=F();await app.register((await import('@fastify/cookie')).default);await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
 await q("DELETE FROM users WHERE username LIKE 'cover-batch-%'");
 const[u]=await q("INSERT INTO users(username,display_name,password_hash,role)VALUES('cover-batch-admin','Fixture','x','admin')RETURNING id");admin=app.jwt.sign({sub:u.id,role:'admin'});
 await app.register((await import('../src/routes/admin')).default);await app.ready();
});
beforeEach(async()=>{
 if(!DSN)return;batch.stopTitleExtractionBatch();core.stopTitleExtractions();await settle();
 await q('DELETE FROM title_extraction_runs');
 const old=await q('SELECT id FROM lib_series WHERE library_id=$1',[LIB]);for(const{id}of old)await core.dropTitleExtractions(id);
 await q('DELETE FROM lib_series WHERE library_id=$1',[LIB]);
 art.cancelAutomaticTitleLogoQueue();await art.titleLogoQueueSettled();
 await q('UPDATE server_settings SET automatic_cover_title_generation=false,automatic_cover_title_apply=false,automatic_cover_titles=false,automatic_title_logos=true,title_logo_retry_at=NULL,cover_title_next_run_at=NULL WHERE id=1');
 await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1',[LIB]);
 await series(1);await q("INSERT INTO series_trackers(series_id,provider,external_id,checked_at)VALUES($1,'anilist','87216',now())",[SID()]);
 await q("INSERT INTO series_other_titles(series_id,anilist_id,english,romaji)VALUES($1,'87216','Fixture title','Fixture title')",[SID()]);
 core.setTitleExtractionForTests({worker,ready:async()=>true,health:async()=>({ready:true,modelFingerprint:'a'.repeat(64)}),assess:async()=>quality(),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)})});
 batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64),warmAliases:async()=>{warmCalls++;}});
 art.setTitleLogoQueuePaceForTests(0);art.setTitleLogoLookupForTests(async()=>{providerCalls++;return{kind:'missing'};});await core.initializeTitleExtractions();await batch.initializeTitleExtractionBatch();calls=0;externalCalls=0;providerCalls=0;warmCalls=0;
});
after(async()=>{
 if(DSN){batch.stopTitleExtractionBatch();core.stopTitleExtractions();await settle();art.cancelAutomaticTitleLogoQueue();await art.titleLogoQueueSettled();art.setTitleLogoLookupForTests();art.setTitleLogoQueuePaceForTests();await app.close();await q('DELETE FROM title_extraction_runs');await q('DELETE FROM lib_series WHERE library_id=$1',[LIB]);await q('DELETE FROM libraries WHERE id=$1',[LIB]);await q("DELETE FROM users WHERE username LIKE 'cover-batch-%'");await q('UPDATE server_settings SET automatic_cover_title_generation=false,automatic_cover_title_apply=false,cover_title_next_run_at=NULL WHERE id=1');batch.setTitleExtractionBatchForTests();core.setTitleExtractionForTests();await pool.end();}
 globalThis.fetch=originalFetch;await rm(ROOT,{recursive:true,force:true});
});

async function missing(id=SID(),linked='87216',milliseconds=86400_000){
 await q(`INSERT INTO series_title_art(series_id,lookup_status,lookup_anilist_id,retry_at)VALUES($1,'missing',$2,now()+($3::int*interval '1 millisecond'))
  ON CONFLICT(series_id)DO UPDATE SET lookup_status='missing',lookup_anilist_id=$2,retry_at=now()+($3::int*interval '1 millisecond')`,[id,linked,milliseconds]);
}
async function retry(){await q("UPDATE title_extraction_items SET retry_at=now()-interval '1 second' WHERE status='pending'");await batch.titleExtractionBatchTick();await settle();}

test('linked series wait for a real online miss, then warm aliases before inference',{skip},async()=>{
 let release!:()=>void;const held=new Promise<void>(r=>{release=r;});const order:string[]=[];
 art.setTitleLogoLookupForTests(async()=>{providerCalls++;order.push('online');await held;return{kind:'missing'};});
 batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64),warmAliases:async()=>{warmCalls++;order.push('aliases');}});
 core.setTitleExtractionForTests({worker:async(...args)=>{order.push('cover');return worker(...args);},ready:async()=>true,assess:async()=>quality()});
 try{await run();await settle();const s=await status();assert.equal(s.running,true);assert.equal(s.online.waitingOnline,1);assert.equal(s.pausedReason,'online_lookup_pending');
  assert.equal(calls,0);assert.equal(warmCalls,0);assert.equal((await q('SELECT attempts FROM title_extraction_items'))[0].attempts,0);
 }finally{release();}await art.titleLogoQueueSettled();await retry();
 assert.equal((await status()).run.counts.ready,1);assert.equal(providerCalls,1);assert.equal(warmCalls,1);assert.deepEqual(order,['online','aliases','cover']);assert.equal(externalCalls,0);
});

test('default, expired and different-identity missing rows never permit cover fallback',{skip},async()=>{
 for(const mode of['default','expired','different']){
  if(mode!=='default')await missing(SID(),mode==='different'?'99999':'87216',mode==='expired'?-1000:86400_000);
  else await q('INSERT INTO series_title_art(series_id)VALUES($1)',[SID()]);
  await run();await settle();assert.equal(calls,0,mode);assert.equal(warmCalls,0,mode);await art.titleLogoQueueSettled();
  assert.equal((await status()).online.waitingOnline,1,mode);await batch.cancelTitleExtractionBatch((await status()).run.id);
  await q('DELETE FROM series_title_art WHERE series_id=$1',[SID()]);
 }
 assert.equal(providerCalls,3);
});

test('a fresh matching cached miss allows fallback during global provider cooldown',{skip},async()=>{
 await missing();await q("UPDATE server_settings SET title_logo_retry_at=now()+interval '49 hours' WHERE id=1");
 await run();await settle();assert.equal(calls,1);assert.equal(warmCalls,1);assert.equal(providerCalls,0);assert.equal((await status()).run.counts.ready,1);
});

test('provider error honors the actual long Retry-After and consumes no model attempt',{skip},async()=>{
 const delay=49*3600_000;art.setTitleLogoLookupForTests(async()=>{providerCalls++;throw Object.assign(Error('Unavailable'),{retryAfterMs:delay});});
 await run();await settle();await art.titleLogoQueueSettled();await retry();const s=await status();
 assert.equal(s.run.counts.pending,1);assert.equal(s.pausedReason,'online_provider_busy');assert.equal(s.online.waitingOnline,1);assert.equal(calls,0);assert.equal(warmCalls,0);assert.equal(providerCalls,1);
 const[item]=await q('SELECT attempts,retry_at FROM title_extraction_items'),[settings]=await q('SELECT title_logo_retry_at FROM server_settings');
 assert.equal(item.attempts,0);const[artRow]=await q('SELECT retry_at FROM series_title_art WHERE series_id=$1',[SID()]);assert.equal(+item.retry_at,Math.max(+settings.title_logo_retry_at,+artRow.retry_at));assert.ok(+item.retry_at>Date.now()+48*3600_000);
 await batch.titleExtractionBatchTick();await settle();assert.equal(providerCalls,1);assert.equal(calls,0);
});

test('provider artwork wins without canonical warming or cover extraction',{skip},async()=>{
 art.setTitleLogoLookupForTests(async()=>{providerCalls++;return{kind:'found',candidate:{bytes:candidate,language:'en',showReadableTitle:false,
  attribution:{provider:'wikimedia',pageUrl:'https://commons.wikimedia.org/wiki/File:Fixture.png',fileName:'Fixture.png',author:null,license:null,licenseUrl:null}}};});
 await run();await settle();await art.titleLogoQueueSettled();await retry();assert.equal(calls,0);assert.equal(warmCalls,0);assert.equal((await status()).run.counts.skipped,1);
 assert.equal((await q('SELECT reason FROM title_extraction_items'))[0].reason,'existing_logo');assert.ok((await art.titleArtsFor([SID()])).get(SID())!.logoUrl);
});

test('a relink during canonical warming cannot reuse the previous identity miss',{skip},async()=>{
 await missing();batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64),warmAliases:async()=>{warmCalls++;await q("UPDATE series_trackers SET external_id='30013' WHERE series_id=$1",[SID()]);}});
 await run();await settle();assert.equal(calls,0);assert.equal(warmCalls,1);assert.equal((await status()).online.waitingOnline,1);await art.titleLogoQueueSettled();
 assert.equal((await q('SELECT lookup_anilist_id FROM series_title_art WHERE series_id=$1',[SID()]))[0].lookup_anilist_id,'30013');
});

test('a manual choice during warming is preserved before inference',{skip},async()=>{
 await missing();batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64),warmAliases:async()=>{await q("UPDATE series_title_art SET mode='text' WHERE series_id=$1",[SID()]);}});
 await run();await settle();assert.equal(calls,0);assert.equal(providerCalls,0);assert.equal((await status()).run.counts.skipped,1);assert.equal((await q('SELECT mode FROM series_title_art'))[0].mode,'text');
});

test('unlinked covers remain local previews, with no claim of a completed online miss',{skip},async()=>{
 await q('DELETE FROM series_trackers WHERE series_id=$1',[SID()]);await q('UPDATE server_settings SET automatic_cover_title_generation=true,automatic_cover_title_apply=true WHERE id=1');
 core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async()=>quality(true),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)})});
 await run();await settle();const s=await status();assert.equal(s.online.needsLink,1);assert.equal(s.online.waitingOnline,0);assert.equal(s.run.counts.ready,1);assert.equal(s.run.counts.applied,0);
 assert.equal(calls,1);assert.equal(warmCalls,0);assert.equal(providerCalls,0);assert.equal(externalCalls,0);
});

test('library opt-out and global online-off allow local drafts without any external request',{skip},async()=>{
 for(const mode of['library','global']){
  await q('UPDATE libraries SET anilist_lookup=$2 WHERE id=$1',[LIB,mode!=='library']);await q('UPDATE server_settings SET automatic_title_logos=$1 WHERE id=1',[mode!=='global']);
  await run();await settle();const s=await status();assert.equal(s.online.optedOut,1);assert.equal(s.online.waitingOnline,0);assert.equal(s.run.counts.ready+s.run.counts.skipped,1);
 }
 assert.equal(calls,1,'unchanged local preview is not re-inferred');assert.equal(warmCalls,0);assert.equal(providerCalls,0);assert.equal(externalCalls,0);
});

test('warming before history invalidates an old alias-free review once',{skip},async()=>{
 await q('UPDATE server_settings SET automatic_title_logos=false WHERE id=1');await q('DELETE FROM series_other_titles WHERE series_id=$1',[SID()]);await run();await settle();assert.equal(calls,1);
 await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');await missing();
 batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64),warmAliases:async()=>{warmCalls++;await q("INSERT INTO series_other_titles(series_id,anilist_id,english)VALUES($1,'87216','Fixture title')ON CONFLICT(series_id)DO UPDATE SET english=EXCLUDED.english",[SID()]);}});
 await run();await settle();assert.equal(calls,2);await run();await settle();assert.equal(calls,2);assert.equal(providerCalls,0);
});

test('review groups count each ready batch job once per group, excluding calibration diagnostics',{skip},async()=>{
 await missing();await series(2);await q("INSERT INTO series_trackers(series_id,provider,external_id,checked_at)VALUES($1,'anilist','30013',now())",[SID(1)]);await missing(SID(1),'30013');
 await run();await settle();const jobs=await q('SELECT id FROM series_title_extractions WHERE batch_item_id IS NOT NULL ORDER BY id');assert.equal(jobs.length,2);
 await q('UPDATE series_title_extractions SET reasons=$2::jsonb WHERE id=$1',[jobs[0].id,JSON.stringify(['source_title_not_confirmed','candidate_title_not_confirmed','missing_verified_alias','title_identity_unverified','low_contrast','automatic_verification_unvalidated','verifier_profile_mismatch'])]);
 await q('UPDATE series_title_extractions SET reasons=$2::jsonb WHERE id=$1',[jobs[1].id,JSON.stringify(['foreground_lost','source_text_clipped','ocr_unavailable','manual_mask_edit','low_contrast'])]);
 assert.deepEqual(Object.fromEntries((await status()).reviewReasons.map((r:any)=>[r.code,r.count])),{low_contrast:2,checks_unavailable:1,lettering_incomplete:1,other:1,text_unclear:1,title_not_verified:1});
 await q("UPDATE series_title_extractions SET expires_at=now()-interval '1 second' WHERE id=$1",[jobs[1].id]);
 assert.deepEqual(Object.fromEntries((await status()).reviewReasons.map((r:any)=>[r.code,r.count])),{low_contrast:1,text_unclear:1,title_not_verified:1});
});


test('opting out during provider backoff resumes a local preview on the next tick',{skip},async()=>{
 await q("UPDATE server_settings SET title_logo_retry_at=now()+interval '49 hours' WHERE id=1");await run();await settle();assert.equal(calls,0);assert.equal((await status()).pausedReason,'online_provider_busy');
 const[before]=await q('SELECT title_logo_retry_at FROM server_settings');await q('UPDATE libraries SET anilist_lookup=false WHERE id=$1',[LIB]);
 await batch.titleExtractionBatchTick();await settle();assert.equal(calls,1);assert.equal((await status()).run.counts.ready,1);assert.equal(providerCalls,0);assert.equal(warmCalls,0);
 assert.equal(+(await q('SELECT title_logo_retry_at FROM server_settings'))[0].title_logo_retry_at,+before.title_logo_retry_at,'local opt-out must not reset provider backoff');
});

test('a pending manual refresh takes precedence over an older fresh negative result',{skip},async()=>{
 await missing();let release!:()=>void;const held=new Promise<void>(r=>{release=r;});art.setTitleLogoLookupForTests(async()=>{providerCalls++;await held;return{kind:'missing'};});
 try{await art.queueTitleLogos([SID()],'manual');await run();await settle();assert.equal(calls,0);assert.equal(warmCalls,0);assert.equal((await status()).online.waitingOnline,1);}
 finally{release();}await art.titleLogoQueueSettled();await retry();assert.equal(calls,1);assert.equal(providerCalls,1);
});

test('an online decision changing during inference keeps review private, then retries publication once after a miss',{skip},async()=>{
 await missing();await q('UPDATE server_settings SET automatic_cover_title_generation=true,automatic_cover_title_apply=true WHERE id=1');let generation=0;
 core.setTitleExtractionForTests({worker:async(...args)=>{
  if(generation++===0)await q("UPDATE series_title_art SET lookup_status='error',retry_at=now()+interval '5 minutes' WHERE series_id=$1",[SID()]);
  return worker(...args);
 },ready:async()=>true,health:async()=>({ready:true,modelFingerprint:'a'.repeat(64)}),assess:async()=>quality(true),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'b'.repeat(64)})});
 await run();await settle();assert.equal(calls,1);assert.equal((await status()).run.counts.ready,1);assert.equal((await status()).run.counts.applied,0);
 assert.equal((await q('SELECT publication_requested FROM series_title_extraction_history WHERE series_id=$1',[SID()]))[0].publication_requested,false);
 await missing();await run();await settle();assert.equal(calls,2);assert.equal((await status()).run.counts.applied,1);
 await run();await settle();assert.equal(calls,2,'same evidence and completed publication must not loop');assert.equal(providerCalls,0);
});

test('a checked-ID relink wakes obsolete per-ID backoff but preserves a shared provider deadline',{skip},async()=>{
 await missing();await q("UPDATE series_title_art SET lookup_status='error',retry_at=now()+interval '49 hours' WHERE series_id=$1",[SID()]);
 await run();await settle();assert.equal(providerCalls,0);assert.equal(calls,0);assert.equal((await status()).pausedReason,'online_provider_busy');
 await q("UPDATE series_trackers SET external_id='30013' WHERE series_id=$1",[SID()]);await q("UPDATE server_settings SET title_logo_retry_at=now()+interval '1 hour' WHERE id=1");
 await batch.titleExtractionBatchTick();await settle();assert.equal(providerCalls,0,'valid relink cannot bypass shared cooldown');assert.equal(calls,0);
 await q('UPDATE server_settings SET title_logo_retry_at=NULL WHERE id=1');await batch.titleExtractionBatchTick();await settle();await art.titleLogoQueueSettled();
 assert.equal(providerCalls,1,'new checked identity must not inherit the old identity error deadline');assert.equal(calls,0);await retry();assert.equal(calls,1);
 assert.equal((await q('SELECT lookup_anilist_id FROM series_title_art WHERE series_id=$1',[SID()]))[0].lookup_anilist_id,'30013');
});
