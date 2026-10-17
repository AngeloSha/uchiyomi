import test from 'node:test';import assert from 'node:assert/strict';
process.env.DATABASE_URL||='postgresql://unused@127.0.0.1:1/unused';process.env.JWT_SECRET||='synthetic-pr-regression-key-only';delete process.env.TRUST_PROXY;
test('default private-peer forwarding cannot rotate the source rate limit',async()=>{
 const {env}=await import('../src/env'),{trustProxySetting}=await import('../src/lib/auth');const app=(await import('fastify')).default({trustProxy:trustProxySetting(env.TRUST_PROXY)});await app.register((await import('@fastify/rate-limit')).default,{max:10,timeWindow:'5 minutes'});app.get('/fixture',async req=>({ip:req.ip}));
 try{const statuses=[];for(let i=0;i<12;i++)statuses.push((await app.inject({url:'/fixture',remoteAddress:'192.168.1.20',headers:{'x-forwarded-for':`198.51.100.${i+1}`}})).statusCode);assert.deepEqual(statuses,[200,200,200,200,200,200,200,200,200,200,429,429]);}finally{await app.close();}
});
