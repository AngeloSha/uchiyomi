import {randomUUID} from 'node:crypto';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN=process.env.TEST_DATABASE_URL;
const skip=DSN ? false : 'set TEST_DATABASE_URL to run';
let root:string, app:any, q:any, a:string, b:string, admin:string, privateSeries:string, privateBook:string;
let scopes:typeof import('../src/lib/contentScope');
let vis:typeof import('../src/lib/visibility');
let trackers:typeof import('../src/lib/trackers');
let providers:typeof import('../src/lib/trackerProviders');
const realFetch=globalThis.fetch;
let delayedGate=Promise.resolve(),releaseDelayed=()=>{},enterDelayed=()=>{},delayedWrites=0;
const as=(id:string, role='user')=>({authorization:`Bearer ${app.jwt.sign({sub:id,role})}`});
const cookie=(id:string)=>({cookie:`yomi_img=${app.jwt.sign({sub:id,typ:'img'})}`});

before(async()=>{
  if(!DSN) return;
  root=await mkdtemp(join(tmpdir(),'uchiyomi-private-library-'));
  Object.assign(process.env,{DATABASE_URL:DSN,JWT_SECRET:'private-library-test-secret-32-chars',CONFIG_DIR:join(root,'config'),
    CACHE_DIR:join(root,'cache'),LIBRARY_ROOT:join(root,'library'),DL_ROOT:join(root,'downloads'),LIBRARY_BACKEND:'owned',MIN_FREE_GB:'0',UCHIYOMI_PING_URL:''});
  await mkdir(process.env.LIBRARY_ROOT!,{recursive:true});
  globalThis.fetch=(async()=>{throw new Error('Private library tests cannot call external services');}) as typeof fetch;
  ({q}=await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  scopes=await import('../src/lib/contentScope'); vis=await import('../src/lib/visibility');
  trackers=await import('../src/lib/trackers'); providers=await import('../src/lib/trackerProviders');
  const users=await q(`INSERT INTO users(username,display_name,password_hash,role,auth_kind,perms)
    VALUES('private-fixture-a','A','x','user','password','{"canUploadManually":true}'),
    ('private-fixture-b','B','x','user','password','{}'),('private-fixture-admin','Admin','x','admin','password','{}') RETURNING id,username`);
  a=users.find((u:any)=>u.username.endsWith('-a')).id;b=users.find((u:any)=>u.username.endsWith('-b')).id;
  admin=users.find((u:any)=>u.username.endsWith('-admin')).id;
  const scope=await scopes.resolveAddScope(await vis.viewCtxFor(a),{visibility:'private'});
  const folder=`${scope.folderPrefix}/Fixture/Secret title`;
  const path=join(process.env.DL_ROOT!,folder);
  await mkdir(path,{recursive:true});
  const zip=new ((await import('adm-zip')).default)();
  zip.addFile('001.png',await (await import('sharp')).default({create:{width:8,height:8,channels:3,background:'#34aabb'}}).png().toBuffer());
  await writeFile(join(path,'Chapter 1.cbz'),zip.toBuffer());
  await (await import('../src/lib/library')).persistScan();
  const [series]=await q('SELECT id FROM lib_series WHERE folder=$1',[folder]);privateSeries=series.id;
  privateBook=(await q('SELECT id FROM lib_books WHERE series_id=$1',[privateSeries]))[0].id;
  app=(await import('fastify')).default();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
  const images=await import('../src/routes/images');
  app.addHook('preHandler',async(req:any,reply:any)=>{if(req.url.startsWith('/img/'))await images.authorizeImageRequest(app,req,reply);});
  app.addHook('onSend',async(req:any,reply:any,payload:any)=>{await (await import('../src/routes/privateLibrary')).privateResponseHeaders(req,reply);return payload;});
  await app.register((await import('../src/routes/privateLibrary')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/downloads')).default);
  await app.register(images.default);
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/comments')).default);
  await app.register(async (fixture:any)=>{
    const auth=await import('../src/lib/auth'),guard=await import('../src/lib/privateAdmin');
    fixture.addHook('preHandler',auth.authenticate);fixture.addHook('preHandler',auth.requireAdmin);
    fixture.addHook('preHandler',guard.privateAdminContentGuard);
    fixture.put('/api/admin/series/:id/private-delay-fixture',async(req:any)=>{
      enterDelayed();await delayedGate;
      await q('UPDATE lib_series SET auto_update=false WHERE id=$1',[req.params.id]);delayedWrites++;
      return {ok:true};
    });
  });
  await app.ready();
});

after(async()=>{
  if(!DSN)return;
  releaseDelayed();globalThis.fetch=realFetch;await app?.close();
  const ids=[a,b,admin].filter(Boolean);
  await q('DELETE FROM lib_series WHERE owner_user_id=ANY($1::uuid[]) OR source_id=$2',[ids,'private_fixture_source']);
  await q('DELETE FROM libraries WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await q('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);
  await rm(root,{recursive:true,force:true});
});

test('scanner assigns owner and privacy before a new reserved folder becomes readable',{skip},async()=>{
  const [row]=await q('SELECT owner_user_id,is_private,library_id FROM lib_series WHERE id=$1',[privateSeries]);
  assert.equal(row.owner_user_id,a);assert.equal(row.is_private,true);
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(a)),true);
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(b)),false);
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(admin,'admin')),false);
  assert.equal(await vis.seriesVisible(privateSeries,vis.SYSTEM_CTX),true);
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(null)),false);
});
test('two accounts cannot name private libraries or access titles, manifests, images or page aliases by ID',{skip},async()=>{
  for(const url of [`/api/series/${privateSeries}`,`/api/books/${privateBook}/download-manifest`,`/api/series/${privateSeries}/privacy`]){
    const denied=await app.inject({url,headers:as(b)});assert.equal(denied.statusCode,404,`${url}: ${denied.body}`);
    const allowed=await app.inject({url,headers:as(a)});assert.equal(allowed.statusCode,200,`${url}: ${allowed.body}`);
    assert.equal(allowed.headers['x-uchiyomi-private'],'1');assert.match(allowed.headers['cache-control'],/no-store/);
  }
  for(const url of [`/img/books/${privateBook}/page/1`,`/img/lib/books/${privateBook}/page/1`]){
    const denied=await app.inject({url,headers:cookie(b)});assert.equal(denied.statusCode,404,`${url}: ${denied.body}`);
    const allowed=await app.inject({url,headers:cookie(a)});assert.equal(allowed.statusCode,200,`${url}: ${allowed.body}`);
  }
  const libraries=(await app.inject({url:'/api/libraries',headers:as(b)})).json();
  assert.ok(!JSON.stringify(libraries).includes(`private_${a}`));
});
test('own private library is independent of shared allowlist, but deny-all and disabled account stay authoritative',{skip},async()=>{
  await q("INSERT INTO user_libraries(user_id,library_id) VALUES($1,'unrelated')",[a]);
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(a)),true);
  await q("UPDATE user_libraries SET library_id='' WHERE user_id=$1",[a]);
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(a)),false);
  const deniedCtx=await vis.viewCtxFor(a);
  await assert.rejects(()=>scopes.resolveAddScope(deniedCtx,{visibility:'private'}));
  await q('DELETE FROM user_libraries WHERE user_id=$1',[a]);
  await q('UPDATE users SET disabled=true WHERE id=$1',[a]);
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(a)),false);
  await q('UPDATE users SET disabled=false WHERE id=$1',[a]);
});
test('orphan reserved folders fail closed instead of becoming shared library content',{skip},async()=>{
  await assert.rejects(()=>scopes.privateScopeForFolder('_private/not-a-user/Fixture/Title'),/orphan_private_folder/);
  await assert.rejects(()=>scopes.privateScopeForFolder('_private/00000000-0000-4000-8000-000000000001/Fixture/Title'),/orphan_private_folder/);
});
test('defaults remain shared; opting in affects only later additions and rejects a client owner',{skip},async()=>{
  assert.equal((await app.inject({url:'/api/personal/privacy',headers:as(b)})).json().defaultPrivate,false);
  const enabled=await app.inject({method:'PUT',url:'/api/personal/privacy',headers:as(b),payload:{defaultPrivate:true}});
  assert.equal(enabled.statusCode,200);assert.equal((await scopes.resolveAddScope(await vis.viewCtxFor(b))).ownerUserId,b);
  assert.equal((await scopes.resolveAddScope(await vis.viewCtxFor(b),{visibility:'shared'})).visibility,'shared');
  const spoof=await app.inject({method:'PUT',url:'/api/personal/privacy',headers:as(b),payload:{defaultPrivate:true,ownerUserId:a}});
  assert.equal(spoof.statusCode,400);
});
test('safe owner publication and revocation keep series and book identities; other accounts cannot change it',{skip},async()=>{
  const before=(await q('SELECT id,file FROM lib_books WHERE series_id=$1',[privateSeries]))[0];
  assert.equal((await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(b),payload:{isPrivate:false}})).statusCode,404);
  await q('INSERT INTO reading_events(user_id,series_id,book_id,page,completed,is_private) VALUES($1,$2,$3,1,true,true)',[a,privateSeries,privateBook]);
  const publication=await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:false}});
  assert.equal(publication.statusCode,200);assert.equal(publication.headers['x-uchiyomi-private'],'1');
  const historical=await app.inject({url:`/api/series/${privateSeries}`,headers:as(a)});
  assert.equal(historical.headers['x-uchiyomi-private'],'1','private history remains uncached after publishing the last private title');
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(b)),true);
  assert.equal((await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:true}})).statusCode,200);
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(b)),false);
  assert.deepEqual((await q('SELECT id,file FROM lib_books WHERE series_id=$1',[privateSeries]))[0],before);
});
test('private AniList protection runs even with an imported chapter floor and unsupported providers cannot publish',{skip},async()=>{
  const adapter=providers.ADAPTERS.anilist;const oldState=adapter.seriesState,oldPrivate=adapter.setPrivate,oldProgress=adapter.setProgress;
  const calls:any[]=[];
  adapter.seriesState=async()=>({ended:false,total:null,entry:{status:'reading',progress:150,private:false}});
  adapter.setPrivate=async(_token,id)=>{calls.push({private:id});return true;};
  adapter.setProgress=async(...args)=>{calls.push({progress:args});};
  try{
    const token=(await import('../src/lib/secretbox')).seal('private-test-token');
    await q("INSERT INTO user_trackers(user_id,provider,access_token) VALUES($1,'anilist',$2)",[a,token]);
    await q("INSERT INTO series_trackers(series_id,provider,external_id) VALUES($1,'anilist','123456')",[privateSeries]);
    await q('INSERT INTO read_progress(user_id,book_id,series_id,page,completed) VALUES($1,$2,$3,1,true)',[a,privateBook,privateSeries]);
    await trackers.seedTrackerFloor(a,privateSeries,'anilist',150);
    await trackers.pushSeriesProgress(a,privateSeries);
    assert.ok(calls.some(c=>c.private==='123456'),'privacy must not be skipped by chapter floor');
    assert.ok(!calls.some(c=>c.progress),'imported progress must not be rewound');
    await trackers.clearTrackerFloor(a,privateSeries,'anilist');
    adapter.seriesState=async()=>({ended:false,total:null,entry:null});calls.length=0;
    await q("UPDATE tracker_entry_privacy SET sync_state='pending' WHERE user_id=$1 AND provider='anilist'",[a]);
    await trackers.pushSeriesProgress(a,privateSeries);
    assert.equal(calls.find(c=>c.progress)?.progress[5]?.private,true,'first external entry is created atomically private');
    assert.equal((await q("SELECT sync_state FROM tracker_entry_privacy WHERE user_id=$1 AND provider='anilist'",[a]))[0].sync_state,'applied');

    await trackers.rememberTrackerPrivacy(a,'myanimelist','654321',true);
    assert.equal(await trackers.trackerPrivateRequired(a,'myanimelist','654321'),true);
    await trackers.rememberTrackerPrivacy(a,'myanimelist','654321',false);
    assert.equal(await trackers.trackerPrivateRequired(a,'myanimelist','654321'),true,'shared state never makes remote entry public');
    await q("INSERT INTO user_trackers(user_id,provider,access_token) VALUES($1,'myanimelist',$2)",[a,token]);
    await q("INSERT INTO series_trackers(series_id,provider,external_id) VALUES($1,'myanimelist','654321')",[privateSeries]);
    const mal=providers.ADAPTERS.myanimelist;const oldMalProgress=mal.setProgress;let publicWrites=0;
    mal.setProgress=async()=>{publicWrites++;};
    try{await trackers.pushSeriesProgress(a,privateSeries);assert.equal(publicWrites,0);}
    finally{mal.setProgress=oldMalProgress;}
    assert.equal((await q("SELECT sync_state FROM tracker_entry_privacy WHERE user_id=$1 AND provider='myanimelist'",[a]))[0].sync_state,'error');
  }finally{adapter.seriesState=oldState;adapter.setPrivate=oldPrivate;adapter.setProgress=oldProgress;}
});


test('source identity, title duplicates and language editions remain inside the selected ownership scope',{skip},async()=>{
  const {registerAdapter}=await import('../src/lib/sources');
  registerAdapter({id:'private_fixture_source',name:'Private Fixture Source',lang:'en',
    async search(){return [];},async getSeries(){return {title:'Same source title',summary:'',author:''};},
    async listChapters(){return [{id:'chapter1',number:1,title:'Chapter 1'}];},async getPageUrls(){return [];} } as any);
  const add=async(id:string,visibility:'shared'|'private')=>{
    const result=await app.inject({method:'POST',url:'/api/sources/add',headers:as(id,id===admin?'admin':'user'),
      payload:{source:'private_fixture_source',sourceId:'entry',chapterFrom:'none',visibility}});
    assert.equal(result.statusCode,200,result.body);return result.json();
  };
  const shared=await add(admin,'shared'),ownA=await add(a,'private'),ownB=await add(b,'private');
  assert.equal(new Set([shared.seriesId,ownA.seriesId,ownB.seriesId]).size,3,'each scope has its own series identity');
  assert.notEqual(shared.folder,ownA.folder);assert.notEqual(ownA.folder,ownB.folder);
  assert.equal((await add(a,'private')).seriesId,ownA.seriesId,'repeat add is idempotent within own private scope');
  const linked=await (await import('../src/lib/editions')).linkEdition(ownA.seriesId,{of:ownB.seriesId,lang:'ja'});
  assert.equal(linked,'gone','no cross-account work or tracker link can be created');
  assert.equal((await (await import('../src/lib/libraryAdmin')).mergeRefusal(ownA.seriesId,shared.seriesId))?.refused,'different_scope');
  const published=await app.inject({method:'PUT',url:`/api/series/${ownA.seriesId}/privacy`,headers:as(a),payload:{isPrivate:false}});
  assert.equal(published.statusCode,409,'an existing shared source copy blocks implicit publication merging');
  await q('DELETE FROM lib_series WHERE id=$1',[shared.seriesId]);
  assert.equal((await app.inject({method:'PUT',url:`/api/series/${ownA.seriesId}/privacy`,headers:as(a),payload:{isPrivate:false}})).statusCode,200);
  const freshPrivate=await add(a,'private');
  assert.notEqual(freshPrivate.folder,ownA.folder,'private add never writes into its published predecessor’s physical folder');
  assert.notEqual(freshPrivate.seriesId,ownA.seriesId);
  const publicIdx=await (await import('../src/lib/discoverIdentity')).libraryIndex(await vis.viewCtxFor(admin,'admin'));
  assert.ok(![...publicIdx.byName.values()].flat().some(row=>row.id===freshPrivate.seriesId || row.id===ownB.seriesId));
  const bad=await app.inject({url:'/api/sources/detail?source=private_fixture_source&sourceId=entry&visibility=invalid',headers:as(a)});
  assert.equal(bad.statusCode,400);
});


test('deleting an account or managed library with private content is a safe conflict, never an orphan or publication',{skip},async()=>{
  const result=await app.inject({method:'DELETE',url:`/api/admin/users/${a}`,headers:as(admin,'admin')});
  assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'private_content_owned');
  const library=(await q('SELECT id FROM libraries WHERE owner_user_id=$1',[a]))[0].id;
  const removal=await app.inject({method:'DELETE',url:`/api/admin/libraries/${library}`,headers:as(admin,'admin')});
  assert.equal(removal.statusCode,404,'another administrator cannot name a private library');
  const ownAdminLibrary=await scopes.ensurePrivateLibrary(admin);
  assert.equal((await app.inject({method:'DELETE',url:`/api/admin/libraries/${ownAdminLibrary.libraryId}`,headers:as(admin,'admin')})).statusCode,409,'own managed library has an explicit protected lifecycle');
  assert.equal(await vis.seriesVisible(privateSeries,await vis.viewCtxFor(b)),false);
  const [empty]=await q("INSERT INTO users(username,display_name,password_hash,role,auth_kind) VALUES('private-fixture-empty','Empty','x','user','password') RETURNING id");
  await scopes.ensurePrivateLibrary(empty.id);
  assert.equal(await scopes.deleteAccountPreservingPrivate(empty.id),'deleted','empty managed metadata can be removed safely');
});
test('privacy response classification failure disables implicit caching',{skip},async()=>{
  const headers=new Map<string,unknown>([['Vary','Accept-Encoding']]);
  await (await import('../src/routes/privateLibrary')).privateResponseHeaders({url:'/api/history',viewCtx:{userId:'invalid-uuid'}} as any,
    {header(name:string,value:unknown){headers.set(name,value);return this;},getHeader(name:string){return headers.get(name);}} as any);
  assert.equal(headers.get('X-Uchiyomi-Private'),'1');assert.match(String(headers.get('Cache-Control')),/no-store/);
  assert.match(String(headers.get('Vary')),/Accept-Encoding/);
});


test('a member can pause, remove, restore and explicitly delete only their never-published private copy',{skip},async()=>{
  const scope=await scopes.ensurePrivateLibrary(a),folder=`${scope.folderPrefix}/Fixture/Owner managed`;
  const file=(await q('SELECT file FROM lib_books WHERE id=$1',[privateBook]))[0].file;
  await mkdir(join(process.env.DL_ROOT!,folder),{recursive:true});
  await writeFile(join(process.env.DL_ROOT!,folder,'Chapter 1.cbz'),await readFile(join(process.env.DL_ROOT!,file)));
  await (await import('../src/lib/library')).persistScan();
  const [series]=await q('SELECT id FROM lib_series WHERE folder=$1',[folder]);
  const [book]=await q('SELECT id FROM lib_books WHERE series_id=$1',[series.id]);
  await q('INSERT INTO read_progress(user_id,series_id,book_id,page,is_private) VALUES($1,$2,$3,1,true)',[a,series.id,book.id]);
  const manage=(who:string,action:string,confirmed?:boolean)=>app.inject({method:'POST',url:`/api/series/${series.id}/private-management`,headers:as(who),payload:{action,...(confirmed===undefined?{}:{confirmed})}});
  assert.equal((await manage(b,'pause')).statusCode,404);
  assert.equal((await manage(a,'pause')).statusCode,200);
  assert.equal((await q('SELECT auto_update FROM lib_series WHERE id=$1',[series.id]))[0].auto_update,false);
  assert.equal((await manage(a,'resume')).statusCode,200);
  assert.equal((await manage(a,'remove')).statusCode,200);
  const removed=(await app.inject({url:'/api/personal/private-series',headers:as(a)})).json().content.find((s:any)=>s.id===series.id);
  assert.equal(removed.deleted,true);assert.equal(removed.canDelete,true);
  assert.equal((await manage(a,'restore')).statusCode,200);
  assert.equal((await q('SELECT book_id FROM read_progress WHERE user_id=$1 AND series_id=$2',[a,series.id]))[0].book_id,book.id);
  assert.equal((await manage(a,'remove')).statusCode,200);
  assert.equal((await manage(a,'delete')).statusCode,400,'permanent deletion needs explicit confirmation');
  const deleted=await manage(a,'delete',true);assert.equal(deleted.statusCode,200,deleted.body);
  assert.equal((await q('SELECT id FROM lib_series WHERE id=$1',[series.id])).length,0);
  assert.equal((await q('SELECT owner_user_id FROM private_resource_owners WHERE resource_id=$1',[series.id]))[0].owner_user_id,a,'opaque owner provenance survives Forget');
  assert.ok(!(await app.inject({url:'/api/admin/audit',headers:as(admin,'admin')})).body.includes(series.id),'forgotten private audit references stay private');
  await assert.rejects(()=>readFile(join(process.env.DL_ROOT!,folder,'Chapter 1.cbz')),/ENOENT/);
  const priorPublished=await app.inject({method:'POST',url:`/api/series/${privateSeries}/private-management`,headers:as(a),payload:{action:'remove'}});
  assert.equal(priorPublished.statusCode,200);
  const protectedDelete=await app.inject({method:'POST',url:`/api/series/${privateSeries}/private-management`,headers:as(a),payload:{action:'delete',confirmed:true}});
  assert.equal(protectedDelete.statusCode,409);assert.equal(protectedDelete.json().error,'admin_cleanup_required');
  await app.inject({method:'POST',url:`/api/series/${privateSeries}/private-management`,headers:as(a),payload:{action:'restore'}});
});
test('an incognito private place still prevents implicit caching after its title is published',{skip},async()=>{
  const [reader]=await q("INSERT INTO users(username,display_name,password_hash,role,auth_kind) VALUES('private-fixture-rp-cache','Cache','x','user','password') RETURNING id");
  try{
    await q('INSERT INTO read_progress(user_id,series_id,book_id,page,incognito,is_private) VALUES($1,$2,$3,1,true,true)',[reader.id,privateSeries,privateBook]);
    const r=await app.inject({url:'/api/libraries',headers:as(reader.id)});
    assert.equal(r.statusCode,200);assert.equal(r.headers['x-uchiyomi-private'],'1');
    assert.equal((await q('SELECT 1 FROM reading_events WHERE user_id=$1',[reader.id])).length,0);
    assert.equal((await q('SELECT 1 FROM lib_series WHERE owner_user_id=$1 AND is_private',[reader.id])).length,0);
  }finally{await q('DELETE FROM users WHERE id=$1',[reader.id]);}
});


test('legacy admin and child content routes reject another owner’s private IDs and corrupt work propagation',{skip},async()=>{
  const publicId='s_private_fixture_public',work=randomUUID();
  await q("INSERT INTO lib_series(id,source,title,folder,library_id,work_id,lang) VALUES($1,'Fixture','Public work target',$1,'lib',$2,'en')",[publicId,work]);
  await q("UPDATE lib_series SET work_id=$2,lang='ko' WHERE id=$1",[privateSeries,work]);
  await q('INSERT INTO series_overrides(series_id,age_rating,adult_exempt) VALUES($1,4,false) ON CONFLICT(series_id) DO UPDATE SET age_rating=4,adult_exempt=false',[privateSeries]);
  try{
    const hiddenRequests=[
      {method:'PUT',url:`/api/admin/series/${privateSeries}/meta`,payload:{title:'Forbidden override',ageRating:18}},
      {method:'PUT',url:`/api/admin/books/${privateBook}/meta`,payload:{title:'Forbidden chapter'}},
      {method:'PATCH',url:`/api/admin/series/${privateSeries}`,payload:{autoUpdate:true}},
      {method:'GET',url:`/api/admin/series/${privateSeries}/scanlators`},
      {method:'GET',url:`/api/admin/art/candidates/${privateSeries}`},
      {method:'GET',url:`/api/admin/series/${privateSeries}/title-extraction/cover`},
      {method:'POST',url:'/api/admin/series/bulk/hide',payload:{ids:[privateSeries]}},
      {method:'POST',url:`/api/admin/series/${publicId}/merge`,payload:{into:privateSeries}},
      {method:'POST',url:'/api/admin/tasks/rescan/apply',payload:{planId:randomUUID(),renumber:[privateSeries],merge:[]}},
    ];
    for(const request of hiddenRequests){
      const result=await app.inject({...request,headers:as(admin,'admin')});assert.equal(result.statusCode,404,`${request.url}: ${result.body}`);
      assert.equal((await q('SELECT age_rating FROM series_overrides WHERE series_id=$1',[privateSeries]))[0].age_rating,4,'a forbidden handler must not run after sending404');
    }
    const permitted=await app.inject({method:'PUT',url:`/api/admin/series/${publicId}/meta`,headers:as(admin,'admin'),payload:{title:'Public work target',ageRating:18,adultExempt:true}});
    assert.equal(permitted.statusCode,200,permitted.body);
    assert.deepEqual((await q('SELECT age_rating,adult_exempt FROM series_overrides WHERE series_id=$1',[privateSeries]))[0],{age_rating:4,adult_exempt:false},'work IDs never grant cross-scope metadata writes');
    assert.ok(!(await (await import('../src/lib/editions')).workRows(publicId)).some(r=>r.id===privateSeries),'corrupt work identity does not reveal private sibling names');
    const uniqueGroup='private-fixture-secret-group';
    await q('UPDATE lib_books SET scanlator=$2 WHERE id=$1',[privateBook,uniqueGroup]);
    assert.ok(!(await app.inject({url:'/api/admin/scanlators',headers:as(admin,'admin')})).body.includes(uniqueGroup),'global group cache excludes private-only metadata');
    await q('UPDATE lib_series SET deleted_at=now() WHERE id=$1',[privateSeries]);
    for(const url of ['/api/admin/series/deleted','/api/admin/libraries','/api/admin/art/overview']){
      const result=await app.inject({url,headers:as(admin,'admin')});assert.equal(result.statusCode,200,result.body);
      assert.ok(!result.body.includes(privateSeries)&&!result.body.includes(`private_${a}`),`${url} exposes private identifiers`);
    }
  }finally{
    await q('UPDATE lib_series SET work_id=NULL,deleted_at=NULL WHERE id=$1',[privateSeries]);
    await q('DELETE FROM lib_series WHERE id=$1',[publicId]);
  }
});
test('private download history remains owner-only after publication and after persisted-log hydration',{skip},async()=>{
  const activity=await import('../src/lib/downloadActivity'),log=await import('../src/lib/activityLog');
  const folder=(await q('SELECT folder FROM lib_series WHERE id=$1',[privateSeries]))[0].folder;
  await log.startActivityLog();
  const event=activity.withOrigin('add',a,()=>activity.beginDownload({folder,title:'Private download history fixture',number:1,source:'private_fixture_source'}));
  activity.endDownload(event,{status:'done',pages:1});await log.flushActivityLog();
  assert.equal((await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:false}})).statusCode,200);
  try{
    activity.clearActivity();await log.startActivityLog();
    assert.ok((await app.inject({url:'/api/admin/scanlators',headers:as(admin,'admin')})).body.includes('private-fixture-secret-group'),'published metadata may enter the shared cache');
    const owner=await app.inject({url:'/api/sources/jobs',headers:as(a)});
    assert.ok(owner.body.includes('Private download history fixture'),'owner retains download history after restart');
    for(const id of[b,admin]){
      const result=await app.inject({url:'/api/sources/jobs',headers:as(id,id===admin?'admin':'user')});
      assert.ok(!result.body.includes('Private download history fixture')&&!result.body.includes(folder),'publication never publishes historical private download cards');
    }
  }finally{
    await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:true}});
    assert.ok(!(await app.inject({url:'/api/admin/scanlators',headers:as(admin,'admin')})).body.includes('private-fixture-secret-group'),'revocation invalidates collapsed shared metadata immediately');
    activity.clearActivity();await q('DELETE FROM download_log WHERE folder=$1',[folder]);
  }
});
test('private maintenance history and audit references are hidden independently of adult reveal',{skip},async()=>{
  const run=randomUUID(),fix=randomUUID(),title='Private historical maintenance fixture';
  const result={phaseIndex:0,log:[{code:'autofix.item.renumbered',params:{title,seriesIds:[privateSeries]}}]};
  await q("INSERT INTO repair_runs(id,origin,kind,status,target,result,notes,finished_at) VALUES($1,'manual','fill','done',$2,$3,$4,now()),($5,'manual','autofix','done','{}',$6,NULL,now())",[run,JSON.stringify({seriesId:privateSeries,label:title}),JSON.stringify({skips:[{step:'short',target:{seriesId:privateSeries,bookId:privateBook,title},why:'busy'}]}),JSON.stringify({replaced:[title]}),fix,JSON.stringify(result)]);
  const records=await import('../src/lib/repairRuns');records.clearRunDigest();
  await (await import('../src/lib/audit')).logAudit('private.fixture',{userId:a,detail:{id:privateSeries,title}});
  try{
    for(const url of [`/api/admin/tasks/repair/runs?adult=1&id=${run}`,`/api/admin/tasks/repair/runs?adult=1&id=${fix}`,`/api/admin/health/autofix/${fix}?adult=1`,'/api/admin/audit']){
      const result=await app.inject({url,headers:as(admin,'admin')});assert.equal(result.statusCode,200,result.body);
      assert.ok(!result.body.includes(title)&&!result.body.includes(privateSeries)&&!result.body.includes(privateBook),`${url} discloses private maintenance provenance`);
    }
  }finally{await q('DELETE FROM repair_runs WHERE id=ANY($1::uuid[])',[[run,fix]]);records.clearRunDigest();}
});


test('comments and reactions written privately never become public history after publication',{skip},async()=>{
  const posted=await app.inject({method:'POST',url:`/api/books/${privateBook}/comments`,headers:as(a),payload:{body:'Private conversation fixture'}});
  assert.equal(posted.statusCode,201,posted.body);const comment=posted.json().id;
  const reaction=await app.inject({method:'PUT',url:`/api/books/${privateBook}/reaction`,headers:as(a),payload:{emoji:'❤️'}});
  assert.equal(reaction.statusCode,200,reaction.body);
  assert.equal((await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:false}})).statusCode,200);
  try{
    const own=(await app.inject({url:`/api/books/${privateBook}/comments`,headers:as(a)})).json();
    assert.ok(own.comments.some((c:any)=>c.id===comment));assert.equal(own.reactions.length,1);
    const other=(await app.inject({url:`/api/books/${privateBook}/comments`,headers:as(b)})).json();
    assert.equal(other.comments.length,0);assert.equal(other.reactions.length,0);
    const counts=(await app.inject({url:`/api/series/${privateSeries}/comments`,headers:as(b)})).json();
    assert.equal(counts.content.length,0,'aggregate counts do not disclose private conversations');
    const denied=await app.inject({method:'DELETE',url:`/api/comments/${comment}`,headers:as(admin,'admin')});
    assert.equal(denied.statusCode,404);assert.equal((await q('SELECT id FROM chapter_comments WHERE id=$1',[comment])).length,1);
  }finally{
    await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:true}});
    await app.inject({method:'DELETE',url:`/api/comments/${comment}`,headers:as(a)});
    await app.inject({method:'DELETE',url:`/api/books/${privateBook}/reaction`,headers:as(a)});
  }
});
test('revoking a published series invalidates existing fill scans and their authorized plans',{skip},async()=>{
  const folder=(await q('SELECT folder FROM lib_series WHERE id=$1',[privateSeries]))[0].folder;
  const file=(await q('SELECT file FROM lib_books WHERE id=$1',[privateBook]))[0].file;
  for(const n of[2,3])await writeFile(join(process.env.DL_ROOT!,folder,`Chapter ${n}.cbz`),await readFile(join(process.env.DL_ROOT!,file)));
  await (await import('../src/lib/library')).persistScan();
  assert.equal((await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:false}})).statusCode,200);
  try{
    const scan=await app.inject({method:'POST',url:'/api/sources/fill/scan',headers:as(b),payload:{seriesId:privateSeries}});
    assert.equal(scan.statusCode,200,scan.body);const started=scan.json();assert.ok(started.scanId);
    const fill=await import('../src/lib/fill');const plan=fill.getPlan(started.planId)!;
    plan.candidates.push({source:'private_fixture_source',name:'Fixture',sourceSeriesId:'entry',title:'Secret title',count:4,first:1,last:4,coverage:1,matched:3,fillable:[],newer:[4],older:[],why:'ok',pinned:false});
    plan.chapters.set(fill.planKey('private_fixture_source','entry'),[{sourceId:'chapter4',number:4,title:'4'}]);
    assert.equal((await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:true}})).statusCode,200);
    const poll=await app.inject({url:`/api/sources/fill/scan/${started.scanId}`,headers:as(b)});
    assert.equal(poll.statusCode,404,poll.body);assert.ok(!poll.body.includes(folder));
    const apply=await app.inject({method:'POST',url:'/api/sources/fill',headers:as(b),payload:{planId:plan.id,source:'private_fixture_source',sourceSeriesId:'entry',numbers:[4]}});
    assert.equal(apply.statusCode,404,apply.body);
    assert.equal((await q('SELECT id FROM lib_books WHERE series_id=$1 AND number=4',[privateSeries])).length,0);
  }finally{
    await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:true}});
  }
});


test('successful privacy revocation cannot race a previously authorized legacy admin mutation',{skip},async()=>{
  assert.equal((await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:false}})).statusCode,200);
  delayedGate=new Promise<void>(resolve=>{releaseDelayed=resolve;});
  const entered=new Promise<void>(resolve=>{enterDelayed=resolve;});
  const pending=app.inject({method:'PUT',url:`/api/admin/series/${privateSeries}/private-delay-fixture`,headers:as(admin,'admin')}).then((r:any)=>r);
  try{
    await entered;
    const concurrent=await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:true}});
    assert.equal(concurrent.statusCode,409,concurrent.body);assert.equal(concurrent.json().error,'busy');
    assert.equal((await q('SELECT is_private FROM lib_series WHERE id=$1',[privateSeries]))[0].is_private,false,'the public request completes before the privacy change can commit');
    releaseDelayed();assert.equal((await pending).statusCode,200);
    assert.equal((await app.inject({method:'PUT',url:`/api/series/${privateSeries}/privacy`,headers:as(a),payload:{isPrivate:true}})).statusCode,200);
    const writes=delayedWrites;
    const blocked=await app.inject({method:'PUT',url:`/api/admin/series/${privateSeries}/private-delay-fixture`,headers:as(admin,'admin')});
    assert.equal(blocked.statusCode,404);assert.equal(delayedWrites,writes,'the rejected handler never executes');
  }finally{releaseDelayed();await pending;}
});


test('a corrupt private-to-shared merge pointer cannot reassign private files during a scan',{skip},async()=>{
  const target='s_private_fixture_scan_target';
  await q("INSERT INTO lib_series(id,source,title,folder) VALUES($1,'Fixture','Shared scan target',$1)",[target]);
  const before=await q('SELECT id FROM lib_books WHERE series_id=$1 ORDER BY id',[privateSeries]);
  await q('UPDATE lib_series SET merged_into=$2 WHERE id=$1',[privateSeries,target]);
  try{
    await (await import('../src/lib/library')).persistScan();
    assert.deepEqual(await q('SELECT id FROM lib_books WHERE series_id=$1 ORDER BY id',[privateSeries]),before);
    assert.equal((await q('SELECT id FROM lib_books WHERE series_id=$1',[target])).length,0,'private bytes are never registered as shared content');
  }finally{await q('UPDATE lib_series SET merged_into=NULL WHERE id=$1',[privateSeries]);await q('DELETE FROM lib_series WHERE id=$1',[target]);}
});
