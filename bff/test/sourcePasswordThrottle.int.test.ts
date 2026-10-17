import test from 'node:test';
import assert from 'node:assert/strict';
const DSN=process.env.TEST_DATABASE_URL;
if(DSN){process.env.DATABASE_URL=DSN;process.env.JWT_SECRET||='synthetic-pr-regression-key-only';}
test('public password failures throttle the source without locking its victim',{skip:!DSN},async()=>{
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
  const victim=await account('victim');
  for(let i=0;i<5;i++)assert.equal((await login('victim','wrong','198.51.100.1')).statusCode,401);
  const r=await login('victim','wrong','198.51.100.1');assert.equal(r.statusCode,429);assert.ok(Number(r.headers['retry-after'])>0);
  assert.equal((await login('victim',password,'198.51.100.2')).statusCode,200);
  for(let i=0;i<6;i++)assert.equal((await login('victim','wrong',`192.0.2.${i+1}`)).statusCode,401);
  assert.deepEqual(await one('SELECT failed_logins,locked_until FROM users WHERE id=$1',[victim]),{failed_logins:0,locked_until:null});
  for(let i=0;i<6;i++)assert.equal((await login('victim',password,`203.0.113.${i+50}`)).statusCode,200);
 
 }finally{globalThis.fetch=nativeFetch;await app.close();await q('DELETE FROM audit_log WHERE user_id=ANY($1::uuid[]) OR username LIKE $2',[ids,prefix+'%']);await q('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);await pool.end();}
});
