import test from 'node:test';
import assert from 'node:assert/strict';
const DSN=process.env.TEST_DATABASE_URL;
if(DSN){process.env.DATABASE_URL=DSN;process.env.JWT_SECRET||='synthetic-pr-regression-key-only';}
test('pre-password account states have uniform refusals and verification work',{skip:!DSN},async(t)=>{
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
  const member=await account('member'),disabled=await account('disabled'),locked=await account('locked'),nopassword=await account('nopassword');
  await q('UPDATE users SET disabled=true WHERE id=$1',[disabled]);await q("UPDATE users SET locked_until=now()+interval '15 minutes' WHERE id=$1",[locked]);
  // A profile without a password (users.password_login false). It keeps a real hash here, so
  // only the refusal itself can stop the right password below.
  await q('UPDATE users SET password_login=false WHERE id=$1',[nopassword]);
  const original=argon.verify,hashes:string[]=[];const mock=t.mock.method(argon,'verify',(encoded:string,pw:string)=>{hashes.push(encoded);return original(encoded,pw);});
  try{for(const name of ['missing','disabled','locked','member','nopassword']){const n=hashes.length,r=await login(name,'wrong');assert.equal(r.statusCode,401);assert.deepEqual(r.json(),{error:'invalid_credentials'});assert.equal(hashes.length-n,1);}assert.ok(hashes.every(h=>h.split('$').slice(1,4).join('$')===ph.split('$').slice(1,4).join('$')));}finally{mock.mock.restore();}
  let seed=95;const rng=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};const samples:{member:number[],missing:number[]}={member:[],missing:[]};
  for(let i=0;i<35;i++){await q('UPDATE users SET failed_logins=0,locked_until=null WHERE id=$1',[member]);for(const name of rng()<0.5?['member','missing']:['missing','member']){const start=performance.now(),r=await login(name,'wrong',`198.51.100.${i+1}`);assert.equal(r.statusCode,401);if(i>=5)samples[name as 'member'|'missing'].push(performance.now()-start);}}
  const median=(a:number[])=>[...a].sort((a,b)=>a-b)[a.length>>1];t.diagnostic(`30 randomized pairs after 5 warmups: existing ${median(samples.member).toFixed(3)} ms, missing ${median(samples.missing).toFixed(3)} ms. Local observations, not a remote timing proof.`);
  assert.equal((await login('member')).statusCode,200);
  // A profile without a password is refused like a name nobody has, even given the hash's own password, and the log says why.
  const right=await login('nopassword');assert.equal(right.statusCode,401);assert.deepEqual(right.json(),{error:'invalid_credentials'});
  const why=await one<{r:string}>("SELECT detail->>'reason' AS r FROM audit_log WHERE username=$1 ORDER BY id DESC LIMIT 1",[prefix+'nopassword']);assert.equal(why?.r,'no_password');

 }finally{globalThis.fetch=nativeFetch;await app.close();await q('DELETE FROM audit_log WHERE user_id=ANY($1::uuid[]) OR username LIKE $2',[ids,prefix+'%']);await q('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);await pool.end();}
});
