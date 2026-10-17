import test from 'node:test';
import assert from 'node:assert/strict';
const DSN=process.env.TEST_DATABASE_URL;
if(DSN){process.env.DATABASE_URL=DSN;process.env.JWT_SECRET||='synthetic-pr-regression-key-only';}
test('inline administration intersects account role and API-token scope',{skip:!DSN},async()=>{
 const {q,one,pool}=await import('../src/lib/db');
 await (await import('../src/lib/migrate')).migrate();
 const auth=await import('../src/lib/auth');
 const app=(await import('fastify')).default();
 await app.register((await import('@fastify/rate-limit')).default,{global:false});
 await app.register((await import('@fastify/cookie')).default);
 await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
 await app.register((await import('../src/routes/auth')).default);
 await app.register((await import('../src/routes/admin')).default);
 await app.register((await import('../src/routes/sources')).default);
 await app.ready();
 const prefix='pr-regression-',password='synthetic-pr-password-only';
 const argon=(await import('node:module')).createRequire(import.meta.url)('@node-rs/argon2');
 const ph=await argon.hash(password);
 const ids:string[]=[];
 const account=async(name:string,role='user')=>{const row=await one<{id:string}>(`INSERT INTO users(username,display_name,password_hash,role,auth_kind) VALUES ($1,$1,$2,$3,'password') RETURNING id`,[prefix+name,ph,role]);ids.push(row!.id);return row!.id;};
 let peer=1;
 const login=(name:string,pw=password,ip=`203.0.113.${peer++}`)=>app.inject({method:'POST',url:'/auth/login',remoteAddress:ip,payload:{username:prefix+name,password:pw}});
 const bearer=(token:string)=>({authorization:'Bearer '+token});
 const nativeFetch=globalThis.fetch;
 globalThis.fetch=(async()=>{throw Error('No external fetch permitted');}) as typeof fetch;

 try{
 const runs=await import('../src/lib/downloadJobs');let sid:string|undefined,lib:string|undefined;
 try{
  const admin=await account('admin','admin'),owner=await account('owner'),other=await account('other');
  const token=async(id:string,scopes:any)=>(await auth.issueApiToken(id,'fixture',scopes,null)).token;
  const sync=await token(admin,['read','write']),ops=await token(admin,['read','write','admin']),own=await token(owner,['read','write']);
  const card=runs.beginRun('sweep',other,1);
  const cancel=(t:string)=>app.inject({method:'POST',url:'/api/sources/runs/sweep/cancel',headers:bearer(t)});
  for(const t of [sync,own]){assert.equal((await cancel(t)).statusCode,403);assert.ok(!card.cancelRequested);}
  const view=await app.inject({method:'GET',url:'/api/sources/jobs',headers:bearer(sync)});assert.equal(view.statusCode,200);assert.ok(!view.json().runs.some((r:any)=>r.kind==='sweep'));
  assert.equal((await cancel(ops)).statusCode,200);assert.ok(card.cancelRequested);runs.clearRuns();
  const mine=runs.beginRun('sweep',owner,1);assert.equal((await cancel(own)).statusCode,200);assert.ok(mine.cancelRequested);runs.clearRuns();
  sid=prefix+'series';lib=prefix+'library';await q('INSERT INTO libraries(id,name,path) VALUES ($1,$1,$1)',[lib]);
  await q(`INSERT INTO lib_series(id,source,title,folder,books_count,library_id) VALUES ($1,'fixture',$1,$1,0,$2)`,[sid,lib]);
  await q(`INSERT INTO archive_queue(series_id,state,added_by) VALUES ($1,'done',$2)`,[sid,other]);
  const remove=(t:string)=>app.inject({method:'DELETE',url:'/api/sources/archive/'+sid,headers:bearer(t)});
  assert.equal((await remove(sync)).statusCode,403);assert.ok(await one('SELECT 1 FROM archive_queue WHERE series_id=$1',[sid]));
  assert.equal((await remove(ops)).statusCode,200);
  await q(`INSERT INTO archive_queue(series_id,state,added_by) VALUES ($1,'done',$2)`,[sid,owner]);assert.equal((await remove(own)).statusCode,200);
 }finally{runs.clearRuns();if(sid)await q('DELETE FROM lib_series WHERE id=$1',[sid]);if(lib)await q('DELETE FROM libraries WHERE id=$1',[lib]);}

 }finally{globalThis.fetch=nativeFetch;await app.close();await q('DELETE FROM audit_log WHERE user_id=ANY($1::uuid[]) OR username LIKE $2',[ids,prefix+'%']);await q('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);await pool.end();}
});
