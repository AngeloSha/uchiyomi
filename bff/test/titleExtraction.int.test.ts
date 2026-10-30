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
test('manual selection intent remains exact when worker ROI and tight candidate bounds differ', {skip},async()=>{
  const selected={left:.053125,top:.545125,width:.890125,height:.357125},excluded=[{left:.8,top:.7,width:.05,height:.05}];
  const detected={left:.054,top:.545,width:.889,height:.358},tight={left:.1,top:.6,width:.5,height:.125};
  core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),worker:async(bytes,selection)=>{
    assert.deepEqual(selection.region,selected);assert.deepEqual(selection.exclusions,excluded);
    return{...await worker(bytes,selection),region:detected,candidateRegion:tight};
  }});
  const created=await request('POST',base,{region:selected,exclusions:excluded});assert.equal(created.statusCode,202,created.body);
  assert.equal(created.json().job.selectionMode,'manual');assert.deepEqual(created.json().job.region,selected);
  await core.titleExtractionsSettled();const ready=await jobState(created.json().job.id);
  assert.equal(ready.selectionMode,'manual');assert.deepEqual(ready.region,selected);assert.deepEqual(ready.exclusions,excluded);
  assert.deepEqual(ready.resultRegion,detected);assert.deepEqual(ready.candidateRegion,tight);assert.equal(ready.modelFingerprint,'a'.repeat(64));
  const latest=(await request('GET',base)).json().job;assert.deepEqual(latest.region,selected);assert.deepEqual(latest.candidateRegion,tight);
});
test('automatic detections and legacy output never silently become manual regions on regeneration', {skip},async()=>{
  const received:Array<unknown>=[];
  core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),worker:async(bytes,selection)=>{received.push(selection.region);return worker(bytes,selection);}});
  for(let n=0;n<2;n++){
    const job=await makeReady(),ready=await jobState(job);assert.equal(ready.selectionMode,'automatic');assert.equal(ready.region,null);
    assert.deepEqual(ready.resultRegion,{left:0,top:0,width:1,height:.3});
  }
  assert.deepEqual(received,[undefined,undefined]);
  const latest=(await request('GET',base)).json().job;const oldRegion={left:.1,top:.2,width:.8,height:.3};
  await q("UPDATE series_title_extractions SET selection_mode='legacy',region=$2,result_region=NULL WHERE id=$1",[latest.id,JSON.stringify(oldRegion)]);
  const legacy=await jobState(latest.id);assert.equal(legacy.selectionMode,'legacy');assert.equal(legacy.region,null);assert.deepEqual(legacy.resultRegion,oldRegion);
  assert.equal((await request('POST',base+'/'+latest.id+'/apply',{})).statusCode,200,'an explicitly reviewed older draft still applies');
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
test('ordered online warming fills checked canonical aliases before retry identity and repairs an empty cache', {skip},async()=>{
  const{SYSTEM_CTX}=await import('../src/lib/visibility');await q('DELETE FROM series_other_titles WHERE series_id=$1',[SID]);
  await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');const baseline=globalThis.fetch;let requests=0;
  const before=await core.titleExtractionVerificationContext(await core.titleExtractionSnapshot(SID,SYSTEM_CTX),'a'.repeat(64));
  globalThis.fetch=(async(_url,options)=>{requests++;const body=JSON.parse(String(options?.body));assert.equal(body.variables.id,87216);assert.match(body.query,/id type title/);
    return new Response(JSON.stringify({data:{Media:{id:87216,type:'MANGA',title:{english:'Fixture Tale',romaji:'Fikushon',native:'作品'}}}}),{status:200});})as typeof fetch;
  try{
    await core.warmTitleExtractionAliases(SID,SYSTEM_CTX);let[row]=await q('SELECT * FROM series_other_titles WHERE series_id=$1',[SID]);
    assert.deepEqual([row.anilist_id,row.english,row.romaji,row.native],['87216','Fixture Tale','Fikushon','作品']);
    const after=await core.titleExtractionVerificationContext(await core.titleExtractionSnapshot(SID,SYSTEM_CTX),'a'.repeat(64));assert.notEqual(after.key,before.key,'old missing-alias review history invalidates after verified evidence arrives');
    await core.warmTitleExtractionAliases(SID,SYSTEM_CTX);assert.equal(requests,1,'a populated checked cache does not trigger another lookup');
    await q('UPDATE series_other_titles SET english=NULL,romaji=NULL,native=NULL WHERE series_id=$1',[SID]);
    await core.warmTitleExtractionAliases(SID,SYSTEM_CTX);assert.equal(requests,2);[row]=await q('SELECT * FROM series_other_titles WHERE series_id=$1',[SID]);assert.equal(row.native,'作品');
    let observed=false;core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async input=>{observed=true;assert.deepEqual(input.evidence.aliases,['Fixture Tale','Fikushon','作品']);assert.equal(input.evidence.aliasesAnilistId,input.evidence.linkedAnilistId);return quality();}});
    await makeReady();assert.equal(observed,true);assert.equal(requests,2);
  }finally{globalThis.fetch=baseline;}
});
test('online warming sends nothing for disabled discovery, private libraries, unverified IDs, first pages or an aborted request', {skip},async()=>{
  const{SYSTEM_CTX}=await import('../src/lib/visibility');await q('DELETE FROM series_other_titles WHERE series_id=$1',[SID]);const baseline=globalThis.fetch;let requests=0;
  globalThis.fetch=(async()=>{requests++;throw Error('unexpected metadata request');})as typeof fetch;
  try{
    await core.warmTitleExtractionAliases(SID,SYSTEM_CTX);assert.equal(requests,0,'global online lookup is off');
    await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');await q('UPDATE libraries SET anilist_lookup=false WHERE id=$1',[LIB]);
    await core.warmTitleExtractionAliases(SID,SYSTEM_CTX);await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1',[LIB]);
    await q("UPDATE series_trackers SET checked_at=NULL,linked_by=NULL WHERE series_id=$1 AND provider='anilist'",[SID]);await core.warmTitleExtractionAliases(SID,SYSTEM_CTX);
    await q("UPDATE series_trackers SET checked_at=now(),external_id='087216' WHERE series_id=$1 AND provider='anilist'",[SID]);await core.warmTitleExtractionAliases(SID,SYSTEM_CTX);
    await q("UPDATE series_trackers SET external_id='87216' WHERE series_id=$1 AND provider='anilist'",[SID]);
    const abort=new AbortController();abort.abort();await core.warmTitleExtractionAliases(SID,SYSTEM_CTX,abort.signal);
    await request('PUT',`/api/admin/series/${SID}/art`,{kind:'cover',mode:'first_page'});await core.warmTitleExtractionAliases(SID,SYSTEM_CTX);
    assert.equal(requests,0);assert.equal((await q('SELECT count(*)::int n FROM series_other_titles WHERE series_id=$1',[SID]))[0].n,0);
  }finally{globalThis.fetch=baseline;}
});
test('online canonical warming rechecks consent, link, cover and artwork after the network response', {skip},async()=>{
  const{SYSTEM_CTX}=await import('../src/lib/visibility');const baseline=globalThis.fetch;
  try{for(const change of['global','library','identity','cover','title']){
    await q('DELETE FROM series_other_titles WHERE series_id=$1',[SID]);await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');
    await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1',[LIB]);await q("UPDATE series_trackers SET external_id='87216',checked_at=now() WHERE series_id=$1 AND provider='anilist'",[SID]);
    await q("UPDATE series_overrides SET cover='upload' WHERE series_id=$1",[SID]);
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    globalThis.fetch=(async()=>{entered();await gate;return new Response(JSON.stringify({data:{Media:{id:87216,type:'MANGA',title:{english:'Verified title',romaji:'Verified title',native:'作品'}}}}),{status:200});})as typeof fetch;
    const warming=core.warmTitleExtractionAliases(SID,SYSTEM_CTX);
    try{await started;
      if(change==='global')await q('UPDATE server_settings SET automatic_title_logos=false WHERE id=1');
      else if(change==='library')await q('UPDATE libraries SET anilist_lookup=false WHERE id=$1',[LIB]);
      else if(change==='identity')await q("UPDATE series_trackers SET external_id='99999' WHERE series_id=$1 AND provider='anilist'",[SID]);
      else if(change==='cover')await q("UPDATE series_overrides SET cover='first_page' WHERE series_id=$1",[SID]);
      else await request('PUT',`/api/admin/series/${SID}/art`,{kind:'logo',mode:'style',style:'fantasy'});
    }finally{release();}await warming;
    assert.equal((await q('SELECT count(*)::int n FROM series_other_titles WHERE series_id=$1',[SID]))[0].n,0,change+' changed before publication');
  }}finally{globalThis.fetch=baseline;}
});

async function makeCorrectable(){
  core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),worker:async(bytes,selection)=>({
    ...await worker(bytes,selection),sourceWidth:240,sourceHeight:320,candidateRegion:{left:0,top:.25,width:1,height:.25},
  })});return makeReady();
}
const edit=(id:string,expectedRevision:number,strokes:any[],token=admin)=>request('PATCH',base+'/'+id+'/mask',{expectedRevision,strokes},token);
const restore={mode:'restore',radius:.02,points:[{x:.5,y:.7}]};
const erase={mode:'erase',radius:.02,points:[{x:.15,y:.375}]};
test('mask correction replays an immutable full-source baseline and preserves original RGB until explicit Apply', {skip},async()=>{
  const id=await makeCorrectable(),before=await jobState(id),originalArt=await currentArt();
  assert.deepEqual([before.mask.canvas.width,before.mask.canvas.height],[480,640]);assert.equal(before.mask.revision,0);
  const baseline=await request('GET',before.mask.canvas.baselineUrl),source=await request('GET',before.mask.canvas.sourceUrl);
  assert.equal(baseline.statusCode,200);assert.equal(baseline.headers['cache-control'],'private, no-store');
  const baselineBefore=createHash('sha256').update(baseline.rawPayload).digest('hex');
  const saved=await edit(id,0,[restore,erase]);assert.equal(saved.statusCode,200,saved.body);const changed=saved.json().job;
  assert.equal(changed.mask.revision,1);assert.deepEqual(changed.mask.strokes,[restore,erase]);assert.match(changed.previewUrl,/revision=1$/);
  assert.equal(changed.quality.safeToApply,false);assert.equal(changed.quality.sourceTitleMatched,null);assert.equal(changed.quality.needsReview,true);
  assert.ok(changed.reasons.includes('manual_mask_edit'));assert.equal((await currentArt()).version,originalArt.version);assert.equal((await currentArt()).logoUrl,null);
  const preview=await request('GET',changed.previewUrl),decoded=await sharp(preview.rawPayload).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const sourceRgb=await sharp(source.rawPayload).removeAlpha().raw().toBuffer(),bounds=changed.mask.previewRegion;
  const offset=(x:number,y:number)=>((y-Math.round(bounds.top*640))*decoded.info.width+x-Math.round(bounds.left*480))*4;
  const restored=offset(240,448),erased=offset(72,240);assert.equal(decoded.data[restored+3],255);assert.equal(decoded.data[erased+3],0);
  assert.deepEqual(decoded.data.subarray(restored,restored+3),sourceRgb.subarray((448*480+240)*3,(448*480+240)*3+3));
  assert.equal(createHash('sha256').update((await request('GET',before.mask.canvas.baselineUrl)).rawPayload).digest('hex'),baselineBefore);
  assert.equal((await request('GET',before.previewUrl)).statusCode,409,'a versioned old URL cannot silently show a newer preview');
  assert.equal((await edit(id,0,[restore])).statusCode,409);
  assert.equal((await request('POST',base+'/'+id+'/apply',{})).statusCode,409,'an older client cannot apply unseen corrections');
  assert.equal((await request('POST',base+'/'+id+'/apply',{expectedMaskRevision:0})).statusCode,409);
  const reset=await edit(id,1,[]);assert.equal(reset.statusCode,200,reset.body);assert.equal(reset.json().job.mask.revision,2);
  assert.deepEqual(reset.json().job.mask.strokes,[]);assert.equal((await edit(id,1,[restore])).statusCode,409);
  const applied=await request('POST',base+'/'+id+'/apply',{expectedMaskRevision:2});assert.equal(applied.statusCode,200,applied.body);
  assert.equal(applied.json().titleArt.mode,'custom');assert.equal(applied.json().titleArt.attribution.source,'Cover lettering');
  assert.equal((await readdir(core.EXTRACTION_DIR)).some(n=>n.startsWith(id+'.')),false,'Apply removes baseline, raw mask and all private revisions');
});
test('an isolated restored pixel keeps exact alpha bounds and source color in both preview and published artwork', {skip},async()=>{
  const rgb=Buffer.alloc(600*900*3,184),pixel=(720*600+480)*3;rgb[pixel]=23;rgb[pixel+1]=141;rgb[pixel+2]=205;
  const source=await sharp(rgb,{raw:{width:600,height:900,channels:3}}).png().toBuffer();
  const upload=await request('PUT',`/api/admin/series/${SID}/art`,{kind:'cover',mode:'upload',dataUrl:'data:image/png;base64,'+source.toString('base64')});
  assert.equal(upload.statusCode,200,upload.body);
  core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),worker:async(bytes,selection)=>({
    ...await worker(bytes,selection),sourceWidth:600,sourceHeight:900,candidateRegion:{left:60/600,top:100/900,width:240/600,height:80/900},
  })});
  const id=await makeReady(),snapshot=await request('GET',(await jobState(id)).mask.canvas.sourceUrl);
  const sourceRgb=await sharp(snapshot.rawPayload).removeAlpha().raw().toBuffer();
  const saved=await edit(id,0,[{mode:'restore',radius:.0005,points:[{x:480.5/600,y:720.5/900}]}]);
  assert.equal(saved.statusCode,200,saved.body);const job=saved.json().job;
  assert.deepEqual(job.mask.previewRegion,{left:80/600,top:120/900,width:401/600,height:601/900});
  const preview=await request('GET',job.previewUrl);assert.equal(preview.statusCode,200);
  const decoded=await sharp(preview.rawPayload).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.deepEqual([decoded.info.width,decoded.info.height],[401,601],'a detached restored pixel remains inside the final bounds');
  const last=(600*401+400)*4;assert.deepEqual([...decoded.data.subarray(last,last+4)],[...sourceRgb.subarray(pixel,pixel+3),255]);
  const first=(120*600+80)*3;assert.deepEqual([...decoded.data.subarray(0,4)],[...sourceRgb.subarray(first,first+3),255],'existing lettering uses source colors too');
  assert.equal(decoded.data[((600*401)+399)*4+3],0,'adjacent background remains transparent');
  const applied=await request('POST',base+'/'+id+'/apply',{expectedMaskRevision:1});assert.equal(applied.statusCode,200,applied.body);
  assert.deepEqual((await art.readTitleLogo(SID))!.bytes,preview.rawPayload,'Apply publishes exactly the decoded and reviewed preview');
});
test('mask correction is admin/owner authorized and validates bounded source-only strokes', {skip},async()=>{
  const id=await makeCorrectable(),job=await jobState(id),url=base+'/'+id+'/mask';
  assert.equal((await app.inject({method:'PATCH',url,payload:{expectedRevision:0,strokes:[]}})).statusCode,401);
  assert.equal((await edit(id,0,[],member)).statusCode,403);assert.equal((await edit(id,0,[],other)).statusCode,404);
  assert.equal((await request('GET',job.mask.canvas.baselineUrl,undefined,other)).statusCode,404);
  assert.equal((await request('GET',job.mask.canvas.baselineUrl,undefined,member)).statusCode,403);
  for(const body of[{expectedRevision:0,strokes:[],rgb:'arbitrary'},{expectedRevision:-1,strokes:[]},{expectedRevision:0,strokes:[{...restore,radius:.1}]},
    {expectedRevision:0,strokes:[{...restore,points:[]}]},{expectedRevision:0,strokes:[{...restore,points:[{x:2,y:.1}]}]},
    {expectedRevision:0,strokes:Array.from({length:129},()=>restore)},
    {expectedRevision:0,strokes:[{...restore,points:Array.from({length:8192},()=>({x:.1,y:.2}))},restore]}])
    assert.equal((await request('PATCH',url,body)).statusCode,400);
  assert.equal((await jobState(id)).mask.revision,0);assert.equal((await currentArt()).logoUrl,null);
});
test('concurrent corrections accept one revision and persist only its winning private preview', {skip},async()=>{
  const id=await makeCorrectable(),results=await Promise.all([edit(id,0,[restore]),edit(id,0,[erase])]);
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);const saved=(await jobState(id));assert.equal(saved.mask.revision,1);
  assert.deepEqual(saved.mask.strokes,results.find(r=>r.statusCode===200)!.json().job.mask.strokes);
  assert.equal((await readdir(core.EXTRACTION_DIR)).filter(n=>n.startsWith(id+'.revision.')).length,1);
  await request('DELETE',base+'/'+id);assert.equal((await readdir(core.EXTRACTION_DIR)).some(n=>n.startsWith(id+'.')),false);
});
test('private preview filenames reject traversal, another job and malformed revision identities', {skip},async()=>{
  const id=await makeCorrectable(),saved=await edit(id,0,[restore]);assert.equal(saved.statusCode,200,saved.body);
  const original=(await q('SELECT mask_preview_file FROM series_title_extractions WHERE id=$1',[id]))[0].mask_preview_file;
  const otherId=await makeCorrectable(),otherSaved=await edit(otherId,0,[restore]);assert.equal(otherSaved.statusCode,200,otherSaved.body);
  const otherName=(await q('SELECT mask_preview_file FROM series_title_extractions WHERE id=$1',[otherId]))[0].mask_preview_file;
  const sentinel=join(ROOT,'private-preview-sentinel.webp'),bytes=(await request('GET',saved.json().job.previewUrl)).rawPayload;
  const malformed=`${id}.revision.1.${'a'.repeat(36)}.webp`;
  await writeFile(sentinel,bytes);await writeFile(join(core.EXTRACTION_DIR,malformed),bytes);
  try{
    for(const name of[sentinel,'../private-preview-sentinel.webp',otherName,malformed]){
      await q('UPDATE series_title_extractions SET mask_preview_file=$2 WHERE id=$1',[id,name]);
      assert.equal((await request('GET',saved.json().job.previewUrl)).statusCode,404,name);
      assert.equal((await request('POST',base+'/'+id+'/apply',{expectedMaskRevision:1})).statusCode,404,name);
    }
    assert.equal((await request('GET',base+'/'+encodeURIComponent('../'+id)+'/preview')).statusCode,404);
    assert.deepEqual(await readFile(sentinel),bytes,'refused paths never modify files outside the private directory');
    assert.equal((await request('GET',otherSaved.json().job.previewUrl)).statusCode,200,'the other job remains intact');
  }finally{await q('UPDATE series_title_extractions SET mask_preview_file=$2 WHERE id=$1',[id,original]);await rm(sentinel,{force:true});}
  assert.equal((await request('GET',saved.json().job.previewUrl)).statusCode,200);assert.equal((await currentArt()).logoUrl,null);
});
test('cover/title changes and baseline corruption reject corrections without publishing', {skip},async()=>{
  let id=await makeCorrectable();await request('PUT',`/api/admin/series/${SID}/art`,{kind:'logo',mode:'style',style:'fantasy'});
  assert.equal((await edit(id,0,[restore])).statusCode,409);await core.dropTitleExtractions(SID);
  id=await makeCorrectable();await q("UPDATE series_trackers SET external_id='9999' WHERE series_id=$1",[SID]);
  assert.equal((await edit(id,0,[restore])).statusCode,409);await q("UPDATE series_trackers SET external_id='87216' WHERE series_id=$1",[SID]);await core.dropTitleExtractions(SID);
  id=await makeCorrectable();await writeFile(join(core.EXTRACTION_DIR,id+'.mask-base.png'),Buffer.from('corrupt baseline'));
  assert.equal((await edit(id,0,[restore])).statusCode,409);assert.equal((await jobState(id)).mask.revision,0);await core.dropTitleExtractions(SID);
  id=await makeCorrectable();const path=join(core.EXTRACTION_DIR,id+'.mask-base.png');await rm(path);await symlink(join(core.EXTRACTION_DIR,id+'.png'),path);
  assert.equal((await edit(id,0,[restore])).statusCode,404);assert.equal((await currentArt()).logoUrl,null);
});
test('Apply rechecks the preview revision after waiting for its job row lock', {skip},async()=>{
  const id=await makeCorrectable(),client=await pool.connect();let committed=false;
  try{
    await client.query('BEGIN');await client.query('SELECT id FROM series_title_extractions WHERE id=$1 FOR UPDATE',[id]);
    const applying=request('POST',base+'/'+id+'/apply',{});let waiting=false;
    for(let n=0;n<100;n++){
      const rows=await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%series_title_extractions%FOR UPDATE%'");
      if(rows.length){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(waiting,true,'Apply has read the old revision and is waiting for the job lock');
    await client.query('UPDATE series_title_extractions SET mask_revision=1 WHERE id=$1',[id]);await client.query('COMMIT');committed=true;
    const response=await applying;assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error,'stale_mask');assert.equal((await currentArt()).logoUrl,null);
  }finally{if(!committed)await client.query('ROLLBACK');client.release();}
});

test('shared automatic review drafts can be corrected explicitly but never retain automatic certification', {skip},async()=>{
  const id=await makeCorrectable();await q('UPDATE series_title_extractions SET automatic=true,owner_id=NULL WHERE id=$1',[id]);
  const response=await edit(id,0,[restore],other);assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().job.automatic,true);assert.equal(response.json().job.quality.safeToApply,false);
  const job=await jobState(id);assert.equal(job.mask.revision,1);assert.equal((await currentArt()).logoUrl,null);
});
test('empty output, work-budget abuse, changed covers and expiry leave the saved draft untouched', {skip},async()=>{
  let id=await makeCorrectable();
  const wipe={mode:'erase',radius:.05,points:[{x:0,y:.3125},{x:1,y:.3125},{x:1,y:.36},{x:0,y:.36},{x:0,y:.40625},{x:1,y:.40625},{x:1,y:.4375},{x:0,y:.4375}]};
  assert.equal((await edit(id,0,[wipe])).statusCode,422);assert.equal((await jobState(id)).mask.revision,0);
  const excessive={...restore,points:Array.from({length:8192},(_,n)=>({x:n%2,y:n%2}))};
  const refusal=await edit(id,0,[excessive]);assert.equal(refusal.statusCode,400);assert.equal(refusal.json().error,'mask_too_complex');
  const replacement=await sharp({create:{width:480,height:640,channels:3,background:'#aabbcc'}}).png().toBuffer();
  await request('PUT',`/api/admin/series/${SID}/art`,{kind:'cover',mode:'upload',dataUrl:'data:image/png;base64,'+replacement.toString('base64')});
  assert.equal((await edit(id,0,[restore])).statusCode,409);await core.dropTitleExtractions(SID);
  id=await makeCorrectable();await q("UPDATE series_title_extractions SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
  assert.equal((await edit(id,0,[restore])).statusCode,410);await core.cleanupTitleExtractions();
  assert.equal((await readdir(core.EXTRACTION_DIR)).some(n=>n.startsWith(id+'.')),false);
});
test('startup validates the current correction revision and cleanup removes abandoned immutable files', {skip},async()=>{
  const id=await makeCorrectable(),saved=await edit(id,0,[restore]);assert.equal(saved.statusCode,200);
  await core.initializeTitleExtractions();assert.equal((await jobState(id)).status,'ready');
  const row=(await q('SELECT mask_preview_file FROM series_title_extractions WHERE id=$1',[id]))[0];await rm(join(core.EXTRACTION_DIR,row.mask_preview_file));
  await core.initializeTitleExtractions();assert.equal((await jobState(id)).error,'extract_interrupted');
  await core.dropTitleExtractions(SID);assert.equal((await readdir(core.EXTRACTION_DIR)).some(n=>n.startsWith(id+'.')),false);
});
test('a valid high-entropy full-resolution cover saves a small title without encoding the whole RGB canvas as RGBA', {skip},async()=>{
  const width=1800,height=2400,rgb=Buffer.alloc(width*height*3);let state=0x12345678;
  for(let n=0;n<rgb.length;n++){state^=state<<13;state^=state>>>17;state^=state<<5;rgb[n]=state>>>26;}
  const source=await sharp(rgb,{raw:{width,height,channels:3}}).png().toBuffer();
  const{ART_MAX_BYTES,artFile}=await import('../src/lib/seriesArt');assert.ok(source.length<ART_MAX_BYTES);
  const alpha=new Uint8Array(width*height);for(let y=1000;y<1200;y++)alpha.fill(255,y*width+700,y*width+1100);
  const{sourceRgba}=await import('../src/lib/titleMaskProjection');
  const oversized=await sharp(sourceRgba(rgb,alpha),{raw:{width,height,channels:4}}).png().toBuffer();
  assert.ok(oversized.length>ART_MAX_BYTES,'the former full-canvas encoding exceeds the cap although the original cover fits');
  // Local cover-pipeline fixture: a real source/page cover may retain higher resolution than an admin upload.
  await writeFile(artFile(SID,'cover'),source);
  const rgba=Buffer.alloc(400*200*4,255);rgba[3]=0;const rawCandidate=await sharp(rgba,{raw:{width:400,height:200,channels:4}}).png().toBuffer();
  core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>quality(),worker:async(bytes,selection)=>({
    ...await worker(bytes,selection),bytes:rawCandidate,width:400,height:200,sourceWidth:width,sourceHeight:height,
    candidateRegion:{left:700/width,top:1000/height,width:400/width,height:200/height},
  })});
  const id=await makeReady(),job=await jobState(id);assert.deepEqual([job.mask.canvas.width,job.mask.canvas.height],[width,height]);
  const baseline=await request('GET',job.mask.canvas.baselineUrl);assert.ok(baseline.rawPayload.length<100_000,'zero-RGB alpha baseline does not duplicate cover entropy');
  const saved=await edit(id,0,[]);assert.equal(saved.statusCode,200,saved.body);
  const preview=await request('GET',saved.json().job.previewUrl);assert.equal(preview.statusCode,200);const meta=await sharp(preview.rawPayload).metadata();
  assert.equal(meta.width,400);assert.equal(meta.height,200);assert.equal((await currentArt()).logoUrl,null);
});

test('a durable one-off batch creates a retained private preview while nightly generation is off', {skip},async()=>{
  const batch=await import('../src/lib/titleExtractionBatch');await batch.initializeTitleExtractionBatch();batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64)});
  try{
    await q('UPDATE server_settings SET automatic_cover_title_generation=false,automatic_cover_title_apply=false WHERE id=1');
    const start=await request('POST','/api/admin/title-extraction/batch/run',{});assert.equal(start.statusCode,202,start.body);
    await batch.titleExtractionBatchSettled();const state=(await request('GET','/api/admin/title-extraction/batch/status')).json();
    assert.equal(state.enabled,false);assert.equal(state.running,false);assert.equal(state.run.status,'completed');
    assert.equal(state.run.counts.total,1);assert.equal(state.run.counts.ready,1);assert.equal(state.run.counts.applied,0);
    assert.equal(state.reviewCount,1);assert.equal(state.reviewSeries[0].id,SID);assert.equal((await currentArt()).logoUrl,null);
    const job=await jobState(state.reviewSeries[0].jobId);assert.ok(new Date(job.expiresAt).getTime()>Date.now()+13*86400000);
  }finally{batch.stopTitleExtractionBatch();batch.setTitleExtractionBatchForTests();}
});
test('new batch publication requires both opt-ins and measured checks, without requiring legacy provider-miss consent', {skip},async()=>{
  const batch=await import('../src/lib/titleExtractionBatch');await batch.initializeTitleExtractionBatch();batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64)});
  core.setTitleExtractionForTests({worker,ready:async()=>true,assess:async()=>({...quality(),availableChecksPassed:true}),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'a'.repeat(64)})});
  try{
    await q('UPDATE server_settings SET automatic_cover_title_generation=true,automatic_cover_title_apply=true,automatic_cover_titles=false WHERE id=1');
    await q('UPDATE libraries SET anilist_lookup=false WHERE id=$1',[LIB]);
    const start=await request('POST','/api/admin/title-extraction/batch/run',{});assert.equal(start.statusCode,202,start.body);await batch.titleExtractionBatchSettled();
    const state=(await request('GET','/api/admin/title-extraction/batch/status')).json();assert.equal(state.run.counts.applied,1,JSON.stringify(state));
    const title=await currentArt();assert.equal(title.mode,'automatic');assert.equal(title.attribution?.source,'Cover lettering');
    const[job]=await q('SELECT quality,status FROM series_title_extractions WHERE series_id=$1',[SID]);assert.equal(job.quality.safeToApply,false);assert.equal(job.quality.availableChecksPassed,true);assert.equal(job.status,'applied');
  }finally{await q('UPDATE server_settings SET automatic_cover_title_generation=false,automatic_cover_title_apply=false WHERE id=1');batch.stopTitleExtractionBatch();batch.setTitleExtractionBatchForTests();}
});
test('enabling online discovery during extraction requires a current completed miss before automatic publication', {skip},async()=>{
  const batch=await import('../src/lib/titleExtractionBatch');batch.setTitleExtractionBatchForTests({model:async()=>'a'.repeat(64)});let releaseProvider:(()=>void)|undefined;
  try{for(const result of['unchecked','error','expired','other_identity','ready','pending','missing']){
    batch.stopTitleExtractionBatch();await core.dropTitleExtractions(SID);await q('DELETE FROM title_extraction_runs');await q('DELETE FROM series_title_extraction_history WHERE series_id=$1',[SID]);
    await q('UPDATE server_settings SET automatic_title_logos=false,automatic_cover_title_generation=true,automatic_cover_title_apply=true WHERE id=1');
    await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1',[LIB]);
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    core.setTitleExtractionForTests({ready:async()=>true,assess:async()=>({...quality(),availableChecksPassed:true}),ocrCapability:async()=>({available:true,calibrated:false,verifierFingerprint:'a'.repeat(64)}),
      worker:async(bytes,selection)=>{entered();await gate;return worker(bytes,selection);}});
    await batch.initializeTitleExtractionBatch();
    try{
      const start=await request('POST','/api/admin/title-extraction/batch/run',{});assert.equal(start.statusCode,202,start.body);await started;
      await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');
      await q(`INSERT INTO series_title_art(series_id,lookup_status,lookup_anilist_id,retry_at)VALUES($1,$2,$3,$4)
        ON CONFLICT(series_id)DO UPDATE SET lookup_status=$2,lookup_anilist_id=$3,retry_at=$4`,
        [SID,result==='error'?'error':result==='ready'?'ready':'missing',result==='unchecked'?null:result==='other_identity'?'99999':'87216',result==='unchecked'?null:new Date(Date.now()+(result==='expired'?-60_000:3600_000))]);
      if(result==='pending'){
        let providerEntered!:()=>void;const providerStarted=new Promise<void>(r=>{providerEntered=r;}),providerGate=new Promise<void>(r=>{releaseProvider=r;});
        art.setTitleLogoLookupForTests(async()=>{providerEntered();await providerGate;return{kind:'missing'};});
        await art.queueTitleLogos([SID],'manual');await providerStarted;
      }
    }finally{release();}
    await batch.titleExtractionBatchSettled();await core.titleExtractionsSettled();
    const state=(await request('GET','/api/admin/title-extraction/batch/status')).json(),published=result==='missing';
    assert.equal(state.run.counts.applied,published?1:0,result);assert.equal(state.run.counts.ready,published?0:1,result);
    assert.equal(!!(await currentArt()).logoUrl,published,result);
    if(!published){const[job]=await q('SELECT id,status FROM series_title_extractions WHERE series_id=$1',[SID]);assert.equal(job.status,'ready');assert.equal((await request('GET',(await jobState(job.id)).previewUrl)).statusCode,200);}
    releaseProvider?.();await art.titleLogoQueueSettled();art.setTitleLogoLookupForTests();releaseProvider=undefined;
  }}finally{releaseProvider?.();await art.titleLogoQueueSettled();art.setTitleLogoLookupForTests();await q('UPDATE server_settings SET automatic_title_logos=false,automatic_cover_title_generation=false,automatic_cover_title_apply=false WHERE id=1');batch.stopTitleExtractionBatch();batch.setTitleExtractionBatchForTests();}
});
