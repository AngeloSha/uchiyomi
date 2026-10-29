// Real API/database/filesystem checks. Synthetic local worker results exercise lifecycle, never model accuracy.
import test,{before,after,beforeEach}from'node:test';
import assert from'node:assert/strict';
import{createHash,randomUUID}from'node:crypto';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{readFile,writeFile,readdir,rm,symlink}from'node:fs/promises';
import type{CoverTitleQualityResult}from'../src/lib/coverTitleQuality';
const DSN=process.env.TEST_DATABASE_URL,ROOT=join(tmpdir(),`yomi-title-extract-${process.pid}`);
if(DSN){process.env.DATABASE_URL=DSN;process.env.CONFIG_DIR=ROOT;process.env.CACHE_DIR=join(ROOT,'cache');process.env.LIBRARY_ROOT=join(ROOT,'library');
  process.env.DL_ROOT=join(ROOT,'downloads');process.env.JWT_SECRET='title-extract-test-secret-at-least16';process.env.LIBRARY_BACKEND='owned';process.env.UCHIYOMI_PING_URL='';}
const skip=DSN?false:'set TEST_DATABASE_URL to run',LIB='title-extract-lib',SID='s_title_extract';
let q:any,pool:any,app:any,core:typeof import('../src/lib/titleExtraction'),art:typeof import('../src/lib/titleArt'),sharp:typeof import('sharp').default;
let admin:string,other:string,member:string,adminId:string,cover:Buffer,candidate:Buffer,calls=0;
const realFetch=globalThis.fetch;
const auth=(token=admin)=>({authorization:'Bearer '+token});
const base=`/api/admin/series/${SID}/title-extraction`;
const quality=(safe=false):CoverTitleQualityResult=>({policyVersion:'strict-v1',safeToApply:safe,manualApplyAllowed:true,needsReview:!safe,
  reasons:safe?[]:[{code:'ocr_unavailable',severity:'warning'}],sourceTitleMatched:safe?true:null,candidateTitleMatched:safe?true:null,matchedAlias:safe?'Fixture Tale':null});
const request=(method:string,url:string,payload?:any,token=admin)=>app.inject({method,url,headers:auth(token),...(payload===undefined?{}:{payload})});
const currentArt=async()=>(await art.titleArtsFor([SID])).get(SID)!;
const jobState=async(id:string)=>(await request('GET',base+'/'+id)).json().job;
const worker=async(bytes:Buffer,selection:any)=>{calls++;const meta=await sharp(bytes).metadata();return{bytes:candidate,sourceSha256:createHash('sha256').update(bytes).digest('hex'),
  width:240,height:80,sourceWidth:meta.width!,sourceHeight:meta.height!,region:selection.region??{left:0,top:0,width:1,height:.3},ms:1,
  modelFingerprint:'a'.repeat(64),evidence:{maskScore:.95,foregroundFraction:.2,edgeInkFraction:0,maskRetainedFraction:1,foregroundChangedFraction:0}};};
async function makeReady(){const response=await request('POST',base,{});assert.equal(response.statusCode,202,response.body);const id=response.json().job.id;
  await core.titleExtractionsSettled();assert.equal((await jobState(id)).status,'ready');return id;}
before(async()=>{
  if(!DSN)return;
  globalThis.fetch=(async()=>new Response(JSON.stringify({data:{Media:null,Page:{media:[]}}}),{status:200}))as typeof fetch;
  sharp=(await import('sharp')).default;({q,pool}=await import('../src/lib/db'));await(await import('../src/lib/migrate')).migrate();
  core=await import('../src/lib/titleExtraction');art=await import('../src/lib/titleArt');
  await q(`INSERT INTO libraries(id,name,path,anilist_lookup)VALUES($1,'Extract fixture',$1,true)ON CONFLICT(id)DO NOTHING`,[LIB]);
  cover=await sharp({create:{width:480,height:640,channels:3,background:'#434080'}}).png().toBuffer();
  const stroke=await sharp({create:{width:60,height:40,channels:4,background:'#ef54c9ff'}}).png().toBuffer();
  candidate=await sharp({create:{width:240,height:80,channels:4,background:'#00000000'}}).composite([{input:stroke,left:20,top:20},{input:stroke,left:160,top:20}]).png().toBuffer();
  const Fastify=(await import('fastify')).default;app=Fastify();await app.register((await import('@fastify/cookie')).default);await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
  await q("DELETE FROM users WHERE username LIKE 'title-extract-%'");
  for(const[name,role]of[['admin','admin'],['other','admin'],['member','user']]){const[u]=await q(`INSERT INTO users(username,display_name,password_hash,role)VALUES($1,$1,'x',$2)RETURNING id`,['title-extract-'+name,role]);
    const token=app.jwt.sign({sub:u.id,role});if(name==='admin'){admin=token;adminId=u.id;}else if(name==='other')other=token;else member=token;}
  await app.register((await import('../src/routes/admin')).default);await app.ready();await core.initializeTitleExtractions();
});
beforeEach(async()=>{
  if(!DSN)return;await core.titleExtractionsSettled();await core.dropTitleExtractions(SID);await q('DELETE FROM lib_series WHERE id=$1',[SID]);
  await q(`INSERT INTO lib_series(id,source,title,folder,books_count,library_id)VALUES($1,'T!extract','Fixture Tale',$1,0,$2)`,[SID,LIB]);
  await q(`INSERT INTO series_trackers(series_id,provider,external_id,checked_at)VALUES($1,'anilist','87216',now())`,[SID]);
  await q(`INSERT INTO series_other_titles(series_id,anilist_id,english,romaji,native)VALUES($1,'87216','Fixture Tale','Fixture Tale',NULL)`,[SID]);
  await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1',[LIB]);await q('UPDATE server_settings SET automatic_cover_titles=false,automatic_title_logos=false,title_logo_retry_at=NULL WHERE id=1');
  calls=0;core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async()=>quality(),ocrCapability:async()=>({available:true,calibrated:true,verifierFingerprint:'a'.repeat(64)})});
  const upload=await request('PUT',`/api/admin/series/${SID}/art`,{kind:'cover',mode:'upload',dataUrl:'data:image/png;base64,'+cover.toString('base64')});assert.equal(upload.statusCode,200,upload.body);
});
after(async()=>{
  if(DSN){await core.titleExtractionsSettled();core.stopTitleExtractions();core.setTitleExtractionForTests();await core.dropTitleExtractions(SID);await app.close();
    await q('DELETE FROM lib_series WHERE id=$1',[SID]);await q('DELETE FROM libraries WHERE id=$1',[LIB]);await q("DELETE FROM users WHERE username LIKE 'title-extract-%'");
    await q('UPDATE server_settings SET automatic_cover_titles=false WHERE id=1');await pool.end();}globalThis.fetch=realFetch;await rm(ROOT,{recursive:true,force:true});
});
test('capabilities and cover snapshots are admin-only; unconfigured automatic mode cannot be enabled', {skip},async()=>{
  assert.equal((await app.inject({method:'GET',url:base+'/cover'})).statusCode,401);
  assert.equal((await request('GET',base+'/cover',undefined,member)).statusCode,403);
  const snapshot=await request('GET',base+'/cover');assert.equal(snapshot.statusCode,200);assert.equal(snapshot.headers['content-type'],'image/png');
  assert.match(snapshot.headers['x-cover-fingerprint'],/^[a-f0-9]{64}$/);assert.match(snapshot.headers['cache-control'],/^private, no-store/);
  const settings=await request('GET','/api/admin/settings');assert.equal(settings.json().automatic_cover_titles,false);
  core.setTitleExtractionForTests({ready:async()=>false,ocrCapability:async()=>({available:false,calibrated:false,verifierFingerprint:null})});
  assert.equal((await request('GET','/api/admin/title-extraction/capabilities')).json().available,false);
  assert.equal((await request('PATCH','/api/admin/settings',{automaticCoverTitles:true})).statusCode,409);
  assert.equal((await request('POST',base,{})).statusCode,503);assert.equal((await currentArt()).logoUrl,null);
});
test('immutable cover selection creates a private async preview; only its owner can explicitly apply it', {skip},async()=>{
  const before=await currentArt(),coverResponse=await request('GET',base+'/cover');let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let source:Buffer|undefined;
  core.setTitleExtractionForTests({worker:async(bytes,selection)=>{source=bytes;await gate;assert.deepEqual(selection.exclusions,[{left:.1,top:.1,width:.1,height:.1}]);return worker(bytes,selection);},ready:async()=>true,assess:async()=>quality()});
  let job:any;
  try{const created=await request('POST',base,{coverFingerprint:coverResponse.headers['x-cover-fingerprint'],region:{left:0,top:0,width:1,height:.3},exclusions:[{left:.1,top:.1,width:.1,height:.1}]});
    assert.equal(created.statusCode,202,created.body);job=created.json().job;assert.equal((await currentArt()).version,before.version);assert.equal((await currentArt()).logoUrl,null);
    const coverSnapshot=await request('GET',job.coverPreviewUrl);assert.equal(coverSnapshot.headers['x-cover-fingerprint'],job.coverFingerprint);assert.deepEqual(coverSnapshot.rawPayload,coverResponse.rawPayload);
    assert.equal((await request('GET',base+'/'+job.id,undefined,other)).statusCode,404);assert.equal((await request('POST',base+'/'+job.id+'/apply',{},other)).statusCode,404);
  }finally{release();}await core.titleExtractionsSettled();assert.ok(source);assert.deepEqual(source,coverResponse.rawPayload);
  const ready=await jobState(job.id);assert.equal(ready.status,'ready');assert.equal(ready.quality.needsReview,true);assert.equal((await currentArt()).logoUrl,null);
  const preview=await request('GET',ready.previewUrl);assert.equal(preview.statusCode,200);assert.equal((await sharp(preview.rawPayload).metadata()).hasAlpha,true);
  const apply=await request('POST',base+'/'+job.id+'/apply',{});assert.equal(apply.statusCode,200,apply.body);assert.equal(apply.json().titleArt.mode,'custom');assert.ok(apply.json().titleArt.logoUrl);
  assert.equal(apply.json().titleArt.attribution.source,'Cover lettering');assert.equal(apply.json().titleArt.attribution.sourceUrl,null);assert.equal(apply.json().titleArt.showReadableTitle,true);
  assert.equal((await request('POST',base+'/'+job.id+'/apply',{})).statusCode,409);assert.deepEqual((await request('GET',base+'/cover')).rawPayload,coverResponse.rawPayload);
});
test('selection cannot supply arbitrary URLs, malformed rectangles, stale cover hashes or more than eight exclusions', {skip},async()=>{
  for(const body of[{url:'http://127.0.0.1/secret'},{region:{left:.9,top:0,width:.2,height:1}},{region:{left:0,top:0,width:0,height:1}},
    {exclusions:Array.from({length:9},()=>({left:0,top:0,width:.1,height:.1}))}])assert.equal((await request('POST',base,body)).statusCode,400);
  assert.equal((await request('POST',base,{coverFingerprint:'0'.repeat(64)})).statusCode,409);assert.equal(calls,0);
});
test('changed cover, checked identity and manual title edits reject stale Apply without replacing the original art', {skip},async()=>{
  for(const change of['cover','identity','style','file-bytes']as const){
    const job=await makeReady();const before=await currentArt();
    if(change==='cover')await q("UPDATE series_overrides SET cover='first_page',updated_at=now() WHERE series_id=$1",[SID]);
    if(change==='identity')await q("UPDATE series_trackers SET external_id='99999' WHERE series_id=$1",[SID]);
    if(change==='style')await request('PUT',`/api/admin/series/${SID}/art`,{kind:'logo',mode:'style',style:'noir'});
    if(change==='file-bytes')await writeFile(join(ROOT,'series-art',SID+'-cover.webp'),await sharp(cover).modulate({brightness:.6}).webp().toBuffer());
    const applied=await request('POST',base+'/'+job+'/apply',{});assert.equal(applied.statusCode,409,`${change}: ${applied.body}`);assert.equal((await currentArt()).logoUrl,before.logoUrl);
    await core.dropTitleExtractions(SID);await q("UPDATE series_overrides SET cover='upload',updated_at=now() WHERE series_id=$1",[SID]);
    await q("UPDATE series_trackers SET external_id='87216' WHERE series_id=$1",[SID]);
  }
});
test('malformed, opaque and wrong-source worker output cannot create title artwork; timeouts terminate the job', {skip},async()=>{
  for(const fault of['bytes','opaque','source','timeout']as const){
    core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),timeoutMs:25,worker:async(bytes,selection,aliases,signal)=>{
      if(fault==='timeout')return new Promise(()=>{});const result=await worker(bytes,selection);
      if(fault==='bytes')result.bytes=Buffer.from('not PNG');if(fault==='source')result.sourceSha256='0'.repeat(64);
      if(fault==='opaque')result.bytes=await sharp({create:{width:240,height:80,channels:3,background:'#fff'}}).png().toBuffer();return result;
    }});
    const created=await request('POST',base,{});assert.equal(created.statusCode,202);await core.titleExtractionsSettled();
    const job=await jobState(created.json().job.id);assert.equal(job.status,'error');assert.equal(job.previewUrl,null);assert.equal((await currentArt()).logoUrl,null);
    if(fault==='timeout')assert.equal(job.error,'extract_timeout');await core.dropTitleExtractions(SID);
  }
});
test('discard, expiry, hard retirement and symlink guards remove or refuse private candidates', {skip},async()=>{
  let job=await makeReady();const preview=join(core.EXTRACTION_DIR,job+'.webp');await rm(preview);await symlink(join(ROOT,'series-art',SID+'-cover.webp'),preview);
  assert.equal((await request('GET',base+'/'+job+'/preview')).statusCode,404);assert.equal((await request('POST',base+'/'+job+'/apply',{})).statusCode,404);
  assert.equal((await request('DELETE',base+'/'+job)).statusCode,200);assert.equal((await request('GET',base+'/'+job)).statusCode,404);
  job=await makeReady();await q("UPDATE series_title_extractions SET expires_at=now()-interval '1 second' WHERE id=$1",[job]);
  assert.equal((await jobState(job)).status,'expired');assert.equal((await request('POST',base+'/'+job+'/apply',{})).statusCode,410);await core.cleanupTitleExtractions();
  assert.equal((await readdir(core.EXTRACTION_DIR)).some(n=>n.startsWith(job)),false);
  job=await makeReady();await core.dropTitleExtractions(SID);assert.equal((await readdir(core.EXTRACTION_DIR)).some(n=>n.startsWith(job)),false);
});
test('discarding a running preview cancels publication and current visibility still gates an owned draft', {skip},async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});let job='';
  core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),worker:async(bytes,selection)=>{entered();await gate;return worker(bytes,selection);}});
  try{const created=await request('POST',base,{});job=created.json().job.id;await started;
    assert.equal((await request('DELETE',base+'/'+job)).statusCode,200);await core.titleExtractionsSettled();
    assert.equal((await request('GET',base+'/'+job)).statusCode,404);assert.equal((await currentArt()).logoUrl,null);
  }finally{release();}
  core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async()=>quality()});job=await makeReady();
  await q('UPDATE lib_series SET deleted_at=now() WHERE id=$1',[SID]);
  try{assert.equal((await request('GET',base+'/'+job)).statusCode,404);assert.equal((await request('GET',base+'/'+job+'/preview')).statusCode,404);
    assert.equal((await request('POST',base+'/'+job+'/apply',{})).statusCode,404);
  }finally{await q('UPDATE lib_series SET deleted_at=NULL WHERE id=$1',[SID]);}
});
test('automatic strict pass publishes a bound fallback, while a later provider logo remains preferred', {skip},async()=>{
  await q('UPDATE server_settings SET automatic_cover_titles=true WHERE id=1');
  await q("INSERT INTO series_title_art(series_id,lookup_status,lookup_anilist_id,retry_at)VALUES($1,'missing','87216',now()+interval '7 days')",[SID]);
  core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async()=>quality(true),ocrCapability:async()=>({available:true,calibrated:true,verifierFingerprint:'a'.repeat(64)})});
  await core.scanAutomaticTitleExtractions();await core.titleExtractionsSettled();let title=await currentArt();assert.equal(title.mode,'automatic');assert.equal(title.status,'ready');assert.equal(title.attribution?.source,'Cover lettering');
  const row=(await q('SELECT auto_cover_key,version FROM series_title_art WHERE series_id=$1',[SID]))[0];assert.match(row.auto_cover_key,/^[a-f0-9]{64}$/);
  await q("UPDATE series_overrides SET updated_at=now()+interval '1 second' WHERE series_id=$1",[SID]);assert.equal((await currentArt()).logoUrl,null,'a cover edit hides its old derived fallback');
  await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');await q('UPDATE series_title_art SET retry_at=NULL WHERE series_id=$1',[SID]);
  art.setTitleLogoLookupForTests(async()=>({kind:'found',candidate:{bytes:candidate,language:'en',showReadableTitle:false,
    attribution:{provider:'wikimedia',pageUrl:'https://commons.wikimedia.org/wiki/File:Fixture.png',fileName:'Fixture.png',author:null,license:'Public domain',licenseUrl:null}}}));
  try{await art.queueTitleLogos([SID]);await art.titleLogoQueueSettled();}finally{art.setTitleLogoLookupForTests();}
  title=await currentArt();assert.equal(title.attribution?.source,'Wikimedia Commons');assert.equal((await q('SELECT auto_cover_key FROM series_title_art WHERE series_id=$1',[SID]))[0].auto_cover_key,null);
});
test('uncertain automatic output stays a shared review draft; opt-out during a strict run prevents publication', {skip},async()=>{
  await q('UPDATE server_settings SET automatic_cover_titles=true WHERE id=1');await q("INSERT INTO series_title_art(series_id,lookup_status,lookup_anilist_id)VALUES($1,'missing','87216')",[SID]);
  await core.scanAutomaticTitleExtractions();await core.titleExtractionsSettled();assert.equal((await currentArt()).logoUrl,null);
  const latest=await request('GET',base,undefined,other);assert.equal(latest.json().job.automatic,true);assert.equal(latest.json().job.status,'ready');
  await core.dropTitleExtractions(SID);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  core.setTitleExtractionForTests({ready:async()=>true,ocrCapability:async()=>({available:true,calibrated:true,verifierFingerprint:'a'.repeat(64)}),
    worker:async(bytes,selection)=>{await gate;return worker(bytes,selection);},assess:async()=>quality(true)});
  try{await core.scanAutomaticTitleExtractions();await q('UPDATE server_settings SET automatic_cover_titles=false WHERE id=1');}finally{release();}
  await core.titleExtractionsSettled();assert.equal((await currentArt()).logoUrl,null);assert.equal((await currentArt()).mode,'automatic');
});
test('canonical alias warming checks exact returned manga identity and consent again before keeping it', {skip},async()=>{
  await q('DELETE FROM series_other_titles WHERE series_id=$1',[SID]);let metadataCalls=0;const baseline=globalThis.fetch;
  let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  globalThis.fetch=(async(_input,init)=>{metadataCalls++;const request=JSON.parse(String(init?.body));assert.equal(request.variables.id,87216);entered();await gate;
    return new Response(JSON.stringify({data:{Media:{id:87216,type:'MANGA',title:{english:'Fixture Tale',romaji:'Fixture Tale',native:'作品'}}}}),{status:200});})as typeof fetch;
  try{
    await q('UPDATE libraries SET anilist_lookup=false WHERE id=$1',[LIB]);await makeReady();assert.equal(metadataCalls,0,'private libraries make no alias request');
    await core.dropTitleExtractions(SID);await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1',[LIB]);
    const created=await request('POST',base,{});assert.equal(created.statusCode,202);await started;
    await q('UPDATE libraries SET anilist_lookup=false WHERE id=$1',[LIB]);
  }finally{release();}
  await core.titleExtractionsSettled();assert.equal(metadataCalls,1);assert.equal((await q('SELECT count(*)::int n FROM series_other_titles WHERE series_id=$1',[SID]))[0].n,0);
  await core.dropTitleExtractions(SID);await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1',[LIB]);
  try{
    globalThis.fetch=(async()=>new Response(JSON.stringify({data:{Media:{id:99999,type:'MANGA',title:{english:'Wrong Manga'}}}}),{status:200}))as typeof fetch;
    await makeReady();assert.equal((await q('SELECT count(*)::int n FROM series_other_titles WHERE series_id=$1',[SID]))[0].n,0,'a mismatched response cannot authorize a title');
    await core.dropTitleExtractions(SID);
    globalThis.fetch=(async()=>new Response(JSON.stringify({data:{Media:{id:87216,type:'MANGA',title:{english:'Fixture Tale',romaji:'Fixture Tale',native:'作品'}}}}),{status:200}))as typeof fetch;
    await makeReady();const[kept]=await q('SELECT anilist_id,native FROM series_other_titles WHERE series_id=$1',[SID]);assert.equal(kept.anilist_id,'87216');assert.equal(kept.native,'作品');
  }finally{globalThis.fetch=baseline;}
});
