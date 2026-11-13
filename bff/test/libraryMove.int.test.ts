// Actual admin routes against a disposable Postgres database and two local CBZ roots.
// Filesystem moves, private ownership and catalog identities must succeed or roll back together.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const DSN=process.env.TEST_DATABASE_URL;
const skip=DSN?false:'set TEST_DATABASE_URL to run';
let root:string, roots:string[], app:any, q:any, pool:any, a:string, b:string, shared:string, privateA:string, privateB:string, cbz:Buffer;
let library:typeof import('../src/lib/library');
let scopes:typeof import('../src/lib/contentScope');
const ids=new Set<string>();
const realFetch=globalThis.fetch;
const headers=(id=a)=>({authorization:`Bearer ${app.jwt.sign({sub:id,role:'admin'})}`});
const row=(id:string)=>q('SELECT id,folder,library_id,library_pinned,is_private,owner_user_id,private_published_at,folder_prev FROM lib_series WHERE id=$1',[id]).then((rows:any[])=>rows[0]);
const books=(id:string)=>q('SELECT id,file,root FROM lib_books WHERE series_id=$1 ORDER BY id',[id]);
const move=(id:string,libraryId:string|null,confirm?:boolean,actor=a)=>app.inject({method:'POST',url:`/api/admin/series/${id}/library`,headers:headers(actor),payload:{libraryId,...(confirm===undefined?{}:{confirmVisibilityChange:confirm})}});
const exists=(path:string)=>stat(path).then(()=>true,()=>false);
let releaseRead=()=>{}, enterRead=()=>{}, readGate=Promise.resolve();

async function fixture(name:string,options:{owner?:string;metadataOnly?:boolean}={}){
  const owner=options.owner;
  const folder=`${owner?`_private/${owner}/`:''}MoveFixture/${name}-${randomUUID()}`;
  if(options.metadataOnly){
    const id=`s_move_${randomUUID()}`;ids.add(id);
    await q(`INSERT INTO lib_series(id,source,title,folder,library_id,is_private,owner_user_id) VALUES($1,'MoveFixture',$2,$3,$4,$5,$6)`,[id,name,folder,owner===a?privateA:owner===b?privateB:'lib',!!owner,owner??null]);
    return {id,folder};
  }
  for(const [index,disk] of roots.entries()){
    await mkdir(join(disk,folder),{recursive:true});
    await writeFile(join(disk,folder,`Chapter ${index+1}.cbz`),cbz);
  }
  await library.persistScan();
  const [stored]=await q('SELECT id FROM lib_series WHERE folder=$1',[folder]);
  assert.ok(stored,`scanner missed ${folder}`);ids.add(stored.id);
  assert.equal((await books(stored.id)).length,2,'fixture spans both real roots');
  return {id:stored.id,folder};
}

before(async()=>{
  if(!DSN)return;
  root=await mkdtemp(join(tmpdir(),'uchiyomi-library-move-'));roots=[join(root,'library'),join(root,'downloads')];
  Object.assign(process.env,{DATABASE_URL:DSN,JWT_SECRET:'library-move-private-test-secret-32',CONFIG_DIR:join(root,'config'),CACHE_DIR:join(root,'cache'),LIBRARY_ROOT:roots[0],DL_ROOT:roots[1],LIBRARY_BACKEND:'owned',MIN_FREE_GB:'0',UCHIYOMI_PING_URL:''});
  for(const disk of roots)await mkdir(disk,{recursive:true});
  globalThis.fetch=(async()=>{throw new Error('Library move tests cannot call external services');}) as typeof fetch;
  ({q,pool}=await import('../src/lib/db'));await (await import('../src/lib/migrate')).migrate();
  scopes=await import('../src/lib/contentScope');library=await import('../src/lib/library');
  const token=randomUUID();
  const users=await q(`INSERT INTO users(username,display_name,password_hash,role,auth_kind) VALUES($1,'Move A','x','admin','password'),($2,'Move B','x','admin','password') RETURNING id,username`,[`move-a-${token}`,`move-b-${token}`]);
  a=users.find((u:any)=>u.username.startsWith('move-a')).id;b=users.find((u:any)=>u.username.startsWith('move-b')).id;
  privateA=(await scopes.ensurePrivateLibrary(a)).libraryId;privateB=(await scopes.ensurePrivateLibrary(b)).libraryId;
  shared=`move_shared_${token}`;
  await q("INSERT INTO libraries(id,name,path) VALUES($1,'Move published','MovePublished')",[shared]);
  await q("INSERT INTO library_paths(library_id,path) VALUES($1,'MovePublished')",[shared]);
  const zip=new ((await import('adm-zip')).default)();
  zip.addFile('001.png',await (await import('sharp')).default({create:{width:8,height:8,channels:3,background:'#9273e6'}}).png().toBuffer());cbz=zip.toBuffer();
  app=(await import('fastify')).default();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/privateLibrary')).default);
  await app.register(async(child:any)=>{
    const auth=await import('../src/lib/auth'),guard=await import('../src/lib/privateAdmin');
    child.addHook('preHandler',auth.authenticate);child.addHook('preHandler',auth.requireAdmin);child.addHook('preHandler',guard.privateAdminContentGuard);
    child.get('/api/admin/series/:id/move-read-fixture',async()=>{enterRead();await readGate;return {ok:true};});
  });
  await app.ready();
});

after(async()=>{
  if(!DSN)return;
  releaseRead();globalThis.fetch=realFetch;await app?.close();
  if(q){
    await q('DROP TRIGGER IF EXISTS move_fixture_fail ON lib_books').catch(()=>{});
    await q('DROP FUNCTION IF EXISTS move_fixture_fail()').catch(()=>{});
    // Scanning cover-only directories may register additional rows. They belong
    // to this run's random owners/library too, even when no fixture returned them.
    await q('DELETE FROM lib_series WHERE id=ANY($1::text[]) OR library_id=$2 OR owner_user_id=ANY($3::uuid[])',[[...ids],shared,[a,b]]);
    await q('DELETE FROM libraries WHERE id=$1 OR owner_user_id=ANY($2::uuid[])',[shared,[a,b]]);
    await q('DELETE FROM users WHERE id=ANY($1::uuid[])',[[a,b]]);
  }
  await pool?.end();if(root)await rm(root,{recursive:true,force:true});
});

test('single moves require explicit confirmation before either direction changes visibility',{skip},async()=>{
  const s=await fixture('Confirmation');const initial=await row(s.id);
  for(const confirmed of [undefined,false]){
    const result=await move(s.id,privateA,confirmed);assert.equal(result.statusCode,409,result.body);
    assert.deepEqual(result.json(),{error:'visibility_confirmation_required',visibility:'private',count:1});assert.deepEqual(await row(s.id),initial);
  }
  assert.equal((await move(s.id,privateA,true)).statusCode,200);
  const after=await row(s.id);assert.equal(after.is_private,true);assert.equal(after.owner_user_id,a);
  const publish=await move(s.id,shared);assert.equal(publish.statusCode,409,publish.body);assert.equal(publish.json().visibility,'shared');assert.deepEqual(await row(s.id),after);
});

test('mixed bulk preflight confirms the entire selection before even same-privacy rows are pinned',{skip},async()=>{
  const sharedSeries=await fixture('Bulk shared'),privateSeries=await fixture('Bulk private',{owner:a});
  const before=await Promise.all([row(sharedSeries.id),row(privateSeries.id)]);
  const result=await app.inject({method:'POST',url:'/api/admin/series/library',headers:headers(),payload:{seriesIds:[sharedSeries.id,privateSeries.id],libraryId:shared}});
  assert.equal(result.statusCode,409,result.body);assert.equal(result.json().count,1);
  assert.deepEqual(await Promise.all([row(sharedSeries.id),row(privateSeries.id)]),before);
});

test('two-root publication and revocation preserve book IDs, progress and history across rescans',{skip},async()=>{
  const s=await fixture('History',{owner:a}),before=await books(s.id);
  await q('INSERT INTO read_progress(user_id,series_id,book_id,page,is_private) VALUES($1,$2,$3,7,true)',[a,s.id,before[0].id]);
  await q('INSERT INTO reading_events(user_id,series_id,book_id,page,is_private) VALUES($1,$2,$3,7,true)',[a,s.id,before[0].id]);
  for(const target of [shared,privateA]){
    const result=await move(s.id,target,true);assert.equal(result.statusCode,200,result.body);
    const stored=await row(s.id);assert.equal(stored.is_private,target===privateA);assert.equal(stored.owner_user_id,a);assert.equal(stored.library_id,target);assert.equal(stored.library_pinned,true);
    for(const disk of roots)assert.ok(await exists(join(disk,stored.folder)),'both roots moved');
    for(const book of await books(s.id))assert.deepEqual(await readFile(join(book.root,book.file)),cbz);
    await library.persistScan();assert.deepEqual((await books(s.id)).map((book:any)=>book.id),before.map((book:any)=>book.id));
    assert.deepEqual((await q('SELECT page,book_id,is_private FROM read_progress WHERE user_id=$1 AND series_id=$2',[a,s.id]))[0],{page:7,book_id:before[0].id,is_private:true});
    assert.equal((await q('SELECT count(*) AS n FROM reading_events WHERE user_id=$1 AND series_id=$2',[a,s.id]))[0].n,1);
  }
});

test('foreign private series and libraries stay opaque, and foreign-owned shared content cannot transfer ownership',{skip},async()=>{
  const foreign=await fixture('Foreign',{owner:b}),publicSeries=await fixture('Foreign published');
  assert.equal((await move(foreign.id,shared,true)).statusCode,404);
  assert.equal((await move(publicSeries.id,privateB,true)).statusCode,404);
  await q('UPDATE lib_series SET owner_user_id=$2 WHERE id=$1',[publicSeries.id,b]);const before=await row(publicSeries.id);
  const transfer=await move(publicSeries.id,privateA,true);assert.equal(transfer.statusCode,409,transfer.body);assert.equal(transfer.json().error,'forbidden');assert.deepEqual(await row(publicSeries.id),before);
  const listing=await app.inject({url:'/api/admin/libraries',headers:headers()});assert.equal(listing.statusCode,200,listing.body);assert.ok(listing.body.includes(privateA));assert.ok(!listing.body.includes(privateB));
});

test('a destination occupied in only the second root refuses the whole move without partial changes',{skip},async()=>{
  const s=await fixture('Collision'),before=await row(s.id),dest=`_private/${a}/${s.folder}`;
  await mkdir(join(roots[1],dest),{recursive:true});await writeFile(join(roots[1],dest,'unrelated.txt'),'keep');
  const result=await move(s.id,privateA,true);assert.equal(result.statusCode,409,result.body);assert.deepEqual(await row(s.id),before);
  for(const disk of roots)assert.ok(await exists(join(disk,s.folder)));
  assert.equal(await exists(join(roots[0],dest)),false);assert.equal(await readFile(join(roots[1],dest,'unrelated.txt'),'utf8'),'keep');
  await rm(join(roots[1],dest),{recursive:true});
});

test('a library that already holds the series refuses publication before any folder moves',{skip},async()=>{
  // From Calvin-Davidson's #432: the clash is found before the disk is touched, not in the catalogue step and undone.
  const mine=await fixture('Published twice',{owner:a}),theirs=await fixture('Published twice shared');
  await q(`UPDATE lib_series SET source_id='sw:clash',source_series_id=$2 WHERE id=ANY($1)`,[[mine.id,theirs.id],randomUUID()]);
  await q('UPDATE lib_series SET library_id=$2 WHERE id=$1',[theirs.id,shared]);
  const before=await row(mine.id),priorBooks=await books(mine.id);
  const result=await move(mine.id,shared,true);
  assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'privacy_destination_conflict');
  // Reintroduce the catalogue-step check alone (lib/libraryAdmin.ts renameSeriesFolder) and this says the moves were undone.
  assert.doesNotMatch(result.json().message,/undone/i,'the folders moved before the clash was found');
  assert.deepEqual(await row(mine.id),before);assert.deepEqual(await books(mine.id),priorBooks);
  for(const disk of roots)assert.ok(await exists(join(disk,mine.folder)),'a refused publication moved files');
});

test('a shared series made private keeps a record that it was shared, so its owner cannot erase it',{skip},async()=>{
  // The private Delete erases every member's progress, favourites and ratings with the series; it is offered only for a
  // series nobody else ever had (routes/privateLibrary.ts canDelete).
  const s=await fixture('Was shared');
  const result=await move(s.id,privateA,true);assert.equal(result.statusCode,200,result.body);
  assert.ok((await row(s.id)).private_published_at,'a shared series made private looks as if it had never been shared');
  const listed=await app.inject({method:'GET',url:'/api/personal/private-series',headers:headers()});
  assert.equal(listed.json().content.find((r:any)=>r.id===s.id)?.canDelete,false,'its owner is offered the Delete that erases other members');
});

test('a series that absorbed a merge refuses a visibility change before anything moves',{skip},async()=>{
  const survivor=await fixture('Merge survivor'),absorbed=await fixture('Merge absorbed');
  // What mergeSeries does: the rows move to the survivor, the files stay in the absorbed folder.
  await q('UPDATE lib_books SET series_id=$1 WHERE series_id=$2',[survivor.id,absorbed.id]);
  await q('UPDATE lib_series SET merged_into=$1 WHERE id=$2',[survivor.id,absorbed.id]);
  const before=await row(survivor.id);
  const result=await move(survivor.id,privateA,true);assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'unsafe_files');
  // Refused before the disk is touched. The catalogue step asks again, so without the first check this still refuses, but
  // only after moving the folder and back: the refusal then says the moves were undone.
  assert.doesNotMatch(result.json().message,/undone/i,'the folder moved before the merge was noticed');
  assert.deepEqual(await row(survivor.id),before);
  for(const disk of roots){assert.ok(await exists(join(disk,survivor.folder)));assert.ok(await exists(join(disk,absorbed.folder)));}
});

test('a root left with only deleted chapters does not block a visibility change',{skip},async()=>{
  const s=await fixture('Deleted in one root'),dest=`_private/${a}/${s.folder}`;
  // Chapters deleted on purpose in the second root, and the folder gone with them.
  await q(`UPDATE lib_books SET pruned_at=now(),pruned_reason='deleted' WHERE series_id=$1 AND root=$2`,[s.id,roots[1]]);
  await rm(join(roots[1],s.folder),{recursive:true});
  const result=await move(s.id,privateA,true);assert.equal(result.statusCode,200,result.body);
  assert.ok(await exists(join(roots[0],dest)),'the folder that holds chapters did not move');
  assert.equal(await exists(join(roots[1],dest)),false,'an empty private folder was made where nothing was');
  assert.ok((await books(s.id)).every((b:any)=>b.file.startsWith(`${dest}/`)),'a deleted chapter kept the old folder in its path');
});

test('a catalog failure after both filesystem renames rolls back every root, privacy and book path',{skip},async()=>{
  const s=await fixture('Database rollback'),before=await row(s.id),priorBooks=await books(s.id),dest=`_private/${a}/${s.folder}`;
  await q(`CREATE OR REPLACE FUNCTION move_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.series_id='${s.id}' THEN RAISE EXCEPTION 'forced move fixture failure'; END IF; RETURN NEW; END $$`);
  await q('CREATE TRIGGER move_fixture_fail BEFORE UPDATE OF file ON lib_books FOR EACH ROW EXECUTE FUNCTION move_fixture_fail()');
  try{
    const result=await move(s.id,privateA,true);assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'file_operation_failed');
    assert.deepEqual(await row(s.id),before);assert.deepEqual(await books(s.id),priorBooks);
    for(const disk of roots){assert.ok(await exists(join(disk,s.folder)));assert.equal(await exists(join(disk,dest)),false);}
  }finally{await q('DROP TRIGGER move_fixture_fail ON lib_books');await q('DROP FUNCTION move_fixture_fail()');}
});

test('an authorized active read blocks visibility changes and releases cleanly afterwards',{skip},async()=>{
  const s=await fixture('Read fence');readGate=new Promise<void>(resolve=>{releaseRead=resolve;});const entered=new Promise<void>(resolve=>{enterRead=resolve;});
  const pending=app.inject({url:`/api/admin/series/${s.id}/move-read-fixture`,headers:headers()}).then((r:any)=>r);
  try{await entered;const result=await move(s.id,privateA,true);assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'busy');assert.equal((await row(s.id)).is_private,false);}
  finally{releaseRead();await pending;}
  const retry=await move(s.id,privateA,true);assert.equal(retry.statusCode,200,retry.body);
});

test('automatic filing unpins without publishing private content, while shared filing follows folder rules',{skip},async()=>{
  const s=await fixture('Automatic private',{owner:a}),initial=await row(s.id);
  await q('UPDATE lib_series SET library_pinned=true WHERE id=$1',[s.id]);const result=await move(s.id,null);
  assert.equal(result.statusCode,200,result.body);const current=await row(s.id);assert.equal(current.is_private,true);assert.equal(current.folder,initial.folder);assert.equal(current.library_id,privateA);assert.equal(current.library_pinned,false);
  const publicSeries=await fixture('Automatic shared');assert.equal((await move(publicSeries.id,shared)).statusCode,200);
  assert.equal((await move(publicSeries.id,null)).statusCode,200);assert.equal((await row(publicSeries.id)).library_id,'lib');
});

test('metadata-only series can transition without inventing files',{skip},async()=>{
  const s=await fixture('No files',{metadataOnly:true});
  for(const target of [privateA,shared]){const result=await move(s.id,target,true);assert.equal(result.statusCode,200,result.body);assert.equal((await row(s.id)).library_id,target);assert.equal((await books(s.id)).length,0);}
});

test('zero-book folders keep cover and notes bytes across all roots when moving private and shared',{skip},async()=>{
  const s=await fixture('Artwork without chapters',{metadataOnly:true});
  const payloads=roots.map((_disk,index)=>({cover:Buffer.from(`cover-bytes-${index}`),notes:`personal notes in root ${index}`}));
  for(const [index,disk] of roots.entries()){
    await mkdir(join(disk,s.folder),{recursive:true});
    await writeFile(join(disk,s.folder,'cover.png'),payloads[index].cover);
    await writeFile(join(disk,s.folder,'notes.txt'),payloads[index].notes);
  }
  let previous=s.folder;
  for(const target of [privateA,shared,privateA]){
    const result=await move(s.id,target,true);assert.equal(result.statusCode,200,result.body);
    const current=await row(s.id);assert.equal(current.library_id,target);assert.equal(current.is_private,target===privateA);assert.equal((await books(s.id)).length,0);
    for(const [index,disk] of roots.entries()){
      assert.equal(await exists(join(disk,previous)),false,'the old zero-book folder must not remain behind');
      assert.deepEqual(await readFile(join(disk,current.folder,'cover.png')),payloads[index].cover);
      assert.equal(await readFile(join(disk,current.folder,'notes.txt'),'utf8'),payloads[index].notes);
    }
    previous=current.folder;
  }
});

test('re-privatizing an already published reserved folder preserves same-folder local artwork',{skip},async()=>{
  const s=await fixture('Same folder artwork',{owner:a});
  const published=await app.inject({method:'PUT',url:`/api/series/${s.id}/privacy`,headers:headers(),payload:{isPrivate:false}});assert.equal(published.statusCode,200,published.body);
  const before=await row(s.id);assert.equal(before.folder,s.folder,'owner privacy API preserves its existing folder');
  await q(`INSERT INTO series_local_art(series_id,root,folder,priority,cover_file,cover_stamp) VALUES($1,$2,$3,1,'cover.png','fixture') ON CONFLICT(series_id,root,folder) DO UPDATE SET cover_file='cover.png',cover_stamp='fixture'`,[s.id,roots[0],s.folder]);
  const art=await q('SELECT * FROM series_local_art WHERE series_id=$1 ORDER BY root,folder',[s.id]);
  const result=await move(s.id,privateA,true);assert.equal(result.statusCode,200,result.body);assert.equal((await row(s.id)).folder,s.folder);assert.equal((await row(s.id)).folder_prev,before.folder_prev);
  assert.deepEqual(await q('SELECT * FROM series_local_art WHERE series_id=$1 ORDER BY root,folder',[s.id]),art);
});

test('an active folder writer fences both metadata filing and visibility changes',{skip},async()=>{
  const s=await fixture('Writer fence'),before=await row(s.id);
  const writers=await import('../src/lib/bulkNewest');
  const claim=writers.claimWriterFolders([s.folder],()=>false);assert.ok(claim);
  try{
    for(const target of [shared,privateA]){const result=await move(s.id,target,true);assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error,'busy');assert.deepEqual(await row(s.id),before);}
  }finally{claim.release();}
  assert.equal((await move(s.id,privateA,true)).statusCode,200);
});

test('stale destination primary or secondary paths reject the transition and roll back all filesystem moves',{skip},async()=>{
  const s=await fixture('Stale destination',{owner:a}),before=await row(s.id),priorBooks=await books(s.id);
  const filing=await import('../src/lib/libraryMove'),fence=await import('../src/lib/privateFence'),writers=await import('../src/lib/bulkNewest');
  for(const field of ['primary','secondary']){
    const [snapshot]=await q('SELECT id,folder,library_id,is_private,owner_user_id,work_id,deleted_at,merged_into FROM lib_series WHERE id=$1',[s.id]);
    const target=await filing.filingLibrary(shared);assert.ok(target);
    const lease=fence.claimPrivateContentChange(s.id);assert.ok(lease);
    try{
      if(field==='primary')await q("UPDATE libraries SET path='MoveChanged' WHERE id=$1",[shared]);
      else await q("UPDATE library_paths SET path='MoveChanged' WHERE library_id=$1 AND path='MovePublished'",[shared]);
      const outcome=await filing.fileSeriesInLibrary(snapshot,target,a,(_ids,folders)=>writers.claimWriterFolders(folders,()=>false));
      assert.equal(outcome.ok,false);assert.deepEqual(await row(s.id),before);assert.deepEqual(await books(s.id),priorBooks);
      const destination=join('MovePublished',s.folder.slice(`_private/${a}/`.length));
      for(const disk of roots){assert.ok(await exists(join(disk,s.folder)));assert.equal(await exists(join(disk,destination)),false);}
    }finally{
      lease.release();
      await q("UPDATE libraries SET path='MovePublished' WHERE id=$1",[shared]);
      await q("UPDATE library_paths SET path='MovePublished' WHERE library_id=$1 AND path='MoveChanged'",[shared]);
    }
  }
});

test('a source ownership change after preflight refuses the stale snapshot before moving bytes',{skip},async()=>{
  const s=await fixture('Stale source',{owner:a}),priorBooks=await books(s.id);
  const filing=await import('../src/lib/libraryMove'),fence=await import('../src/lib/privateFence'),writers=await import('../src/lib/bulkNewest');
  const [snapshot]=await q('SELECT id,folder,library_id,is_private,owner_user_id,work_id,deleted_at,merged_into FROM lib_series WHERE id=$1',[s.id]);
  const target=await filing.filingLibrary(shared);assert.ok(target);
  const lease=fence.claimPrivateContentChange(s.id);assert.ok(lease);
  try{
    await q('UPDATE lib_series SET owner_user_id=$2 WHERE id=$1',[s.id,b]);
    const outcome=await filing.fileSeriesInLibrary(snapshot,target,a,(_ids,folders)=>writers.claimWriterFolders(folders,()=>false));
    assert.equal(outcome.ok,false);if(!outcome.ok)assert.equal(outcome.code,'catalogue_changed');
    assert.equal((await row(s.id)).owner_user_id,b);assert.deepEqual(await books(s.id),priorBooks);
    for(const disk of roots)assert.ok(await exists(join(disk,s.folder)));
  }finally{lease.release();await q('UPDATE lib_series SET owner_user_id=$2 WHERE id=$1',[s.id,a]);}
});

test('scans do not register empty move parents as ghost series',{skip},async t=>{
  const registered=await q(`SELECT s.id,s.folder,b.file,b.root FROM lib_series s LEFT JOIN lib_books b ON b.series_id=s.id
    WHERE NOT(s.id=ANY($1::text[])) AND (s.library_id=$2 OR s.owner_user_id=ANY($3::uuid[]))`,[[...ids],shared,[a,b]]);
  // Existing loose-image support may index the parent of our cover-only fixture.
  // Those rows must point to actual cover-bearing chapter directories, never to
  // empty parent directories left by a successful rename.
  for(const entry of registered){
    assert.ok(entry.file,`${entry.folder} is an empty ghost series`);
    const chapter=join(entry.root,entry.file);assert.ok((await stat(chapter)).isDirectory());
    assert.ok((await readdir(chapter)).includes('cover.png'),'extra row represents the cover-only loose-image fixture');
  }
  t.diagnostic(`${new Set(registered.map((entry:any)=>entry.id)).size} additional scanner row(s), all backed by real cover-bearing chapters`);
});

test('admin library counts and folder suggestions use the actor visibility for private, deleted and merged rows',{skip},async()=>{
  const listing=async()=>{
    const result=await app.inject({url:'/api/admin/libraries',headers:headers()});assert.equal(result.statusCode,200,result.body);
    return {body:result.body,...result.json()};
  };
  const baseline=await listing(),ownBefore=baseline.content.find((entry:any)=>entry.id===privateA),sharedBefore=baseline.content.find((entry:any)=>entry.id===shared);
  assert.ok(ownBefore);assert.ok(sharedBefore);
  const live=await fixture('Count live',{owner:a,metadataOnly:true});
  const deleted=await fixture('Count deleted',{owner:a,metadataOnly:true});
  const merged=await fixture('Count merged',{owner:a,metadataOnly:true});
  await q('UPDATE lib_series SET library_pinned=true WHERE id=ANY($1::text[])',[[live.id,deleted.id,merged.id]]);
  await q('UPDATE lib_series SET deleted_at=now() WHERE id=$1',[deleted.id]);
  await q('UPDATE lib_series SET merged_into=$2 WHERE id=$1',[merged.id,live.id]);
  const publicSeries=await fixture('Visible folder suggestion',{metadataOnly:true}),prefix=`PublicSuggestion-${randomUUID()}`;
  await q("UPDATE lib_series SET folder=$2,source='Visible public source',library_id=$3 WHERE id=$1",[publicSeries.id,`${prefix}/Group/Title`,shared]);
  const foreign=await fixture('Foreign count secret',{owner:b,metadataOnly:true});
  // A corrupt misfiled private row is still private. Neither counts, folder
  // suggestions nor source-looking labels may turn the library_id into access.
  await q('UPDATE lib_series SET library_id=$2,source=$3 WHERE id=$1',[foreign.id,shared,prefix]);
  const foreignLibraryName=`Foreign private library ${randomUUID()}`;
  await q('UPDATE libraries SET name=$2 WHERE id=$1',[privateB,foreignLibraryName]);
  const result=await listing(),own=result.content.find((entry:any)=>entry.id===privateA),publicLibrary=result.content.find((entry:any)=>entry.id===shared);
  assert.equal(own.n,ownBefore.n+1,'only live own-private series count');
  assert.equal(own.pinned,ownBefore.pinned+1,'deleted/merged own-private pins do not count');
  assert.equal(publicLibrary.n,sharedBefore.n+1,'foreign private rows do not inflate a shared library');
  assert.ok(!result.content.some((entry:any)=>entry.id===privateB));
  assert.ok(!result.body.includes(foreignLibraryName));assert.ok(!result.body.includes(`_private/${b}`));
  assert.ok(result.candidates.every((entry:any)=>entry.path!=='_private'&&!entry.path.startsWith('_private/')),'reserved private parents cannot be library suggestions');
  const suggestion=result.candidates.find((entry:any)=>entry.path===prefix);assert.ok(suggestion,'visible shared parent remains selectable');
  assert.equal(suggestion.series,1);assert.equal(suggestion.looksLikeSource,false,'a hidden private source name does not label a public folder');
});
