import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
const DSN=process.env.TEST_DATABASE_URL, skip=!DSN;
let root='',app:any,db:any,address='',authorization='',uid='',other='',series='',book='';
let red:Buffer,blue:Buffer;
if(DSN) Object.assign(process.env,{DATABASE_URL:DSN,JWT_SECRET:'image-chapter-isolated-test-key',LIBRARY_BACKEND:'owned',MIN_FREE_GB:'0',UPLOAD_MAX_MB:'4',UCHIYOMI_PING_URL:''});
const title='Image Chapter HTTP Fixture';
const target=(extra='')=>`${address}/api/library/upload?title=${encodeURIComponent(title)}&fresh=1&name=Chapter%207.cbz&images=1${extra}`;
function body(pages:Array<[string,Buffer]>) {
  const form=new FormData();
  for(const [name,bytes] of pages) form.append('pages',new Blob([new Uint8Array(bytes)]),name);
  return form;
}
async function post(url:string,pages:Array<[string,Buffer]>,auth=authorization) {
  const r=await fetch(url,{method:'POST',headers:{authorization:auth},body:body(pages)});
  return {status:r.status,data:await r.json() as any};
}
async function until(fn:()=>Promise<boolean>) {const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Upload cleanup did not finish');}
before(async()=> {
  if(!DSN)return;
  root=await mkdtemp(join(tmpdir(),'uchi-images-'));Object.assign(process.env,{DL_ROOT:join(root,'dl'),LIBRARY_ROOT:join(root,'lib'),CONFIG_DIR:join(root,'config')});
  db=await import('../src/lib/db');await(await import('../src/lib/migrate')).migrate();
  (await import('../src/lib/healthSummary')).setSummaryRefresh(async()=>{}, {everyMs:1});
  const stale=(await db.q("SELECT id FROM users WHERE username=ANY($1)",[['image-http-admin','image-http-other']])).map((u:any)=>u.id);
  if(stale.length){await db.q(`DELETE FROM lib_series WHERE title=$1 OR owner_user_id=ANY($2::uuid[])
    OR library_id IN (SELECT id FROM libraries WHERE owner_user_id=ANY($2::uuid[]))
    OR EXISTS(SELECT 1 FROM unnest($2::uuid[]) u WHERE folder LIKE '_private/'||u::text||'/%')`,[title,stale]);await db.q('DELETE FROM libraries WHERE owner_user_id=ANY($1::uuid[])',[stale]);await db.q('DELETE FROM users WHERE id=ANY($1::uuid[])',[stale]);}
  [uid,other]=(await db.q(`INSERT INTO users(username,display_name,password_hash,role,auth_kind,perms) VALUES
    ('image-http-admin','Image admin','x','admin','password','{}'),('image-http-other','Image other','x','user','password','{"canUploadManually":true}') RETURNING id`)).map((u:any)=>u.id);
  app=(await import('fastify')).default();await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});await app.register((await import('../src/routes/upload')).uploadSeriesRoutes);
  address=await app.listen({host:'127.0.0.1',port:0});authorization=`Bearer ${app.jwt.sign({sub:uid,role:'admin'})}`;
  const sharp=(await import('sharp')).default;
  red=await sharp({create:{width:2,height:3,channels:3,background:'#ff0000'}}).png().toBuffer();
  blue=await sharp({create:{width:3,height:2,channels:3,background:'#0000ff'}}).png().toBuffer();
});
after(async()=> {
  if(!DSN)return;
  await app?.close();(await import('../src/lib/healthSummary')).setSummaryRefresh();const owned=[uid,other].filter(Boolean);await db.q(`DELETE FROM lib_series WHERE title=$1 OR owner_user_id=ANY($2::uuid[])
    OR library_id IN (SELECT id FROM libraries WHERE owner_user_id=ANY($2::uuid[]))
    OR EXISTS(SELECT 1 FROM unnest($2::uuid[]) u WHERE folder LIKE '_private/'||u::text||'/%')`,[title,owned]);await db.q('DELETE FROM libraries WHERE owner_user_id=ANY($1::uuid[])',[owned]);await db.q('DELETE FROM users WHERE id=ANY($1::uuid[])',[owned]);await db.pool.end();await rm(root,{recursive:true,force:true});
});
test('real multipart upload preserves the chosen page order, original colors and normal chapter numbering', {skip},async()=> {
  const r=await post(target(),[['10.png',red],['2.png',blue]]);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.number,7);series=r.data.seriesId;book=r.data.bookId;
  const {cbzPages,cbzEntry}=await import('../src/lib/library');const file=join(root,'dl',r.data.file);
  assert.deepEqual(await cbzPages(file),['00001.png','00002.png']);assert.deepEqual(await cbzEntry(file,'00001.png'),red);assert.deepEqual(await cbzEntry(file,'00002.png'),blue);
  await db.q('INSERT INTO read_progress(user_id,book_id,series_id,page,completed) VALUES($1,$2,$3,1,true)',[uid,book,series]);
  await db.q('INSERT INTO bookmarks(user_id,book_id,series_id,page,note) VALUES($1,$2,$3,1,\'keep\')',[uid,book,series]);
  const before=await readFile(file),again=await post(`${address}/api/library/upload?seriesId=${series}&name=Chapter%207.cbz&images=1`,[['1.png',blue]]);
  assert.equal(again.status,409);assert.deepEqual(await readFile(file),before);
  const added=await post(`${address}/api/library/upload?seriesId=${series}&name=Chapter%208.cbz&images=1`,[['1.png',blue]]);assert.equal(added.status,200);
  assert.equal((await db.q('SELECT completed FROM read_progress WHERE book_id=$1 AND user_id=$2',[book,uid]))[0].completed,true);
  assert.equal((await db.q('SELECT note FROM bookmarks WHERE book_id=$1 AND user_id=$2',[book,uid]))[0].note,'keep');
});
test('a corrupt second image refuses the whole chapter and removes every temporary artifact',{skip},async()=> {
  const r=await post(`${address}/api/library/upload?seriesId=${series}&name=Chapter%209.cbz&images=1`,[['1.png',red],['2.png',Buffer.from('not a PNG')]]);
  assert.equal(r.status,400);assert.equal(r.data.error,'invalid_page');assert.equal(r.data.page,'2.png','named page refusals survive the real HTTP route');
  assert.deepEqual((await readdir(join(root,'dl','Uploads',title))).sort(),['Chapter 7.cbz','Chapter 8.cbz']);
});
test('private uploads do not reuse a shared title, and another account cannot write into the private copy',{skip},async()=> {
  const r=await post(target('&visibility=private'),[['1.png',red]]);assert.equal(r.status,200,JSON.stringify(r));assert.notEqual(r.data.seriesId,series);
  const [row]=await db.q('SELECT owner_user_id,is_private FROM lib_series WHERE id=$1',[r.data.seriesId]);assert.deepEqual(row,{owner_user_id:uid,is_private:true});
  const denied=await post(`${address}/api/library/upload?seriesId=${r.data.seriesId}&name=Chapter%208.cbz&images=1`,[['1.png',blue]],`Bearer ${app.jwt.sign({sub:other,role:'user'})}`);assert.equal(denied.status,404);
  // Publication can retain the physical folder. A later private copy must never append bytes to that shared row.
  await db.q("UPDATE lib_series SET is_private=false,owner_user_id=NULL,library_id='lib' WHERE id=$1",[r.data.seriesId]);
  const fresh=await post(target('&visibility=private'),[['1.png',blue]]);assert.equal(fresh.status,200,JSON.stringify(fresh));assert.notEqual(fresh.data.seriesId,r.data.seriesId);
  assert.notEqual(fresh.data.file,r.data.file,'the new scope has its own physical destination');
  assert.equal((await db.q('SELECT is_private FROM lib_series WHERE id=$1',[r.data.seriesId]))[0].is_private,false,'the published row stays shared');
});
test('an interrupted real multipart stream releases the writer and leaves no partially indexed chapter',{skip,timeout:15000},async()=> {
  const boundary='image-abort-boundary',url=`${address}/api/library/upload?seriesId=${series}&name=Chapter%2010.cbz&images=1`;
  const req=http.request(url,{method:'POST',headers:{authorization,'content-type':`multipart/form-data; boundary=${boundary}`,'transfer-encoding':'chunked'}});req.on('error',()=>{});
  req.flushHeaders();req.write(`--${boundary}\r\nContent-Disposition: form-data; name="pages"; filename="1.png"\r\nContent-Type: image/png\r\n\r\n`);req.write(red.subarray(0,4));
  const dir=join(root,'dl','Uploads',title);
  await until(async()=> (await readdir(dir)).some(n=>n.includes('.tmp.')));req.destroy();
  await until(async()=> !(await readdir(dir)).some(n=>n.includes('.tmp.')));
  const retry=await post(url,[['1.png',red]]);assert.equal(retry.status,200,JSON.stringify(retry));
});

test('unknown-length multipart uploads enforce aggregate bytes across pages and release their writer',{skip,timeout:20000},async()=> {
  const sharp=(await import('sharp')).default, pixels=(await import('node:crypto')).randomBytes(1024*1024*3);
  const large=await sharp(pixels,{raw:{width:1024,height:1024,channels:3}}).png().toBuffer();
  assert.ok(large.length<4*1024*1024 && large.length*2>4*1024*1024);
  const boundary='image-total-limit',url=`${address}/api/library/upload?seriesId=${series}&name=Chapter%2011.cbz&images=1`;
  let request:http.ClientRequest;
  const response=new Promise<{status:number;body:string}>((resolve,reject)=>{
    request=http.request(url,{method:'POST',headers:{authorization,'content-type':`multipart/form-data; boundary=${boundary}`,'transfer-encoding':'chunked'}},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString()}));res.on('error',reject);
    });request.on('error',reject);
  });
  const header=(name:string)=>`--${boundary}\r\nContent-Disposition: form-data; name="pages"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`;
  request!.write(header('1.png'));request!.write(large);request!.write('\r\n'+header('2.png'));request!.write(large);
  // Deliberately leave the request open: refusal must not wait for a malicious sender to finish.
  const refused=await response;request!.destroy();assert.equal(refused.status,413,refused.body);assert.equal(JSON.parse(refused.body).error,'too_large');
  const dir=join(root,'dl','Uploads',title);await until(async()=>!(await readdir(dir)).some(n=>n.includes('.tmp.')));
  const retry=await post(url,[['1.png',red]]);assert.equal(retry.status,200,JSON.stringify(retry));
});

test('server-generated page names prevent a multipart filename from escaping its chapter',{skip},async()=> {
  const url=`${address}/api/library/upload?seriesId=${series}&name=Chapter%2012.cbz&images=1`;
  const r=await post(url,[['../../escape.png',red],['fake-extension.jpg',blue]]);assert.equal(r.status,200,JSON.stringify(r));
  const {cbzPages,cbzEntry}=await import('../src/lib/library');const abs=join(root,'dl',r.data.file);
  assert.deepEqual(await cbzPages(abs),['00001.png','00002.png'],'actual decoded image formats, not supplied suffixes');assert.deepEqual(await cbzEntry(abs,'00002.png'),blue);
  await assert.rejects(readFile(join(root,'escape.png')));
});

test('a disk-full publication refusal removes its CBZ and leaves the series writable for retry',{skip},async(t)=> {
  const files=(await import('node:fs')).promises,url=`${address}/api/library/upload?seriesId=${series}&name=Chapter%2013.cbz&images=1`;
  const publication=t.mock.method(files,'link',async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});});
  const refused=await post(url,[['1.png',red]]);assert.equal(refused.status,507);assert.equal(refused.data.error,'disk_full');publication.mock.restore();
  assert.ok(!(await readdir(join(root,'dl','Uploads',title))).some(n=>n.includes('.tmp.')));
  assert.equal((await post(url,[['1.png',red]])).status,200);
});


test('a chosen shared library is reserved before publication even without a path mapping, and failed intake leaves no empty series',{skip},async(t)=> {
  const library='image-http-restricted',chosenTitle='Image chosen library fixture',failedTitle='Image failed library fixture';
  await db.q("INSERT INTO libraries(id,name,path) VALUES($1,'Restricted upload fixture','Unmapped Images')",[library]);
  // No library_paths row: a fresh scanner inference would otherwise put this under the default library.
  const files=(await import('node:fs')).promises,realLink=files.link.bind(files);
  let reservedBeforePublication=false;
  const publication=t.mock.method(files,'link',async(from:any,to:any)=>{
    const [row]=await db.q('SELECT library_id,is_private,library_pinned FROM lib_series WHERE title=$1',[chosenTitle]);
    assert.deepEqual(row,{library_id:library,is_private:false,library_pinned:true},'chosen scope exists before any archive becomes visible');
    reservedBeforePublication=true;return realLink(from,to);
  });
  try {
    const url=(label:string)=>`${address}/api/library/upload?title=${encodeURIComponent(label)}&fresh=1&name=Chapter%201.cbz&images=1&visibility=shared&libraryId=${library}`;
    const accepted=await post(url(chosenTitle),[['1.png',red]]);assert.equal(accepted.status,200,JSON.stringify(accepted));assert.equal(reservedBeforePublication,true);
    assert.equal((await db.q('SELECT library_id FROM lib_series WHERE id=$1',[accepted.data.seriesId]))[0].library_id,library,'scan preserves authoritative selected destination');
    publication.mock.restore();
    const refused=await post(url(failedTitle),[['1.png',red],['2.png',Buffer.from('corrupt')]]);assert.equal(refused.status,400);
    assert.deepEqual(await db.q('SELECT id FROM lib_series WHERE title=$1',[failedTitle]),[],'failed fresh upload removes its own unpublished DB reservation');
    assert.equal((await post(url(failedTitle),[['1.png',red]])).status,200,'same destination is available for a correct retry');
  } finally {
    publication.mock.restore();await db.q('DELETE FROM lib_series WHERE library_id=$1',[library]);await db.q('DELETE FROM libraries WHERE id=$1',[library]);
  }
});
