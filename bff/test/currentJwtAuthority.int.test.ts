import test from 'node:test';
import assert from 'node:assert/strict';
const DSN=process.env.TEST_DATABASE_URL;
if(DSN){process.env.DATABASE_URL=DSN;process.env.JWT_SECRET||='synthetic-pr-regression-key-only';}
test('access JWTs follow current account state and role',{skip:!DSN},async()=>{
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
  const admin=await account('admin','admin'),control=await account('control','admin');
  const old=(await login('admin')).json().accessToken;
  const controller=app.jwt.sign({sub:control,role:'admin'});
  const patch=(body:object)=>app.inject({method:'PATCH',url:'/api/admin/users/'+admin,headers:bearer(controller),payload:body});
  assert.equal((await patch({role:'user'})).statusCode,200);
  assert.equal((await app.inject({method:'GET',url:'/api/admin/users',headers:bearer(old)})).statusCode,403);
  assert.equal((await app.inject({method:'GET',url:'/auth/me',headers:bearer(old)})).statusCode,200);
  assert.equal((await patch({disabled:true})).statusCode,200);
  assert.equal((await app.inject({method:'GET',url:'/auth/me',headers:bearer(old)})).statusCode,401);
  const gone=await account('deleted'),deleted=app.jwt.sign({sub:gone,role:'admin'});await q('DELETE FROM users WHERE id=$1',[gone]);
  assert.equal((await app.inject({method:'GET',url:'/api/admin/users',headers:bearer(deleted)})).statusCode,401);

 }finally{globalThis.fetch=nativeFetch;await app.close();await q('DELETE FROM audit_log WHERE user_id=ANY($1::uuid[]) OR username LIKE $2',[ids,prefix+'%']);await q('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);await pool.end();}
});
