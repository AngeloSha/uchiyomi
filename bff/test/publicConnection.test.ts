import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';

process.env.DATABASE_URL ||= 'postgres://unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

test('public connection lookup validates the exact addresses returned to the socket',async()=>{
  const { publicLookup }=await import('../src/lib/publicConnection');
  const lookup=(answers:any[],options:any={all:true})=>new Promise<any>((resolve,reject)=>{
    publicLookup(async()=>answers)('synthetic.invalid',options,(e:any,address:any,family:any)=>e?reject(e):resolve({address,family}));
  });
  for(const answers of [[],[{address:'127.0.0.1',family:4}],[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}],[{address:'::ffff:7f00:1',family:6}]]) await assert.rejects(lookup(answers));
  const publicAnswers=[{address:'93.184.216.34',family:4},{address:'2606:4700::1111',family:6}];
  assert.deepEqual((await lookup(publicAnswers)).address,publicAnswers);
  assert.deepEqual(await lookup(publicAnswers,{family:6}),{address:'2606:4700::1111',family:6});
  await assert.rejects(lookup([{address:'93.184.216.34',family:4}],{family:6}));
  await assert.rejects(new Promise((resolve,reject)=>publicLookup(async()=>{throw new Error('synthetic DNS failure');})('synthetic.invalid',{},(e:any)=>e?reject(e):resolve(null))));
});

const DSN=process.env.TEST_DATABASE_URL;
test('the public-hop dispatcher transports a real local response through Node fetch',async()=>{
  const {fetchPublicHop}=await import('../src/lib/publicConnection');
  const nativeFetch=globalThis.fetch;
  const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('synthetic transport control');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as any).port;
  // Only the fixture transport rewrites the destination. Exercise the production dispatcher/Node handler
  // compatibility without ever connecting to a real public server or weakening the address policy.
  globalThis.fetch=((input:any,init:any)=>{
    assert.equal(new URL(String(input)).hostname,'transport-control.invalid');
    return nativeFetch(`http://127.0.0.1:${port}/control`,init);
  }) as typeof fetch;
  try {
    const r=await fetchPublicHop(new URL('http://transport-control.invalid/control'),{signal:AbortSignal.timeout(2000)});
    assert.equal(r.status,200);assert.equal(await r.text(),'synthetic transport control');
  } finally {globalThis.fetch=nativeFetch;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('real cover and cached public-fetch routes cannot connect after DNS changes to loopback', {skip:DSN?false:'set TEST_DATABASE_URL to run'},async(t)=>{
  process.env.DATABASE_URL=DSN!;
  const require=createRequire(import.meta.url), dns=require('node:dns'), promises=require('node:dns/promises');
  const originalLookup=dns.lookup, originalPromise=promises.lookup;
  const host='connection-boundary.invalid';
  const sharp=(await import('sharp')).default;
  const pixel=await sharp({create:{width:1,height:1,channels:3,background:{r:86,g:86,b:86}}}).png().toBuffer();
  let checked=0,rawDials=0,hits=0;
  const server=createServer((_req,res)=>{hits++;res.writeHead(200,{'content-type':'image/png'});res.end(pixel);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as any).port;
  const { q,pool }=await import('../src/lib/db');let app:any;
  try {
    await (await import('../src/lib/migrate')).migrate();
    const id=(await q(`INSERT INTO users (username,display_name,password_hash,role) VALUES ('connection-boundary','fixture','x','user') RETURNING id`))[0].id;
    promises.lookup=async(name:string,options:any)=>{
      assert.equal(name,host);checked++;
      const answer={address:checked<=2?'93.184.216.34':'127.0.0.1',family:4};
      return options?.all?[answer]:answer;
    };
    // The vulnerable default connector would resolve to this real disposable loopback socket.
    dns.lookup=(name:string,options:any,cb:any)=>{assert.equal(name,host);rawDials++;if(typeof options==='function'){cb=options;options={};}queueMicrotask(()=>options?.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4));};
    syncBuiltinESMExports();
    app=(await import('fastify')).default();
    await app.register((await import('@fastify/cookie')).default);
    await app.register((await import('@fastify/jwt')).default,{secret:process.env.JWT_SECRET!});
    await app.register((await import('../src/routes/images')).default);await app.ready();
    const cookie=app.jwt.sign({sub:id,typ:'img'},{expiresIn:60});
    const r=await app.inject({method:'GET',url:`/img/sources/cover?u=${encodeURIComponent(`http://${host}:${port}/private.png`)}`,headers:{cookie:`yomi_img=${cookie}`}});
    assert.equal(hits,0,'a cover safety check must not be followed by a private socket');
    assert.equal(rawDials,0,'no unchecked resolver may connect');assert.ok(checked>=3,'the connection lookup must validate again');
    assert.notEqual(r.statusCode,200,'the synthetic private image must not be returned');
    const { fetchPublic,fetchFollowingPublic,assertNotPrivateHost }=await import('../src/lib/safeFetch');
    // The cached preflight accepts a formerly public host; the connection still refuses its current answer.
    checked=0;await assertNotPrivateHost(host);
    checked=2;
    const out=await fetchPublic(`http://${host}:${port}/cached.png`,{maxBytes:4096});
    assert.equal(out,null);assert.ok(checked>=3,'cached preflight cannot replace socket validation');
    await assert.rejects(fetchFollowingPublic(`http://${host}:${port}/page.png`,{headers:{},signal:AbortSignal.timeout(2000)}));
    assert.equal(hits,0);assert.equal(rawDials,0);
  } finally {
    dns.lookup=originalLookup;promises.lookup=originalPromise;syncBuiltinESMExports();
    await app?.close();await q("DELETE FROM users WHERE username='connection-boundary'");await pool.end();
    await new Promise<void>(r=>server.close(()=>r()));
  }
});
